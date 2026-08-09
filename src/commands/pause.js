const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause playback'),

  async execute(interaction, manager) {
    const session = manager.getSession(interaction.guild.id);
    if (!session.isPlaying) {
      return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
    }
    session.pause();
    return interaction.reply('⏸️ Paused.');
  },
};
