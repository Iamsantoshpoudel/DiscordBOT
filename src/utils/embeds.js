'use strict';

const { EmbedBuilder } = require('discord.js');

const COLORS = {
  success: 0x57f287,
  error: 0xed4245,
  info: 0x5865f2,
};

function successEmbed(title, description) {
  return new EmbedBuilder().setColor(COLORS.success).setTitle(title).setDescription(description ?? null);
}

function errorEmbed(title, description) {
  return new EmbedBuilder().setColor(COLORS.error).setTitle(title).setDescription(description ?? null);
}

function infoEmbed(title, description) {
  return new EmbedBuilder().setColor(COLORS.info).setTitle(title).setDescription(description ?? null);
}

module.exports = { successEmbed, errorEmbed, infoEmbed };
