'use strict';

const { PermissionsBitField } = require('discord.js');
const config = require('../config/config');

/**
 * @typedef {Object} PermissionCheckResult
 * @property {boolean} allowed
 * @property {string} [reason] - Human-readable reason shown to the user when denied.
 */

/**
 * Verifies the invoking member is allowed to control the bot:
 *  1. If ALLOWED_ROLE_IDS is configured, the member must hold one of those roles.
 *  2. Otherwise, the member must currently be connected to the configured voice channel.
 * @param {import('discord.js').GuildMember} member
 * @returns {PermissionCheckResult}
 */
function checkMemberAuthorized(member) {
  if (!member) {
    return { allowed: false, reason: 'Could not resolve your guild membership.' };
  }

  const { allowedRoleIds, voiceChannelId } = config.discord;

  if (allowedRoleIds.length > 0) {
    const hasRole = member.roles.cache.some((role) => allowedRoleIds.includes(role.id));
    if (!hasRole) {
      return { allowed: false, reason: 'You do not have a role permitted to control the music bot.' };
    }
    return { allowed: true };
  }

  const memberVoiceChannelId = member.voice?.channelId;
  if (memberVoiceChannelId !== voiceChannelId) {
    return { allowed: false, reason: 'You must be in the music voice channel to use this command.' };
  }

  return { allowed: true };
}

/**
 * Verifies the bot itself has the Discord permissions it needs in the
 * configured voice channel before attempting to join/play.
 * @param {import('discord.js').Guild} guild
 * @returns {PermissionCheckResult}
 */
function checkBotVoicePermissions(guild) {
  const channel = guild.channels.cache.get(config.discord.voiceChannelId);
  if (!channel) {
    return { allowed: false, reason: 'The configured voice channel could not be found on this server.' };
  }

  const me = guild.members.me;
  if (!me) {
    return { allowed: false, reason: 'Could not resolve the bot member on this server.' };
  }

  const perms = channel.permissionsFor(me);
  const required = [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.ViewChannel];
  const missing = required.filter((flag) => !perms?.has(flag));

  if (missing.length > 0) {
    return { allowed: false, reason: 'The bot is missing Connect/Speak/View Channel permissions in the voice channel.' };
  }

  return { allowed: true };
}

module.exports = { checkMemberAuthorized, checkBotVoicePermissions };
