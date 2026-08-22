'use strict';

const config = require('../config/config');
const logger = require('../utils/logger').child('autoJoinLeaveManager');
const { isAcceptingCommands } = require('../utils/health');
const { PermanentError } = require('../utils/retry');

/**
 * Counts non-bot members currently in the configured voice channel.
 * @param {import('discord.js').Guild} guild
 * @returns {number}
 */
function countHumansInChannel(guild) {
  const channel = guild.channels.cache.get(config.discord.voiceChannelId);
  if (!channel?.isVoiceBased?.()) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

/**
 * Watches the configured voice channel and drives two independent timers:
 *
 *  - Auto-join: starts a single 30s (configurable) timer the moment the
 *    channel goes from 0 -> 1 human members. If more humans join while
 *    that timer is pending, we do NOT start a second timer. If everyone
 *    leaves before the timer fires, it's cancelled.
 *
 *  - Auto-leave: starts a 30s (configurable) timer the moment the channel
 *    goes from 1 -> 0 human members (bot excluded from the count). If a
 *    human rejoins before it fires, the timer is cancelled.
 */
class AutoJoinLeaveManager {
  /**
   * @param {import('./musicQueue').QueueManager} queueManager
   * @param {import('./playbackService')} playbackService
   * @param {import('./voiceManager')} voiceManager
   */
  constructor(queueManager, playbackService, voiceManager) {
    this.queueManager = queueManager;
    this.playbackService = playbackService;
    this.voiceManager = voiceManager;
  }

  /**
   * Called on every relevant voiceStateUpdate. Recomputes channel
   * occupancy and reconciles the join/leave timers against it.
   * @param {import('discord.js').Guild} guild
   */
  reconcile(guild) {
    const queue = this.queueManager.getOrCreate(guild.id);
    const humanCount = countHumansInChannel(guild);
    const botConnected = !!queue.connection;

    if (humanCount > 0) {
      queue.clearAutoLeaveTimer();

      if (!botConnected && !queue.autoJoinTimer) {
        this._scheduleAutoJoin(guild, queue);
      }
    } else {
      queue.autoJoinAttempts = 0;
      queue.clearAutoJoinTimer();

      if (botConnected && !queue.autoLeaveTimer) {
        this._scheduleAutoLeave(guild, queue);
      }
    }
  }

  /**
   * After an unrecoverable voice drop, rejoin quickly if humans are still there
   * instead of waiting for another voiceStateUpdate (which may never come).
   * @param {import('discord.js').Guild} guild
   */
  scheduleRejoin(guild) {
    const queue = this.queueManager.getOrCreate(guild.id);
    if (countHumansInChannel(guild) === 0) return;
    if (queue.connection) return;
    queue.clearAutoJoinTimer();
    this._scheduleAutoJoin(guild, queue, 2000);
  }

  /**
   * @param {import('discord.js').Guild} guild
   * @param {import('./musicQueue').GuildMusicQueue} queue
   * @param {number} [delayMs]
   */
  _scheduleAutoJoin(guild, queue, delayMs = config.playback.autoJoinDelayMs) {
    logger.info('auto_join_timer_started', { guildId: guild.id, delayMs });

    queue.autoJoinTimer = setTimeout(async () => {
      queue.autoJoinTimer = null;
      // Re-check: humans may have all left again during the delay window.
      if (countHumansInChannel(guild) === 0) {
        logger.info('auto_join_aborted_channel_empty', { guildId: guild.id });
        return;
      }
      if (!isAcceptingCommands()) {
        logger.info('auto_join_aborted_shutting_down', { guildId: guild.id });
        return;
      }
      try {
        logger.info('auto_join_triggered', { guildId: guild.id });
        await this.playbackService.start(guild);
        queue.autoJoinAttempts = 0;
      } catch (err) {
        logger.error('auto_join_failed', err, { guildId: guild.id });
        queue.autoJoinAttempts = (queue.autoJoinAttempts || 0) + 1;
        if (
          !(err instanceof PermanentError || err?.permanent) &&
          queue.autoJoinAttempts < 3 &&
          countHumansInChannel(guild) > 0 &&
          isAcceptingCommands()
        ) {
          const retryDelayMs = 1000 * 2 ** (queue.autoJoinAttempts - 1);
          logger.warn('auto_join_retry_scheduled', {
            guildId: guild.id,
            attempt: queue.autoJoinAttempts,
            retryDelayMs,
          });
          this._scheduleAutoJoin(guild, queue, retryDelayMs);
        }
      }
    }, delayMs);
  }

  /**
   * @param {import('discord.js').Guild} guild
   * @param {import('./musicQueue').GuildMusicQueue} queue
   */
  _scheduleAutoLeave(guild, queue) {
    const delayMs = config.playback.autoLeaveDelayMs;
    logger.info('auto_leave_timer_started', { guildId: guild.id, delayMs });

    queue.autoLeaveTimer = setTimeout(() => {
      queue.autoLeaveTimer = null;
      // Re-check: a human may have rejoined during the delay window.
      if (countHumansInChannel(guild) > 0) {
        logger.info('auto_leave_aborted_human_present', { guildId: guild.id });
        return;
      }
      logger.info('auto_leave_triggered', { guildId: guild.id });
      try {
        this.voiceManager.leave(guild.id, 'auto_leave_no_humans');
      } catch (err) {
        logger.error('auto_leave_failed', err, { guildId: guild.id });
      }
    }, delayMs);
  }
}

module.exports = AutoJoinLeaveManager;
