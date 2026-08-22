'use strict';

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const http = require('node:http');

const config = require('./config/config');
const logger = require('./utils/logger');
const { loadCommands } = require('./commands');
const { registerEvents } = require('./events');
const { registerClientErrorHandlers } = require('./events/clientErrors');

const queueManager = require('./services/queueManagerInstance');
const supabaseService = require('./services/supabaseService');
const VoiceManager = require('./services/voiceManager');
const PlaybackService = require('./services/playbackService');
const AutoJoinLeaveManager = require('./services/autoJoinLeaveManager');

// ---------------------------------------------------------------------------
// Global process-level safety nets. Per-command and per-event try/catch
// blocks handle the vast majority of failures without ever reaching here;
// these exist purely as a last line of defense so a single unexpected
// throw can't silently kill the bot without a trace, and so the process
// exits cleanly (letting Render restart it) rather than hanging in a
// broken state.
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', err);
  // An uncaught exception means the process is in an unknown state.
  // Exit deliberately so the platform's process supervisor restarts us
  // cleanly, rather than continuing to run in a possibly-corrupted state.
  process.exitCode = 1;
  shutdown('uncaught_exception').finally(() => process.exit(1));
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

const voiceManager = new VoiceManager(queueManager);
const playbackService = new PlaybackService(queueManager, voiceManager);
const autoJoinLeaveManager = new AutoJoinLeaveManager(queueManager, playbackService, voiceManager);
const commands = loadCommands();

/** @type {import('./types').CommandContext} */
const ctx = {
  client,
  queueManager,
  supabaseService,
  voiceManager,
  playbackService,
  autoJoinLeaveManager,
  commands,
  logger,
};

registerClientErrorHandlers(client);
registerEvents(client, ctx);

// ---------------------------------------------------------------------------
// Auto-detect music: scan the Storage bucket for audio files on startup and
// on a recurring interval, adding any new ones to the database (and
// deactivating any whose files were deleted). This is what lets someone
// just drop a file into the bucket with no manual SQL — playNext() also
// triggers this same sync whenever the queue needs refilling, so this
// interval mainly keeps things fresh while the bot is idle or mid-playlist.
// ---------------------------------------------------------------------------
supabaseService.syncFromStorageSafe();
setInterval(() => supabaseService.syncFromStorageSafe(), config.playback.librarySyncIntervalMs).unref();

// Optional tiny health-check server. Only binds if Render (or another
// platform) supplies a PORT, e.g. when deployed as a Web Service instead
// of a Background Worker.
if (config.ops.port) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ready: client.isReady() }));
    })
    .listen(config.ops.port, () => {
      logger.info('health_server_listening', { port: config.ops.port });
    });
}

async function shutdown(signal) {
  logger.info('shutdown_initiated', { signal });
  try {
    for (const guildId of queueManager.queues.keys()) {
      voiceManager.leave(guildId, `shutdown:${signal}`);
    }
    client.destroy();
    logger.info('shutdown_complete', { signal });
  } catch (err) {
    logger.error('shutdown_failed', err, { signal });
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));

client.login(config.discord.token).catch((err) => {
  logger.error('login_failed', err);
  process.exit(1);
});
