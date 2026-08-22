'use strict';

const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config/config');
const logger = require('./utils/logger');
const supervisor = require('./utils/supervisor');
const { inc, snapshot } = require('./utils/metrics');
const health = require('./utils/health');
const cooldownManager = require('./utils/cooldown');
const queueSnapshot = require('./utils/queueSnapshot');
const { retry } = require('./utils/retry');
const { loadCommands } = require('./commands');
const { registerEvents } = require('./events');
const { registerClientErrorHandlers } = require('./events/clientErrors');

const queueManager = require('./services/queueManagerInstance');
const supabaseService = require('./services/supabaseService');
const VoiceManager = require('./services/voiceManager');
const PlaybackService = require('./services/playbackService');
const AutoJoinLeaveManager = require('./services/autoJoinLeaveManager');

let shuttingDown = false;
/** @type {NodeJS.Timeout|null} */
let librarySyncTimer = null;
/** @type {NodeJS.Timeout|null} */
let metricsTimer = null;

process.on('unhandledRejection', (reason) => {
  inc('unhandledRejections');
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.critical('unhandled_rejection', err, {
    command: err.commandName,
    userId: err.userId,
    guildId: err.guildId,
  });
  supervisor.reportFailure('unhandled', err, {
    command: err.commandName,
    userId: err.userId,
    guildId: err.guildId,
    force: true,
  });
});

process.on('uncaughtException', (err) => {
  inc('uncaughtExceptions');
  logger.critical('uncaught_exception', err);
  shutdown('uncaught_exception').finally(() => process.exit(1));
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

const voiceManager = new VoiceManager(queueManager);
const playbackService = new PlaybackService(queueManager, voiceManager);
voiceManager.playbackService = playbackService;
const autoJoinLeaveManager = new AutoJoinLeaveManager(queueManager, playbackService, voiceManager);
voiceManager.onChannelLost = (guildId) => {
  const guild = client.guilds.cache.get(guildId);
  if (guild) autoJoinLeaveManager.scheduleRejoin(guild);
};
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

health.setExtraSnapshot(() => ({
  ready: client.isReady(),
  acceptingCommands: health.isAcceptingCommands(),
  activeVoiceConnections: voiceManager.activeConnectionCount(),
  guilds: client.guilds.cache.size,
}));

supabaseService.syncFromStorageSafe();
librarySyncTimer = setInterval(() => {
  supabaseService.syncFromStorageSafe();
}, config.playback.librarySyncIntervalMs);
librarySyncTimer.unref();

health.startHeartbeat();

metricsTimer = setInterval(() => {
  logger.info('metrics_snapshot', snapshot({
    ready: client.isReady(),
    activeVoiceConnections: voiceManager.activeConnectionCount(),
  }));
}, config.ops.metricsIntervalMs);
metricsTimer.unref();

const listenPort = config.ops.port || config.ops.healthPort;
if (listenPort) {
  health.startHealthServer(listenPort);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  health.setAcceptingCommands(false);
  logger.info('shutdown_initiated', { signal });

  const forceExit = setTimeout(() => {
    logger.critical('shutdown_timed_out', new Error(signal), { signal });
    process.exit(process.exitCode || 1);
  }, 15_000);

  if (librarySyncTimer) clearInterval(librarySyncTimer);
  if (metricsTimer) clearInterval(metricsTimer);
  health.stopHeartbeat();
  cooldownManager.stop();

  try {
    queueSnapshot.save(queueManager);
    for (const guildId of [...queueManager.queues.keys()]) {
      try {
        voiceManager.leave(guildId, `shutdown:${signal}`);
      } catch (err) {
        logger.error('shutdown_leave_failed', err, { guildId });
      }
    }
    await health.stopHealthServer();
    client.destroy();
    await logger.flush();
    logger.info('shutdown_complete', { signal });
    await logger.flush();
  } catch (err) {
    logger.error('shutdown_failed', err, { signal });
    await logger.flush();
  } finally {
    clearTimeout(forceExit);
  }
}

supervisor.setFlushHandler(async (reason) => {
  logger.critical('supervisor_flush', new Error(reason), { reason });
  await shutdown(`supervisor:${reason}`);
});

process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(process.exitCode || 0)));
process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(process.exitCode || 0)));

logger.info('bot_starting', { nodeEnv: config.ops.nodeEnv, logDir: config.ops.logDir });

retry(() => client.login(config.discord.token), {
  retries: 2,
  baseDelayMs: 1000,
  onRetry: (err, attempt, delayMs) => {
    logger.warn('login_retry', { attempt, delayMs, error: err.message });
  },
}).catch((err) => {
  logger.critical('login_failed', err);
  process.exit(1);
});
