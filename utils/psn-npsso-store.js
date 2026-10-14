"use strict";

// Keeps the user's PSN NPSSO token on disk encrypted with the operating system's per-user
// protection (Electron safeStorage, DPAPI on Windows). It lives in its own file, never in the
// preferences JSON, so it is never sent to the interface or included in a preferences export.
// If the system cannot encrypt, nothing is stored and saving reports it.

const fs = require("fs");
const path = require("path");

function createNpssoStore({ safeStorage, filePath }) {
  function canEncrypt() {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  function has() {
    try {
      return fs.statSync(filePath).size > 0;
    } catch {
      return false;
    }
  }

  /** Returns "" when none is stored or it cannot be decrypted (a changed Windows account, say). */
  function read() {
    try {
      if (!has() || !canEncrypt()) return "";
      return String(safeStorage.decryptString(fs.readFileSync(filePath)) || "").trim();
    } catch {
      return "";
    }
  }

  /** @returns {{ ok: boolean, reason?: string }} */
  function write(npsso) {
    const value = String(npsso || "").trim();
    if (!value) {
      clear();
      return { ok: true };
    }
    if (!canEncrypt()) {
      return { ok: false, reason: "encryption-unavailable" };
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      fs.writeFileSync(temp, safeStorage.encryptString(value));
      fs.renameSync(temp, filePath);
      return { ok: true };
    } catch {
      return { ok: false, reason: "write-failed" };
    }
  }

  function clear() {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }

  return { has, read, write, clear, canEncrypt };
}

module.exports = { createNpssoStore };
