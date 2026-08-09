require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

const config = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  musicVoiceChannelId: required('MUSIC_VOICE_CHANNEL_ID'),
  botTextChannelId: process.env.BOT_TEXT_CHANNEL_ID || null,

  b2: {
    endpoint: required('B2_ENDPOINT'),
    region: process.env.B2_REGION || 'us-west-004',
    keyId: required('B2_KEY_ID'),
    applicationKey: required('B2_APPLICATION_KEY'),
    bucket: required('B2_BUCKET_NAME'),
    prefix: process.env.B2_PREFIX || '',
  },

  autoJoinDelayMs: (parseInt(process.env.AUTO_JOIN_DELAY_SECONDS, 10) || 30) * 1000,
  defaultVolume: parseInt(process.env.DEFAULT_VOLUME, 10) || 100,
  shufflePlaylist: (process.env.SHUFFLE_PLAYLIST || 'false').toLowerCase() === 'true',
  commandPrefix: process.env.COMMAND_PREFIX || '!',

  port: process.env.PORT || 3000,
};

module.exports = config;
