const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip to the next track'),

  async execute(interaction, manager) {
    const session = manager.getSession(interaction.guild.id);

    if (!session.isConnected || (!session.isPlaying && !session.isPaused)) {
      return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
    }

    session.skip();
    // Small delay so currentTrack reflects the new track after the player transitions.
    setTimeout(async () => {
      const track = session.currentTrack;
      try {
        await interaction.followUp(track ? `⏭️ Skipped. Now playing: **${track.title}**` : '⏭️ Skipped.');
      } catch (e) {
        // interaction may have expired, ignore
      }
    }, 700);

    return interaction.reply('⏭️ Skipping...');
  },
};
