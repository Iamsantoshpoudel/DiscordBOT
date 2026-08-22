'use strict';

const config = require('../config/config');
const logger = require('../utils/logger').child('autoJoinLeaveManager');

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
      // A human is present: cancel any pending auto-leave, and start
      // auto-join only if the bot isn't connected AND no join timer is
      // already pending (this is what prevents a second timer).
      queue.clearAutoLeaveTimer();

      if (!botConnected && !queue.autoJoinTimer) {
        this._scheduleAutoJoin(guild, queue);
      }
    } else {
      // Channel is empty of humans: cancel any pending auto-join (nobody
      // to play for), and start auto-leave only if the bot is connected
      // and no leave timer is already pending.
      queue.clearAutoJoinTimer();

      if (botConnected && !queue.autoLeaveTimer) {
        this._scheduleAutoLeave(guild, queue);
      }
    }
  }

  /**
   * @param {import('discord.js').Guild} guild
   * @param {import('./musicQueue').GuildMusicQueue} queue
   */
  _scheduleAutoJoin(guild, queue) {
    const delayMs = config.playback.autoJoinDelayMs;
    logger.info('auto_join_timer_started', { guildId: guild.id, delayMs });

    queue.autoJoinTimer = setTimeout(async () => {
      queue.autoJoinTimer = null;
      // Re-check: humans may have all left again during the delay window.
      if (countHumansInChannel(guild) === 0) {
        logger.info('auto_join_aborted_channel_empty', { guildId: guild.id });
        return;
      }
      try {
        logger.info('auto_join_triggered', { guildId: guild.id });
        await this.playbackService.start(guild);
      } catch (err) {
        logger.error('auto_join_failed', err, { guildId: guild.id });
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
      this.voiceManager.leave(guild.id, 'auto_leave_no_humans');
    }, delayMs);
  }
}

module.exports = AutoJoinLeaveManager;
