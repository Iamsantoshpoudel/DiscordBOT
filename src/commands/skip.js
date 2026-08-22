'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../utils/embeds');
const { escapeMarkdown } = require('../utils/sanitize');

module.exports = {
  requiresVoiceMembership: true,
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track.'),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction @param {import('../types').CommandContext} ctx */
  async execute(interaction, ctx) {
    const queue = ctx.queueManager.get(interaction.guild.id);

    if (!queue?.nowPlaying) {
      await interaction.reply({ embeds: [errorEmbed('Nothing to skip', 'There is no active track.')], ephemeral: true });
      return;
    }

    const skippedTitle = queue.nowPlaying.song.title;
    const ok = ctx.playbackService.skip(interaction.guild);

    await interaction.reply({
      embeds: ok
        ? [successEmbed('Skipped', `Skipped **${escapeMarkdown(skippedTitle)}**.`)]
        : [errorEmbed('Could not skip', 'Something went wrong skipping the track.')],
    });
  },
};
