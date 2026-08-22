'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { infoEmbed } = require('../utils/embeds');
const { escapeMarkdown } = require('../utils/sanitize');

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

module.exports = {
  requiresVoiceMembership: false,
  data: new SlashCommandBuilder().setName('status').setDescription('Show the current playback status.'),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction @param {import('../types').CommandContext} ctx */
  async execute(interaction, ctx) {
    const queue = ctx.queueManager.get(interaction.guild.id);

    if (!queue || !queue.connection) {
      await interaction.reply({ embeds: [infoEmbed('Status', 'The bot is not currently connected to the voice channel.')] });
      return;
    }

    const lines = [
      `**State:** ${queue.state}`,
      `**Volume:** ${Math.round(queue.volume * 100)}%`,
      `**Upcoming tracks:** ${queue.upcoming.length}`,
    ];

    if (queue.nowPlaying) {
      const elapsed = queue.startedAt ? formatDuration(Date.now() - queue.startedAt) : '0:00';
      lines.unshift(
        `**Now Playing:** ${escapeMarkdown(queue.nowPlaying.song.title)} — *${escapeMarkdown(queue.nowPlaying.song.artist)}* (${elapsed} elapsed)`,
      );
    } else {
      lines.unshift('**Now Playing:** Nothing');
    }

    await interaction.reply({ embeds: [infoEmbed('Playback Status', lines.join('\n'))] });
  },
};
