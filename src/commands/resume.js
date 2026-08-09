const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume playback'),

  async execute(interaction, manager) {
    const session = manager.getSession(interaction.guild.id);
    if (!session.isPaused) {
      return interaction.reply({ content: 'Playback is not paused.', ephemeral: true });
    }
    session.resume();
    return interaction.reply('▶️ Resumed.');
  },
};
