const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the playback volume')
    .addIntegerOption((opt) =>
      opt
        .setName('percent')
        .setDescription('Volume percent (0-200)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200)
    ),

  async execute(interaction, manager) {
    const percent = interaction.options.getInteger('percent', true);
    const session = manager.getSession(interaction.guild.id);
    session.setVolume(percent);
    return interaction.reply(`🔊 Volume set to **${percent}%**`);
  },
};
