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
    this._attachConnectionRecovery(guild.id, connection);

    queue.connection = connection;
    queue.player = player;

    logger.info('voice_channel_joined', { guildId: guild.id, channelId: config.discord.voiceChannelId });
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
   */
  _attachConnectionRecovery(guildId, connection) {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      logger.warn('voice_connection_disconnected', { guildId });
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        logger.info('voice_connection_recovering', { guildId });
      } catch {
        // Neither resumed within the window — treat as a real disconnect.
        logger.warn('voice_connection_unrecoverable', { guildId });
        this._cleanupAfterDisconnect(guildId, connection);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      logger.info('voice_connection_destroyed', { guildId });
    });

    connection.on('error', (err) => {
      logger.error('voice_connection_error', err, { guildId });
    });
  }

  _cleanupAfterDisconnect(guildId, connection) {
    try {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
    } catch (err) {
      logger.error('voice_connection_cleanup_failed', err, { guildId });
    }
    const queue = this.queueManager.get(guildId);
    if (queue) {
      queue.resetPlaybackState();
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
    if (!queue?.connection) return;

    try {
      queue.player?.stop(true);
      queue.connection.destroy();
      logger.info('voice_channel_left', { guildId, reason });
    } catch (err) {
      logger.error('voice_channel_leave_failed', err, { guildId, reason });
    } finally {
      queue.resetPlaybackState();
    }
  }

  /**
   * Waits until the connection reaches the `Ready` state, throwing if it
   * doesn't within the timeout. Callers should wrap this with the shared
   * retry() helper for transient join failures.
   * @param {import('@discordjs/voice').VoiceConnection} connection
   * @param {number} [timeoutMs=15000]
   */
  async waitUntilReady(connection, timeoutMs = 15_000) {
    await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
  }
}

module.exports = VoiceManager;
