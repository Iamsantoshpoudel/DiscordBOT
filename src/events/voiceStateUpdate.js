'use strict';

const { Events } = require('discord.js');
const config = require('../config/config');
const logger = require('../utils/logger').child('events:voiceStateUpdate');

module.exports = {
  name: Events.VoiceStateUpdate,
  once: false,

  /**
   * @param {import('discord.js').VoiceState} oldState
   * @param {import('discord.js').VoiceState} newState
   * @param {import('../types').CommandContext} ctx
   */
  async execute(oldState, newState, ctx) {
    try {
      const guild = newState.guild ?? oldState.guild;
      const targetChannelId = config.discord.voiceChannelId;
      const wasInTarget = oldState.channelId === targetChannelId;
      const isInTarget = newState.channelId === targetChannelId;

      if (!wasInTarget && !isInTarget) return; // Irrelevant to the configured channel.

      const member = newState.member ?? oldState.member;
      const isBot = member?.user?.bot;

      if (!isBot) {
        const displayName = member?.displayName || member?.user?.username || 'Someone';
        if (!wasInTarget && isInTarget) {
          logger.info(
            'user_joined_voice',
            { guildId: guild.id, userId: member.id, channelId: targetChannelId },
            `👋 ${displayName} joined the voice channel`,
          );
        } else if (wasInTarget && !isInTarget) {
          logger.info(
            'user_left_voice',
            { guildId: guild.id, userId: member.id, channelId: targetChannelId },
            `🚪 ${displayName} left the voice channel`,
          );
        }
      }

      ctx.autoJoinLeaveManager.reconcile(guild);
    } catch (err) {
      logger.error('voice_state_update_handler_failed', err, {
        guildId: (newState.guild ?? oldState.guild)?.id,
      });
    }
  },
};
