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
        return interaction.editReply(`Already playing: **${track ? track.title : 'unknown'}**`);
      }

      const track = await session.playFromStart();
      return interaction.editReply(`🎶 Now playing: **${track.title}**`);
    } catch (err) {
      console.error('[play]', err);
      return interaction.editReply(`❌ Couldn't start playback: ${err.message}`);
    }
  },
};
