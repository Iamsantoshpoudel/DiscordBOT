'use strict';

const { Events, MessageFlags } = require('discord.js');
const cooldownManager = require('../utils/cooldown');
const { checkMemberAuthorized, checkBotVoicePermissions } = require('../utils/permissions');
const { errorEmbed } = require('../utils/embeds');
const logger = require('../utils/logger').child('events:interactionCreate');

module.exports = {
  name: Events.InteractionCreate,
  once: false,

  /** @param {import('discord.js').Interaction} interaction @param {import('../types').CommandContext} ctx */
  async execute(interaction, ctx) {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) {
      await safeReply(interaction, { embeds: [errorEmbed('Guild only', 'This bot only works inside a server.')] });
      return;
    }

    const command = ctx.commands.get(interaction.commandName);
    const log = {
      commandName: interaction.commandName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      channelId: interaction.channelId,
    };

    if (!command) {
      logger.warn('unknown_command_invoked', log);
      await safeReply(interaction, { embeds: [errorEmbed('Unknown command', 'This command is not currently available.')] });
      return;
    }

    // --- Cooldown check -----------------------------------------------
    const cooldown = cooldownManager.consume(interaction.guildId, interaction.user.id, interaction.commandName);
    if (!cooldown.allowed) {
      const seconds = Math.ceil(cooldown.retryAfterMs / 1000);
      await safeReply(interaction, {
        embeds: [errorEmbed('Slow down', `Please wait ${seconds}s before using \`/${interaction.commandName}\` again.`)],
        ephemeral: true,
      });
      return;
    }

    // --- Permission checks ----------------------------------------------
    if (command.requiresVoiceMembership) {
      const memberCheck = checkMemberAuthorized(interaction.member);
      if (!memberCheck.allowed) {
        logger.warn('command_denied_permissions', { ...log, reason: memberCheck.reason });
        await safeReply(interaction, { embeds: [errorEmbed('Permission denied', memberCheck.reason)], ephemeral: true });
        return;
      }

      const botCheck = checkBotVoicePermissions(interaction.guild);
      if (!botCheck.allowed) {
        logger.warn('command_denied_bot_permissions', { ...log, reason: botCheck.reason });
        await safeReply(interaction, { embeds: [errorEmbed('Bot misconfigured', botCheck.reason)], ephemeral: true });
        return;
      }
    }

    // --- Execute with an isolated try/catch so one bad command can never
    // crash the process or affect other guilds/interactions. -------------
    logger.info('command_invoked', log);
    const startedAt = Date.now();

    try {
      await command.execute(interaction, ctx);
      logger.info('command_completed', { ...log, durationMs: Date.now() - startedAt });
    } catch (err) {
      logger.error('command_failed', err, { ...log, durationMs: Date.now() - startedAt });
      await safeReply(interaction, {
        embeds: [errorEmbed('Something went wrong', 'An unexpected error occurred while running that command. It has been logged.')],
        ephemeral: true,
      });
    }
  },
};

/**
 * Replies or edits/follows-up appropriately depending on interaction
 * state, swallowing any secondary failure (e.g. interaction already
 * expired) so error-reporting itself never throws.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').InteractionReplyOptions} payload
 */
async function safeReply(interaction, payload) {
  const options = { ...payload, flags: payload.ephemeral ? MessageFlags.Ephemeral : undefined };
  delete options.ephemeral;

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(options);
    } else {
      await interaction.reply(options);
    }
  } catch (err) {
    logger.error('safe_reply_failed', err, { commandName: interaction.commandName, guildId: interaction.guildId });
  }
}
