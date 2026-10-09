"use strict";

// Tells PlayniteAchievements (the Playnite add-on) the moment an unlock is detected, so it can
// take its game-window screenshot then instead of whenever it notices the unlock itself.
//
// One short JSON line is written to a local named pipe. It is fire-and-forget: when the add-on
// is not running (the pipe does not exist) nothing happens, nothing is retried, and nothing is
// thrown, so this can never slow down or break a notification.

const net = require("net");

const DEFAULT_PIPE_PATH = "\\\\.\\pipe\\PlayniteAchievements.UnlockNotify.v1";
const PROTOCOL_VERSION = 1;
const MAX_TEXT_LENGTH = 300;

function clean(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

// The announcement for one unlock, or null when it has nothing to identify the achievement by.
function buildUnlockMessage(input = {}) {
  const name = clean(input.name);
  const apiName = clean(input.apiName);
  if (!name && !apiName) return null;
  return {
    v: PROTOCOL_VERSION,
    type: "unlock",
    sentAtUtc: new Date().toISOString(),
    game: {
      name: clean(input.configName),
      appid: clean(input.appid),
      platform: clean(input.platform),
    },
    achievement: {
      name,
      apiName,
      tier: clean(input.tier),
      isPlatinum: input.isPlatinum === true,
    },
  };
}

function createPlayniteBridge(options = {}) {
  const pipePath = options.pipePath || DEFAULT_PIPE_PATH;
  const platform = options.platform || process.platform;
  const connectTimeoutMs = options.connectTimeoutMs || 1000;
  const dedupeMs = options.dedupeMs === undefined ? 60_000 : options.dedupeMs;
  const now = options.now || (() => Date.now());
  const logger = options.logger || null;
  // The default pipe only exists on Windows; a custom path (used by tests) is always tried.
  const enabled = options.pipePath ? true : platform === "win32";

  const recent = new Map();
  let lastFailureLogAt = 0;
  const stats = { sent: 0, skippedDuplicate: 0, failed: 0 };

  function isDuplicate(message) {
    const key = [
      message.game.name.toLowerCase(),
      message.game.appid,
      (message.achievement.name || message.achievement.apiName).toLowerCase(),
    ].join("|");
    const at = now();
    for (const [k, t] of recent) {
      if (at - t > dedupeMs) recent.delete(k);
    }
    if (recent.has(key)) return true;
    recent.set(key, at);
    while (recent.size > 100) recent.delete(recent.keys().next().value);
    return false;
  }

  function noteFailure(error) {
    stats.failed += 1;
    const at = now();
    // "Not running" is the normal case, so it is only mentioned now and then.
    if (logger && at - lastFailureLogAt > 10 * 60_000) {
      lastFailureLogAt = at;
      try {
        logger.info("playnite-bridge:not-delivered", {
          reason: error && (error.code || error.message) ? error.code || error.message : "unknown",
        });
      } catch {}
    }
  }

  // Resolves true when the line was handed to the pipe, false otherwise. Never rejects.
  function notifyUnlock(message) {
    if (!enabled || !message || !message.game || !message.achievement) {
      return Promise.resolve(false);
    }
    if (isDuplicate(message)) {
      stats.skippedDuplicate += 1;
      return Promise.resolve(false);
    }
    let line;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let settled = false;
      let written = false;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        if (ok) stats.sent += 1;
        else noteFailure(error);
        resolve(ok);
      };
      let socket;
      try {
        socket = net.createConnection({ path: pipePath });
      } catch (error) {
        finish(false, error);
        return;
      }
      socket.setTimeout(connectTimeoutMs);
      // Protocol: write the line, then stay connected until the add-on closes its end (it does
      // that right after reading the line). Closing first can make a pipe server miss the
      // message when several arrive together.
      socket.on("connect", () => {
        socket.write(line, "utf8", () => {
          written = true;
        });
      });
      socket.on("error", (error) => {
        try {
          socket.destroy();
        } catch {}
        finish(written, error);
      });
      socket.on("timeout", () => {
        try {
          socket.destroy();
        } catch {}
        // Written but never acknowledged: most likely delivered, so it counts as sent.
        finish(written, new Error("timeout"));
      });
      socket.on("end", () => {
        try {
          socket.end();
        } catch {}
      });
      socket.on("close", () => finish(written, new Error("closed-before-write")));
    });
  }

  return { notifyUnlock, stats: () => ({ ...stats }), isEnabled: () => enabled };
}

module.exports = {
  DEFAULT_PIPE_PATH,
  PROTOCOL_VERSION,
  buildUnlockMessage,
  createPlayniteBridge,
};
