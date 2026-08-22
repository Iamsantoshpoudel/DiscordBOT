'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { sanitizeVolumePercent } = require('../utils/sanitize');
const { successEmbed, errorEmbed } = require('../utils/embeds');

module.exports = {
  requiresVoiceMembership: true,
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the playback volume.')
    .addIntegerOption((opt) =>
      opt.setName('percent').setDescription('Volume from 0 to 100').setRequired(true).setMinValue(0).setMaxValue(100),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction @param {import('../types').CommandContext} ctx */
  async execute(interaction, ctx) {
    const queue = ctx.queueManager.get(interaction.guild.id);
    if (!queue?.connection) {
      await interaction.reply({ embeds: [errorEmbed('Not connected', 'The bot is not currently in the voice channel.')], ephemeral: true });
      return;
    }

    const rawPercent = interaction.options.getInteger('percent', true);
    const volume = sanitizeVolumePercent(rawPercent);

    if (volume === null) {
      await interaction.reply({ embeds: [errorEmbed('Invalid volume', 'Volume must be a number between 0 and 100.')], ephemeral: true });
      return;
    }

    ctx.playbackService.setVolume(interaction.guild.id, volume);
    await interaction.reply({ embeds: [successEmbed('Volume updated', `Volume set to **${Math.round(volume * 100)}%**.`)] });
  },
};
