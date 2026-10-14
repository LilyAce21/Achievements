"use strict";

// Base-game achievement scope for the PSN Platinum, ported from PlayniteAchievements.
//
// A PlayStation Platinum counts the base game only, never DLC. For Steam games SteamHunters
// groups every achievement; the groups that carry a DlcAppId belong to a separate DLC product.
// Everything else (the base game, its post-launch updates, base-game Multiplayer) is base game.
// This only reads SteamHunters' public group list: once per game, then again only when the game
// gains an achievement the saved list has never seen.
// steamhunters.com rejects Node's own HTTP fingerprint, so the caller supplies a fetchText that
// goes through Electron's browser layer.

const fs = require("fs");
const path = require("path");

const BASE_URL = "https://steamhunters.com/api/GetAchievementGroups/v1";
const MIN_REFETCH_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;

function buildGroupsUrl(appId) {
  const id = Number.parseInt(appId, 10);
  if (!Number.isInteger(id) || id <= 0) return "";
  return `${BASE_URL}?appId=${id}&includeMultiplayerGroup=true`;
}

/**
 * Splits a GetAchievementGroups response into the api names that are DLC and every api name it
 * lists at all. Null when the response is not usable, which callers treat as "no category data".
 */
function parseGroups(body) {
  let data = body;
  if (typeof body === "string") {
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!data || !Array.isArray(data.groups)) return null;
  const dlc = new Set();
  const known = new Set();
  for (const group of data.groups) {
    const names = Array.isArray(group?.achievementApiNames) ? group.achievementApiNames : [];
    const dlcAppId = Number(group?.dlcAppId);
    const isDlc = Number.isFinite(dlcAppId) && dlcAppId > 0;
    for (const name of names) {
      if (typeof name !== "string" || !name) continue;
      known.add(name);
      if (isDlc) dlc.add(name);
    }
  }
  return { dlc, known };
}

function parseDlcApiNames(body) {
  return parseGroups(body)?.dlc ?? null;
}

function cachePath(dir, appId) {
  return path.join(dir, `steamhunters-groups-${Number.parseInt(appId, 10)}.json`);
}

function failurePathFor(dir, appId) {
  return path.join(dir, `steamhunters-groups-${Number.parseInt(appId, 10)}.failed`);
}

function readCache(dir, appId) {
  try {
    const entry = JSON.parse(fs.readFileSync(cachePath(dir, appId), "utf8"));
    if (!Array.isArray(entry.dlcApiNames) || !Array.isArray(entry.knownApiNames)) return null;
    return {
      fetchedAt: Number(entry.fetchedAt) || 0,
      dlc: new Set(entry.dlcApiNames),
      known: new Set(entry.knownApiNames),
      unresolved: new Set(Array.isArray(entry.unresolvedNames) ? entry.unresolvedNames : []),
    };
  } catch {
    return null;
  }
}

/**
 * The set of non-base-game api names for a Steam app, or null when SteamHunters has nothing
 * usable (the caller then treats every achievement as base game).
 *
 * The group list is kept for good, because a game's DLC split does not change on its own. It is
 * fetched again only when `currentNames` (the achievements the game has now) holds a name the
 * saved list has never seen, which is what new DLC or a new update looks like. A name
 * SteamHunters still does not list after that fetch is remembered, so it does not trigger a
 * fetch on every unlock. Refetches are at least an hour apart, and a failed fetch is not retried
 * for a day. If a refetch fails, the saved list keeps being used.
 */
async function getDlcApiNames({ appId, cacheDir, fetchText, currentNames = [], now = Date.now() }) {
  const url = buildGroupsUrl(appId);
  if (!url) return null;

  const cached = readCache(cacheDir, appId);
  const names = (currentNames || []).filter((name) => typeof name === "string" && name);
  const unseen = cached
    ? names.filter((name) => !cached.known.has(name) && !cached.unresolved.has(name))
    : [];
  if (cached && unseen.length === 0) return cached.dlc;
  if (cached && now - cached.fetchedAt < MIN_REFETCH_MS) return cached.dlc;

  const failurePath = failurePathFor(cacheDir, appId);
  try {
    if (now - fs.statSync(failurePath).mtimeMs < FAILURE_BACKOFF_MS) return cached ? cached.dlc : null;
  } catch {}

  let parsed = null;
  try {
    parsed = parseGroups(await fetchText(url));
  } catch {
    parsed = null;
  }

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    if (parsed) {
      const unresolved = new Set(cached?.unresolved || []);
      for (const name of names) {
        if (!parsed.known.has(name)) unresolved.add(name);
      }
      fs.writeFileSync(
        cachePath(cacheDir, appId),
        JSON.stringify({
          fetchedAt: now,
          dlcApiNames: [...parsed.dlc],
          knownApiNames: [...parsed.known],
          unresolvedNames: [...unresolved],
        }),
      );
      try {
        fs.unlinkSync(failurePath);
      } catch {}
    } else {
      fs.writeFileSync(failurePath, String(now));
    }
  } catch {}

  if (parsed) return parsed.dlc;
  return cached ? cached.dlc : null;
}

/**
 * Whether every base-game achievement is earned. `snapshot` maps api name to { earned }.
 * `dlcApiNames` may be null (no category data): then every achievement counts.
 */
function isBaseGameComplete(snapshot, dlcApiNames) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const entries = Object.entries(snapshot).filter(([name]) => !(dlcApiNames && dlcApiNames.has(name)));
  return entries.length > 0 && entries.every(([, state]) => state?.earned === true);
}

module.exports = { buildGroupsUrl, parseGroups, parseDlcApiNames, getDlcApiNames, isBaseGameComplete };
