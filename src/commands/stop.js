const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and disconnect the bot from the voice channel'),

  async execute(interaction, manager) {
    const session = manager.getSession(interaction.guild.id);
    manager.clearJoinTimer(interaction.guild.id);

    if (!session.isConnected) {
      return interaction.reply({ content: 'I\'m not currently connected to a voice channel.', ephemeral: true });
    }

    session.disconnect();
    return interaction.reply('⏹️ Stopped playback and left the voice channel.');
  },
};
