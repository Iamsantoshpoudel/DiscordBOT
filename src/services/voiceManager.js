'use strict';

const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const config = require('../config/config');
const logger = require('../utils/logger').child('voiceManager');
const { retry, PermanentError } = require('../utils/retry');
const supervisor = require('../utils/supervisor');
const { inc } = require('../utils/metrics');

/**
 * Owns Discord voice connection lifecycle for a guild: joining, tearing
 * down, and recovering from transient network blips (which surface as the
 * connection dropping to `Disconnected` and either reconnecting on its own
 * or needing to be manually re-established).
 */
class VoiceManager {
  /**
   * @param {import('./musicQueue').QueueManager} queueManager
   */
  constructor(queueManager) {
    this.queueManager = queueManager;
    /** @type {import('./playbackService')|null} */
    this.playbackService = null;
    /** @param {string} guildId */
    this.onChannelLost = null;
  }

  activeConnectionCount() {
    let count = 0;
    for (const queue of this.queueManager.queues.values()) {
      if (queue.connection && queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Joins the configured voice channel for a guild, creating an
   * AudioPlayer and wiring up automatic reconnection handling.
   * @param {import('discord.js').Guild} guild
   * @returns {{ connection: import('@discordjs/voice').VoiceConnection, player: import('@discordjs/voice').AudioPlayer }}
   */
  joinConfiguredChannel(guild) {
    const queue = this.queueManager.getOrCreate(guild.id);

    if (queue.connection && queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      return { connection: queue.connection, player: queue.player };
    }

    if (this.activeConnectionCount() >= config.playback.maxVoiceConnections) {
      throw new PermanentError(
        `Voice connection cap reached (${config.playback.maxVoiceConnections}). Refusing to join another channel.`,
        'VOICE_CAP',
      );
    }

    const channel = guild.channels.cache.get(config.discord.voiceChannelId);
    if (!channel?.isVoiceBased?.()) {
      throw new PermanentError('Configured voice channel is missing or is not a voice channel.', 'VOICE_CHANNEL_MISSING');
    }
    if (config.discord.categoryId && channel.parentId !== config.discord.categoryId) {
      logger.warn('voice_category_mismatch', {
        guildId: guild.id,
        expectedCategoryId: config.discord.categoryId,
        actualParentId: channel.parentId,
      });
    }

    const connection = joinVoiceChannel({
      channelId: config.discord.voiceChannelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    connection.subscribe(player);
    this._attachConnectionRecovery(guild.id, connection, player);

    queue.connection = connection;
    queue.player = player;

    logger.info('voice_channel_joined', { guildId: guild.id, channelId: config.discord.voiceChannelId });
    supervisor.reportSuccess('voice');
    return { connection, player };
  }

  /**
   * Attaches disconnect-recovery logic. @discordjs/voice's connection can
   * report `Disconnected` for two very different reasons:
   *  - A recoverable network blip (WebSocket close code < 4014, or the
   *    connection is expected to come back e.g. after a Discord-side move).
   *  - A permanent disconnect (bot was kicked from the channel, channel
   *    deleted, etc.), where retrying is pointless and we should clean up.
   *
   * We race two recovery paths and destroy the connection if neither
   * resolves in time, so a bad connection never lingers as a zombie.
   * @param {string} guildId
   * @param {import('@discordjs/voice').VoiceConnection} connection
   * @param {import('@discordjs/voice').AudioPlayer} player
   */
  _attachConnectionRecovery(guildId, connection, player) {
    let handlingDisconnect = false;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (handlingDisconnect) return;
      handlingDisconnect = true;
      logger.warn('voice_connection_disconnected', { guildId });
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        logger.info('voice_connection_recovering', { guildId });
        supervisor.reportSuccess('voice');
        handlingDisconnect = false;
      } catch {
        logger.warn('voice_connection_unrecoverable', { guildId });
        inc('voiceErrors');
        supervisor.reportFailure('voice', new Error('unrecoverable_disconnect'), { guildId, force: true });
        this._cleanupAfterDisconnect(guildId, connection, player);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      logger.info('voice_connection_destroyed', { guildId });
    });

    connection.on('error', (err) => {
      logger.error('voice_connection_error', err, { guildId });
      inc('voiceErrors');
    });
  }

  _cleanupAfterDisconnect(guildId, connection, player) {
    try {
      player?.removeAllListeners();
      player?.stop(true);
    } catch (err) {
      logger.error('voice_player_cleanup_failed', err, { guildId });
    }
    try {
      connection.removeAllListeners();
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
    } catch (err) {
      logger.error('voice_connection_cleanup_failed', err, { guildId });
    }
    this.playbackService?.detachGuild(guildId);
    const queue = this.queueManager.get(guildId);
    if (queue) {
      queue.resetPlaybackState();
    }
    if (typeof this.onChannelLost === 'function') {
      setImmediate(() => {
        try {
          this.onChannelLost(guildId);
        } catch (err) {
          logger.error('voice_channel_lost_hook_failed', err, { guildId });
        }
      });
    }
  }

  /**
   * Leaves the configured voice channel for a guild and resets its
   * playback state. Safe to call even if the bot isn't currently connected.
   * @param {string} guildId
   * @param {string} [reason]
   */
  leave(guildId, reason = 'unspecified') {
    const queue = this.queueManager.get(guildId);
    if (!queue?.connection) {
      this.playbackService?.detachGuild(guildId);
      queue?.resetPlaybackState();
      return;
    }

    try {
      queue.destroyCurrentStream();
      queue.player?.removeAllListeners();
      queue.player?.stop(true);
      queue.connection.removeAllListeners();
      queue.connection.destroy();
      logger.info('voice_channel_left', { guildId, reason });
    } catch (err) {
      logger.error('voice_channel_leave_failed', err, { guildId, reason });
    } finally {
      this.playbackService?.detachGuild(guildId);
      queue.resetPlaybackState();
    }
  }

  /**
   * Waits until the connection reaches the `Ready` state, throwing if it
   * doesn't within the timeout. Wrapped with retry by playbackService.start.
   * @param {import('@discordjs/voice').VoiceConnection} connection
   * @param {number} [timeoutMs=15000]
   */
  async waitUntilReady(connection, timeoutMs = 15_000) {
    await retry(() => entersState(connection, VoiceConnectionStatus.Ready, timeoutMs), {
      retries: 2,
      baseDelayMs: 500,
      onRetry: (err, attempt, delayMs) => {
        logger.warn('voice_ready_retry', { attempt, delayMs, error: err.message });
      },
    });
  }
}

module.exports = VoiceManager;
