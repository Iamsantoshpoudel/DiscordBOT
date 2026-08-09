const config = require('../config');
const { isAllowedTextChannel } = require('../utils/voiceWatcher');
const { getMissingPermissions, formatMissingPermissions } = require('../utils/permissions');

module.exports = (client, commands, manager) => {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) return;

    if (!isAllowedTextChannel(interaction.channelId)) {
      return interaction.reply({
        content: 'Commands are only allowed in the configured bot text channel.',
        ephemeral: true,
      });
    }

    const guildMissing = getMissingPermissions(interaction.guild);
    if (guildMissing.length > 0 && interaction.commandName !== 'invite') {
      return interaction.reply({
        content: formatMissingPermissions(guildMissing),
        ephemeral: true,
      });
    }

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, manager);
    } catch (err) {
      console.error(`[command:${interaction.commandName}]`, err);
      const payload = { content: '❌ Something went wrong running that command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });
};
