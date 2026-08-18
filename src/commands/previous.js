const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('previous')
    .setDescription('Go back to the previous track'),

  async execute(interaction, manager) {
    const session = manager.getSession(interaction.guild.id);

    if (!session.isConnected || (!session.isPlaying && !session.isPaused)) {
      return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
    }

    const track = await session.previous();
    if (!track) {
      return interaction.reply({ content: 'No previous track in history.', ephemeral: true });
    }

    return interaction.reply({ content: `⏮️ Now playing: **${track.title}**`, allowedMentions: { parse: [] } });
  },
};
