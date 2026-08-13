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
  engine: "codex_cli",
  activePermissionProfile: "default"
};
const ROOT_PRESETS = new Set(["observe", "edit", "develop", "full_control"]);

function comparable(value) {
  const absolute = path.resolve(String(value));
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function inside(target, root) {
  const child = comparable(target);
  const base = comparable(root);
  const separator = base.endsWith(path.sep) ? "" : path.sep;
  return child === base || child.startsWith(`${base}${separator}`);
}

export class ConfigStore {
  constructor(dir) {
    this.dir = dir || path.join(os.tmpdir(), "local-codex-studio");
    this.file = path.join(this.dir, "config.json");
    this.permissionFile = path.join(this.dir, "permission-profiles.json");
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

  getPermissionStore() {
    try {
      if (existsSync(this.permissionFile)) {
        const raw = JSON.parse(readFileSync(this.permissionFile, "utf8").replace(/^ï»¿/, ""));
        if (raw?.profiles && typeof raw.profiles === "object") return raw;
      }
    } catch {
      /* create a migrated store below */
    }
    const cfg = this.get();
    const workspace = cfg.workspace ? path.resolve(cfg.workspace) : "";
    return {
      version: 1,
      active_profile: cfg.activePermissionProfile || "default",
      profiles: workspace ? {
        default: {
          version: 1,
          name: "default",
          description: "Private Local Codex Studio profile",
          working_directory: workspace,
          roots: [{ label: "Primary workspace", path: workspace, preset: cfg.mode === "full" ? "full_control" : "develop" }]
        }
      } : {}
    };
  }

  setPermissionStore(store) {
    if (!store || typeof store !== "object" || !store.profiles || typeof store.profiles !== "object") {
      throw new Error("Invalid permission profile store.");
    }
    const names = Object.keys(store.profiles);
    if (!names.length) throw new Error("At least one permission profile is required.");
    const active = String(store.active_profile || names[0]);
    if (!store.profiles[active]) throw new Error(`Active permission profile does not exist: ${active}`);
    for (const [name, profile] of Object.entries(store.profiles)) {
      if (!profile?.working_directory || !Array.isArray(profile?.roots) || !profile.roots.length) {
        throw new Error(`Permission profile ${name} needs a working_directory and at least one root.`);
      }
      profile.name = name;
      for (const root of profile.roots) {
        if (!root?.path || !ROOT_PRESETS.has(String(root.preset))) {
          throw new Error(`Permission profile ${name} contains an invalid root or preset.`);
        }
        if (inside(this.permissionFile, root.path)) {
          throw new Error("Permission profile storage must stay outside every authorized root.");
        }
      }
      if (!profile.roots.some((root) => inside(profile.working_directory, root.path))) {
        throw new Error(`Permission profile ${name} working_directory must be inside one of its roots.`);
      }
    }
    const normalized = { version: 1, ...store, active_profile: active };
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.permissionFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    this.set({
      activePermissionProfile: active,
      workspace: path.resolve(normalized.profiles[active].working_directory)
    });
    return { file: this.permissionFile, store: normalized };
  }
}

export default ConfigStore;
