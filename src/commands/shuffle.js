'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../utils/embeds');

module.exports = {
  requiresVoiceMembership: true,
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Reshuffle the upcoming queue.'),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction @param {import('../types').CommandContext} ctx */
  async execute(interaction, ctx) {
    const queue = ctx.queueManager.get(interaction.guild.id);

    if (!queue || queue.upcoming.length < 2) {
      await interaction.reply({
        embeds: [errorEmbed('Nothing to shuffle', 'There need to be at least 2 upcoming tracks to reshuffle.')],
        ephemeral: true,
      });
      return;
    }

    ctx.playbackService.reshuffle(interaction.guild);
    await interaction.reply({
      embeds: [successEmbed('Shuffled', `Reshuffled ${queue.upcoming.length} upcoming tracks. Playback is always shuffled with no immediate repeats.`)],
    });
  },
};
