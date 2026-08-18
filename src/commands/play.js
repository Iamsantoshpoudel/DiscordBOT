const { SlashCommandBuilder, ChannelType } = require('discord.js');
const config = require('../config');
const { getMissingPermissions, formatMissingPermissions } = require('../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Join the music channel and start/resume the playlist'),

  async execute(interaction, manager) {
    const voiceChannel = interaction.guild.channels.cache.get(config.musicVoiceChannelId);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      return interaction.reply({ content: 'The configured music voice channel could not be found.', ephemeral: true });
    }

    const voiceMissing = getMissingPermissions(interaction.guild, voiceChannel);
    if (voiceMissing.length > 0) {
      return interaction.reply({ content: formatMissingPermissions(voiceMissing), ephemeral: true });
    }

    await interaction.deferReply();
    const session = manager.getSession(interaction.guild.id);
    session.textChannel = interaction.channel;

    try {
      if (!session.isConnected) {
        await session.connect(voiceChannel);
      }

      if (session.isPaused) {
        session.resume();
        return interaction.editReply('▶️ Resumed playback.');
      }

      if (session.isPlaying) {
        const track = session.currentTrack;
        return interaction.editReply({
          content: `Already playing: **${track ? track.title : 'unknown'}**`,
          allowedMentions: { parse: [] }, // titles come from filenames in B2; never let them ping anyone
        });
      }

      const track = await session.playFromStart();
      return interaction.editReply({
        content: `🎶 Now playing: **${track.title}**`,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('[play]', err.message);
      return interaction.editReply({
        content: `❌ Couldn't start playback: ${err.message}`,
        allowedMentions: { parse: [] },
      });
    }
  },
};
