'use strict';

const { Events, ActivityType } = require('discord.js');
const logger = require('../utils/logger').child('events:ready');

module.exports = {
  name: Events.ClientReady,
  once: true,

  /** @param {import('discord.js').Client} client @param {import('../types').CommandContext} ctx */
  async execute(client, ctx) {
    logger.info('bot_ready', { tag: client.user.tag, guildCount: client.guilds.cache.size });

    try {
      client.user.setPresence({
        activities: [{ name: '/status | streaming from Supabase', type: ActivityType.Listening }],
        status: 'online',
      });
    } catch (err) {
      logger.warn('presence_update_failed', { error: err.message });
    }

    // Reconcile auto-join/auto-leave state for every guild in case humans
    // are already sitting in the voice channel when the bot (re)starts.
    for (const guild of client.guilds.cache.values()) {
      try {
        await guild.members.fetch({ withPresences: false }).catch(() => {});
        ctx.autoJoinLeaveManager.reconcile(guild);
      } catch (err) {
        logger.error('startup_reconcile_failed', err, { guildId: guild.id });
      }
    }
  },
};
