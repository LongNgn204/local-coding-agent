// Local Coding Agent public preview — multi-root permission profiles.
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PERMISSION_PROFILE_VERSION = 1;

export const ROOT_PRESETS = Object.freeze({
  observe: Object.freeze({ filesystem: "read", commands: "deny" }),
  edit: Object.freeze({ filesystem: "write", commands: "deny" }),
  develop: Object.freeze({ filesystem: "write", commands: "safe" }),
  full_control: Object.freeze({ filesystem: "write", commands: "full" }),
  deny: Object.freeze({ filesystem: "deny", commands: "deny" })
});

const FILESYSTEM_LEVEL = Object.freeze({ deny: 0, read: 1, write: 2 });
const COMMAND_LEVEL = Object.freeze({ deny: 0, safe: 1, full: 2 });
const VALID_SCOPES = new Set(["once", "task", "session", "profile"]);

function comparePath(value, platform = process.platform) {
  const normalized = path.normalize(path.resolve(String(value)));
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathInside(target, root, platform = process.platform) {
  const child = comparePath(target, platform);
  const base = comparePath(root, platform);
  if (child === base) return true;
  const relative = path.relative(base, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Resolve the longest existing ancestor, then append the missing tail. This
// closes junction/symlink escapes for paths that do not exist yet.
export function canonicalizePath(value) {
  let current = path.resolve(String(value));
  const tail = [];
  for (let i = 0; i < 128; i++) {
    try {
      const real = realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(String(value));
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(String(value));
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globRegex(glob) {
  const source = String(glob || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "*") {
      if (source[i + 1] === "*") {
        i++;
        out += source[i + 1] === "/" ? "(?:.*/)?" : ".*";
        if (source[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}

function matchesDenyPattern(target, root, patterns) {
  if (!patterns.length || !isPathInside(target, root)) return null;
  const relative = path.relative(root, target).split(path.sep).join("/") || ".";
  return patterns.find((pattern) => globRegex(pattern).test(relative)) || null;
}

function normalizePreset(value, fallback = "develop") {
  const preset = String(value || fallback).toLowerCase();
  if (!ROOT_PRESETS[preset]) throw new Error(`Unknown root preset "${value}".`);
  return preset;
}

function normalizeRoot(raw, { baseDir, source = "profile", platform = process.platform } = {}) {
  const item = typeof raw === "string" ? { path: raw } : { ...(raw || {}) };
  if (!item.path || !String(item.path).trim()) throw new Error("Every permission root needs a non-empty path.");
  const absolute = path.isAbsolute(String(item.path))
    ? path.resolve(String(item.path))
    : path.resolve(baseDir, String(item.path));
  const canonical = canonicalizePath(absolute);
  const preset = normalizePreset(item.preset);
  const defaults = ROOT_PRESETS[preset];
  const filesystem = String(item.filesystem || defaults.filesystem).toLowerCase();
  const commands = String(item.commands || defaults.commands).toLowerCase();
  if (!(filesystem in FILESYSTEM_LEVEL)) throw new Error(`Invalid filesystem permission "${filesystem}" for ${item.path}.`);
  if (!(commands in COMMAND_LEVEL)) throw new Error(`Invalid command permission "${commands}" for ${item.path}.`);
  if (filesystem === "deny" && commands !== "deny") {
    throw new Error(`A denied filesystem root cannot grant command access: ${item.path}`);
  }
  const deny = Array.isArray(item.deny) ? item.deny.map(String).map((s) => s.trim()).filter(Boolean) : [];
  return {
    id: String(item.id || randomUUID()),
    label: String(item.label || path.basename(absolute) || absolute),
    path: absolute,
    canonical_path: canonical,
    preset,
    filesystem,
    commands,
    deny,
    source,
    scope: item.scope && VALID_SCOPES.has(String(item.scope)) ? String(item.scope) : source === "grant" ? "session" : "profile",
    task_id: item.task_id ? String(item.task_id) : null,
    uses_remaining: item.uses_remaining == null ? null : Math.max(0, Number(item.uses_remaining) || 0),
    expires_at: item.expires_at ? String(item.expires_at) : null
  };
}

function dedupeRoots(roots, platform = process.platform) {
  const seen = new Map();
  const result = [];
  for (const root of roots) {
    const pathKey = comparePath(root.canonical_path, platform);
    const ruleKey = `${root.preset}|${root.filesystem}|${root.commands}|${root.deny.join("\u0000")}`;
    if (seen.has(pathKey)) {
      if (seen.get(pathKey) === ruleKey) continue;
      throw new Error(`Permission profile contains conflicting rules for the same canonical root: ${root.path}`);
    }
    seen.set(pathKey, ruleKey);
    result.push(root);
  }
  return result;
}

export function legacyPermissionProfile({ primaryRoot, extraRoots = [], mode = "safe" }) {
  const preset = String(mode).toLowerCase() === "full" ? "full_control" : "develop";
  return {
    version: PERMISSION_PROFILE_VERSION,
    name: "legacy",
    working_directory: path.resolve(primaryRoot),
    migrated_from_legacy: true,
    roots: [primaryRoot, ...extraRoots].map((root, index) => ({
      path: path.resolve(root),
      label: index === 0 ? "Primary workspace" : `Extra root ${index}`,
      preset
    }))
  };
}

function selectStoredProfile(raw, requestedName) {
  if (!raw || typeof raw !== "object") throw new Error("Permission profile must be a JSON object.");
  if (!raw.profiles) return { profile: raw, name: String(raw.name || requestedName || "default"), store: null };
  const profiles = raw.profiles;
  const name = String(requestedName || raw.active_profile || "default");
  const profile = Array.isArray(profiles)
    ? profiles.find((candidate) => String(candidate?.name) === name)
    : profiles[name];
  if (!profile) throw new Error(`Permission profile "${name}" was not found in the profile store.`);
  return { profile: { ...profile, name: profile.name || name }, name, store: raw };
}

export function loadPermissionProfileSync({
  primaryRoot,
  extraRoots = [],
  mode = "safe",
  profileJson = "",
  profileFile = "",
  profileName = ""
} = {}) {
  let raw = null;
  let source = "legacy";
  let store = null;
  let selectedName = profileName || "";
  if (String(profileJson || "").trim()) {
    raw = JSON.parse(String(profileJson));
    source = "env_json";
  } else if (String(profileFile || "").trim()) {
    const absoluteFile = path.resolve(String(profileFile));
    if (!existsSync(absoluteFile)) throw new Error(`Permission profile file does not exist: ${absoluteFile}`);
    raw = JSON.parse(readFileSync(absoluteFile, "utf8"));
    source = absoluteFile;
  }
  if (!raw) raw = legacyPermissionProfile({ primaryRoot, extraRoots, mode });
  const selected = selectStoredProfile(raw, selectedName);
  store = selected.store;
  selectedName = selected.name;
  const rawProfile = selected.profile;
  const workingDirectory = path.resolve(rawProfile.working_directory || primaryRoot);
  const roots = Array.isArray(rawProfile.roots) ? rawProfile.roots : [];
  if (!roots.length) throw new Error(`Permission profile "${selectedName}" has no roots.`);
  const normalized = {
    version: Number(rawProfile.version || raw.version || PERMISSION_PROFILE_VERSION),
    name: String(rawProfile.name || selectedName || "default"),
    description: String(rawProfile.description || ""),
    working_directory: workingDirectory,
    roots: dedupeRoots(roots.map((root) => normalizeRoot(root, { baseDir: workingDirectory }))),
    source,
    profile_file: source === "legacy" || source === "env_json" ? null : source,
    stored: Boolean(store),
    migrated_from_legacy: Boolean(rawProfile.migrated_from_legacy)
  };
  const canonicalWorkingDirectory = canonicalizePath(workingDirectory);
  if (!normalized.roots.some((root) => isPathInside(canonicalWorkingDirectory, root.canonical_path))) {
    throw new Error(`working_directory must be inside a configured permission root: ${workingDirectory}`);
  }
  return normalized;
}

export class PermissionResolver {
  constructor(profile, { platform = process.platform } = {}) {
    if (!profile?.working_directory || !Array.isArray(profile?.roots)) throw new Error("Invalid normalized permission profile.");
    this.profile = profile;
    this.platform = platform;
    this.grants = [];
  }

  get workingDirectory() {
    return this.profile.working_directory;
  }

  get roots() {
    const values = [...this.profile.roots, ...this.activeGrants()].filter((root) => root.filesystem !== "deny").map((root) => root.path);
    return [...new Map(values.map((root) => [comparePath(root, this.platform), root])).values()];
  }

  activeGrants({ taskId = null } = {}) {
    const now = Date.now();
    return this.grants.filter((grant) => {
      if (grant.expires_at && Date.parse(grant.expires_at) <= now) return false;
      if (grant.uses_remaining != null && grant.uses_remaining <= 0) return false;
      if (grant.scope === "task" && String(grant.task_id || "") !== String(taskId || "")) return false;
      return true;
    });
  }

  addGrant(rawGrant) {
    const scope = String(rawGrant?.scope || "session");
    if (!VALID_SCOPES.has(scope)) throw new Error(`Invalid path access scope "${scope}".`);
    if (scope === "task" && !rawGrant?.task_id) throw new Error("task scope requires task_id.");
    const grant = normalizeRoot({
      ...rawGrant,
      scope,
      uses_remaining: scope === "once" ? 1 : rawGrant?.uses_remaining
    }, { baseDir: this.workingDirectory, source: "grant", platform: this.platform });
    this.grants = this.grants.filter((candidate) => candidate.id !== grant.id);
    this.grants.push(grant);
    return grant;
  }

  revokeGrant(id) {
    const before = this.grants.length;
    this.grants = this.grants.filter((grant) => grant.id !== String(id));
    return this.grants.length !== before;
  }

  consumeGrant(id) {
    const grant = this.grants.find((candidate) => candidate.id === String(id));
    if (!grant || grant.uses_remaining == null) return false;
    grant.uses_remaining = Math.max(0, Number(grant.uses_remaining || 0) - 1);
    return true;
  }

  matchingRoots(target, { taskId = null } = {}) {
    const all = [...this.profile.roots, ...this.activeGrants({ taskId })];
    return all
      .map((root, index) => ({ root, index }))
      .filter(({ root }) => isPathInside(target, root.canonical_path, this.platform))
      .sort((a, b) => {
        const specificity = comparePath(b.root.canonical_path, this.platform).length - comparePath(a.root.canonical_path, this.platform).length;
        if (specificity) return specificity;
        const grantPriority = Number(b.root.source === "grant") - Number(a.root.source === "grant");
        return grantPriority || b.index - a.index;
      })
      .map(({ root }) => root);
  }

  explain(input, capability = "read", { taskId = null } = {}) {
    const raw = String(input ?? ".").trim() || ".";
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.workingDirectory, raw);
    const canonical = canonicalizePath(resolved);
    const matches = this.matchingRoots(canonical, { taskId });
    if (!matches.length) return { allowed: false, reason: "outside_roots", capability, resolved, canonical, root: null };

    for (const root of matches) {
      if (root.filesystem === "deny") {
        return { allowed: false, reason: "denied_root", capability, resolved, canonical, root };
      }
      const pattern = matchesDenyPattern(canonical, root.canonical_path, root.deny);
      if (pattern) {
        return { allowed: false, reason: "deny_pattern", deny_pattern: pattern, capability, resolved, canonical, root };
      }
    }

    const root = matches[0];
    let allowed = false;
    if (capability === "read") allowed = FILESYSTEM_LEVEL[root.filesystem] >= FILESYSTEM_LEVEL.read;
    else if (capability === "write") allowed = FILESYSTEM_LEVEL[root.filesystem] >= FILESYSTEM_LEVEL.write;
    else if (capability === "command") allowed = COMMAND_LEVEL[root.commands] >= COMMAND_LEVEL.safe;
    else throw new Error(`Unknown path capability "${capability}".`);
    return {
      allowed,
      reason: allowed ? "allowed" : `requires_${capability}`,
      capability,
      resolved,
      canonical,
      root,
      command_mode: root.commands
    };
  }

  resolvePath(input = ".", capability = "read", options = {}) {
    const result = this.explain(input, capability, options);
    if (!result.allowed) {
      const detail = result.deny_pattern ? ` (matched deny pattern ${result.deny_pattern})` : "";
      throw new Error(`Path permission denied for ${capability}: ${input} [${result.reason}]${detail}`);
    }
    if (result.root?.source === "grant" && result.root.scope === "once" && options.consume !== false) {
      result.root.uses_remaining = Math.max(0, Number(result.root.uses_remaining || 0) - 1);
    }
    return result.resolved;
  }

  commandModeFor(input = ".", options = {}) {
    const result = this.explain(input, "command", options);
    if (!result.allowed) throw new Error(`Path permission denied for command: ${input} [${result.reason}]`);
    return result.command_mode === "full" ? "full" : "safe";
  }

  writableRoots({ taskId = null } = {}) {
    return [...this.profile.roots, ...this.activeGrants({ taskId })]
      .filter((root) => root.filesystem === "write" && root.preset !== "deny")
      .filter((root, index, all) => all.findIndex((candidate) => comparePath(candidate.path, this.platform) === comparePath(root.path, this.platform)) === index)
      .map((root) => root.path);
  }

  summary({ includeCanonical = false, taskId = null } = {}) {
    const roots = [...this.profile.roots, ...this.activeGrants({ taskId })].map((root) => ({
      id: root.id,
      label: root.label,
      path: root.path,
      ...(includeCanonical ? { canonical_path: root.canonical_path } : {}),
      preset: root.preset,
      filesystem: root.filesystem,
      commands: root.commands,
      deny: root.deny,
      source: root.source,
      scope: root.scope,
      task_id: root.task_id,
      uses_remaining: root.uses_remaining,
      expires_at: root.expires_at
    }));
    return {
      version: this.profile.version,
      name: this.profile.name,
      description: this.profile.description,
      working_directory: this.workingDirectory,
      source: this.profile.source,
      migrated_from_legacy: this.profile.migrated_from_legacy,
      roots
    };
  }
}

export async function persistProfileRoot({ profileFile, profileName, root }) {
  if (!profileFile) throw new Error("Persistent path access requires AGENT_PERMISSION_PROFILE_FILE.");
  const absolute = path.resolve(profileFile);
  const raw = JSON.parse(await readFile(absolute, "utf8"));
  const selected = selectStoredProfile(raw, profileName);
  const serializable = {
    id: root.id,
    label: root.label,
    path: root.path,
    preset: root.preset,
    ...(root.deny?.length ? { deny: root.deny } : {})
  };
  const roots = Array.isArray(selected.profile.roots) ? [...selected.profile.roots] : [];
  const key = comparePath(root.path);
  const profileBase = path.resolve(selected.profile.working_directory || path.dirname(absolute));
  const index = roots.findIndex((candidate) => {
    const value = typeof candidate === "string" ? candidate : candidate.path;
    const candidatePath = path.isAbsolute(String(value)) ? String(value) : path.resolve(profileBase, String(value));
    return comparePath(candidatePath) === key;
  });
  if (index >= 0) roots[index] = serializable;
  else roots.push(serializable);
  if (selected.store) {
    if (Array.isArray(raw.profiles)) {
      const profileIndex = raw.profiles.findIndex((candidate) => String(candidate?.name) === selected.name);
      raw.profiles[profileIndex] = { ...raw.profiles[profileIndex], roots };
    } else {
      raw.profiles[selected.name] = { ...raw.profiles[selected.name], roots };
    }
  } else {
    raw.roots = roots;
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return absolute;
}
