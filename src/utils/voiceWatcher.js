const config = require('../config');
const { getMissingPermissions, formatMissingPermissions } = require('./permissions');

function nonBotMemberCount(channel) {
  if (!channel) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

function isAllowedTextChannel(channelId) {
  if (!config.botTextChannelId) return true;
  return channelId === config.botTextChannelId;
}

/**
 * Starts (or keeps) the auto-join countdown when at least one non-bot user
 * is in the watched voice channel and the bot is not connected yet.
 */
function scheduleAutoJoin(guild, manager) {
  const watchedChannelId = config.musicVoiceChannelId;
  const session = manager.getSession(guild.id);

  if (session.isConnected || manager.hasJoinTimer(guild.id)) return;

  console.log(
    `[voice] User(s) in ${watchedChannelId} (guild ${guild.id}). Waiting ${config.autoJoinDelayMs / 1000}s before auto-join...`
  );

  const timeout = setTimeout(async () => {
    manager.clearJoinTimer(guild.id);
    try {
      const channel = await guild.channels.fetch(watchedChannelId);
      if (nonBotMemberCount(channel) === 0) {
        console.log(`[voice] Channel empty before delay elapsed, skipping auto-join for guild ${guild.id}.`);
        return;
      }
      if (session.isConnected) return;

      const voiceMissing = getMissingPermissions(guild, channel);
      if (voiceMissing.length > 0) {
        console.warn(`[voice] Auto-join skipped — missing permissions in guild ${guild.id}: ${voiceMissing.join(', ')}`);
        if (session.textChannel) {
          session.textChannel.send(formatMissingPermissions(voiceMissing)).catch(() => {});
        }
        return;
      }

      await session.connect(channel);
      const track = await session.playFromStart();
      console.log(`[voice] Auto-joined and started playback in guild ${guild.id}: ${track.title}`);
    } catch (err) {
      console.error(`[voice] Auto-join failed for guild ${guild.id}:`, err.message);
    }
  }, config.autoJoinDelayMs);

  manager.setJoinTimer(guild.id, timeout);
}

/**
 * Cancels pending join and disconnects when the watched channel has no users left.
 */
async function handleChannelMaybeEmpty(guild, manager) {
  const watchedChannelId = config.musicVoiceChannelId;
  const session = manager.getSession(guild.id);

  let channel;
  try {
    channel = await guild.channels.fetch(watchedChannelId);
  } catch {
    channel = null;
  }

  if (nonBotMemberCount(channel) > 0) return;

  manager.clearJoinTimer(guild.id);

  if (session.isConnected) {
    console.log(`[voice] Channel empty in guild ${guild.id}, disconnecting.`);
    session.disconnect();
  }
}

/**
 * On startup, join the countdown if users are already waiting in the channel.
 */
async function checkExistingVoiceOccupants(client, manager) {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(config.musicVoiceChannelId);
    if (nonBotMemberCount(channel) > 0) {
      scheduleAutoJoin(guild, manager);
    }
  } catch (err) {
    console.warn('[voice] Could not check voice channel on startup:', err.message);
  }
}

module.exports = {
  nonBotMemberCount,
  isAllowedTextChannel,
  scheduleAutoJoin,
  handleChannelMaybeEmpty,
  checkExistingVoiceOccupants,
};
