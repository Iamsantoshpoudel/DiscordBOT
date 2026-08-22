'use strict';

const { SlashCommandBuilder } = require('discord.js');
const supabaseService = require('../services/supabaseService');
const { sanitizeSearchQuery } = require('../utils/sanitize');
const { successEmbed, errorEmbed } = require('../utils/embeds');

module.exports = {
  requiresVoiceMembership: true,
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Start playback, or queue a specific song to play next.')
    .addStringOption((opt) =>
      opt.setName('song').setDescription('Title or artist to search for (optional)').setRequired(false).setMaxLength(100),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction @param {import('../types').CommandContext} ctx */
  async execute(interaction, ctx) {
    const { guild, member } = interaction;
    const rawQuery = interaction.options.getString('song');

    await interaction.deferReply();

    if (rawQuery) {
      const query = sanitizeSearchQuery(rawQuery);
      const results = await supabaseService.searchSongs(query);

      if (results.length === 0) {
        await interaction.editReply({ embeds: [errorEmbed('No matches found', `Nothing in the library matches "${query}".`)] });
        return;
      }

      const song = results[0];
      const queue = ctx.queueManager.getOrCreate(guild.id);
      queue.playNext(song, member.id);

      await ctx.playbackService.start(guild);

      await interaction.editReply({
        embeds: [successEmbed('Queued', `**${song.title}** by *${song.artist}* will play next.`)],
      });
      return;
    }

    await ctx.playbackService.start(guild);
    const queue = ctx.queueManager.get(guild.id);

    if (queue?.nowPlaying) {
      await interaction.editReply({
        embeds: [successEmbed('Now Playing', `**${queue.nowPlaying.song.title}** by *${queue.nowPlaying.song.artist}*`)],
      });
    } else {
      await interaction.editReply({ embeds: [errorEmbed('Nothing to play', 'The music library appears to be empty.')] });
    }
  },
};
