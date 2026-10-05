"use strict";

const ACHIEVEMENT_RECORD_FPS_VALUES = Object.freeze([30, 60]);
// "native" records at the screen size; "1080p" scales the clips down to 1080 lines high
// (only when the screen is taller than that).
const ACHIEVEMENT_RECORD_RESOLUTION_VALUES = Object.freeze(["native", "1080p"]);
const ACHIEVEMENT_RECORD_RESOLUTION_HEIGHTS = Object.freeze({
  native: 0,
  "1080p": 1080,
});
const ACHIEVEMENT_RECORD_DURATION_VALUES = Object.freeze([
  10, 15, 20, 25, 30,
]);
const ACHIEVEMENT_RECORD_FPS_OPTIONS = new Set(
  ACHIEVEMENT_RECORD_FPS_VALUES,
);
const ACHIEVEMENT_RECORD_DURATION_OPTIONS = new Set(
  ACHIEVEMENT_RECORD_DURATION_VALUES,
);
const DEFAULT_ACHIEVEMENT_RECORD_PREFERENCES = Object.freeze({
  disableAchievementRecords: true,
  enableHdrRecords: false,
  recordFps: 30,
  recordResolution: "native",
  recordDurationSeconds: 20,
});

function normalizeAchievementRecordFps(value, fallback = 30) {
  const parsed = Number.parseInt(value, 10);
  return ACHIEVEMENT_RECORD_FPS_OPTIONS.has(parsed) ? parsed : fallback;
}

function normalizeAchievementRecordResolution(value, fallback = "native") {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (ACHIEVEMENT_RECORD_RESOLUTION_VALUES.includes(key)) return key;
  return ACHIEVEMENT_RECORD_RESOLUTION_VALUES.includes(fallback)
    ? fallback
    : "native";
}

function normalizeAchievementRecordDuration(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10);
  return ACHIEVEMENT_RECORD_DURATION_OPTIONS.has(parsed) ? parsed : fallback;
}

function normalizeAchievementRecordPreferences(prefs = {}, defaults = {}) {
  const source = prefs && typeof prefs === "object" ? prefs : {};
  const fallback = {
    ...DEFAULT_ACHIEVEMENT_RECORD_PREFERENCES,
    ...(defaults && typeof defaults === "object" ? defaults : {}),
  };
  return {
    ...source,
    disableAchievementRecords:
      typeof source.disableAchievementRecords === "boolean"
        ? source.disableAchievementRecords
        : fallback.disableAchievementRecords === true,
    enableHdrRecords:
      typeof source.enableHdrRecords === "boolean"
        ? source.enableHdrRecords
        : fallback.enableHdrRecords === true,
    recordFps: normalizeAchievementRecordFps(
      source.recordFps,
      normalizeAchievementRecordFps(fallback.recordFps, 30),
    ),
    recordResolution: normalizeAchievementRecordResolution(
      source.recordResolution,
      normalizeAchievementRecordResolution(fallback.recordResolution, "native"),
    ),
    recordDurationSeconds: normalizeAchievementRecordDuration(
      source.recordDurationSeconds,
      normalizeAchievementRecordDuration(fallback.recordDurationSeconds, 20),
    ),
  };
}

function getAchievementRecorderTimings(prefs = {}) {
  const fps = normalizeAchievementRecordFps(prefs?.recordFps, 30);
  const durationSeconds = normalizeAchievementRecordDuration(
    prefs?.recordDurationSeconds,
    20,
  );
  const halfDurationMs = Math.round((durationSeconds * 1000) / 2);
  return {
    fps,
    preMs: halfDurationMs,
    postMs: halfDurationMs,
    segmentMs: 2_000,
    hdrToneMapping: prefs?.enableHdrRecords === true,
    maxHeight:
      ACHIEVEMENT_RECORD_RESOLUTION_HEIGHTS[
        normalizeAchievementRecordResolution(prefs?.recordResolution, "native")
      ] || 0,
  };
}

function shouldEnableAchievementRecorder(options = {}) {
  const platform = String(options.platform || process.platform);
  const prefs =
    options.prefs && typeof options.prefs === "object" ? options.prefs : {};
  const configName = String(options.configName || "").trim();
  return (
    platform === "win32" &&
    prefs.disableAchievementRecords === false &&
    options.configMode === "active" &&
    configName.length > 0 &&
    // The dashboard is shown instead of a game, so nothing is being played in
    // view: keep the recorder process shut down while it is open.
    options.dashboardOpen !== true
  );
}

module.exports = {
  ACHIEVEMENT_RECORD_DURATION_VALUES,
  ACHIEVEMENT_RECORD_FPS_VALUES,
  ACHIEVEMENT_RECORD_RESOLUTION_VALUES,
  DEFAULT_ACHIEVEMENT_RECORD_PREFERENCES,
  getAchievementRecorderTimings,
  normalizeAchievementRecordDuration,
  normalizeAchievementRecordFps,
  normalizeAchievementRecordPreferences,
  normalizeAchievementRecordResolution,
  shouldEnableAchievementRecorder,
};
