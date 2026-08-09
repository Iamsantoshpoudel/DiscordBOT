const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current playlist and what\'s up next'),

  async execute(interaction, manager) {
    const session = manager.getSession(interaction.guild.id);
    await session.ensurePlaylist();

    if (session.playlist.length === 0) {
      return interaction.reply({ content: 'No tracks found in the configured B2 bucket/prefix.', ephemeral: true });
    }

    const current = session.currentIndex;
    const total = session.playlist.length;
    const upcomingCount = 10;

    const lines = [];
    for (let i = 0; i < Math.min(total, upcomingCount); i++) {
      const idx = current === -1 ? i : (current + i) % total;
      const track = session.playlist[idx];
      const marker = idx === current ? '▶️' : `${i + 1}.`;
      lines.push(`${marker} ${track.title}`);
    }

    const embed = new EmbedBuilder()
      .setTitle('🎵 Playlist')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${total} track(s) total • Loop: ${session.loopMode}` })
      .setColor(0x5865f2);

    return interaction.reply({ embeds: [embed] });
  },
};
