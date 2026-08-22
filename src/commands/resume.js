'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../utils/embeds');
const { escapeMarkdown } = require('../utils/sanitize');

module.exports = {
  requiresVoiceMembership: true,
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback if paused.'),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction @param {import('../types').CommandContext} ctx */
  async execute(interaction, ctx) {
    const queue = ctx.queueManager.get(interaction.guild.id);

    if (!queue?.nowPlaying) {
      await interaction.reply({ embeds: [errorEmbed('Nothing to resume', 'There is no active track.')], ephemeral: true });
      return;
    }

    if (queue.state !== 'paused') {
      await interaction.reply({ embeds: [errorEmbed('Not paused', 'Playback is not currently paused.')], ephemeral: true });
      return;
    }

    const ok = ctx.playbackService.resume(interaction.guild.id);
    await interaction.reply({
      embeds: ok
        ? [successEmbed('Resumed', `**${escapeMarkdown(queue.nowPlaying.song.title)}** is playing again.`)]
        : [errorEmbed('Could not resume', 'Something went wrong resuming playback.')],
    });
  },
};
