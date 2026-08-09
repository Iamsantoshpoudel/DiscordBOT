const config = require('../config');
const { scheduleAutoJoin, handleChannelMaybeEmpty } = require('../utils/voiceWatcher');

module.exports = (client, manager) => {
  client.on('voiceStateUpdate', async (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const watchedChannelId = config.musicVoiceChannelId;
    const joinedWatched = newState.channelId === watchedChannelId && oldState.channelId !== watchedChannelId;
    const leftWatched = oldState.channelId === watchedChannelId && newState.channelId !== watchedChannelId;
    const movedWithinWatched =
      oldState.channelId === watchedChannelId && newState.channelId === watchedChannelId;

    if (!joinedWatched && !leftWatched && !movedWithinWatched) return;

    const member = newState.member || oldState.member;
    if (member?.user?.bot) return;

    if (joinedWatched) {
      scheduleAutoJoin(guild, manager);
      return;
    }

    if (leftWatched || movedWithinWatched) {
      await handleChannelMaybeEmpty(guild, manager);
    }
  });
};
