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
    .setName('status')
    .setDescription('Show the bot\'s current playback status'),

  async execute(interaction, manager) {
    const session = manager.getSession(interaction.guild.id);
    const track = session.currentTrack;

    let state = 'Idle / not connected';
    if (session.isConnected) {
      if (session.isPlaying) state = 'Playing';
      else if (session.isPaused) state = 'Paused';
      else state = 'Connected, idle';
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 Bot Status')
      .addFields(
        { name: 'State', value: state, inline: true },
        { name: 'Now Playing', value: track ? track.title : '—', inline: true },
        { name: 'Volume', value: `${session.volume}%`, inline: true },
        { name: 'Loop Mode', value: session.loopMode, inline: true },
        { name: 'Shuffle', value: session.shuffleEnabled ? 'on' : 'off', inline: true },
        { name: 'Playing For', value: formatUptime(session.startedAt ? Date.now() - session.startedAt : 0), inline: true },
        { name: 'Tracks Loaded', value: `${session.playlist.length}`, inline: true }
      )
      .setColor(0x57f287);

    return interaction.reply({ embeds: [embed] });
  },
};
