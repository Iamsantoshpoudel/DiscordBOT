const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');
const config = require('./src/config');
const { loadCommands } = require('./src/utils/loadCommands');
const { MusicManager } = require('./src/utils/musicPlayer');
const registerInteractionCreate = require('./src/events/interactionCreate');
const registerVoiceStateUpdate = require('./src/events/voiceStateUpdate');
const registerMessageCreate = require('./src/events/messageCreate');
const registerGuildCreate = require('./src/events/guildCreate');
const { checkExistingVoiceOccupants } = require('./src/utils/voiceWatcher');
const { deployGuildCommands } = require('./src/utils/deployCommands');
const { getInviteUrl } = require('./src/utils/permissions');
const b2 = require('./src/utils/b2Client');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const commands = loadCommands();
const manager = new MusicManager();

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Watching voice channel: ${config.musicVoiceChannelId}`);
  console.log(`Slash commands: type / in chat | Text: ${config.commandPrefix}help`);
  console.log(`Invite link (with permissions): ${getInviteUrl()}`);

  try {
    await deployGuildCommands(console.log);
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err.message);
    console.error('   Run: npm run deploy-commands');
  }

  try {
    const guild = await client.guilds.fetch(config.guildId);
    await registerGuildCreate.ensureGuildPermissions(guild);
  } catch (err) {
    console.warn('[permissions] Could not verify guild permissions:', err.message);
  }

  try {
    const tracks = await b2.listPlaylist();
    console.log(`✅ B2 connected — ${tracks.length} track(s) under prefix "${config.b2.prefix || '(root)'}"`);
    if (tracks.length === 0) {
      console.warn('[b2] No audio files found. Upload .mp3/.flac/etc. to your bucket prefix.');
    }
  } catch (err) {
    console.error(`❌ B2 connection failed: ${err.message}`);
    console.error('[b2] Regenerate your Application Key in Backblaze and update B2_KEY_ID / B2_APPLICATION_KEY in .env');
  }

  await checkExistingVoiceOccupants(client, manager);
});

registerInteractionCreate(client, commands, manager);
registerVoiceStateUpdate(client, manager);
registerMessageCreate(client, commands, manager);
registerGuildCreate(client);

client.login(config.discordToken);

// ---- Keep-alive HTTP server ----
// Needed if deployed as a Render "Web Service" (health checks + prevents some
// platforms from thinking the process is dead). Not required for a
// "Background Worker" deployment, but harmless either way.
const app = express();
app.get('/', (_req, res) => res.send('Discord music bot is running.'));
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.listen(config.port, () => {
  console.log(`Keep-alive server listening on port ${config.port}`);
});

// ---- Graceful shutdown ----
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  client.destroy();
  process.exit(0);
});
