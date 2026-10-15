"use strict";

// PlayStation Platinum lookup for PSN Platinum notifications.
//
// Given a game's NPWR ID (for example NPWR39144_00) this signs in with the user's own NPSSO
// token through psn-api, lists the trophy set and keeps the Platinum's name, description and
// icon. PS5 sets (npServiceName "trophy2") are tried before PS4 ones. Nothing here touches the
// network on its own: the caller passes psn-api and fetch in, which is how the tests run with
// fake data. The NPSSO token is never logged and never put in an error message.

const NPWR_PATTERN = /NPWR\d{5,6}_00/gi;
const NPWR_EXACT = /^NPWR\d{5,6}_00$/;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const ALLOWED_ICON_HOST_SUFFIXES = [".playstation.net", ".playstation.com", ".sony.com"];

class PsnPlatinumError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "PsnPlatinumError";
    this.kind = kind;
  }
}

/** Every distinct NPWR ID found in any text: a bare ID, a psprices page title, page source... */
function extractNpwrIds(text) {
  const found = String(text || "").match(NPWR_PATTERN) || [];
  return [...new Set(found.map((id) => id.toUpperCase()))];
}

function isValidNpwr(id) {
  return NPWR_EXACT.test(String(id || "").trim().toUpperCase());
}

function isAllowedIconUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_ICON_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function looksLikeNpsso(value) {
  return /^[A-Za-z0-9]{40,100}$/.test(String(value || "").trim());
}

function toPlatinum(trophy, npwr, platform, gameName = "") {
  // A Platinum PlayStation lists without a name (a hidden one, say) is still the Platinum.
  const name = String(trophy?.trophyName || "").trim() || "Platinum Trophy";
  return {
    npwr,
    platform,
    gameName: String(gameName || "").trim(),
    name,
    description: String(trophy?.trophyDetail || "").trim(),
    iconUrl: String(trophy?.trophyIconUrl || "").trim(),
  };
}

/** Reads the platinum_data.json the user's own script writes. Null when it is not one. */
function parsePlatinumJson(text) {
  if (typeof text !== "string" || text.length > MAX_JSON_BYTES) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const name = String(data.name || "").trim();
  if (!name) return null;
  const npwr = String(data.title_id || data.npwr || "").trim().toUpperCase();
  return {
    npwr: isValidNpwr(npwr) ? npwr : "",
    platform: "",
    gameName: String(data.game_name || "").trim(),
    name,
    description: String(data.description || "").trim(),
    iconUrl: String(data.icon_url || "").trim(),
  };
}

function classifyError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const message = String(error?.message || "");
  if (status === 429 || /too many requests|rate limit/i.test(message)) {
    return new PsnPlatinumError("rate-limited", "PlayStation asked for a pause. Try again in a few minutes.");
  }
  if (status === 401 || status === 403 || /npsso|unauthori[sz]ed|invalid_grant|access token/i.test(message)) {
    return new PsnPlatinumError("auth", "PlayStation did not accept the NPSSO token. Paste a fresh one in the settings.");
  }
  if (status === 404 || /not found|resource not found/i.test(message)) {
    return new PsnPlatinumError("not-found", "PlayStation has no trophy set with that ID.");
  }
  if (error instanceof PsnPlatinumError) return error;
  return new PsnPlatinumError("network", "PlayStation could not be reached.");
}

/**
 * @param {object} deps
 * @param {object} deps.psnApi   the psn-api module (exchangeNpssoForCode, exchangeCodeForAccessToken, getTitleTrophies)
 * @param {Function} deps.fetchImpl  fetch, used only for the icon
 */
