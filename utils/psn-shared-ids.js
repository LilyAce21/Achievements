"use strict";

// A small file of game -> NPWR ID pairs shared between this app and PlayniteAchievements, so an
// ID entered in one is found by the other. Both apps read and write the same JSON file:
//
//   %APPDATA%\PSN Platinum IDs\npwr-ids.json
//   { "version": 1, "games": { "steam:1678": { "name": "Celeste", "npwrIds": ["NPWR14979_00"], "updatedAt": 1760400000000 }, ... } }
//
// A game is found by its Steam App ID when it has one ("steam:<id>"), or by its name with case,
// punctuation and trademark signs ignored ("name:<letters and digits>"). Entries are written under
// both keys when both are known. Writes merge into what is on disk and replace the file
// atomically, so the two apps do not overwrite each other's games.

const fs = require("fs");
const path = require("path");

const FILE_NAME = "npwr-ids.json";
const FOLDER_NAME = "PSN Platinum IDs";
const NPWR_EXACT = /^NPWR\d{5,6}_00$/;

// This app adds " (Steam)" to the titles of Steam game configs. It must never reach the shared
// file, because PlayniteAchievements matches on the plain game name.
function stripSteamTag(name) {
  return String(name || "").replace(/\s*\(Steam\)/gi, "").trim();
}

function normalizeName(name) {
  // Trademark signs go first: normalising them would turn "™" into the letters "tm".
  return stripSteamTag(name)
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function keysFor({ steamAppId, name } = {}) {
  const keys = [];
  const appId = Number.parseInt(steamAppId, 10);
  if (Number.isInteger(appId) && appId > 0) keys.push(`steam:${appId}`);
  const normalized = normalizeName(name);
  if (normalized) keys.push(`name:${normalized}`);
  return keys;
}

function cleanIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  return [...new Set(list.map((id) => String(id || "").trim().toUpperCase()).filter((id) => NPWR_EXACT.test(id)))];
}

function createSharedIdStore({ dir, now = () => Date.now() }) {
  const filePath = path.join(dir, FILE_NAME);

  // The parsed file is reused while it has not changed on disk, so scanning every game for a
  // known ID does not read and parse the file once per game.
  let cached = null;
  let cachedStamp = "";

  function read() {
    try {
      const stat = fs.statSync(filePath);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (cached && stamp === cachedStamp) return cached;
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data && typeof data === "object" && data.games && typeof data.games === "object") {
        cached = data;
        cachedStamp = stamp;
        return data;
      }
    } catch {}
    return { version: 1, games: {} };
  }

  /** The NPWR IDs known for a game, or [] when none. Steam App ID wins over name. */
  function lookup(identity) {
    const games = read().games;
    for (const key of keysFor(identity)) {
      const ids = cleanIds(games[key]?.npwrIds);
      if (ids.length > 0) return ids;
    }
    return [];
  }

  /** Remembers a game's NPWR IDs under every key it has. Returns false when nothing was saved. */
  function remember({ steamAppId, name, npwrIds }) {
    const ids = cleanIds(npwrIds);
    const keys = keysFor({ steamAppId, name });
    if (ids.length === 0 || keys.length === 0) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const data = JSON.parse(JSON.stringify(read()));
      for (const key of keys) {
        data.games[key] = { name: stripSteamTag(name), npwrIds: ids, updatedAt: now() };
      }
      const temp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(data, null, 2));
      fs.renameSync(temp, filePath);
      cached = null;
      return true;
    } catch {
      return false;
    }
  }

  return { lookup, remember, filePath };
}

module.exports = { FILE_NAME, FOLDER_NAME, normalizeName, keysFor, createSharedIdStore };
