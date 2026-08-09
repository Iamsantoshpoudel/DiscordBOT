const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reload')
    .setDescription('Refresh the music playlist from Backblaze B2 storage'),

  async execute(interaction, manager) {
    await interaction.deferReply();
    const session = manager.getSession(interaction.guild.id);

    try {
      const count = await session.reloadPlaylist();
      return interaction.editReply(`🔄 Playlist reloaded — **${count}** track(s) loaded from B2.`);
    } catch (err) {
      console.error('[reload]', err);
      return interaction.editReply(`❌ Could not reload playlist: ${err.message}`);
    }
  },
};