function createPsnPlatinumService({ psnApi, fetchImpl }) {
  let cached = { npsso: "", authorization: null, at: 0 };

  async function authenticate(npsso) {
    const token = String(npsso || "").trim();
    if (!looksLikeNpsso(token)) {
      throw new PsnPlatinumError("auth", "No valid NPSSO token is set.");
    }
    if (cached.authorization && cached.npsso === token && Date.now() - cached.at < 25 * 60 * 1000) {
      return cached.authorization;
    }
    try {
      const code = await psnApi.exchangeNpssoForCode(token);
      const authorization = await psnApi.exchangeCodeForAccessToken(code);
      cached = { npsso: token, authorization, at: Date.now() };
      return authorization;
    } catch (error) {
      throw classifyError(error);
    }
  }

  function shortError(error) {
    const text = String(error?.message || error || "").replace(/\s+/g, " ").trim();
    return text.length > 140 ? `${text.slice(0, 140)}...` : text;
  }

  /**
   * Reads one trophy service's list page by page (100 at a time, as PlayniteAchievements does)
   * until a Platinum turns up or the pages run out.
   * @returns {{ platinum: object|null, note: string }}
   */
  async function findPlatinumInService(authorization, id, platform, serviceOptions) {
    const types = {};
    let seen = 0;
    let shape = "";
    // "all" lists every trophy group. A set that answers it with nothing at all gets asked for
    // its default group too, which is where the base game's trophies (and Platinum) live.
    for (const group of ["all", "default"]) {
      let offset = 0;
      for (let page = 0; page < 20; page += 1) {
        const response = await psnApi.getTitleTrophies(authorization, id, group, {
          ...(serviceOptions || {}),
          limit: 100,
          offset,
        });
        const trophies = Array.isArray(response?.trophies) ? response.trophies : [];
        seen += trophies.length;
        if (!shape && response && typeof response === "object") {
          shape = `reply keys: ${Object.keys(response).slice(0, 8).join(",") || "none"}`;
        }
        for (const trophy of trophies) {
          const type = String(trophy?.trophyType || "unknown");
          types[type] = (types[type] || 0) + 1;
        }
        const trophy = trophies.find((entry) => entry?.trophyType === "platinum");
        if (trophy) {
          return { platinum: toPlatinum(trophy, id, platform, response?.trophyTitleName), note: `${platform}: Platinum found` };
        }
        const next = Number(response?.nextOffset);
        if (!Number.isFinite(next) || next <= offset) break;
        offset = next;
      }
      if (seen > 0) break; // this set has trophies, just no Platinum: no need to ask another group
    }
    const breakdown = Object.entries(types).map(([type, count]) => `${count} ${type}`).join(", ");
    const detail = seen === 0 && shape ? `; ${shape}` : "";
    return { platinum: null, note: `${platform}: ${seen} trophies${breakdown ? ` (${breakdown})` : ""}, no Platinum${detail}` };
  }

  /** The Platinum of whichever set has one, preferring PS5 over PS4. */
  async function fetchPlatinum(npsso, npwrIds) {
    const ids = [...new Set((npwrIds || []).map((id) => String(id || "").trim().toUpperCase()))].filter(isValidNpwr);
    if (ids.length === 0) {
      throw new PsnPlatinumError("not-found", "No valid NPWR ID was given (it looks like NPWR12345_00).");
    }
    const authorization = await authenticate(npsso);

    let best = null;
    let lastError = null;
    const notes = [];
    for (const id of ids) {
      for (const [platform, options] of [["PS5", { npServiceName: "trophy2" }], ["PS4", { npServiceName: "trophy" }]]) {
        try {
          const found = await findPlatinumInService(authorization, id, platform, options);
          notes.push(`${id} ${found.note}`);
          if (found.platinum) {
            if (!best || (platform === "PS5" && best.platform !== "PS5")) best = found.platinum;
            break; // this set answered: no need to also try its PS4 service name
          }
        } catch (error) {
          const classified = classifyError(error);
          // A rejected token or a pause request ends everything; a missing set just moves on.
          if (classified.kind === "auth" || classified.kind === "rate-limited") throw classified;
          lastError = classified;
          notes.push(`${id} ${platform}: ${shortError(error)}`);
        }
      }
    }
    if (!best) {
      // What PlayStation actually answered goes into the message, so a failure can be diagnosed.
      const detail = notes.length ? ` (${notes.join("; ")})` : "";
      if (lastError && notes.every((note) => !/no Platinum/.test(note))) {
        throw new PsnPlatinumError(lastError.kind, `${lastError.message}${detail}`);
      }
      throw new PsnPlatinumError("no-platinum", `That trophy set has no Platinum trophy.${detail}`);
    }
    return best;
  }

  /** Downloads a Platinum icon: https PlayStation hosts only, size-limited. Null on any failure. */
  async function downloadIcon(url) {
    if (!isAllowedIconUrl(url) || typeof fetchImpl !== "function") return null;
    try {
      const response = await fetchImpl(url, { redirect: "error" });
      if (!response?.ok) return null;
      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_ICON_BYTES) return null;
      return buffer;
    } catch {
      return null;
    }
  }

  function forgetSession() {
    cached = { npsso: "", authorization: null, at: 0 };
  }

  return { authenticate, fetchPlatinum, downloadIcon, forgetSession };
}

module.exports = {
  PsnPlatinumError,
  extractNpwrIds,
  isValidNpwr,
  isAllowedIconUrl,
  looksLikeNpsso,
  parsePlatinumJson,
  createPsnPlatinumService,
  MAX_ICON_BYTES,
};
