'use strict';

const { Events, ActivityType } = require('discord.js');
const logger = require('../utils/logger').child('events:ready');
const queueSnapshot = require('../utils/queueSnapshot');

module.exports = {
  name: Events.ClientReady,
  once: true,

  /** @param {import('discord.js').Client} client @param {import('../types').CommandContext} ctx */
  async execute(client, ctx) {
    logger.info('bot_ready', { tag: client.user.tag, guildCount: client.guilds.cache.size });

    try {
      client.user.setPresence({
        activities: [{ name: 'dexbotx.vercel.app', type: ActivityType.Listening }],
        status: 'online',
      });
    } catch (err) {
      logger.warn('presence_update_failed', { error: err.message });
    }

    // Reconcile auto-join/auto-leave from the voice-state cache (GuildVoiceStates
    // intent). Do not fetch the full member list — that needs the privileged
    // Guild Members intent this bot does not request.
    try {
      queueSnapshot.restore(ctx.queueManager);
    } catch (err) {
      logger.warn('queue_snapshot_restore_skipped', { error: err.message });
    }

    for (const guild of client.guilds.cache.values()) {
      try {
        ctx.autoJoinLeaveManager.reconcile(guild);
      } catch (err) {
        logger.error('startup_reconcile_failed', err, { guildId: guild.id });
      }
    }
  },
};
