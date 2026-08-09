const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Turn playlist shuffle on or off')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Shuffle mode')
        .setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' }
        )
    ),

  async execute(interaction, manager) {
    const mode = interaction.options.getString('mode', true);
    const session = manager.getSession(interaction.guild.id);
    const enabled = mode === 'on';

    await session.setShuffle(enabled);

    return interaction.reply(
      enabled
        ? '🔀 Shuffle **enabled** — playlist order randomized.'
        : '🔀 Shuffle **disabled** — playlist in alphabetical order.'
    );
  },
};
