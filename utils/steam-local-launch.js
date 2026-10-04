const fs = require("fs");
const path = require("path");

// Local fallback for "which executable is this Steam game?" when the SteamDB
// lookup did not give the config a process name. Everything here is read-only
// and uses files Steam already keeps on disk:
//   <steam root>\appcache\stats            (where the config's save_path points)
//   <steam root>\steamapps\libraryfolders.vdf   (all library folders)
//   <library>\steamapps\appmanifest_<appid>.acf (install folder name)

const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_ENTRIES = 600;
const MAX_PICKED_EXECUTABLES = 4;

const EXCLUDED_DIR_NAMES = new Set(
  [
    "_commonredist",
    "commonredist",
    "redist",
    "redistributables",
    "directx",
    "dotnet",
    "vcredist",
    "__installer",
    "easyanticheat",
    "battleye",
    "monobleedingedge",
    "crashreporter",
    "crashhandler",
    "support",
    "tools",
    "engine",
    "prerequisites",
    "prereqs",
  ].map((name) => name.toLowerCase()),
);

const EXCLUDED_EXE_PATTERNS = [
  /^unins/,
  /uninstall/,
  /^setup/,
  /install/,
  /redist/,
  /^dxsetup/,
  /^dxwebsetup/,
  /^dotnet/,
  /^ndp\d/,
  /^oalinst/,
  /^physx/,
  /crash/,
  /report/,
  /helper/,
  /launcher/,
  /easyanticheat/,
  /^eac/,
  /beservice/,
  /battleye/,
  /^steamwebhelper/,
  /^cefsubprocess/,
  /^notification_helper/,
  /^7z/,
  /prereq/,
  /cleanup/,
  /updater?$/,
  /patcher/,
  /^start_protected_game/,
];

function normalizeKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = path.normalize(raw).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function steamRootFromStatsDir(statsDir) {
  const raw = String(statsDir || "").trim();
  if (!raw) return "";
  const normalized = path.normalize(raw).replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  const last = String(parts[parts.length - 1] || "").toLowerCase();
  const prev = String(parts[parts.length - 2] || "").toLowerCase();
  if (last !== "stats" || prev !== "appcache") return "";
  return path.dirname(path.dirname(normalized));
}

function parseLibraryFolderPaths(vdfText) {
  const out = [];
  const re = /"path"\s+"([^"]+)"/gi;
  let match;
  while ((match = re.exec(String(vdfText || "")))) {
    const value = String(match[1] || "").replace(/\\\\/g, "\\").trim();
    if (value) out.push(value);
  }
  return out;
}

function parseInstallDirName(manifestText) {
  const match = /"installdir"\s+"([^"]*)"/i.exec(String(manifestText || ""));
  return match ? String(match[1] || "").trim() : "";
}

async function listSteamLibraryRoots(steamRoot) {
  const roots = [];
  const seen = new Set();
  const add = (value) => {
    const key = normalizeKey(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    roots.push(value);
  };
  add(steamRoot);
  try {
    const text = await fs.promises.readFile(
      path.join(steamRoot, "steamapps", "libraryfolders.vdf"),
      "utf8",
    );
    parseLibraryFolderPaths(text).forEach(add);
  } catch {}
  return roots;
}

async function resolveSteamInstallDir(steamRoot, appid) {
  const id = String(appid || "").trim();
  if (!steamRoot || !/^\d+$/.test(id)) return "";
  for (const library of await listSteamLibraryRoots(steamRoot)) {
    const manifest = path.join(library, "steamapps", `appmanifest_${id}.acf`);
    let text = "";
    try {
      text = await fs.promises.readFile(manifest, "utf8");
    } catch {
      continue;
    }
    const installDirName = parseInstallDirName(text);
    if (!installDirName) continue;
    const dir = path.join(library, "steamapps", "common", installDirName);
    try {
      const stat = await fs.promises.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch {}
  }
  return "";
}

function isExcludedExecutable(fileName) {
  const base = String(fileName || "")
    .toLowerCase()
    .replace(/\.exe$/, "");
  return EXCLUDED_EXE_PATTERNS.some((pattern) => pattern.test(base));
}

async function discoverExecutables(installDir, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
  const maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES;
  const found = [];
  let visited = 0;
  let queue = [{ dir: installDir, depth: 0 }];

  while (queue.length && visited < maxEntries) {
    const next = [];
    for (const { dir, depth } of queue) {
      let entries = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++visited > maxEntries) break;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            depth < maxDepth &&
            !EXCLUDED_DIR_NAMES.has(entry.name.toLowerCase())
          ) {
            next.push({ dir: full, depth: depth + 1 });
          }
          continue;
        }
        if (!entry.isFile() || !/\.exe$/i.test(entry.name)) continue;
        let size = 0;
        try {
          size = (await fs.promises.stat(full)).size;
        } catch {}
        found.push({ name: entry.name, depth, size });
      }
      if (visited > maxEntries) break;
    }
    queue = next;
  }
  return found;
}

// Pick the executables a running game is most likely to show up as.
//  - Unreal games start from a small root stub that hands over to
//    <Game>-Win64-Shipping.exe, and that second process is the one that keeps
//    running, so those are always included.
//  - Otherwise the biggest non-helper executables near the install root.
function pickLaunchExecutables(found) {
  const list = Array.isArray(found) ? found : [];
  const shipping = list
    .filter((item) => /-win(?:64|32)-shipping\.exe$/i.test(item.name))
    .sort((a, b) => b.size - a.size)
    .slice(0, 2);
  const regular = list
    .filter(
      (item) =>
        item.depth <= 1 &&
        !isExcludedExecutable(item.name) &&
        !/-win(?:64|32)-shipping\.exe$/i.test(item.name),
    )
    .sort((a, b) => a.depth - b.depth || b.size - a.size)
    .slice(0, MAX_PICKED_EXECUTABLES);
  const names = [];
  const seen = new Set();
  for (const item of [...shipping, ...regular]) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(item.name);
  }
  return names.slice(0, MAX_PICKED_EXECUTABLES);
}

const derivedCache = new Map(); // key -> { at, value }
const POSITIVE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

async function deriveSteamProcessNames(statsDir, appid) {
  const root = steamRootFromStatsDir(statsDir);
  if (!root) return { names: [], installDir: "", reason: "not-a-steam-stats-dir" };
  const key = `${normalizeKey(root)}|${String(appid)}`;
  const cached = derivedCache.get(key);
  if (cached) {
    const ttl = cached.value.names.length ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
  }
  let value = { names: [], installDir: "", reason: "install-dir-not-found" };
  const installDir = await resolveSteamInstallDir(root, appid);
  if (installDir) {
    const names = pickLaunchExecutables(await discoverExecutables(installDir));
    value = {
      names,
      installDir,
      reason: names.length ? "ok" : "no-executable-found",
    };
  }
  derivedCache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = {
  steamRootFromStatsDir,
  parseLibraryFolderPaths,
  parseInstallDirName,
  resolveSteamInstallDir,
  discoverExecutables,
  pickLaunchExecutables,
  isExcludedExecutable,
  deriveSteamProcessNames,
};
