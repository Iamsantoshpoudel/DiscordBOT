const { SlashCommandBuilder } = require('discord.js');
const { buildHelpEmbed } = require('../utils/helpContent');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show how to use the music bot and list all commands'),

  async execute(interaction) {
    return interaction.reply({ embeds: [buildHelpEmbed()] });
  },
};
