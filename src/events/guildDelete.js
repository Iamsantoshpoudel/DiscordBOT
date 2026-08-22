'use strict';

const { Events } = require('discord.js');
const logger = require('../utils/logger').child('events:guildDelete');

module.exports = {
  name: Events.GuildDelete,
  once: false,

  /**
   * @param {import('discord.js').Guild} guild
   * @param {import('../types').CommandContext} ctx
   */
  async execute(guild, ctx) {
    try {
      logger.info('guild_removed', { guildId: guild.id });
      ctx.voiceManager.leave(guild.id, 'guild_delete');
      ctx.queueManager.delete(guild.id);
    } catch (err) {
      logger.error('guild_delete_cleanup_failed', err, { guildId: guild.id });
    }
  },
};
