// Local Coding Agent Tray — config store.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shares the same cli-config.json schema as scripts/local-coding-agent.mjs so
// the GUI and the universal CLI agree on one configuration. Secrets (Runtime
// API key, MCP auth token) are never written in plain text: they are encrypted
// with the platform secret store (macOS Keychain / Windows DPAPI) via
// Electron's safeStorage and kept in a separate secrets.json.
//
// The store is plain Node so it can be unit-tested without Electron; the main
// process injects an encrypt/decrypt codec backed by safeStorage.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In development, desktop-tray/main -> repo root is two levels up. Packaged
// builds carry the tested server under resources/runtime so the tray does not
// depend on the original clone remaining at the same path.
const packagedRuntime = process.resourcesPath ? path.join(process.resourcesPath, "runtime") : "";
export const REPO_ROOT = packagedRuntime && existsSync(path.join(packagedRuntime, "server", "server.mjs"))
  ? packagedRuntime
  : path.resolve(__dirname, "..", "..");

export function defaultConfigDir() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "LocalCodingAgent");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "LocalCodingAgent");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "LocalCodingAgent");
}

const DEFAULTS = {
  node: "node",
  mcpAppDir: "",
  serverScript: "server.mjs",
  workspace: "",
  extraRoots: "",
  permissionProfileFile: "",
  permissionProfileName: "",
  mode: "safe",
  policy: "balanced",
  port: 8787,
  dashboardPort: 8790,
  authToken: "",
  tunnelBin: "",
  profile: "local-coding-agent",
  profileDir: "",
  tunnelId: "",
  organizationId: "",
  runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
  runtimeKey: "",
  tunnelHealthPort: "8788",
  openWebUi: true,
  noTunnel: false,
  v5Preview: true,
  allowSystemShutdown: false,
  allowDangerous: false
};

export const MODES = ["safe", "full"];
export const POLICIES = ["strict", "balanced", "full"];
export const ROOT_PRESETS = ["observe", "edit", "develop", "full_control"];
const SECRET_NAMES = ["runtimeKey", "authToken"];

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

function yamlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export class ConfigStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dir]       Config directory (default: platform app-data dir).
   * @param {string} [opts.repoRoot]  Repo root used for path defaults.
   * @param {(plain:string)=>string} [opts.encrypt]  Encrypt a secret string to base64.
   * @param {(b64:string)=>string}   [opts.decrypt]  Decrypt base64 back to the secret.
   */
  constructor(opts = {}) {
    this.dir = opts.dir || defaultConfigDir();
    this.repoRoot = opts.repoRoot || REPO_ROOT;
    this.file = path.join(this.dir, "cli-config.json");
    this.secretsFile = path.join(this.dir, "secrets.json");
    this.permissionFile = path.join(this.dir, "permission-profiles.json");
    this.logFile = path.join(this.dir, "tray.log");
    this.encrypt = typeof opts.encrypt === "function" ? opts.encrypt : (s) => Buffer.from(s, "utf8").toString("base64");
    this.decrypt = typeof opts.decrypt === "function" ? opts.decrypt : (b64) => Buffer.from(b64, "base64").toString("utf8");
  }

  get() {
    let data = { ...DEFAULTS };
    try {
      if (existsSync(this.file)) {
        const text = readFileSync(this.file, "utf8").replace(/^\uFEFF/, "");
        data = { ...DEFAULTS, ...JSON.parse(text) };
      }
    } catch {
      data = { ...DEFAULTS };
    }
    this.fillDefaults(data);
    return data;
  }

  fillDefaults(cfg) {
    const tools = path.join(this.repoRoot, "tools");
    if (!cfg.mcpAppDir) cfg.mcpAppDir = path.join(this.repoRoot, "server");
    if (!cfg.serverScript) cfg.serverScript = "server.mjs";
    if (!cfg.tunnelBin) {
      cfg.tunnelBin = path.join(tools, process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    }
    if (!cfg.profileDir) cfg.profileDir = path.join(tools, "profiles");
    if (!cfg.profile) cfg.profile = "local-coding-agent";
    if (!cfg.mode || !MODES.includes(cfg.mode)) cfg.mode = "safe";
    if (!cfg.policy || !POLICIES.includes(cfg.policy)) cfg.policy = "balanced";
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) cfg.port = 8787;
    if (!Number.isInteger(cfg.dashboardPort) || cfg.dashboardPort < 1 || cfg.dashboardPort > 65535) cfg.dashboardPort = 8790;
    // 8788 collides with the OpenAI tunnel-client's own health port; migrate off it.
    if (cfg.dashboardPort === 8788) cfg.dashboardPort = 8790;
    if (!cfg.node) cfg.node = "node";
    if (!cfg.runtimeKeyEnv) cfg.runtimeKeyEnv = "CONTROL_PLANE_API_KEY";
    if (!cfg.tunnelHealthPort) cfg.tunnelHealthPort = "8788";
  }

  set(patch) {
    const next = { ...this.get(), ...(patch || {}) };
    this.fillDefaults(next);
    // Never persist secret material through the shared CLI config from the GUI.
    for (const name of SECRET_NAMES) delete next[name];
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      try {
        chmodSync(this.file, 0o600);
      } catch {
        /* Windows may ignore POSIX mode. */
      }
    } catch {
      /* best effort */
    }
    return next;
  }

  // ---- Secrets (encrypted) -------------------------------------------------

  readSecrets() {
    try {
      if (existsSync(this.secretsFile)) {
        return JSON.parse(readFileSync(this.secretsFile, "utf8").replace(/^\uFEFF/, "")) || {};
      }
    } catch {
      /* ignore */
    }
    return {};
  }

  saveSecret(name, plain) {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret: ${name}`);
    const secrets = this.readSecrets();
    if (plain === undefined || plain === null || plain === "") delete secrets[name];
    else secrets[name] = this.encrypt(String(plain));
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
      try {
        chmodSync(this.secretsFile, 0o600);
      } catch {
        /* ignore */
      }
    } catch {
      /* best effort */
    }
  }

  hasSecret(name) {
    if (!SECRET_NAMES.includes(name)) return false;
    const secrets = this.readSecrets();
    if (secrets[name]) return true;
    // Legacy fallback: the CLI may have left a plaintext value in cli-config.json.
    const cfg = this.get();
    return name === "runtimeKey" ? Boolean(cfg.runtimeKey) : Boolean(cfg.authToken);
  }

  getSecret(name) {
    if (!SECRET_NAMES.includes(name)) return null;
    const secrets = this.readSecrets();
    if (secrets[name]) {
      try {
        const plain = this.decrypt(secrets[name]);
        return plain || null;
      } catch {
        return null;
      }
    }
    const cfg = this.get();
    return name === "runtimeKey" ? (cfg.runtimeKey || null) : (cfg.authToken || null);
  }

  secretSummary() {
    return {
      hasRuntimeKey: this.hasSecret("runtimeKey"),
      hasAuthToken: this.hasSecret("authToken")
    };
  }

  // ---- Permission profiles (v5 multi-path store) ---------------------------

  getPermissionStore() {
    try {
      if (existsSync(this.permissionFile)) {
        const raw = JSON.parse(readFileSync(this.permissionFile, "utf8").replace(/^\uFEFF/, ""));
        if (raw?.profiles && typeof raw.profiles === "object") return raw;
      }
    } catch {
      /* create a migrated store below */
    }
    const cfg = this.get();
    const workspace = cfg.workspace ? path.resolve(cfg.workspace) : "";
    return {
      version: 1,
      active_profile: cfg.permissionProfileName || "default",
      profiles: workspace
        ? {
            default: {
              version: 1,
              name: "default",
              description: "Local Coding Agent v5 multi-root profile",
              working_directory: workspace,
              roots: [{ label: "Primary workspace", path: workspace, preset: cfg.mode === "full" ? "full_control" : "develop" }]
            }
          }
        : {}
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
        if (!root?.path || !ROOT_PRESETS.includes(String(root.preset))) {
          throw new Error(`Permission profile ${name} contains an invalid root or preset.`);
        }
        const absoluteRoot = path.resolve(root.path);
        const isFsRoot = absoluteRoot === path.parse(absoluteRoot).root;
        if (!isFsRoot && inside(this.permissionFile, root.path)) {
          throw new Error("Permission profile storage must stay outside every authorized root.");
        }
      }
      if (!profile.roots.some((root) => inside(profile.working_directory, root.path))) {
        throw new Error(`Permission profile ${name} working_directory must be inside one of its roots.`);
      }
    }
    const normalized = { version: 1, ...store, active_profile: active };
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.permissionFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    } catch {
      /* best effort */
    }
    this.set({
      permissionProfileFile: this.permissionFile,
      permissionProfileName: active,
      workspace: path.resolve(normalized.profiles[active].working_directory)
    });
    return { file: this.permissionFile, store: normalized };
  }

  // ---- Tunnel profile YAML + URLs ------------------------------------------

  tunnelProfilePath(cfg) {
    const profileName = cfg.profile || "local-coding-agent";
    const fileName = profileName.toLowerCase().endsWith(".yaml") ? profileName : `${profileName}.yaml`;
    return path.join(cfg.profileDir || path.join(this.repoRoot, "tools", "profiles"), fileName);
  }

  tunnelProfileYaml(cfg) {
    if (!cfg.tunnelId || !String(cfg.tunnelId).trim()) {
      throw new Error("Tunnel ID is empty. Paste the tunnel_... ID from ChatGPT/OpenAI first.");
    }
    const tunnelId = String(cfg.tunnelId).trim();
    const organizationId = String(cfg.organizationId || "").trim();
    const lines = [
      "config_version: 1",
      "control_plane:",
      '  base_url: "https://api.openai.com"',
      `  tunnel_id: "${yamlEscape(tunnelId)}"`,
      '  api_key: "env:CONTROL_PLANE_API_KEY"'
    ];
    if (organizationId) {
      lines.push("  extra_headers:");
      lines.push(`    - "OpenAI-Organization: ${yamlEscape(organizationId)}"`);
    }
    lines.push("health:");
    lines.push('  listen_addr: "127.0.0.1:8788"');
    lines.push("admin_ui:");
    lines.push(`  open_browser: ${cfg.openWebUi ? "true" : "false"}`);
    lines.push("log:");
    lines.push("  level: info");
    lines.push("  format: json");
    lines.push("mcp:");
    lines.push("  server_urls:");
    lines.push("    - channel: main");
    lines.push(`      url: "${yamlEscape(this.mcpUrl(cfg))}"`);
    return `${lines.join("\n")}\n`;
  }

  writeTunnelProfile(cfg) {
    const yaml = this.tunnelProfileYaml(cfg);
    const file = this.tunnelProfilePath(cfg);
    try {
      if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, yaml, "utf8");
    } catch (error) {
      throw new Error(`Could not write tunnel profile ${file}: ${error.message}`);
    }
    return file;
  }

  mcpUrl(cfg) {
    return `http://127.0.0.1:${cfg.port}/mcp`;
  }

  dashboardUrl(cfg) {
    return `http://127.0.0.1:${cfg.dashboardPort}/ui`;
  }

  healthUrl(cfg) {
    return `http://127.0.0.1:${cfg.port}/healthz`;
  }

  // Startup-config fingerprint (same algorithm as scripts/start-tunnel.sh).
  configId(cfg) {
    const keys = ["workspace", "mode", "policy", "extraRoots", "permissionProfileFile", "permissionProfileName", "port", "dashboardPort"];
    const value = JSON.stringify(Object.fromEntries(keys.map((k) => [k, String(cfg[k] || "")])));
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }

  meta() {
    return {
      configDir: this.dir,
      configPath: this.file,
      permissionStorePath: this.permissionFile,
      logFile: this.logFile,
      repoRoot: this.repoRoot
    };
  }
}

export default ConfigStore;
