'use strict';

const { Events } = require('discord.js');
const logger = require('../utils/logger').child('events:clientErrors');

/**
 * Not a single Discord.js "event" in the addEventListener sense — this
 * module registers several low-level client diagnostic listeners at once.
 * Wired up directly in index.js rather than through the generic per-file
 * event loader, since it doesn't follow the (name, execute) shape.
 * @param {import('discord.js').Client} client
 */
function registerClientErrorHandlers(client) {
  client.on(Events.Error, (err) => {
    logger.error('discord_client_error', err);
  });

  client.on(Events.Warn, (message) => {
    logger.warn('discord_client_warning', { message });
  });

  client.on(Events.ShardError, (err, shardId) => {
    logger.error('discord_shard_error', err, { shardId });
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn('discord_shard_disconnect', { shardId, code: event?.code });
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    logger.info('discord_shard_reconnecting', { shardId });
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.info('discord_shard_resumed', { shardId, replayedEvents });
  });

  client.on(Events.Invalidated, () => {
    logger.critical(
      'discord_session_invalidated',
      new Error('Discord session invalidated — token was reset or the gateway rejected the session'),
    );
    process.exitCode = 1;
    process.emit('SIGTERM');
  });

  try {
    client.rest.on('rateLimited', (info) => {
      logger.warn('discord_rate_limited', {
        timeout: info.timeToReset ?? info.timeout,
        limit: info.limit,
        method: info.method,
        url: info.url ?? info.route,
        global: info.global,
      });
    });
  } catch (err) {
    logger.warn('rate_limit_listener_unavailable', { error: err.message });
  }
}

module.exports = { registerClientErrorHandlers };
