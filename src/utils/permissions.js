const { PermissionFlagsBits } = require('discord.js');
const config = require('../config');

const REQUIRED_GUILD_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];

const PERMISSION_LABELS = {
  [PermissionFlagsBits.ViewChannel.toString()]: 'View Channels',
  [PermissionFlagsBits.SendMessages.toString()]: 'Send Messages',
  [PermissionFlagsBits.EmbedLinks.toString()]: 'Embed Links',
  [PermissionFlagsBits.ReadMessageHistory.toString()]: 'Read Message History',
  [PermissionFlagsBits.Connect.toString()]: 'Connect (voice)',
  [PermissionFlagsBits.Speak.toString()]: 'Speak (voice)',
};

function getInviteUrl(clientId = config.clientId) {
  const permissions = REQUIRED_GUILD_PERMISSIONS.reduce((acc, bit) => acc | bit, 0n);
  const params = new URLSearchParams({
    client_id: clientId,
    permissions: permissions.toString(),
    scope: 'bot applications.commands',
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

function getMissingPermissions(guild, channel = null) {
  const me = guild.members.me;
  if (!me) return ['Bot is not ready in this server yet. Try again in a moment.'];

  const perms = channel ? channel.permissionsFor(me) : me.permissions;
  if (!perms) return ['Could not read bot permissions.'];

  return REQUIRED_GUILD_PERMISSIONS
    .filter((bit) => !perms.has(bit))
    .map((bit) => PERMISSION_LABELS[bit.toString()] || bit.toString());
}

function formatMissingPermissions(missing) {
  return `I'm missing these server permissions: **${missing.join(', ')}**.\nAn admin can re-invite me with the correct permissions using \`/invite\`.`;
}

module.exports = {
  REQUIRED_GUILD_PERMISSIONS,
  getInviteUrl,
  getMissingPermissions,
  formatMissingPermissions,
};
