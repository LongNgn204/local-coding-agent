// Local Codex Studio — tiny JSON config store (workspace, mode, engine).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stored under Electron's userData dir when available, else a temp fallback so
// the module can be imported in tests without Electron.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULTS = {
  workspace: "",
  mode: "safe",
  engine: "codex_cli"
};

export class ConfigStore {
  constructor(dir) {
    this.dir = dir || path.join(os.tmpdir(), "local-codex-studio");
    this.file = path.join(this.dir, "config.json");
    this._cache = null;
  }

  get() {
    if (this._cache) return { ...this._cache };
    let data = { ...DEFAULTS };
    try {
      if (existsSync(this.file)) {
        // Strip a UTF-8 BOM if a hand-edit added one (JSON.parse rejects it).
        const text = readFileSync(this.file, "utf8").replace(/^﻿/, "");
        const raw = JSON.parse(text);
        data = { ...DEFAULTS, ...raw };
      }
    } catch {
      data = { ...DEFAULTS };
    }
    this._cache = data;
    return { ...data };
  }

  set(patch) {
    const next = { ...this.get(), ...(patch || {}) };
    // Normalize.
    next.mode = next.mode === "full" ? "full" : "safe";
    next.engine = next.engine === "script_runner" ? "script_runner" : "codex_cli";
    this._cache = next;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(next, null, 2), "utf8");
    } catch {
      /* best effort */
    }
    return { ...next };
  }
}

export default ConfigStore;
