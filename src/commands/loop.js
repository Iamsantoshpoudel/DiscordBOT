const { SlashCommandBuilder } = require('discord.js');
const { LOOP_MODES } = require('../utils/musicPlayer');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set the loop/repeat mode')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'off', value: LOOP_MODES.OFF },
          { name: 'track (repeat current song)', value: LOOP_MODES.TRACK },
          { name: 'queue (repeat whole playlist)', value: LOOP_MODES.QUEUE }
        )
    ),

  async execute(interaction, manager) {
    const mode = interaction.options.getString('mode', true);
    const session = manager.getSession(interaction.guild.id);
    session.setLoopMode(mode);
    return interaction.reply(`🔁 Loop mode set to **${mode}**`);
  },
};
