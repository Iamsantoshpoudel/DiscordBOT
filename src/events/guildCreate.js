const { getInviteUrl, getMissingPermissions, formatMissingPermissions } = require('../utils/permissions');
const config = require('../config');

async function ensureGuildPermissions(guild, log = console.log) {
  const missing = getMissingPermissions(guild);
  if (missing.length === 0) return true;

  log(`[permissions] Missing in guild ${guild.name} (${guild.id}): ${missing.join(', ')}`);
  log(`[permissions] Re-invite URL: ${getInviteUrl(config.clientId)}`);

  try {
    const owner = await guild.fetchOwner();
    await owner.send({
      content: [
        `👋 **${guild.client.user.username}** was added to **${guild.name}**, but I'm missing permissions:`,
        formatMissingPermissions(missing),
        '\n**Fix:** Re-invite with this link (Discord will ask you to approve permissions first):',
        getInviteUrl(config.clientId),
      ].join('\n'),
    }).catch(() => {});
  } catch {
    // cannot DM owner
  }

  return false;
}

module.exports = (client) => {
  client.on('guildCreate', async (guild) => {
    await ensureGuildPermissions(guild);
  });
};

module.exports.ensureGuildPermissions = ensureGuildPermissions;
