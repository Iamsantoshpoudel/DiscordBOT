'use strict';

const config = require('../config/config');

/**
 * In-memory cooldown tracker: Map<"guildId:userId:commandName", expiryTimestampMs>.
 * A single-process bot doesn't need a distributed store for this; if the bot
 * ever scales horizontally, swap this for a Redis-backed implementation
 * behind the same interface.
 */
class CooldownManager {
  constructor(defaultCooldownMs = config.playback.commandCooldownMs) {
    /** @type {Map<string, number>} */
    this.timestamps = new Map();
    this.defaultCooldownMs = defaultCooldownMs;

    // Periodic sweep so the map doesn't grow unbounded over a long-running process.
    this._sweepInterval = setInterval(() => this._sweep(), 10 * 60 * 1000).unref();
  }

  _key(guildId, userId, commandName) {
    return `${guildId}:${userId}:${commandName}`;
  }

  _sweep() {
    const now = Date.now();
    for (const [key, expiry] of this.timestamps) {
      if (expiry <= now) this.timestamps.delete(key);
    }
  }

  /**
   * Checks whether the user may run the command right now. If allowed, this
   * also starts the cooldown window. Also enforces a per-guild ceiling so a
   * coordinated group of users cannot hammer skip/play and exhaust API quotas.
   * @param {string} guildId
   * @param {string} userId
   * @param {string} commandName
   * @param {number} [cooldownMs]
   * @returns {{ allowed: true } | { allowed: false, retryAfterMs: number }}
   */
  consume(guildId, userId, commandName, cooldownMs = this.defaultCooldownMs) {
    const now = Date.now();

    const guildKey = `guild:${guildId}:${commandName}`;
    const guildExpiry = this.timestamps.get(guildKey);
    const guildCooldownMs = config.playback.guildCommandCooldownMs;
    if (guildExpiry && guildExpiry > now) {
      return { allowed: false, retryAfterMs: guildExpiry - now };
    }

    const key = this._key(guildId, userId, commandName);
    const expiry = this.timestamps.get(key);

    if (expiry && expiry > now) {
      return { allowed: false, retryAfterMs: expiry - now };
    }

    this.timestamps.set(key, now + cooldownMs);
    this.timestamps.set(guildKey, now + guildCooldownMs);
    return { allowed: true };
  }

  stop() {
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }
  }
}

module.exports = new CooldownManager();
