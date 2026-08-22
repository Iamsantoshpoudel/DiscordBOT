'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../utils/embeds');

module.exports = {
  requiresVoiceMembership: true,
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current track.'),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction @param {import('../types').CommandContext} ctx */
  async execute(interaction, ctx) {
    const queue = ctx.queueManager.get(interaction.guild.id);

    if (!queue?.nowPlaying) {
      await interaction.reply({ embeds: [errorEmbed('Nothing playing', 'There is no active track to pause.')], ephemeral: true });
      return;
    }

    if (queue.state === 'paused') {
      await interaction.reply({ embeds: [errorEmbed('Already paused', 'Playback is already paused.')], ephemeral: true });
      return;
    }

    const ok = ctx.playbackService.pause(interaction.guild.id);
    await interaction.reply({
      embeds: ok
        ? [successEmbed('Paused', `**${queue.nowPlaying.song.title}** is paused.`)]
        : [errorEmbed('Could not pause', 'Something went wrong pausing playback.')],
    });
  },
};
