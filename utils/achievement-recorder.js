const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");

const DEFAULT_RECORDER_TIMINGS = Object.freeze({
  preMs: 10_000,
  postMs: 10_000,
  segmentMs: 2_000,
  fps: 30,
  hdrToneMapping: false,
  maxHeight: 0,
});
const DEFAULT_FORCE_STOP_GRACE_MS = 4_000;

function resolveAchievementRecorderHelper(options = {}) {
  const executableName = "achievements-recorder.exe";
  const appDir = String(options.appDir || __dirname);
  const resourcesPath = String(options.resourcesPath || process.resourcesPath || "");
  const unpackedAppDir = appDir.replace(
    /app\.asar(?=[\\/]|$)/i,
    "app.asar.unpacked",
  );
  const isAsarPath = unpackedAppDir !== appDir;
  const candidates = isAsarPath
    ? [
        path.join(unpackedAppDir, "native", executableName),
        path.join(appDir, "native", executableName),
      ]
    : [path.join(appDir, "native", executableName)];
  if (resourcesPath) {
    candidates.push(
      path.join(
        resourcesPath,
        "app.asar.unpacked",
        "utils",
        "native",
        executableName,
      ),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function parseRecorderProtocolLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Recorder protocol message must be an object");
  }
  const type = String(parsed.type || "").trim();
  if (!type) throw new TypeError("Recorder protocol message has no type");
  return { ...parsed, type };
}

class AchievementRecorderController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.appDir = options.appDir || __dirname;
    this.resourcesPath = options.resourcesPath || process.resourcesPath || "";
    this.bufferDir = String(options.bufferDir || "").trim();
    this.timings = {
      ...DEFAULT_RECORDER_TIMINGS,
      ...(options.timings || {}),
    };
    this.spawnProcess = options.spawnProcess || spawn;
    this.enabled = false;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.startTimer = null;
    this.restartTimer = null;
    this.restartAttempt = 0;
    this.stopping = false;
    this.stopPromise = null;
    this.pendingOutputs = new Map();
    this.runCounter = 0;
    this.activeRunDirs = new Set();
    this.nativeResolutionFallback = false;
    this.forceStopGraceMs = Math.max(
      100,
      Number(options.forceStopGraceMs) || DEFAULT_FORCE_STOP_GRACE_MS,
    );
  }

  get status() {
    return {
      enabled: this.enabled,
      running: !!this.child && !this.child.killed,
      ready: this.ready,
      pid: this.child?.pid || null,
    };
  }

  updateTimings(nextTimings = {}) {
    const normalized = {
      preMs: Math.max(1_000, Number(nextTimings.preMs) || this.timings.preMs),
      postMs: Math.max(1_000, Number(nextTimings.postMs) || this.timings.postMs),
      segmentMs: Math.max(
        1_000,
        Number(nextTimings.segmentMs) || this.timings.segmentMs,
      ),
      fps: [30, 60].includes(Number(nextTimings.fps))
        ? Number(nextTimings.fps)
        : this.timings.fps,
      hdrToneMapping: Object.prototype.hasOwnProperty.call(
        nextTimings,
        "hdrToneMapping",
      )
        ? nextTimings.hdrToneMapping === true
        : this.timings.hdrToneMapping,
      maxHeight: Object.prototype.hasOwnProperty.call(nextTimings, "maxHeight")
        ? Math.max(0, Math.round(Number(nextTimings.maxHeight) || 0))
        : this.timings.maxHeight || 0,
    };
    const changed = Object.keys(normalized).some(
      (key) => normalized[key] !== this.timings[key],
    );
    if (changed) {
      const previous = { ...this.timings };
      if (normalized.maxHeight !== (previous.maxHeight || 0)) {
        // A new resolution choice deserves a fresh try even if the old one failed.
        this.nativeResolutionFallback = false;
      }
      this.timings = normalized;
      this.emit("timings-changed", { previous, current: { ...normalized } });
    }
    return changed;
  }

  async restart(reason = "configuration-changed") {
    if (!this.enabled) return false;
    this.restartAttempt = 0;
    await this.stopChild(reason);
    return this.enabled ? this.ensureStarted(`${reason}:restart`) : false;
  }

  setEnabled(enabled, reason = "unknown") {
    const wasEnabled = this.enabled;
    this.enabled = enabled === true;
    if (!this.enabled) {
      this.restartAttempt = 0;
      return this.stop(reason);
    }
    if (!wasEnabled) this.restartAttempt = 0;
    if (this.stopping && this.stopPromise) {
      return this.stopPromise.then(() =>
        this.enabled ? this.ensureStarted(`${reason}:after-stop`) : false,
      );
    }
    return this.ensureStarted(reason);
  }

  ensureStarted(reason = "unknown") {
    if (!this.enabled) return Promise.resolve(false);
    if (this.ready && this.child && !this.child.killed) {
      return Promise.resolve(true);
    }
    if (this.startPromise) return this.startPromise;

    const helper = resolveAchievementRecorderHelper({
      appDir: this.appDir,
      resourcesPath: this.resourcesPath,
    });
    if (!helper) {
      const error = new Error("Bundled achievement recorder helper was not found");
      error.code = "recorder-helper-missing";
      this.emit("recorder-error", error);
      return Promise.reject(error);
    }
    if (!this.bufferDir) {
      const error = new Error("Achievement recorder buffer directory is missing");
      error.code = "recorder-buffer-missing";
      this.emit("recorder-error", error);
      return Promise.reject(error);
    }

    fs.mkdirSync(this.bufferDir, { recursive: true });
    // Every helper gets its own buffer folder. The native helper wipes every
    // "session-<pid>" folder it finds in its buffer dir on startup, so two helpers
    // sharing one folder (a restart overlapping a helper that is still shutting
    // down) would delete each other's live segment files.
    this.sweepStaleRunDirs();
    this.runCounter += 1;
    const runDir = path.join(
      this.bufferDir,
      `run-${Date.now().toString(36)}-${process.pid}-${this.runCounter}`,
    );
    fs.mkdirSync(runDir, { recursive: true });
    this.activeRunDirs.add(runDir);
    this.stopping = false;
    this.ready = false;
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    const args = [
      "--buffer-dir",
      runDir,
      "--pre-ms",
      String(this.timings.preMs),
      "--post-ms",
      String(this.timings.postMs),
      "--segment-ms",
      String(this.timings.segmentMs),
      "--fps",
      String(this.timings.fps),
      "--hdr-tone-map",
      String(this.timings.hdrToneMapping === true),
    ];
    // Only sent when scaling is on, so a recorder program built before this option
    // existed (it rejects unknown arguments) keeps working with the native setting.
    const maxHeight = this.nativeResolutionFallback
      ? 0
      : this.timings.maxHeight || 0;
    if (maxHeight > 0) args.push("--max-height", String(maxHeight));
    const child = this.spawnProcess(helper, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.lowerChildPriority(child);
    this.emit("starting", { reason, helper, pid: child.pid || null });

    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => {
      if (this.child !== child) return; // output from a helper we already replaced
      try {
        const message = parseRecorderProtocolLine(line);
        if (!message) return;
        this.handleMessage(message);
      } catch (error) {
        this.emit("protocol-error", {
          error: error?.message || String(error),
          line: String(line).slice(0, 1000),
        });
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.rejectStart(error);
      this.emit("recorder-error", error);
    });
    child.once("exit", (code, signal) => {
      output.close();
      this.activeRunDirs.delete(runDir);
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {}
      if (this.child !== child) {
        // A helper that was already stopped/replaced finally exited. It must not
        // touch the state of the helper that replaced it (that used to reset
        // `child`, reject the new start and schedule a duplicate helper).
        this.emit("exit", {
          code,
          signal,
          wasReady: false,
          expected: true,
          stale: true,
        });
        return;
      }
      const wasStopping = this.stopping;
      const wasReady = this.ready;
      this.ready = false;
      this.child = null;
      const error = new Error(
        `Achievement recorder exited (code=${code}, signal=${signal || ""})${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      );
      error.code = "recorder-exited";
      this.rejectStart(error);
      this.emit("exit", { code, signal, wasReady, expected: wasStopping });
      if (
        !wasStopping &&
        !wasReady &&
        !this.nativeResolutionFallback &&
        (this.timings.maxHeight || 0) > 0
      ) {
        // The scaled recording never produced a frame. Record at the native size from
        // now on (until the resolution setting changes) so recording keeps working.
        this.nativeResolutionFallback = true;
        this.emit("resolution-fallback", {
          requestedMaxHeight: this.timings.maxHeight,
          effective: "native",
          reason: "helper-exited-before-ready",
          code,
          signal: signal || null,
        });
      }
      this.cleanupPendingOutputs("helper-exit");
      this.stopping = false;
      if (this.enabled && !wasStopping) this.scheduleRestart();
    });
    this.startTimer = setTimeout(() => {
      if (this.child !== child) return;
      const error = new Error("Achievement recorder did not become ready in time");
      error.code = "recorder-start-timeout";
      this.rejectStart(error);
      this.emit("recorder-error", error);
      try {
        child.kill();
      } catch {}
    }, 15_000);
    this.startTimer.unref?.();
    return this.startPromise;
  }

  // The recorder is background work: let the game win when the CPU is contended.
  // Best effort only; if the OS refuses, the helper simply keeps normal priority.
  lowerChildPriority(child) {
    if (this.lowerPriority === false || process.platform !== "win32") return;
    if (!child || !Number.isInteger(child.pid)) return;
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
  }

  sweepStaleRunDirs(maxAgeMs = 10 * 60 * 1000) {
    let entries = [];
    try {
      entries = fs.readdirSync(this.bufferDir, { withFileTypes: true });
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^(?:run-|session-)/.test(entry.name)) continue;
      const full = path.join(this.bufferDir, entry.name);
      if (this.activeRunDirs.has(full)) continue;
      try {
        const age = now - fs.statSync(full).mtimeMs;
        if (age > maxAgeMs) fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  }

  handleMessage(message) {
    if (message.type === "ready") {
      if (this.ready) {
        this.emit("duplicate-ready", message);
        return;
      }
      this.ready = true;
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      const resolve = this.startResolve;
      this.clearStartPromise();
      resolve?.(true);
      this.emit("ready", message);
      return;
    }
    if (message.type === "fatal") {
      const error = new Error(message.error || "Achievement recorder failed");
      error.code = "recorder-fatal";
      this.rejectStart(error);
      this.emit("recorder-error", error);
      return;
    }
    if (message.type === "segment-finalized" && this.restartAttempt > 0) {
      const previousAttempt = this.restartAttempt;
      this.restartAttempt = 0;
      this.emit("restart-stabilized", {
        previousAttempt,
        reason: "first-segment-finalized",
      });
    }
    if (message.type === "saved" || message.type === "failed") {
      const id = String(message.id || "").trim();
      if (id) this.pendingOutputs.delete(id);
    }
    this.emit(message.type, message);
    this.emit("message", message);
  }

  clearStartPromise() {
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
  }

  rejectStart(error) {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const reject = this.startReject;
    this.clearStartPromise();
    reject?.(error);
  }

  scheduleRestart() {
    if (this.restartTimer || !this.enabled) return;
    const delays = [5_000, 15_000, 30_000, 60_000];
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)];
    this.restartAttempt += 1;
    this.emit("restart-scheduled", { delay, attempt: this.restartAttempt });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.enabled) return;
      this.ensureStarted("automatic-restart").catch(() => {});
    }, delay);
    this.restartTimer.unref?.();
  }

  async trigger(payload = {}) {
    if (!this.enabled) {
      const error = new Error("Achievement recorder is disabled");
      error.code = "recorder-disabled";
      throw error;
    }
    await this.ensureStarted("achievement-trigger");
    const outputPath = String(payload.outputPath || "").trim();
    if (!outputPath) {
      throw new TypeError("Achievement recorder output path is required");
    }
    const id = String(payload.id || crypto.randomUUID());
    const command = JSON.stringify({ type: "trigger", id, outputPath });
    if (!this.child?.stdin?.writable) {
      const error = new Error("Achievement recorder input is unavailable");
      error.code = "recorder-input-unavailable";
      throw error;
    }
    this.pendingOutputs.set(id, outputPath);
    this.child.stdin.write(`${command}\n`);
    return { id, outputPath };
  }

  cleanupPendingOutputs(reason = "unknown") {
    for (const [id, outputPath] of this.pendingOutputs) {
      try {
        const stat = fs.statSync(outputPath);
        if (stat.isFile() && stat.size === 0) fs.rmSync(outputPath, { force: true });
      } catch {}
      this.emit("cancelled", { id, outputPath, reason });
    }
    this.pendingOutputs.clear();
  }

  forceStop(reason = "unknown") {
    this.enabled = false;
    this.restartAttempt = 0;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const child = this.child;
    this.cleanupPendingOutputs(reason);
    if (!child) {
      this.ready = false;
      return false;
    }
    this.emit("stopping", { reason, pid: child.pid || null, forced: true });
    try {
      if (child.stdin?.writable) {
        child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      }
    } catch {}
    // Give the native helper time to finalize its capture pipeline and remove
    // the per-process buffer directory. A hard kill is retained as a bounded
    // fallback for a helper that no longer responds to the protocol command.
    const killTimer = setTimeout(() => {
      if (this.child !== child || child.killed) return;
      try {
        child.kill();
      } catch {}
    }, this.forceStopGraceMs);
    killTimer.unref?.();
    child.once("exit", () => clearTimeout(killTimer));
    return true;
  }

  stop(reason = "unknown") {
    this.enabled = false;
    this.restartAttempt = 0;
    return this.stopChild(reason);
  }

  stopChild(reason = "unknown") {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const child = this.child;
    if (this.stopPromise) return this.stopPromise;
    if (!child) {
      this.ready = false;
      this.rejectStart(new Error("Achievement recorder stopped"));
      this.cleanupPendingOutputs(reason);
      return Promise.resolve(false);
    }
    this.stopping = true;
    this.emit("stopping", { reason, pid: child.pid || null });
    try {
      if (child.stdin?.writable) {
        child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      }
    } catch {}
    this.stopPromise = new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.stopPromise = null;
        resolve(true);
      };
      child.once("exit", finish);
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        // Give the killed process a moment to really exit before a new helper
        // is started; finish() is still guaranteed by the bounded fallback.
        timer = setTimeout(finish, 2_000);
        timer.unref?.();
      }, 4_000);
      timer.unref?.();
    });
    return this.stopPromise;
  }
}

module.exports = {
  AchievementRecorderController,
  DEFAULT_FORCE_STOP_GRACE_MS,
  DEFAULT_RECORDER_TIMINGS,
  parseRecorderProtocolLine,
  resolveAchievementRecorderHelper,
};
