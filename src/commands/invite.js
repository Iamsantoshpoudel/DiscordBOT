const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getInviteUrl } = require('../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Get the bot invite link with the required server permissions'),

  async execute(interaction) {
    const url = getInviteUrl(interaction.client.user.id);

    const embed = new EmbedBuilder()
      .setTitle('🔗 Invite Dex Music Bot')
      .setDescription(
        'Use this link to add the bot to a server. Discord will ask you to **approve the required permissions** before adding it.'
      )
      .addFields(
        {
          name: 'Required permissions',
          value: [
            '✅ View Channels',
            '✅ Send Messages & Embed Links',
            '✅ Read Message History',
            '✅ Connect & Speak (voice)',
            '✅ Use Slash Commands (via OAuth scope)',
          ].join('\n'),
        },
        { name: 'Invite link', value: `[Click here to invite the bot](${url})` }
      )
      .setColor(0x57f287);

    const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

    return interaction.reply({
      embeds: [embed],
      ephemeral: !canManage,
    });
  },
};
