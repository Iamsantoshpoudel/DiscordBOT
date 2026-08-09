const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function formatUptime(ms) {
  if (!ms) return '—';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track'),

  async execute(interaction, manager) {
    const session = manager.getSession(interaction.guild.id);
    const track = session.currentTrack;

    if (!track || (!session.isPlaying && !session.isPaused)) {
      return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle(session.isPaused ? '⏸️ Paused' : '🎶 Now Playing')
      .setDescription(`**${track.title}**`)
      .addFields(
        { name: 'Volume', value: `${session.volume}%`, inline: true },
        { name: 'Loop', value: session.loopMode, inline: true },
        { name: 'Elapsed', value: formatUptime(session.startedAt ? Date.now() - session.startedAt : 0), inline: true },
        {
          name: 'Position',
          value: `${session.currentIndex + 1} / ${session.playlist.length}`,
          inline: true,
        }
      )
      .setColor(session.isPaused ? 0xfee75c : 0x57f287);

    return interaction.reply({ embeds: [embed] });
  },
};
