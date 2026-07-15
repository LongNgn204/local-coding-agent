// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rename,
  rm,
  appendFile,
  access,
  copyFile,
  cp
} from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ----------------------------------------------------------------------------
// Configuration (all overridable via environment variables)
// ----------------------------------------------------------------------------
const VERSION = "4.4.3-prodev";
const PRODUCT_TIER = "pro";
const PORT = Number(process.env.PORT || 8787);
// Bind to loopback by default. The local OpenAI tunnel-client forwards to this,
// so we never need to listen on 0.0.0.0 (which would expose a shell to the LAN).
const HOST = process.env.AGENT_HOST || "127.0.0.1";

// Local-only dashboard (metrics + charts). Deliberately a SEPARATE server bound
// to loopback so it is NOT forwarded through the tunnel to ChatGPT. Set
// DASHBOARD_PORT=0 to disable.
// NOTE: avoid 8788 — the OpenAI tunnel-client binds 127.0.0.1:8788 for its own
// health service, so using it here would stop the tunnel from starting.
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 8790);
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const CONFIG_ID = String(process.env.AGENT_CONFIG_ID || "");
const INTERNAL_HEALTH_PROBE_HEADER = "x-local-coding-agent-probe";
const INTERNAL_HEALTH_PROBE_TRAY = "tray";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = path.resolve(APP_DIR, "..", "agent-workspace");
const PRIMARY_ROOT = path.resolve(process.env.AGENT_WORKSPACE || DEFAULT_WORKSPACE);
const STARTUP_PROFILE = (() => {
  try {
    return JSON.parse(readFileSync(path.join(PRIMARY_ROOT, ".agent", "profile.json"), "utf8"));
  } catch {
    return null;
  }
})();
const EXTRA_ROOTS = parseExtraRoots();
const ROOTS = dedupe([PRIMARY_ROOT, ...EXTRA_ROOTS]);

// "safe" (default): file/command tools are confined to roots, destructive
// commands and absolute Windows paths inside commands are blocked.
// "full": full power inside roots, only catastrophic system commands stay
// blocked (unless AGENT_ALLOW_DANGEROUS=1).
const MODE = String(process.env.AGENT_MODE || STARTUP_PROFILE?.mode || "safe").toLowerCase() === "full" ? "full" : "safe";
const ALLOW_DANGEROUS = process.env.AGENT_ALLOW_DANGEROUS === "1";

// Optional defense-in-depth bearer token. If set, every /mcp request must send
// Authorization: Bearer <token>. Leave empty when relying on the
// OpenAI Secure MCP Tunnel, whose channel is already private to your account.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const APPROVAL_TOKEN = process.env.AGENT_APPROVAL_TOKEN || "";
const ALLOWED_ORIGINS = new Set(
  String(process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const DATA_DIR = path.resolve(APP_DIR, "data");
const WORKSPACE_ID = createHash("sha256").update(comparePath(PRIMARY_ROOT)).digest("hex").slice(0, 16);
const WORKSPACE_DATA_DIR = path.join(DATA_DIR, "workspaces", WORKSPACE_ID);
const NOTES_PATH = path.resolve(WORKSPACE_DATA_DIR, "notes.json");
const CHECKPOINT_PATH = path.resolve(WORKSPACE_DATA_DIR, "checkpoint.json");
const AUDIT_PATH = path.resolve(DATA_DIR, "audit.log");
const METRICS_PATH = path.resolve(DATA_DIR, "metrics.json");

// v2.1 Repo index cache
const INDEX_PATH = path.resolve(WORKSPACE_DATA_DIR, "index.json");

// v2.2 Patch history
const PATCH_HISTORY_PATH = path.resolve(WORKSPACE_DATA_DIR, "patch-history.json");
const BACKUPS_DIR = path.resolve(WORKSPACE_DATA_DIR, "backups");

// v2.5 Planner state
const AGENT_STATE_DIR = path.join(PRIMARY_ROOT, ".agent", "state");
const TASK_PLAN_PATH = path.join(AGENT_STATE_DIR, "current-task.json");
const DECISIONS_PATH = path.join(AGENT_STATE_DIR, "decisions.md");

// v2.6 Approvals
const APPROVALS_DIR = path.resolve(WORKSPACE_DATA_DIR, "approvals");
const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_TTL_MINUTES = boundedNumber(process.env.AGENT_APPROVAL_TTL_MINUTES, 10, 1, 30);

// v2.6 Policy
const AGENT_POLICY = (() => {
  const p = String(process.env.AGENT_POLICY || STARTUP_PROFILE?.policy || "balanced").toLowerCase();
  if (p === "strict" || p === "full") return p;
  return "balanced";
})();

// v2.8 Profile
let WORKSPACE_PROFILE = STARTUP_PROFILE;

// Skills: reusable playbooks the agent can load on demand (Claude-style).
// Discovered from: AGENT_SKILLS_DIR (env), the repo's shipped skills/, and each
// workspace root's .claude/skills and .agent/skills.
const SKILLS_DIRS = dedupe([
  ...(process.env.AGENT_SKILLS_DIR ? [path.resolve(process.env.AGENT_SKILLS_DIR)] : []),
  path.resolve(APP_DIR, "..", "skills"),
  ...ROOTS.flatMap((r) => [path.join(r, ".claude", "skills"), path.join(r, ".agent", "skills")])
]);

const MAX_READ_CHARS = Number(process.env.AGENT_MAX_READ_CHARS || 200_000);
// Default (not max) chars returned by read_file — keeps payloads small so the
// ChatGPT UI does not choke on huge file dumps. Callers can raise via max_chars.
const READ_DEFAULT = Number(process.env.AGENT_READ_DEFAULT || 12_000);
const CMD_OUTPUT_DEFAULT = Number(process.env.AGENT_CMD_OUTPUT_DEFAULT || 8_000);
const MAX_COMMAND_OUTPUT = Number(process.env.AGENT_MAX_COMMAND_OUTPUT || 200_000);
const MAX_BATCH_READ_CHARS = boundedNumber(process.env.AGENT_MAX_BATCH_READ_CHARS, 120_000, 10_000, 2_000_000);
const MAX_BODY_BYTES = Number(process.env.AGENT_MAX_BODY_BYTES || 16 * 1024 * 1024);
const DEFAULT_CMD_TIMEOUT = 60_000;
const MAX_PROCS = 24;
const PROC_BUFFER = 200_000;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "__pycache__",
  ...((Array.isArray(STARTUP_PROFILE?.ignoredDirs) ? STARTUP_PROFILE.ignoredDirs : []).map(String))
]);

// Always blocked, even in full mode, unless AGENT_ALLOW_DANGEROUS=1.
// These can brick the OS or wipe disks regardless of working directory.
const CATASTROPHIC = [
  // Disk format command only (e.g. "format C:", "format /fs:ntfs D:").
  // Must NOT match PowerShell's Format-Table / Format-List / -f format operator.
  /(^|[;&|]\s*)format(\.com)?\s+(\/|[a-z]:)/i,
  /\bdiskpart\b/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\bremove-item\b[^\n]*\b(c:\\\\|c:\/|\$env:systemroot|system32|windows\\\\)/i,
  /\b(rd|rmdir)\b\s+\/s[^\n]*\bc:\\\\/i,
  /\bdel\b[^\n]*\/s[^\n]*\bc:\\\\/i,
  /\bcipher\b\s+\/w/i,
  /\b(reg)\b\s+delete\s+hk(lm|ey_local_machine)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, // fork bomb
  // --- Unix / macOS / Linux ---
  /\brm\s+-[rRfile]*\s+(--no-preserve-root\s+)?\/(\s|$|\*)/i, // rm -rf /
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/i, // overwrite a disk
  /\bmkfs\.[a-z0-9]+\b/i,
  /\b(reboot|halt|poweroff|init\s+0)\b/i,
  /\bchmod\s+-R\s*0*\s+\//i,
  />\s*\/dev\/(sd|nvme|disk|hd)[a-z0-9]/i // write to raw disk
];

// Extra blocks that only apply in "safe" mode.
const SAFE_MODE_BLOCKS = [
  /\b(del|erase|rmdir|rd|remove-item|rm|format|shutdown|restart-computer|stop-computer|diskpart)\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\breg\s+delete\b/i,
  /\btakeown\b/i,
  /\bicacls\b/i,
  /[a-z]:\\/i,
  /(^|\s)~[\\/]/i
];

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
const processes = new Map(); // id -> { id, name, command, child, status, exitCode, startedAt, stdout, stderr }
let approvalLock = Promise.resolve();
const bootStartedAt = Date.now();

// ----------------------------------------------------------------------------
// Bootstrap
// ----------------------------------------------------------------------------
await mkdir(DATA_DIR, { recursive: true });
await mkdir(WORKSPACE_DATA_DIR, { recursive: true });
await mkdir(PRIMARY_ROOT, { recursive: true });
await mkdir(BACKUPS_DIR, { recursive: true });
await mkdir(APPROVALS_DIR, { recursive: true });
await mkdir(AGENT_STATE_DIR, { recursive: true });

let metrics = loadMetrics();

// v2.8 Load workspace profile on startup
await loadWorkspaceProfile();

// Detect ripgrep once at startup — the fastest search engine when present.
const RG_BIN = await detectRg();
if (RG_BIN) console.log("ripgrep detected: search_text/find_files will use rg");

function detectRg() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("rg", ["--version"], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? "rg" : null));
  });
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
    if (shouldLogHttpRequest(req, requestUrl)) {
      log(`${req.method} ${requestUrl.pathname} ua=${req.headers["user-agent"] || ""}`);
    }
    if (!originAllowed(req)) {
      return sendJson(res, 403, { error: "browser_origin_not_allowed" });
    }
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = requestUrl;
    if (req.method === "GET" && url.pathname === "/") {
      return sendHtml(res, homeHtml());
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, {
        status: "ok",
        version: VERSION,
        tier: PRODUCT_TIER,
        pid: process.pid,
        mode: MODE,
        policy: AGENT_POLICY,
        allow_dangerous: ALLOW_DANGEROUS,
        auth: AUTH_TOKEN ? "bearer" : "none",
        config_id: CONFIG_ID || null,
        roots: ROOTS,
        workspace: PRIMARY_ROOT,
        dashboard_port: DASHBOARD_PORT,
        mcp_endpoint: `http://${HOST}:${PORT}/mcp`
      });
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return sendJson(res, 200, oauthProtectedResourceMetadata());
    }
    if (url.pathname === "/mcp") {
      if (!checkAuth(req, url)) {
        return sendJson(res, 401, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized." },
          id: null
        });
      }
      return await handleMcp(req, res);
    }
    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      return sendJson(res, error?.statusCode || 500, { error: error?.message || "Internal Server Error" });
    }
  }
});

httpServer.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`FATAL: MCP port ${PORT} is already in use — another server instance is likely running. Exiting.`);
    saveMetricsSync();
    process.exit(1);
  }
  log(`httpServer error: ${err?.message || err}`);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Local Coding Agent v${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`Mode: ${MODE}${ALLOW_DANGEROUS ? " (+dangerous)" : ""}  Auth: ${AUTH_TOKEN ? "bearer" : "none (tunnel-only)"}`);
  console.log(`Roots:\n${ROOTS.map((r) => `  - ${r}`).join("\n")}`);
  console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
});

// Local-only dashboard server (not tunneled).
let dashServer = null;
if (DASHBOARD_PORT > 0) {
  dashServer = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
      if (!dashboardOriginAllowed(req)) return sendJson(res, 403, { error: "dashboard_origin_not_allowed" });
      if (url.pathname === "/metrics") return sendJson(res, 200, metricsSnapshot());
      if (url.pathname === "/ui") return sendHtml(res, dashboardHtml());
      // Mini-IDE JSON APIs (local-only, read-only except clear-metrics).
      if (url.pathname === "/api/tree") return void dashApiTree(url, res);
      if (url.pathname === "/api/file") return void dashApiFile(url, res);
      if (url.pathname === "/api/diff") return void dashApiDiff(url, res);
      if (url.pathname === "/api/approvals" && req.method === "GET") return void dashApiApprovals(res);
      if (url.pathname.startsWith("/api/approvals/") && req.method === "POST") return void dashApiApprovalAction(url, res);
      if (url.pathname === "/api/clear-metrics" && req.method === "POST") return void dashApiClearMetrics(res);
      if (url.pathname === "/api/customer-prompts") return void dashApiCustomerPrompts(res);
      if (url.pathname === "/") {
        res.writeHead(302, { Location: "/ui" });
        return res.end();
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      return sendJson(res, 500, { error: error?.message || "error" });
    }
  });
  dashServer.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`WARN: dashboard port ${DASHBOARD_PORT} is in use (the OpenAI tunnel uses 8788). Dashboard disabled. Set DASHBOARD_PORT to a free port. The MCP server keeps running.`);
    } else {
      log(`dashboard error: ${err?.message || err}`);
    }
    dashServer = null;
  });
  dashServer.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    console.log(`Dashboard (local only): http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/ui`);
  });
}

// Never let a single bad request take the whole server down.
process.on("uncaughtException", (err) => log(`uncaughtException: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err?.stack || err}`));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    saveMetricsSync();
    for (const proc of processes.values()) killProcessTree(proc);
    httpServer.close(() => process.exit(0));
    dashServer?.close();
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

// ----------------------------------------------------------------------------
// Auth + transport
// ----------------------------------------------------------------------------
function checkAuth(req, url) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers["authorization"] || "";
  const fromHeader = header.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(fromHeader, AUTH_TOKEN);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function handleMcp(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    });
  }
  const len = Number(req.headers["content-length"] || 0);
  if (len > MAX_BODY_BYTES) {
    return sendJson(res, 413, {
      jsonrpc: "2.0",
      error: { code: -32002, message: "Payload too large." },
      id: null
    });
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  await transport.handleRequest(req, res, body);
}

const SERVER_INSTRUCTIONS = [
  "Local Coding Agent Pro MCP: tool calls cross a tunnel, so start with workspace_snapshot or workspace_doctor, then use read_many/search_text/run_commands to batch work; prefer dedicated tools over run_command. Policy may require local dashboard approval for risky delete/install/network/mutating-git actions; exact action batches can use request_approval_batch. File tools are root-confined, but commands are not an OS sandbox.",
  "WORKFLOW: (1) Start with workspace_snapshot for repo/git/test/policy/health in one call; use workspace_doctor when you need operational readiness. (2) Use preview_patch/validate_patch before apply_patch for large edits. (3) After editing source, run quality_gate, run_tests, or run_changed_tests. (4) Before marking 'done', call review_diff and session_report. (5) For multi-step tasks, use task_plan + decision_log to maintain state across chats.",
  "POLICY: Check policy_status if you are unsure whether an action is allowed. In balanced policy, risky operations (delete, install, network, mutating git, risky processes) require one-time local approval.",
  "Use the DEDICATED tools instead of run_command for these — they are faster and cheaper:",
  "- Find files by name -> find_files (NOT dir/ls/Get-ChildItem/where).",
  "- Search file contents -> search_text with context= (NOT grep/findstr/Select-String).",
  "- Read files -> read_many for several or targeted ranges, read_file for one (NOT type/cat/Get-Content).",
  "- Run independent checks -> run_commands once; keep parallel=false unless commands cannot race.",
  "- Map a repo -> workspace_snapshot first, repo_map for deeper tree detail; use workspace_doctor for readiness checks.",
  "- Create/edit files -> write_file / apply_patch (with a unified `diff` for many edits) (NOT echo>/Set-Content).",
  "- Symbol search -> repo_symbols for function/class definitions.",
  "Reserve run_command for builds, tests, installs, running programs, and git. When you do use it:",
  "- Pass the `cwd` argument instead of cd/pushd.",
  "- Combine multiple steps into ONE command (&& on cmd/bash, ; on PowerShell).",
  "- Keep output small with tail_lines/head_lines/max_output_chars.",
  "Keep the conversation light: do NOT re-read a file you already read; read only the line range you need; never dump a whole large file or large command output unless asked.",
  "Anti-lag workflow: do not paste full logs, full diffs, base64 blobs, image/icon inventories, or repeated single-file reads into chat. Save detailed output to local files or reports, then return a compact summary with paths and next actions.",
  "Prefer targeted line ranges, globs, read_many with max_chars, and run_command/run_commands with max_output_chars so long ChatGPT Web threads stay responsive.",
  "When the conversation grows long or feels slow, call checkpoint() with a compact summary + next steps, then tell the user to open a NEW chat; in that fresh chat call resume() first. This resets the heavy context (faster) while keeping your progress.",
  "If a task matches an available skill, call list_skills first, then read_skill(name) to load its instructions before doing the work.",
  "Prefer a few large, well-targeted calls over many tiny ones."
].join("\n");

function createMcpServer() {
  const mcp = new McpServer({ name: "Local Coding Agent", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerBasicTools(mcp);
  registerFsReadTools(mcp);
  registerFsWriteTools(mcp);
  registerExecTools(mcp);
  registerProcessTools(mcp);
  registerGitTool(mcp);
  registerSkillTools(mcp);
  registerRepoIntelTools(mcp);    // v2.1
  registerPatchEngineTools(mcp);  // v2.2
  registerTestRunnerTools(mcp);   // v2.3
  registerReviewTools(mcp);       // v2.4
  registerPlannerTools(mcp);      // v2.5
  registerPolicyTools(mcp);       // v2.6
  registerProfileTools(mcp);      // v2.8
  return mcp;
}

function registerSkillTools(mcp) {
  reg(
    mcp,
    "list_skills",
    {
      title: "List skills",
      description: "List reusable skills (playbooks) available to load. Call this when a task might match a skill; it is cheap (names + descriptions only).",
      inputSchema: {}
    },
    async () => {
      const skills = await discoverSkills();
      return jsonResult({
        count: skills.length,
        skills: skills.map((s) => ({ name: s.name, description: s.description }))
      });
    }
  );

  reg(
    mcp,
    "read_skill",
    {
      title: "Read skill",
      description: "Load a skill's full instructions (SKILL.md) and its bundled file list. Call before doing work the skill covers.",
      inputSchema: { name: z.string().min(1).describe("Skill name from list_skills.") }
    },
    async ({ name }) => {
      const skills = await discoverSkills();
      const skill = skills.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
      if (!skill) throw new Error(`No skill named "${name}". Use list_skills to see available skills.`);
      const body = await readFile(skill.skillFile, "utf8");
      let files = [];
      try {
        files = (await readdir(skill.dir)).filter((f) => f.toLowerCase() !== "skill.md");
      } catch {
        /* ignore */
      }
      return jsonResult({ name: skill.name, dir: skill.dir, files, content: body.slice(0, MAX_READ_CHARS) });
    }
  );

  reg(
    mcp,
    "create_skill",
    {
      title: "Create skill",
      description: "Author a reusable skill: writes <skillsdir>/<name>/SKILL.md with YAML frontmatter (name, description) plus your body. Default skillsdir is <PRIMARY_ROOT>/.claude/skills. After this, list_skills will show it.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name (folder + frontmatter name), e.g. \"deploy-web\"."),
        description: z.string().min(1).describe("One-line description shown by list_skills."),
        body: z.string().describe("Markdown body of the skill (instructions). Written below the frontmatter."),
        dir: z.string().optional().describe("Skills directory to write into (must be inside a root). Default <PRIMARY_ROOT>/.claude/skills.")
      }
    },
    async ({ name, description, body, dir }) => {
      const folderName = sanitizeSkillName(name);
      if (!folderName) throw new Error("Invalid skill name. Use letters, digits, dot, dash or underscore.");
      const skillsDir = resolvePath(dir || defaultSkillsDir());
      const skillFolder = path.join(skillsDir, folderName);
      // Keep writes within a recognised skills dir (defense in depth).
      if (!isWithinSkillsDir(skillFolder)) {
        throw new Error("Refusing to write outside a skills directory.");
      }
      const skillFile = path.join(skillFolder, "SKILL.md");
      const frontName = String(name).replace(/"/g, '\\"');
      const frontDesc = String(description).replace(/\r?\n/g, " ").replace(/"/g, '\\"');
      const content = `---\nname: "${frontName}"\ndescription: "${frontDesc}"\n---\n\n${body || ""}${body && !body.endsWith("\n") ? "\n" : ""}`;
      await mkdir(skillFolder, { recursive: true });
      await writeFile(skillFile, content, "utf8");
      return jsonResult({ ok: true, name: folderName, dir: skillFolder, skill_file: skillFile });
    }
  );

  reg(
    mcp,
    "delete_skill",
    {
      title: "Delete skill",
      description: "Delete a skill folder (the directory holding its SKILL.md). Only removes folders located inside a skills directory.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name from list_skills."),
        dir: z.string().optional().describe("Skills directory to look in (must be inside a root). Default <PRIMARY_ROOT>/.claude/skills.")
      }
    },
    async ({ name, dir }) => {
      const skills = await discoverSkills();
      let target = null;
      const hit = skills.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
      if (hit) {
        target = hit.dir;
      } else {
        const folderName = sanitizeSkillName(name);
        if (folderName) target = path.join(resolvePath(dir || defaultSkillsDir()), folderName);
      }
      if (!target) throw new Error(`No skill named "${name}".`);
      const resolved = resolvePath(target);
      if (!isWithinSkillsDir(resolved)) {
        throw new Error("Refusing to delete a folder that is not inside a skills directory.");
      }
      if (!existsSync(resolved)) throw new Error(`No skill folder at ${resolved}.`);
      await rm(resolved, { recursive: true, force: true });
      return jsonResult({ ok: true, deleted: resolved });
    }
  );
}

// First workspace skills dir for authoring: <PRIMARY_ROOT>/.claude/skills.
function defaultSkillsDir() {
  return path.join(PRIMARY_ROOT, ".claude", "skills");
}

// Skill folder names: keep them simple path segments (no separators / traversal).
function sanitizeSkillName(name) {
  const s = String(name || "").trim();
  if (!s || s === "." || s === "..") return "";
  if (/[\\/]/.test(s) || !/^[\w.-]+$/.test(s)) return "";
  return s;
}

// A path is "inside a skills directory" if any segment of its parent chain is a
// known skills dir (from SKILLS_DIRS) or matches the .claude/skills | .agent/skills
// convention under a root. Used to confine create/delete to skills areas.
function isWithinSkillsDir(p) {
  const parent = path.dirname(p);
  const candidates = new Set(SKILLS_DIRS.map((d) => path.resolve(d)));
  candidates.add(path.resolve(defaultSkillsDir()));
  for (const root of ROOTS) {
    candidates.add(path.resolve(path.join(root, ".claude", "skills")));
    candidates.add(path.resolve(path.join(root, ".agent", "skills")));
  }
  return candidates.has(path.resolve(parent));
}

// ----------------------------------------------------------------------------
// Tool registration helper: audit + uniform error handling
// ----------------------------------------------------------------------------
function reg(mcp, name, def, handler) {
  mcp.registerTool(name, def, async (args, extra) => {
    const startedAt = isoNow();
    const startedMs = performance.now();
    const inChars = safeLen(args);
    let result;
    let ok = true;
    try {
      await enforceToolPolicy(name, args ?? {});
      result = await handler(args ?? {}, extra);
    } catch (err) {
      ok = false;
      result = { content: [{ type: "text", text: `ERROR: ${err?.message || err}` }], isError: true };
    }
    const success = ok && !result?.isError;
    const outChars = resultLen(result);
    const durationMs = Math.max(0, Math.round((performance.now() - startedMs) * 10) / 10);
    const errText = success ? null : firstText(result).slice(0, 200);
    audit({ ts: startedAt, tool: name, ok: success, durationMs, inChars, outChars, error: errText || undefined, args: summarizeArgs(args) });
    recordMetric(name, success, inChars, outChars, errText, durationMs);
    return result;
  });
}

// ----------------------------------------------------------------------------
// Basic tools
// ----------------------------------------------------------------------------
function registerBasicTools(mcp) {
  reg(
    mcp,
    "ping",
    {
      title: "Ping",
      description: "Check whether the local coding agent is reachable.",
      inputSchema: { message: z.string().optional().describe("Optional message to echo back.") }
    },
    async ({ message }) => textResult(`Local coding agent online (mode=${MODE}).${message ? ` Echo: ${message}` : ""}`)
  );

  reg(
    mcp,
    "workspace_info",
    {
      title: "Workspace info",
      description: "Return roots, mode, limits, host info, and safety rules.",
      inputSchema: {}
    },
    async () =>
      jsonResult({
        status: "ok",
        version: VERSION,
        tier: PRODUCT_TIER,
        mode: MODE,
        policy: AGENT_POLICY,
        allow_dangerous: ALLOW_DANGEROUS,
        auth: AUTH_TOKEN ? "bearer" : "none",
        roots: ROOTS,
        primary_root: PRIMARY_ROOT,
        host: { platform: os.platform(), release: os.release(), hostname: os.hostname(), cwd: process.cwd(), node: process.version },
        limits: {
          max_read_chars: MAX_READ_CHARS,
          max_batch_read_chars: MAX_BATCH_READ_CHARS,
          max_command_output: MAX_COMMAND_OUTPUT,
          max_procs: MAX_PROCS
        },
        running_processes: [...processes.values()].filter((p) => p.status === "running").length,
        safety:
          MODE === "full"
            ? ["File tools are root-confined; command cwd is root-confined but command execution is not an OS sandbox.", "Catastrophic system commands stay blocked unless AGENT_ALLOW_DANGEROUS=1.", "Paths outside the roots are rejected by file tools."]
            : ["File tools are root-confined; command cwd is root-confined but command execution is not an OS sandbox.", "Destructive commands and absolute Windows paths in commands are blocked.", "Switch to AGENT_MODE=full only for trusted automation."]
      })
  );

  reg(
    mcp,
    "save_note",
    {
      title: "Save note",
      description: "Save a note on the local machine for later retrieval.",
      inputSchema: { title: z.string().min(1), body: z.string().min(1) }
    },
    async ({ title, body }) => {
      const notes = await readNotes();
      const note = { id: randomUUID(), title, body, created_at: isoNow() };
      notes.unshift(note);
      await writeNotes(notes);
      return textResult(`Saved note "${title}" (${note.id}).`);
    }
  );

  reg(
    mcp,
    "list_notes",
    {
      title: "List notes",
      description: "List previously saved notes.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() }
    },
    async ({ limit = 10 }) => {
      const notes = (await readNotes()).slice(0, limit);
      if (!notes.length) return textResult("No notes saved yet.");
      return textResult(notes.map((n) => `- ${n.title} (${n.id})\n  ${n.body}`).join("\n"));
    }
  );

  reg(
    mcp,
    "checkpoint",
    {
      title: "Save a progress checkpoint",
      description: "Save a COMPACT summary of progress so the user can start a fresh, fast chat and you can continue. Call this when the conversation gets long/slow, then tell the user to open a new chat and you will call resume().",
      inputSchema: {
        summary: z.string().min(1).describe("What has been done so far, the goal, and current state — concise."),
        next_steps: z.array(z.string()).optional().describe("Ordered remaining steps."),
        files_touched: z.array(z.string()).optional().describe("Key files involved.")
      }
    },
    async ({ summary, next_steps = [], files_touched = [] }) => {
      // v2.5: snapshot current-task.json into checkpoints dir
      try {
        const cpStateDir = path.join(AGENT_STATE_DIR, "checkpoints");
        await mkdir(cpStateDir, { recursive: true });
        if (existsSync(TASK_PLAN_PATH)) {
          const taskPlan = await readFile(TASK_PLAN_PATH, "utf8");
          await writeFile(path.join(cpStateDir, `task-${Date.now()}.json`), taskPlan, "utf8");
        }
      } catch { /* best-effort */ }
      const cp = { saved_at: isoNow(), summary, next_steps, files_touched };
      await mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
      await writeFile(CHECKPOINT_PATH, `${JSON.stringify(cp, null, 2)}\n`, "utf8");
      return textResult("Checkpoint saved. Tell the user to open a NEW chat (resets the heavy context), then call resume() to continue.");
    }
  );

  reg(
    mcp,
    "resume",
    {
      title: "Resume from last checkpoint",
      description: "Load the last checkpoint saved by checkpoint(). Call this FIRST in a fresh chat to continue prior work without the old heavy context.",
      inputSchema: {}
    },
    async () => {
      try {
        const cp = JSON.parse(await readFile(CHECKPOINT_PATH, "utf8"));
        return jsonResult(cp);
      } catch {
        return textResult("No checkpoint saved yet.");
      }
    }
  );
}

// ----------------------------------------------------------------------------
// Filesystem read tools
// ----------------------------------------------------------------------------
function registerFsReadTools(mcp) {
  reg(
    mcp,
    "list_files",
    {
      title: "List files",
      description: "List files and folders under a root (or absolute path inside a root).",
      inputSchema: {
        path: z.string().optional().describe("Directory path. Relative paths resolve against the primary root."),
        recursive: z.boolean().optional(),
        limit: z.number().int().min(1).max(2000).optional()
      }
    },
    async ({ path: rel = ".", recursive = false, limit = 200 }) => {
      const dir = resolvePath(rel);
      const entries = await listEntries(dir, { recursive, limit });
      return jsonResult({ path: toRel(dir), count: entries.length, entries });
    }
  );

  reg(
    mcp,
    "read_file",
    {
      title: "Read file",
      description: "Read ONE UTF-8 text file (supports line ranges). If you need several files, call read_many ONCE instead of calling this repeatedly — it is far faster over the network. For large files, pass start_line/line_count to read only the part you need.",
      inputSchema: {
        path: z.string().min(1),
        start_line: z.number().int().min(1).optional().describe("1-based first line to return."),
        line_count: z.number().int().min(1).max(20000).optional().describe("Number of lines to return from start_line."),
        max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional().describe(`Max chars to return (default ${READ_DEFAULT}).`)
      }
    },
    async ({ path: rel, start_line, line_count, max_chars = READ_DEFAULT }) => {
      const filePath = resolvePath(rel);
      const content = await readFile(filePath, "utf8");
      const allLines = content.split(/\r?\n/);
      if (start_line || line_count) {
        const from = (start_line || 1) - 1;
        const to = line_count ? from + line_count : allLines.length;
        const slice = allLines.slice(from, to).join("\n");
        return jsonResult({
          path: toRel(filePath),
          total_lines: allLines.length,
          start_line: from + 1,
          returned_lines: Math.min(to, allLines.length) - from,
          content: slice.length > max_chars ? slice.slice(0, max_chars) : slice,
          truncated: slice.length > max_chars
        });
      }
      const truncated = content.length > max_chars;
      return jsonResult({
        path: toRel(filePath),
        total_lines: allLines.length,
        chars: content.length,
        truncated,
        content: truncated ? content.slice(0, max_chars) : content
      });
    }
  );

  reg(
    mcp,
    "stat_path",
    {
      title: "Stat path",
      description: "Return metadata about a file or directory.",
      inputSchema: { path: z.string().min(1) }
    },
    async ({ path: rel }) => {
      const target = resolvePath(rel);
      const info = await stat(target);
      return jsonResult({
        path: toRel(target),
        type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        size: info.size,
        modified: info.mtime.toISOString(),
        created: info.birthtime.toISOString()
      });
    }
  );

  reg(
    mcp,
    "search_text",
    {
      title: "Search text",
      description: "Search text under a path (ripgrep > git grep > file scan, picked automatically). Prefer this over reading many files. Pass context>0 to get surrounding lines so you usually do NOT need a follow-up read_file. Pass glob (e.g. \"*.ts\") to limit file types.",
      inputSchema: {
        query: z.string().min(1),
        path: z.string().optional(),
        regex: z.boolean().optional(),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
        context: z.number().int().min(0).max(10).optional().describe("Lines of context before/after each match."),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ query, path: rel = ".", regex = false, glob, context = 0, limit = 100 }) => {
      const start = resolvePath(rel);
      // Tolerate a broken regex: fall back to a literal substring search instead
      // of erroring out.
      let useRegex = regex;
      let regexFallback = false;
      if (regex) {
        try {
          new RegExp(query);
        } catch {
          useRegex = false;
          regexFallback = true;
        }
      }
      let engine = "scan";
      let matches = null;
      const info = await stat(start).catch(() => null);
      const isDir = info && info.isDirectory();
      if (isDir && RG_BIN) {
        matches = await ripgrepGrep(start, query, { regex: useRegex, limit, glob });
        if (matches) engine = "ripgrep";
      }
      if (matches === null && isDir) {
        matches = await gitGrep(start, query, { regex: useRegex, limit, glob });
        if (matches) engine = "git";
      }
      if (matches === null) matches = await searchTree(start, query, { regex: useRegex, limit, glob });
      if (context > 0 && matches.length) await attachContext(matches, context);
      return jsonResult({ query, regex: useRegex, regex_fallback: regexFallback, engine, context, count: matches.length, matches });
    }
  );

  reg(
    mcp,
    "find_files",
    {
      title: "Find files",
      description: "List file paths matching a name glob (ripgrep > git ls-files > scan). Fast way to locate files (e.g. glob \"*.config.ts\") instead of listing directories one by one.",
      inputSchema: {
        glob: z.string().min(1).describe('Name glob, e.g. "*.ts" or "**/Dockerfile".'),
        path: z.string().optional().describe("Directory to search under."),
        limit: z.number().int().min(1).max(2000).optional()
      }
    },
    async ({ glob, path: rel = ".", limit = 300 }) => {
      const start = resolvePath(rel);
      const { files, engine } = await findFiles(start, glob, limit);
      return jsonResult({ glob, engine, count: files.length, files });
    }
  );

  reg(
    mcp,
    "read_many",
    {
      title: "Read many files",
      description: "Read up to 100 files or targeted line ranges in ONE call. Reads run concurrently with a bounded worker pool and a total output cap, cutting tunnel round-trips without flooding context.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(100).optional().describe("Simple file paths to read."),
        requests: z.array(z.object({
          path: z.string().min(1),
          start_line: z.number().int().min(1).optional(),
          line_count: z.number().int().min(1).max(10000).optional(),
          max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional()
        })).min(1).max(100).optional().describe("Structured reads with optional line ranges. Use either paths or requests."),
        max_chars_per_file: z.number().int().min(1).max(MAX_READ_CHARS).optional(),
        concurrency: z.number().int().min(1).max(16).optional().describe("Concurrent local reads (default 8).")
      }
    },
    async ({ paths, requests, max_chars_per_file = 40_000, concurrency = 8 }) => {
      if (paths?.length && requests?.length) throw new Error("Use either paths or requests, not both.");
      const items = requests?.length ? requests : (paths || []).map((p) => ({ path: p }));
      if (!items.length) throw new Error("Provide at least one path or read request.");

      const files = new Array(items.length);
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          const request = items[index];
          try {
            const fp = resolvePath(request.path);
            const content = await readFile(fp, "utf8");
            const maxChars = request.max_chars || max_chars_per_file;
            if (request.start_line || request.line_count) {
              const lines = content.split(/\r?\n/);
              const start = request.start_line || 1;
              const count = request.line_count || lines.length;
              const selected = lines.slice(start - 1, start - 1 + count).join("\n");
              files[index] = {
                path: toRel(fp),
                total_lines: lines.length,
                start_line: start,
                returned_lines: Math.min(count, Math.max(0, lines.length - start + 1)),
                chars: selected.length,
                truncated: selected.length > maxChars,
                content: selected.slice(0, maxChars)
              };
              continue;
            }
            files[index] = {
              path: toRel(fp),
              chars: content.length,
              truncated: content.length > maxChars,
              content: content.slice(0, maxChars)
            };
          } catch (err) {
            files[index] = { path: request.path, error: String(err?.message || err) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

      let remaining = MAX_BATCH_READ_CHARS;
      let batchTruncated = false;
      for (const file of files) {
        if (typeof file.content !== "string") continue;
        if (file.content.length > remaining) {
          file.content = file.content.slice(0, Math.max(0, remaining));
          file.truncated = true;
          file.batch_truncated = true;
          batchTruncated = true;
        }
        remaining = Math.max(0, remaining - file.content.length);
      }
      return jsonResult({
        count: files.length,
        failed: files.filter((f) => f.error).length,
        chars_returned: MAX_BATCH_READ_CHARS - remaining,
        max_batch_chars: MAX_BATCH_READ_CHARS,
        batch_truncated: batchTruncated,
        files
      });
    }
  );

  reg(
    mcp,
    "repo_overview",
    {
      title: "Repo overview",
      description: "One call: a compact directory tree plus detected manifest/config files. Start here to map a repo instead of probing file-by-file.",
      inputSchema: {
        path: z.string().optional().describe("Directory to map. Defaults to the primary root."),
        depth: z.number().int().min(1).max(6).optional().describe("Tree depth (default 3)."),
        max_entries: z.number().int().min(10).max(4000).optional().describe("Max tree entries (default 800).")
      }
    },
    async ({ path: rel = ".", depth = 3, max_entries = 800 }) => {
      const start = resolvePath(rel);
      const { tree, dirs, files } = await buildTree(start, depth, max_entries);
      const manifests = files.filter((f) => MANIFEST_NAMES.has(path.basename(f).toLowerCase()));
      return jsonResult({
        root: toRel(start),
        depth,
        dirs: dirs.length,
        files: files.length,
        truncated: tree.length >= max_entries,
        manifests: manifests.map(toRel).slice(0, 100),
        tree: tree.map(toRel)
      });
    }
  );
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "tsconfig.json",
  "pubspec.yaml",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "requirements.txt",
  "pyproject.toml",
  "gemfile",
  "composer.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "readme.md",
  ".env.example"
]);

async function buildTree(start, maxDepth, maxEntries) {
  const tree = [];
  const dirs = [];
  const files = [];
  async function walk(current, depth) {
    if (tree.length >= maxEntries || depth > maxDepth) return;
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    // directories first, then files, alphabetical — predictable for the model
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const item of items) {
      if (tree.length >= maxEntries) return;
      if (SKIP_DIRS.has(item.name)) continue;
      const abs = path.join(current, item.name);
      tree.push(item.isDirectory() ? abs + path.sep : abs);
      if (item.isDirectory()) {
        dirs.push(abs);
        await walk(abs, depth + 1);
      } else {
        files.push(abs);
      }
    }
  }
  await walk(start, 1);
  return { tree, dirs, files };
}

// ----------------------------------------------------------------------------
// Filesystem write tools
// ----------------------------------------------------------------------------
function registerFsWriteTools(mcp) {
  reg(
    mcp,
    "write_file",
    {
      title: "Write file",
      description: "Create or overwrite a UTF-8 text file.",
      inputSchema: { path: z.string().min(1), content: z.string() }
    },
    async ({ path: rel, content }) => {
      const filePath = resolvePath(rel);
      await createBackupBatch("write_file", [filePath]);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      return jsonResult({ ok: true, path: toRel(filePath), bytes: Buffer.byteLength(content) });
    }
  );

  reg(
    mcp,
    "replace_in_file",
    {
      title: "Replace in file",
      description: "Replace exact text in ONE file. If you are making several edits (in one or many files), call apply_patch ONCE with all of them instead of calling this repeatedly — fewer round trips, much faster.",
      inputSchema: {
        path: z.string().min(1),
        old_text: z.string().min(1),
        new_text: z.string(),
        replace_all: z.boolean().optional()
      }
    },
    async ({ path: rel, old_text, new_text, replace_all = false }) => {
      const filePath = resolvePath(rel);
      await createBackupBatch("replace_in_file", [filePath]);
      const content = await readFile(filePath, "utf8");
      if (!content.includes(old_text)) throw new Error(`old_text not found in ${filePath}`);
      const next = replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, new_text);
      await writeFile(filePath, next, "utf8");
      return jsonResult({ ok: true, path: toRel(filePath), replacements: replace_all ? content.split(old_text).length - 1 : 1 });
    }
  );

  reg(
    mcp,
    "apply_patch",
    {
      title: "Apply patch",
      description: "Apply MANY edits in ONE call. Two modes: (a) `diff` = a standard unified diff covering one or more files (preferred for multi-file edits), or (b) `operations` = structured create/update/delete/rename. Use this instead of many replace_in_file calls.",
      inputSchema: {
        diff: z.string().optional().describe("A unified diff (---/+++/@@). Applies by matching context, ignoring line numbers."),
        operations: z
          .array(
            z.object({
              op: z.enum(["create", "update", "delete", "rename"]),
              path: z.string().min(1),
              content: z.string().optional().describe("For create: full file content."),
              rename_to: z.string().optional().describe("For rename: destination path."),
              recursive: z.boolean().optional().describe("For delete of a directory."),
              edits: z
                .array(z.object({ old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }))
                .optional()
                .describe("For update: ordered text replacements.")
            })
          )
          .optional()
      }
    },
    async ({ diff, operations }) => {
      if (diff && diff.trim()) {
        // Collect affected file paths for backup
        const affectedPaths = new Set();
        for (const line of diff.split(/\r?\n/)) {
          if ((line.startsWith("--- ") || line.startsWith("+++ ")) && !line.includes("/dev/null")) {
            const p = line.slice(4).replace(/^[ab]\//, "").trim();
            if (p) {
              try { affectedPaths.add(resolvePath(p)); } catch { /* apply will report invalid paths */ }
            }
          }
        }
        if (affectedPaths.size > 0) await createBackupBatch("apply_patch_diff", [...affectedPaths]);
        const results = await applyUnifiedDiff(diff);
        const ok = results.every((r) => r.ok);
        return jsonResult({ ok, mode: "diff", applied: results.filter((r) => r.ok).length, results });
      }
      if (!operations || !operations.length) {
        throw new Error("Provide either `diff` or a non-empty `operations` array.");
      }
      // Backup existing files that will be modified/deleted
      const pathsToBackup = operations
        .flatMap((op) => [op.path, ...(op.op === "rename" && op.rename_to ? [op.rename_to] : [])])
        .map((p) => { try { return resolvePath(p); } catch { return null; } })
        .filter(Boolean);
      if (pathsToBackup.length > 0) await createBackupBatch("apply_patch_ops", pathsToBackup);
      const results = [];
      for (const op of operations) {
        try {
          results.push(await applyOne(op));
        } catch (err) {
          results.push({ op: op.op, path: op.path, ok: false, error: String(err?.message || err) });
          break; // stop on first failure to keep state predictable
        }
      }
      const ok = results.every((r) => r.ok);
      return jsonResult({ ok, mode: "operations", applied: results.filter((r) => r.ok).length, results });
    }
  );

  reg(
    mcp,
    "make_dir",
    {
      title: "Make directory",
      description: "Create a directory (recursive).",
      inputSchema: { path: z.string().min(1) }
    },
    async ({ path: rel }) => {
      const dir = resolvePath(rel);
      await mkdir(dir, { recursive: true });
      return jsonResult({ ok: true, path: toRel(dir) });
    }
  );

  reg(
    mcp,
    "move_path",
    {
      title: "Move / rename",
      description: "Move or rename a file or directory. Both ends must be inside the roots.",
      inputSchema: { from: z.string().min(1), to: z.string().min(1) }
    },
    async ({ from, to }) => {
      const src = resolvePath(from);
      const dst = resolvePath(to);
      await createBackupBatch("move_path", [src, dst]);
      await mkdir(path.dirname(dst), { recursive: true });
      await rename(src, dst);
      return jsonResult({ ok: true, from: toRel(src), to: toRel(dst) });
    }
  );

  reg(
    mcp,
    "delete_path",
    {
      title: "Delete path",
      description: "Delete a file or directory inside the roots. Directories require recursive=true.",
      inputSchema: { path: z.string().min(1), recursive: z.boolean().optional() }
    },
    async ({ path: rel, recursive = false }) => {
      const target = resolvePath(rel);
      if (target === PRIMARY_ROOT || ROOTS.includes(target)) throw new Error("Refusing to delete a configured root.");
      const info = await stat(target);
      if (info.isDirectory() && !recursive) throw new Error("Path is a directory; pass recursive=true to delete it.");
      if (info.isFile()) await createBackupBatch("delete_path", [target]);
      await rm(target, { recursive, force: false });
      return jsonResult({ ok: true, deleted: toRel(target) });
    }
  );
}

// Apply a unified diff by CONTENT matching (ignores the @@ line numbers, which
// models often get wrong). Each hunk's context+removed lines must appear in the
// file; they are replaced by its context+added lines.
async function applyUnifiedDiff(diffText) {
  const results = [];
  const lines = diffText.split(/\r?\n/);
  const fileChunks = [];
  let current = null;

  const stripPrefix = (p) => p.replace(/^["']|["']$/g, "").replace(/^[ab]\//, "").trim();

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("--- ")) {
      const next = lines[i + 1] || "";
      const minus = stripPrefix(ln.slice(4));
      const plus = next.startsWith("+++ ") ? stripPrefix(next.slice(4)) : "";
      current = { minus, plus, hunks: [], hunk: null };
      fileChunks.push(current);
      if (next.startsWith("+++ ")) i++;
      continue;
    }
    if (!current) continue;
    if (ln.startsWith("@@")) {
      current.hunk = { before: [], after: [] };
      current.hunks.push(current.hunk);
      continue;
    }
    if (!current.hunk) continue;
    const tag = ln[0];
    const body = ln.slice(1);
    if (tag === " ") {
      current.hunk.before.push(body);
      current.hunk.after.push(body);
    } else if (tag === "-") {
      current.hunk.before.push(body);
    } else if (tag === "+") {
      current.hunk.after.push(body);
    } else if (ln === "\\ No newline at end of file") {
      // ignore
    }
  }

  for (const fc of fileChunks) {
    const isNew = fc.minus === "/dev/null";
    const isDelete = fc.plus === "/dev/null";
    const relPath = isNew ? fc.plus : fc.minus || fc.plus;
    try {
      const target = resolvePath(relPath);
      if (isDelete) {
        await rm(target, { force: true });
        results.push({ path: toRel(target), ok: true, action: "delete" });
        continue;
      }
      if (isNew) {
        const content = fc.hunks.flatMap((h) => h.after).join("\n");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content.endsWith("\n") ? content : content + "\n", "utf8");
        results.push({ path: toRel(target), ok: true, action: "create" });
        continue;
      }
      let content = await readFile(target, "utf8");
      let applied = 0;
      for (const h of fc.hunks) {
        const before = h.before.join("\n");
        const after = h.after.join("\n");
        if (before === after) continue;
        if (before && content.includes(before)) {
          content = content.replace(before, after);
          applied++;
        } else if (!before) {
          content += (content.endsWith("\n") ? "" : "\n") + after;
          applied++;
        } else {
          throw new Error(`hunk context not found in ${toRel(target)}`);
        }
      }
      await writeFile(target, content, "utf8");
      results.push({ path: toRel(target), ok: true, action: "update", hunks: applied });
    } catch (err) {
      results.push({ path: relPath, ok: false, error: String(err?.message || err) });
      break;
    }
  }
  if (!fileChunks.length) throw new Error("No file sections found in diff (need ---/+++ headers).");
  return results;
}

async function applyOne(op) {
  const target = resolvePath(op.path);
  if (op.op === "create") {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, op.content ?? "", "utf8");
    return { op: "create", path: toRel(target), ok: true, bytes: Buffer.byteLength(op.content ?? "") };
  }
  if (op.op === "update") {
    let content = await readFile(target, "utf8");
    let count = 0;
    for (const edit of op.edits || []) {
      if (!content.includes(edit.old_text)) throw new Error(`old_text not found in ${target}`);
      if (edit.replace_all) {
        count += content.split(edit.old_text).length - 1;
        content = content.split(edit.old_text).join(edit.new_text);
      } else {
        content = content.replace(edit.old_text, edit.new_text);
        count += 1;
      }
    }
    await writeFile(target, content, "utf8");
    return { op: "update", path: toRel(target), ok: true, replacements: count };
  }
  if (op.op === "delete") {
    if (target === PRIMARY_ROOT || ROOTS.includes(target)) throw new Error("Refusing to delete a configured root.");
    await rm(target, { recursive: Boolean(op.recursive), force: false });
    return { op: "delete", path: toRel(target), ok: true };
  }
  if (op.op === "rename") {
    if (!op.rename_to) throw new Error("rename requires rename_to");
    const dst = resolvePath(op.rename_to);
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(target, dst);
    return { op: "rename", path: toRel(target), to: toRel(dst), ok: true };
  }
  throw new Error(`Unknown op: ${op.op}`);
}

// ----------------------------------------------------------------------------
// Command execution
// ----------------------------------------------------------------------------
function registerExecTools(mcp) {
  reg(
    mcp,
    "run_command",
    {
      title: "Run command",
      description: "Run a command and wait for it to finish. Use proc_start for long-running servers. Output is trimmed to keep payloads small — use tail_lines/head_lines or max_output_chars to control it.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional().describe("Working directory inside a root."),
        shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional().describe("Shell to use (default cmd on Windows, bash/sh on macOS/Linux)."),
        timeout_ms: z.number().int().min(1000).max(600000).optional(),
        tail_lines: z.number().int().min(1).max(5000).optional().describe("Return only the last N lines of output."),
        head_lines: z.number().int().min(1).max(5000).optional().describe("Return only the first N lines of output."),
        max_output_chars: z.number().int().min(500).max(MAX_COMMAND_OUTPUT).optional().describe(`Cap stdout/stderr chars (default ${CMD_OUTPUT_DEFAULT}).`)
      }
    },
    async ({ command, cwd = ".", shell, timeout_ms = DEFAULT_CMD_TIMEOUT, tail_lines, head_lines, max_output_chars = CMD_OUTPUT_DEFAULT }) => {
      assertCommandAllowed(command);
      const workdir = resolvePath(cwd);
      const result = await runShellCommand(command, workdir, shell, timeout_ms);
      const trim = (s) => trimOutput(s, { tail_lines, head_lines, max_chars: max_output_chars });
      const stdout = trim(result.stdout);
      const stderr = trim(result.stderr);
      return jsonResult({
        cwd: workdir,
        command,
        shell: shell || defaultShell(),
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        stdout_truncated: stdout.length < result.stdout.length,
        stderr_truncated: stderr.length < result.stderr.length,
        stdout,
        stderr
      });
    }
  );

  reg(
    mcp,
    "run_commands",
    {
      title: "Run command batch",
      description: "Run up to 12 bounded commands in one MCP call. Sequential is the safe default; set parallel=true only for independent checks. Each command still passes mode, policy, root, timeout, and output guards.",
      inputSchema: {
        commands: z.array(z.object({
          command: z.string().min(1),
          cwd: z.string().optional(),
          shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
          timeout_ms: z.number().int().min(1000).max(600000).optional(),
          max_output_chars: z.number().int().min(500).max(50_000).optional()
        })).min(1).max(12),
        parallel: z.boolean().optional().describe("Run independent commands concurrently (default false)."),
        max_concurrency: z.number().int().min(1).max(4).optional(),
        stop_on_failure: z.boolean().optional().describe("Sequential mode only; default true.")
      }
    },
    async ({ commands, parallel = false, max_concurrency = 4, stop_on_failure = true }) => {
      const results = new Array(commands.length);
      const runOne = async (item, index) => {
        assertCommandAllowed(item.command);
        const workdir = resolvePath(item.cwd || ".");
        const result = await runShellCommand(item.command, workdir, item.shell, item.timeout_ms || DEFAULT_CMD_TIMEOUT);
        const maxChars = item.max_output_chars || 10_000;
        const stdout = trimOutput(result.stdout, { max_chars: maxChars });
        const stderr = trimOutput(result.stderr, { max_chars: maxChars });
        results[index] = {
          index,
          cwd: workdir,
          command: item.command,
          shell: item.shell || defaultShell(),
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          stdout_truncated: stdout.length < result.stdout.length,
          stderr_truncated: stderr.length < result.stderr.length,
          stdout,
          stderr
        };
      };

      if (parallel) {
        let cursor = 0;
        const worker = async () => {
          while (true) {
            const index = cursor++;
            if (index >= commands.length) return;
            await runOne(commands[index], index);
          }
        };
        await Promise.all(Array.from({ length: Math.min(max_concurrency, commands.length) }, () => worker()));
      } else {
        for (let index = 0; index < commands.length; index++) {
          await runOne(commands[index], index);
          if (stop_on_failure && results[index].exit_code !== 0) break;
        }
      }

      const completed = results.filter(Boolean);
      return jsonResult({
        ok: completed.length === commands.length && completed.every((result) => result.exit_code === 0),
        parallel,
        requested: commands.length,
        completed: completed.length,
        stopped_early: completed.length < commands.length,
        results: completed
      });
    }
  );
}

function registerProcessTools(mcp) {
  reg(
    mcp,
    "proc_start",
    {
      title: "Start background process",
      description: "Start a long-running process (dev server, watcher). Returns an id to poll.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional(),
        shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
        name: z.string().optional()
      }
    },
    async ({ command, cwd = ".", shell, name }) => {
      assertCommandAllowed(command);
      const running = [...processes.values()].filter((p) => p.status === "running").length;
      if (running >= MAX_PROCS) throw new Error(`Too many running processes (max ${MAX_PROCS}). Stop some first.`);
      const workdir = resolvePath(cwd);
      const proc = startBackground(command, workdir, shell, name);
      return jsonResult({ ok: true, id: proc.id, name: proc.name, command, cwd: workdir, pid: proc.child.pid });
    }
  );

  reg(
    mcp,
    "proc_list",
    {
      title: "List background processes",
      description: "List background processes started by this agent.",
      inputSchema: {}
    },
    async () =>
      jsonResult({
        processes: [...processes.values()].map((p) => ({
          id: p.id,
          name: p.name,
          command: p.command,
          status: p.status,
          exit_code: p.exitCode,
          pid: p.child?.pid,
          started_at: p.startedAt
        }))
      })
  );

  reg(
    mcp,
    "proc_output",
    {
      title: "Read process output",
      description: "Return buffered stdout/stderr of a background process.",
      inputSchema: { id: z.string().min(1), tail_chars: z.number().int().min(1).max(PROC_BUFFER).optional() }
    },
    async ({ id, tail_chars }) => {
      const proc = processes.get(id);
      if (!proc) throw new Error(`No process with id ${id}`);
      const tail = (s) => (tail_chars && s.length > tail_chars ? s.slice(-tail_chars) : s);
      return jsonResult({
        id,
        status: proc.status,
        exit_code: proc.exitCode,
        stdout: tail(proc.stdout),
        stderr: tail(proc.stderr)
      });
    }
  );

  reg(
    mcp,
    "proc_stop",
    {
      title: "Stop background process",
      description: "Terminate a background process (and its child tree).",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      const proc = processes.get(id);
      if (!proc) throw new Error(`No process with id ${id}`);
      killProcessTree(proc);
      return jsonResult({ ok: true, id, status: proc.status });
    }
  );
}

// Git flags blocked on the raw `git` tool (any mode): they can write arbitrary
// files, run external programs, or operate outside the resolved repo.
const BAD_GIT_FLAGS = [
  /^-c$/, /^-C$/,
  /^--git-dir(=|$)/i, /^--work-tree(=|$)/i,
  /^--output(=|$)/i, /^--no-index$/i, /^--ext-diff$/i,
  /^--exec-path(=|$)/i, /^--upload-pack(=|$)/i, /^--receive-pack(=|$)/i
];

// Read-only git subcommands allowed in safe mode (mutating ones need full mode).
const GIT_READONLY = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-tree", "rev-parse", "blame",
  "grep", "cat-file", "describe", "shortlog", "reflog", "whatchanged", "name-rev",
  "merge-base", "symbolic-ref", "for-each-ref", "count-objects", "version", "help"
]);

function registerGitTool(mcp) {
  reg(
    mcp,
    "git",
    {
      title: "Git",
      description: "Run a git command. Pass args as an array, e.g. [\"status\",\"--short\"].",
      inputSchema: {
        args: z.array(z.string()).min(1).describe('Git arguments, e.g. ["log","--oneline","-n","10"].'),
        cwd: z.string().optional().describe("Repository directory inside a root.")
      }
    },
    async ({ args, cwd = "." }) => {
      // Always block flags that can write files, run external programs, or escape
      // the repo — even on "read" subcommands (e.g. `git diff --output=../x`,
      // `-c core.pager=...`, `--ext-diff`, `--git-dir`/`--work-tree`).
      if (args.some((a) => BAD_GIT_FLAGS.some((re) => re.test(a)))) {
        throw new Error("That git flag is blocked (can write files, run external programs, or escape the repo).");
      }
      if (MODE !== "full") {
        // safe mode: only allow read-only git subcommands. Mutations
        // (restore, checkout --, rm, branch -D, push --force, reset, clean, …)
        // require AGENT_MODE=full.
        const sub = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
        const infoFlag = args.some((a) => /^(--version|--help)$/i.test(a) || /^-[vh]$/.test(a));
        if (!infoFlag && !GIT_READONLY.has(sub)) {
          throw new Error(
            `Git "${sub || args[0] || ""}" is blocked in safe mode (only read-only git is allowed). Use git_status/git_diff, or set AGENT_MODE=full.`
          );
        }
      }
      const workdir = resolvePath(cwd);
      const result = await spawnCapture("git", args, workdir, DEFAULT_CMD_TIMEOUT);
      return jsonResult({ cwd: workdir, args, ...result });
    }
  );

  reg(
    mcp,
    "git_status",
    {
      title: "Git status",
      description: "Parsed working-tree status (git status --porcelain) for a repo inside a root. Returns a structured list of changed files with their index/worktree codes.",
      inputSchema: {
        cwd: z.string().optional().describe("Repository directory inside a root (default the primary root).")
      }
    },
    async ({ cwd = "." }) => {
      const workdir = resolvePath(cwd);
      const result = await spawnCapture("git", ["status", "--porcelain"], workdir, DEFAULT_CMD_TIMEOUT);
      if (result.exit_code !== 0) {
        // Not a git repo (or git error) — don't pretend it's "clean".
        return jsonResult({
          cwd: workdir,
          is_git_repo: false,
          clean: null,
          error: (result.stderr || "git error").split(/\r?\n/)[0]
        });
      }
      const branchRes = await spawnCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], workdir, DEFAULT_CMD_TIMEOUT);
      const files = parsePorcelain(result.stdout || "");
      return jsonResult({
        cwd: workdir,
        is_git_repo: true,
        branch: (branchRes.stdout || "").trim() || null,
        clean: files.length === 0,
        count: files.length,
        files
      });
    }
  );

  reg(
    mcp,
    "git_diff",
    {
      title: "Git diff",
      description: "Show a git diff for a repo inside a root. Optionally limit to a path; pass staged:true to diff the index against HEAD.",
      inputSchema: {
        path: z.string().optional().describe("Limit the diff to this file or directory."),
        staged: z.boolean().optional().describe("Diff staged changes (--staged) instead of the working tree."),
        cwd: z.string().optional().describe("Repository directory inside a root (default the primary root).")
      }
    },
    async ({ path: rel, staged = false, cwd = "." }) => {
      const workdir = resolvePath(cwd);
      const args = ["diff"];
      if (staged) args.push("--staged");
      if (rel) {
        // Confine the diff path to a root as well.
        const target = resolvePath(rel);
        args.push("--", target);
      }
      const result = await spawnCapture("git", args, workdir, DEFAULT_CMD_TIMEOUT);
      if (result.exit_code !== 0) {
        return jsonResult({
          cwd: workdir,
          is_git_repo: false,
          error: (result.stderr || "git error").split(/\r?\n/)[0]
        });
      }
      return jsonResult({
        cwd: workdir,
        is_git_repo: true,
        staged,
        path: rel || null,
        diff: result.stdout || "",
        empty: !(result.stdout || "").trim()
      });
    }
  );
}

// Parse `git status --porcelain` into structured entries. Each line is
// "XY <path>" (or "XY <old> -> <new>" for renames) where X is the index code
// and Y the worktree code.
function parsePorcelain(out) {
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const index = line[0];
    const worktree = line[1];
    let rest = line.slice(3);
    let from = null;
    let to = rest;
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) {
      from = rest.slice(0, arrow);
      to = rest.slice(arrow + 4);
    }
    files.push({
      index: index === " " ? null : index,
      worktree: worktree === " " ? null : worktree,
      path: to,
      from,
      staged: index !== " " && index !== "?",
      untracked: index === "?" && worktree === "?"
    });
  }
  return files;
}

// ----------------------------------------------------------------------------
// Path safety
// ----------------------------------------------------------------------------
// Canonical (symlink/junction-resolved) form of the roots, computed once.
const REAL_ROOTS = ROOTS.map((r) => {
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
});

// Resolve the longest existing ancestor with realpath, then re-append the
// not-yet-existing tail. This canonicalizes symlinks/junctions even for files
// that don't exist yet (e.g. write_file targets).
function canonicalize(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p);
}

function resolvePath(input = ".") {
  const raw = String(input ?? ".").trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(PRIMARY_ROOT, raw);
  // Validate the canonical path. Besides blocking symlink/junction escapes,
  // this avoids false rejections on case-insensitive macOS volumes when the
  // caller uses different path casing than the filesystem stores.
  const canon = canonicalize(resolved);
  if (!isWithinRoots(canon, REAL_ROOTS)) {
    throw new Error(`Path is outside the allowed roots or resolves outside via a link: ${input}`);
  }
  return resolved;
}

function isWithinRoots(p, roots = ROOTS) {
  return roots.some((root) => {
    const target = comparePath(p);
    const base = comparePath(root);
    const withSep = base.endsWith(path.sep) ? base : base + path.sep;
    return target === base || target.startsWith(withSep);
  });
}

// Shorten output paths: relative to the primary root (posix slashes) when the
// file lives under it, otherwise the absolute path. Round-trips back through
// resolvePath() because relative inputs resolve against the primary root.
function toRel(abs) {
  if (comparePath(abs) === comparePath(PRIMARY_ROOT)) return ".";
  const withSep = PRIMARY_ROOT.endsWith(path.sep) ? PRIMARY_ROOT : PRIMARY_ROOT + path.sep;
  if (comparePath(abs).startsWith(comparePath(withSep))) return abs.slice(withSep.length).split(path.sep).join("/");
  return abs;
}

// ----------------------------------------------------------------------------
// Listing / search
// ----------------------------------------------------------------------------
async function listEntries(dir, { recursive, limit }) {
  const out = [];
  async function walk(current) {
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= limit) return;
      if (SKIP_DIRS.has(item.name)) continue;
      const abs = path.join(current, item.name);
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      out.push({
        path: toRel(abs),
        type: item.isDirectory() ? "directory" : "file",
        size: info.size,
        modified: info.mtime.toISOString()
      });
      if (recursive && item.isDirectory()) await walk(abs);
    }
  }
  await walk(dir);
  return out;
}

// Parse "path:line:text" grep-style output into match objects.
function parseGrepOutput(out, dir, limit) {
  const matches = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const abs = path.resolve(dir, m[1]);
    matches.push({ path: toRel(abs), line: Number(m[2]), text: m[3].slice(0, 500) });
    if (matches.length >= limit) break;
  }
  return matches;
}

// Fastest path: ripgrep. Respects .gitignore, works in any folder. null on miss.
function ripgrepGrep(dir, query, { regex, limit, glob }) {
  if (!RG_BIN) return Promise.resolve(null);
  // NOTE: no -I here — in ripgrep -I means --no-filename (grep/git use it for
  // "ignore binary"). ripgrep skips binary files by default.
  const args = ["--no-heading", "--with-filename", "-n", "-S", "--color", "never"];
  if (!regex) args.push("-F");
  if (glob) args.push("-g", glob);
  args.push("-e", query, "--", ".");
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(RG_BIN, args, { cwd: dir, windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on("data", (c) => {
      if (out.length < 8_000_000) out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) return resolve(null);
      resolve(parseGrepOutput(out, dir, limit));
    });
  });
}

// Fast path: `git grep` inside a git work tree. Returns null when not a git repo
// / git unavailable / errored, so the caller can fall back to a JS scan.
function gitGrep(dir, query, { regex, limit, glob }) {
  return new Promise((resolve) => {
    const args = ["-C", dir, "grep", "--no-color", "-n", "-I", "-i", "--untracked"];
    args.push(regex ? "-E" : "-F", "-e", query, "--", glob ? glob : ".");
    let out = "";
    let child;
    try {
      child = spawn("git", args, { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on("data", (c) => {
      if (out.length < 8_000_000) out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 128) return resolve(null); // not a git repo
      if (code !== 0 && code !== 1) return resolve(null); // 1 = no matches
      resolve(parseGrepOutput(out, dir, limit));
    });
  });
}

// Attach a few lines of context to each match by reading files locally (no extra
// round trips to the model). Files are read once and cached for this call.
async function attachContext(matches, ctx) {
  const cache = new Map();
  for (const m of matches) {
    const abs = path.isAbsolute(m.path) ? m.path : path.resolve(PRIMARY_ROOT, m.path);
    let lines = cache.get(abs);
    if (!lines) {
      try {
        lines = (await readFile(abs, "utf8")).split(/\r?\n/);
      } catch {
        lines = null;
      }
      cache.set(abs, lines);
    }
    if (!lines) continue;
    const from = Math.max(1, m.line - ctx);
    const to = Math.min(lines.length, m.line + ctx);
    const snippet = [];
    for (let i = from; i <= to; i++) snippet.push(`${i}| ${lines[i - 1]}`);
    m.snippet = snippet.join("\n");
  }
}

// Convert a simple glob (*, **, ?) to a RegExp for the scan fallback.
function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += ".";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

// Find files by name glob: ripgrep --files > git ls-files > JS walk.
async function findFiles(start, glob, limit) {
  // ripgrep
  if (RG_BIN) {
    const out = await spawnFilesList(RG_BIN, ["--files", "-g", glob], start);
    if (out !== null) return { engine: "ripgrep", files: out.slice(0, limit).map((p) => toRel(path.resolve(start, p))) };
  }
  // git ls-files
  const gitOut = await spawnFilesList("git", ["-C", start, "ls-files", "--cached", "--others", "--exclude-standard"], null);
  if (gitOut !== null) {
    const rx = globToRegex(glob);
    const hasSlash = glob.includes("/");
    const hit = gitOut.filter((p) => rx.test(hasSlash ? p : path.basename(p)));
    if (hit.length || gitOut.length) return { engine: "git", files: hit.slice(0, limit).map((p) => toRel(path.resolve(start, p))) };
  }
  // JS walk fallback
  const rx = globToRegex(glob);
  const hasSlash = glob.includes("/");
  const all = await listEntries(start, { recursive: true, limit: 20000 });
  const files = all
    .filter((e) => e.type === "file")
    .map((e) => e.path)
    .filter((p) => rx.test(hasSlash ? p.split(path.sep).join("/") : path.basename(p)))
    .slice(0, limit);
  return { engine: "scan", files };
}

function spawnFilesList(file, args, cwd) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(file, args, cwd ? { cwd, windowsHide: true } : { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on("data", (c) => {
      if (out.length < 8_000_000) out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) return resolve(null);
      resolve(out.split(/\r?\n/).filter(Boolean));
    });
  });
}

async function searchTree(start, query, { regex, limit, glob }) {
  const pattern = regex ? new RegExp(query, "i") : null;
  const needle = query.toLowerCase();
  const globRx = glob ? globToRegex(glob) : null;
  const globHasSlash = glob ? glob.includes("/") : false;
  const matches = [];
  const files = [];

  async function collect(current) {
    let info;
    try {
      info = await stat(current);
    } catch {
      return;
    }
    if (info.isFile()) {
      files.push(current);
      return;
    }
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (SKIP_DIRS.has(item.name)) continue;
      if (files.length > 50000) return;
      await collect(path.join(current, item.name));
    }
  }

  await collect(start);
  for (const file of files) {
    if (matches.length >= limit) break;
    if (globRx) {
      const rel = toRel(file);
      const target = globHasSlash ? rel : path.basename(file);
      if (!globRx.test(target)) continue;
    }
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const found = regex ? pattern.test(line) : line.toLowerCase().includes(needle);
      if (!found) continue;
      matches.push({ path: toRel(file), line: i + 1, text: line.slice(0, 500) });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

// ----------------------------------------------------------------------------
// Command policy + execution
// ----------------------------------------------------------------------------
function assertCommandAllowed(command) {
  const cmd = String(command);
  if (!ALLOW_DANGEROUS && CATASTROPHIC.some((re) => re.test(cmd))) {
    throw new Error("Command blocked: catastrophic system operation (set AGENT_ALLOW_DANGEROUS=1 to override).");
  }
  if (MODE !== "full" && SAFE_MODE_BLOCKS.some((re) => re.test(cmd))) {
    throw new Error("Command blocked by safe mode. Switch to AGENT_MODE=full for unrestricted in-root commands.");
  }
}

function defaultShell() {
  if (process.platform === "win32") return "cmd";
  return hasCommand("bash") ? "bash" : "sh";
}

function buildSpawn(command, shell) {
  const s = shell || defaultShell();
  if (s === "powershell") {
    const file = process.platform === "win32" ? "powershell.exe" : hasCommand("pwsh") ? "pwsh" : "powershell";
    return { file, args: ["-NoProfile", "-NonInteractive", "-Command", command], opts: {} };
  }
  if (s === "bash") {
    return { file: "bash", args: ["-lc", command], opts: {} };
  }
  if (s === "sh") {
    return { file: "sh", args: ["-c", command], opts: {} };
  }
  if (s === "zsh") {
    return { file: "zsh", args: ["-lc", command], opts: {} };
  }
  // cmd / default: rely on the OS shell so pipes/redirects work.
  return { file: command, args: [], opts: { shell: true } };
}

function spawnOptions(cwd, opts = {}, env) {
  return {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    ...(env ? { env } : {}),
    ...opts
  };
}

function terminateChildTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function runShellCommand(command, cwd, shell, timeoutMs) {
  const { file, args, opts } = buildSpawn(command, shell);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, spawnOptions(cwd, opts, { ...process.env, AGENT_WORKSPACE: PRIMARY_ROOT }));
    } catch (err) {
      resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout = appendLimited(stdout, c.toString(), MAX_COMMAND_OUTPUT)));
    child.stderr?.on("data", (c) => (stderr = appendLimited(stderr, c.toString(), MAX_COMMAND_OUTPUT)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit_code: null, timed_out: timedOut, stdout, stderr: stderr + String(err?.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code, timed_out: timedOut, stdout, stderr });
    });
  });
}

function spawnCapture(file, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, spawnOptions(cwd));
    } catch (err) {
      resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout = appendLimited(stdout, c.toString(), MAX_COMMAND_OUTPUT)));
    child.stderr?.on("data", (c) => (stderr = appendLimited(stderr, c.toString(), MAX_COMMAND_OUTPUT)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit_code: null, timed_out: timedOut, stdout, stderr: stderr + String(err?.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code, timed_out: timedOut, stdout, stderr });
    });
  });
}

function startBackground(command, cwd, shell, name) {
  const { file, args, opts } = buildSpawn(command, shell);
  const child = spawn(file, args, spawnOptions(cwd, opts, { ...process.env, AGENT_WORKSPACE: PRIMARY_ROOT }));
  const proc = {
    id: randomUUID(),
    name: name || command.slice(0, 40),
    command,
    child,
    status: "running",
    exitCode: null,
    startedAt: isoNow(),
    stdout: "",
    stderr: ""
  };
  child.stdout?.on("data", (c) => (proc.stdout = appendLimited(proc.stdout, c.toString(), PROC_BUFFER)));
  child.stderr?.on("data", (c) => (proc.stderr = appendLimited(proc.stderr, c.toString(), PROC_BUFFER)));
  child.on("error", (err) => {
    proc.status = "error";
    proc.stderr = appendLimited(proc.stderr, String(err?.message || err), PROC_BUFFER);
  });
  child.on("close", (code) => {
    proc.status = "exited";
    proc.exitCode = code;
  });
  processes.set(proc.id, proc);
  return proc;
}

function killProcessTree(proc) {
  if (!proc?.child || proc.status !== "running") {
    if (proc) proc.status = proc.status === "running" ? "stopped" : proc.status;
    return;
  }
  const pid = proc.child.pid;
  try {
    if (pid) terminateChildTree(proc.child, "SIGTERM");
  } catch {}
  proc.status = "stopped";
}

// ----------------------------------------------------------------------------
// Notes
// ----------------------------------------------------------------------------
async function readNotes() {
  try {
    return JSON.parse(await readFile(NOTES_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function writeNotes(notes) {
  await mkdir(path.dirname(NOTES_PATH), { recursive: true });
  await writeFile(NOTES_PATH, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
}

// ----------------------------------------------------------------------------
// Skills (Claude-style on-demand playbooks)
// ----------------------------------------------------------------------------
async function discoverSkills() {
  const found = [];
  const seen = new Set();
  for (const base of SKILLS_DIRS) {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // dir doesn't exist
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      let skillFile = null;
      try {
        const files = await readdir(dir);
        const hit = files.find((f) => f.toLowerCase() === "skill.md");
        if (hit) skillFile = path.join(dir, hit);
      } catch {
        continue;
      }
      if (!skillFile) continue;
      let meta;
      try {
        meta = parseSkillMeta(await readFile(skillFile, "utf8"), e.name);
      } catch {
        meta = { name: e.name, description: "" };
      }
      const key = meta.name.toLowerCase();
      if (seen.has(key)) continue; // first source wins
      seen.add(key);
      found.push({ name: meta.name, description: meta.description, dir, skillFile });
    }
  }
  return found;
}

function parseSkillMeta(text, fallbackName) {
  text = text.replace(/^﻿/, ""); // strip UTF-8 BOM (some Windows editors add it)
  let name = fallbackName;
  let description = "";
  const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
  if (fm) {
    const block = fm[1];
    const n = block.match(/^\s*name\s*:\s*(.+?)\s*$/im);
    const d = block.match(/^\s*description\s*:\s*(.+?)\s*$/im);
    if (n) name = n[1].replace(/^["']|["']$/g, "").trim();
    if (d) description = d[1].replace(/^["']|["']$/g, "").trim();
  }
  if (!description) {
    const body = fm ? text.slice(fm[0].length) : text;
    const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (firstLine) description = firstLine.slice(0, 200);
  }
  return { name, description };
}

// ----------------------------------------------------------------------------
// Metrics
// ----------------------------------------------------------------------------
function emptyMetrics() {
  return {
    startedAt: isoNow(), // first ever run
    totalCalls: 0,
    okCalls: 0,
    errorCalls: 0,
    inChars: 0,
    outChars: 0,
    totalDurationMs: 0,
    latencies: [],
    perTool: {},
    recent: [], // newest first, capped
    buckets: [] // per-minute { t, calls, tokens }, capped
  };
}

function loadMetrics() {
  try {
    if (existsSync(METRICS_PATH)) {
      const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
      return { ...emptyMetrics(), ...m, perTool: m.perTool || {}, recent: m.recent || [], buckets: m.buckets || [], latencies: m.latencies || [] };
    }
  } catch {
    /* corrupt file -> start fresh */
  }
  return emptyMetrics();
}

let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    writeFile(METRICS_PATH, JSON.stringify(metrics), "utf8").catch(() => {});
  }, 2000);
  _saveTimer.unref?.();
}

function saveMetricsSync() {
  try {
    writeFileSync(METRICS_PATH, JSON.stringify(metrics), "utf8");
  } catch {
    /* ignore */
  }
}

function estTokens(chars) {
  return Math.ceil(chars / 4);
}

function recordMetric(tool, ok, inChars, outChars, errText, durationMs = 0) {
  metrics.totalCalls += 1;
  if (ok) metrics.okCalls += 1;
  else metrics.errorCalls += 1;
  metrics.inChars += inChars;
  metrics.outChars += outChars;
  metrics.totalDurationMs = (metrics.totalDurationMs || 0) + durationMs;
  (metrics.latencies ||= []).push(durationMs);
  if (metrics.latencies.length > 1000) metrics.latencies.splice(0, metrics.latencies.length - 1000);

  const pt = (metrics.perTool[tool] ||= { calls: 0, ok: 0, err: 0, inChars: 0, outChars: 0, totalDurationMs: 0, latencies: [] });
  pt.calls += 1;
  if (ok) pt.ok += 1;
  else pt.err += 1;
  pt.inChars += inChars;
  pt.outChars += outChars;
  pt.totalDurationMs = (pt.totalDurationMs || 0) + durationMs;
  (pt.latencies ||= []).push(durationMs);
  if (pt.latencies.length > 300) pt.latencies.splice(0, pt.latencies.length - 300);

  metrics.recent.unshift({ ts: isoNow(), tool, ok, duration_ms: durationMs, inChars, outChars, tokens: estTokens(inChars + outChars), error: ok ? undefined : errText || undefined });
  if (metrics.recent.length > 60) metrics.recent.length = 60;

  const minute = Math.floor(Date.now() / 60000) * 60000;
  let b = metrics.buckets[metrics.buckets.length - 1];
  if (!b || b.t !== minute) {
    b = { t: minute, calls: 0, tokens: 0, duration_ms: 0 };
    metrics.buckets.push(b);
    if (metrics.buckets.length > 180) metrics.buckets.shift();
  }
  b.calls += 1;
  b.tokens += estTokens(inChars + outChars);
  b.duration_ms = (b.duration_ms || 0) + durationMs;

  scheduleSave();
}

function metricsSnapshot() {
  const health = computeHealthInsights();
  const topTools = Object.entries(metrics.perTool)
    .map(([name, v]) => ({
      name,
      ...v,
      latencies: undefined,
      tokens: estTokens(v.inChars + v.outChars),
      avg_ms: v.calls ? Math.round((v.totalDurationMs || 0) / v.calls) : 0,
      p95_ms: percentile(v.latencies || [], 0.95)
    }))
    .sort((a, b) => b.calls - a.calls);
  const uptimeMinutes = Math.max((Date.now() - bootStartedAt) / 60000, 1 / 60);
  return {
    version: VERSION,
    tier: PRODUCT_TIER,
    mode: MODE,
    policy: AGENT_POLICY,
    roots: ROOTS,
    port: PORT,
    mcp_endpoint: `http://${HOST}:${PORT}/mcp`,
    since: metrics.startedAt,
    uptime_sec: Math.floor((Date.now() - bootStartedAt) / 1000),
    running_processes: [...processes.values()].filter((p) => p.status === "running").length,
    total_calls: metrics.totalCalls,
    ok_calls: metrics.okCalls,
    error_calls: metrics.errorCalls,
    in_chars: metrics.inChars,
    out_chars: metrics.outChars,
    est_tokens_in: estTokens(metrics.inChars),
    est_tokens_out: estTokens(metrics.outChars),
    est_tokens_total: estTokens(metrics.inChars + metrics.outChars),
    success_rate: metrics.totalCalls ? Math.round((metrics.okCalls / metrics.totalCalls) * 10000) / 100 : 100,
    calls_per_minute: Math.round((metrics.totalCalls / uptimeMinutes) * 100) / 100,
    avg_latency_ms: metrics.totalCalls ? Math.round((metrics.totalDurationMs || 0) / metrics.totalCalls) : 0,
    p50_latency_ms: percentile(metrics.latencies || [], 0.5),
    p95_latency_ms: percentile(metrics.latencies || [], 0.95),
    p99_latency_ms: percentile(metrics.latencies || [], 0.99),
    health_score: health.score,
    health_label: health.label,
    pro_tips: health.tips,
    bottlenecks: health.bottlenecks,
    top_tools: topTools,
    recent: metrics.recent,
    buckets: metrics.buckets
  };
}

function computeHealthInsights() {
  const total = metrics.totalCalls || 0;
  const success = total ? metrics.okCalls / total : 1;
  const p95 = percentile(metrics.latencies || [], 0.95);
  const avg = total ? (metrics.totalDurationMs || 0) / total : 0;
  const readFileCalls = metrics.perTool?.read_file?.calls || 0;
  const readManyCalls = metrics.perTool?.read_many?.calls || 0;
  const runCommandCalls = metrics.perTool?.run_command?.calls || 0;
  const runCommandsCalls = metrics.perTool?.run_commands?.calls || 0;
  const searchCalls = metrics.perTool?.search_text?.calls || 0;
  const recentErrors = (metrics.recent || []).filter((r) => !r.ok).length;
  const tokensPerCall = total ? estTokens(metrics.inChars + metrics.outChars) / total : 0;

  let score = 100;
  const tips = [];
  const bottlenecks = [];

  if (success < 0.95) {
    const hit = Math.min(30, Math.round((0.95 - success) * 120));
    score -= hit;
    bottlenecks.push("error_rate");
    tips.push("Error rate is elevated; inspect Recent calls and fix repeated failing tools before continuing.");
  }
  if (p95 > 2500) {
    score -= 18;
    bottlenecks.push("latency_p95");
    tips.push("P95 latency is high; batch reads with read_many/workspace_snapshot and avoid many tiny calls.");
  } else if (p95 > 1200) {
    score -= 10;
    bottlenecks.push("latency_p95");
    tips.push("Latency is noticeable; prefer fewer larger tool calls over repeated single-file calls.");
  }
  if (readFileCalls > Math.max(8, readManyCalls * 4)) {
    score -= 8;
    bottlenecks.push("chatty_reads");
    tips.push("Many read_file calls detected; use read_many for related files to reduce tunnel round-trips.");
  }
  if (runCommandCalls > Math.max(8, searchCalls + readManyCalls)) {
    score -= 6;
    bottlenecks.push("command_heavy");
    tips.push(runCommandsCalls
      ? "High run_command usage; keep grouping independent checks with run_commands/quality_gate and prefer dedicated repo/git tools."
      : "High run_command usage; group independent checks with run_commands/quality_gate and prefer repo_map/search_text/git_status/git_diff.");
  }
  if (tokensPerCall > 3500) {
    score -= 8;
    bottlenecks.push("large_payloads");
    tips.push("Large payloads per call; use line ranges, globs, and max_output_chars to keep context light.");
  }
  if (recentErrors >= 5) {
    score -= 8;
    bottlenecks.push("recent_errors");
    tips.push("Several recent calls failed; clear the failing path/command before more edits.");
  }
  if (!tips.length) {
    tips.push("Healthy session. Keep using workspace_snapshot, read_many, search_text, and targeted tests for best speed.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 90 ? "excellent" : score >= 75 ? "good" : score >= 55 ? "watch" : "attention";
  return {
    score,
    label,
    tips: tips.slice(0, 4),
    bottlenecks,
    avg_latency_ms: Math.round(avg),
    p95_latency_ms: p95,
    tokens_per_call: Math.round(tokensPerCall)
  };
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]);
}

function safeLen(args) {
  try {
    return JSON.stringify(args ?? {}).length;
  } catch {
    return 0;
  }
}

function resultLen(result) {
  try {
    let n = 0;
    for (const c of result?.content || []) n += (c?.text || "").length;
    return n;
  } catch {
    return 0;
  }
}

function firstText(result) {
  try {
    return result?.content?.[0]?.text || "";
  } catch {
    return "";
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function dedupe(arr) {
  return [...new Set(arr)];
}

function boundedNumber(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseExtraRoots() {
  const json = process.env.AGENT_EXTRA_ROOTS_JSON;
  if (json && json.trim()) {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
        throw new Error("AGENT_EXTRA_ROOTS_JSON must be a JSON string array.");
      }
      return dedupe([...parsed, ...(Array.isArray(STARTUP_PROFILE?.extraRoots) ? STARTUP_PROFILE.extraRoots : [])]).map((p) => path.resolve(p));
    } catch (err) {
      console.warn(`Invalid AGENT_EXTRA_ROOTS_JSON ignored: ${err?.message || err}`);
    }
  }
  return dedupe([
    ...(process.env.AGENT_EXTRA_ROOTS || "").split(";"),
    ...(Array.isArray(STARTUP_PROFILE?.extraRoots) ? STARTUP_PROFILE.extraRoots : [])
  ])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
  return !result.error;
}

function comparePath(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isoNow() {
  return new Date().toISOString();
}

function appendLimited(current, next, max) {
  const combined = current + next;
  if (combined.length <= max) return combined;
  return combined.slice(combined.length - max);
}

// Trim command output for display: prefer line slicing (head/tail), else cap chars.
function trimOutput(s, { tail_lines, head_lines, max_chars }) {
  if (!s) return s;
  if (head_lines || tail_lines) {
    const lines = s.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // drop trailing newline's empty line
    const picked = head_lines ? lines.slice(0, head_lines) : lines.slice(-tail_lines);
    const out = picked.join("\n");
    return out.length > max_chars ? out.slice(0, max_chars) : out;
  }
  return s.length > max_chars ? s.slice(0, max_chars) : s;
}

// Fields whose values may carry secrets or large payloads — redact them in the
// audit log so data/audit.log never stores tokens/keys/file contents/commands.
const AUDIT_REDACT = /^(content|body|diff|patch|old_text|new_text|command|token|approval_token|mcp_auth_token|control_plane_api_key|key|secret|password|authorization|auth|api[_-]?key)$/i;

// Recursively redact sensitive keys at ANY depth (e.g. apply_patch.operations[].content,
// .edits[].new_text) and truncate long strings, so data/audit.log never stores secrets.
function redactDeep(v, depth = 0) {
  if (depth > 8) return "…";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (AUDIT_REDACT.test(k)) {
        o[k] = typeof val === "string" ? `[redacted ${val.length} chars]` : "[redacted]";
      } else {
        o[k] = redactDeep(val, depth + 1);
      }
    }
    return o;
  }
  if (typeof v === "string" && v.length > 200) return `${v.slice(0, 200)}…(${v.length} chars)`;
  return v;
}

function summarizeArgs(args) {
  try {
    const s = JSON.stringify(redactDeep(args || {}));
    return s.length > 800 ? `${s.slice(0, 800)}…` : s;
  } catch {
    return "<unserializable>";
  }
}

function log(message) {
  console.log(`${isoNow()} ${message}`);
}

function shouldLogHttpRequest(req, url) {
  const isTrayHealthProbe =
    req.method === "GET" &&
    url.pathname === "/healthz" &&
    String(req.headers[INTERNAL_HEALTH_PROBE_HEADER] || "").toLowerCase() === INTERNAL_HEALTH_PROBE_TRAY;
  return !isTrayHealthProbe;
}

function audit(entry) {
  appendFile(AUDIT_PATH, `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// Compact JSON keeps payloads (and the tokens ChatGPT must read) small, which
// is the main lever for perceived speed over the tunnel.
function jsonResult(value) {
  return textResult(JSON.stringify(value));
}

function originAllowed(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function dashboardOriginAllowed(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  return new Set([
    `http://127.0.0.1:${DASHBOARD_PORT}`,
    `http://localhost:${DASHBOARD_PORT}`,
    `http://[::1]:${DASHBOARD_PORT}`
  ]).has(origin);
}

function setCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(Object.assign(new Error("Payload too large."), { statusCode: 413 }));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  const json = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
}

function oauthProtectedResourceMetadata() {
  const resource = `http://${HOST}:${PORT}/mcp`;
  return {
    resource,
    bearer_methods_supported: ["header"],
    scopes_supported: [],
    resource_name: "Local Coding Agent MCP",
    resource_documentation: `http://${HOST}:${PORT}/`
  };
}

function homeHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Local Coding Agent</title>
  <style>
    body { margin: 0; min-height: 100vh; background: #090b10; color: #eef2ff; font-family: Inter, system-ui, sans-serif; }
    main { max-width: 920px; margin: 0 auto; padding: 36px 18px; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { color: #a8b3c7; line-height: 1.6; }
    code { color: #93c5fd; word-break: break-all; }
    .panel { border: 1px solid #223048; background: #10141d; border-radius: 8px; padding: 18px; margin: 14px 0; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 999px; background: #2dd4bf; margin-right: 8px; }
    .tag { display:inline-block; font-size:12px; padding:2px 8px; border-radius:999px; background:#1e293b; color:#93c5fd; margin-left:8px; }
  </style>
</head>
<body>
  <main>
    <h1><span class="dot"></span>Local Coding Agent <span class="tag">v${escapeHtml(VERSION)}</span> <span class="tag">${escapeHtml(MODE)} mode</span></h1>
    <p>Local MCP server that lets ChatGPT Web work with files, run commands, manage background processes, and use git inside your configured roots.</p>
    <div class="panel"><p><strong>Roots</strong></p>${ROOTS.map((r) => `<p><code>${escapeHtml(r)}</code></p>`).join("")}</div>
    <div class="panel"><p><strong>MCP endpoint</strong></p><p><code>http://${HOST}:${PORT}/mcp</code></p></div>
    <div class="panel"><p><strong>Tools</strong></p>
      <p><strong>Core:</strong> <code>workspace_info, repo_overview, list_files, find_files, read_file, read_many, stat_path, search_text, write_file, replace_in_file, apply_patch, make_dir, move_path, delete_path, run_command, run_commands, proc_start, proc_list, proc_output, proc_stop, git, git_status, git_diff, list_skills, read_skill, create_skill, delete_skill, ping, save_note, list_notes, checkpoint, resume</code></p>
      <p><strong>Pro repo intel:</strong> <code>workspace_snapshot, workspace_doctor, project_profile, important_files, repo_map, repo_symbols, index_status</code></p>
      <p><strong>v2.2 patch engine:</strong> <code>preview_patch, validate_patch, undo_last_patch</code></p>
      <p><strong>v2.3 test runner:</strong> <code>quality_gate, detect_test_commands, run_tests, run_build, run_lint, run_changed_tests</code></p>
      <p><strong>v2.4 review:</strong> <code>session_report, review_diff, security_scan, todo_scan, change_summary</code></p>
      <p><strong>v2.5 planner:</strong> <code>task_plan, task_state, decision_log</code></p>
      <p><strong>Policy:</strong> <code>policy_status, explain_risk, request_approval, request_approval_batch, approve_request, deny_request</code></p>
      <p><strong>v2.8 profile:</strong> <code>profile_status, reload_profile</code></p>
    </div>
    <div class="panel"><p><strong>Local dashboard</strong> (this machine only): <code>http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/ui</code></p></div>
  </main>
</body>
</html>`;
}

// ----------------------------------------------------------------------------
// Mini-IDE dashboard APIs (local-only). Read-only file/tree/diff + clear-metrics.
// Reuse the same root confinement (resolvePath) and SKIP_DIRS as the MCP tools.
// ----------------------------------------------------------------------------
async function dashApiTree(url, res) {
  try {
    const rel = url.searchParams.get("path") || ".";
    const start = resolvePath(rel);
    const depth = Math.min(Math.max(Number(url.searchParams.get("depth") || 4), 1), 8);
    const maxEntries = Math.min(Math.max(Number(url.searchParams.get("max") || 2000), 10), 6000);
    const { tree } = await buildTree(start, depth, maxEntries);
    const entries = tree.map((abs) => {
      const isDir = abs.endsWith(path.sep);
      const clean = isDir ? abs.slice(0, -1) : abs;
      return { path: toRel(clean), type: isDir ? "directory" : "file" };
    });
    return sendJson(res, 200, {
      root: toRel(start),
      truncated: tree.length >= maxEntries,
      count: entries.length,
      entries
    });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "error" });
  }
}

async function dashApiFile(url, res) {
  try {
    const rel = url.searchParams.get("path");
    if (!rel) return sendJson(res, 400, { error: "path is required" });
    const filePath = resolvePath(rel);
    const info = await stat(filePath);
    if (info.isDirectory()) return sendJson(res, 400, { error: "path is a directory" });
    const raw = await readFile(filePath, "utf8");
    const total_lines = raw.split(/\r?\n/).length;
    const cap = MAX_READ_CHARS;
    const truncated = raw.length > cap;
    return sendJson(res, 200, {
      path: toRel(filePath),
      total_lines,
      chars: raw.length,
      truncated,
      content: truncated ? raw.slice(0, cap) : raw
    });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "error" });
  }
}

async function dashApiDiff(url, res) {
  try {
    const rel = url.searchParams.get("path");
    const args = ["diff"];
    if (rel) {
      const target = resolvePath(rel);
      args.push("--", target);
    }
    const result = await spawnCapture("git", args, PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT);
    if (result.exit_code !== 0) {
      return sendJson(res, 200, {
        root: toRel(PRIMARY_ROOT),
        is_git_repo: false,
        diff: "",
        empty: true,
        error: (result.stderr || "not a git repository").split(/\r?\n/)[0]
      });
    }
    return sendJson(res, 200, {
      root: toRel(PRIMARY_ROOT),
      is_git_repo: true,
      diff: result.stdout || "",
      empty: !(result.stdout || "").trim()
    });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "error" });
  }
}

function dashApiClearMetrics(res) {
  try {
    metrics = emptyMetrics();
    saveMetricsSync();
    return sendJson(res, 200, { ok: true, cleared: true });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || "error" });
  }
}

function customerPrompt(kind = "setup") {
  const repo = "https://github.com/LongNgn204/local-coding-agent";
  if (kind === "update") {
    return [
      "You are setting up/updating Local Coding Agent for a customer.",
      `Repo: ${repo}`,
      "",
      "Tasks:",
      "1. Read AGENTS.md and README.md first.",
      "2. Preserve customer config, tunnel-client binaries, runtime keys, and local workspace paths.",
      "3. Run: git pull --ff-only, node scripts/local-coding-agent.mjs install, node scripts/local-coding-agent.mjs skills validate, node scripts/local-coding-agent.mjs skills doctor.",
      "4. Run: node scripts/local-coding-agent.mjs setup-wizard.",
      "5. Run health checks and server tests when dependencies are present.",
      "6. Do not paste full logs/diffs/base64 output into chat. Save long output to local files and summarize with exact paths.",
      "7. Report changed files, checks run, errors, and next action."
    ].join("\n");
  }
  if (kind === "diagnose") {
    return [
      "You are diagnosing a customer's Local Coding Agent install.",
      `Repo: ${repo}`,
      "",
      "Tasks:",
      "1. Read AGENTS.md, README.md, and skills/customer-doctor/SKILL.md if present.",
      "2. Run: node scripts/local-coding-agent.mjs status, doctor, skills doctor, setup-wizard, support.",
      "3. Check Node.js, npm install, ports 8787/8790, dashboard health, tunnel-client location, workspace roots, and local firewall/proxy symptoms.",
      "4. Redact secrets/tokens/keys before sharing anything.",
      "5. Do not paste full logs/diffs/base64 output into chat. Save long output to local files and summarize with exact paths.",
      "6. Return a clear diagnosis: likely cause, evidence, files/reports created, and exact fix steps."
    ].join("\n");
  }
  return [
    "You are installing Local Coding Agent for a customer.",
    `Repo: ${repo}`,
    "",
    "Tasks:",
    "1. Check Node.js >= 18 and git. Do not install system software without asking.",
    "2. Clone the repo if needed, then read AGENTS.md and README.md.",
    "3. Run: node scripts/local-coding-agent.mjs install.",
    "4. Ask the customer for the workspace root that the AI may read/write.",
    "5. Run: node scripts/local-coding-agent.mjs setup-wizard --workspace \"<customer workspace>\".",
    "6. Start server-only first if tunnel-client is missing: node scripts/local-coding-agent.mjs start --workspace \"<customer workspace>\" --no-tunnel.",
    "7. Verify: health endpoint, dashboard, skills validate, and npm --prefix server run test:agent.",
    "8. Do not paste full logs/diffs/base64 output into chat. Save long output to local files and summarize with exact paths.",
    "9. Return setup status, MCP URL, dashboard URL, checks run, and any missing customer action."
  ].join("\n");
}

function dashApiCustomerPrompts(res) {
  return sendJson(res, 200, {
    version: VERSION,
    prompts: {
      setup: customerPrompt("setup"),
      update: customerPrompt("update"),
      diagnose: customerPrompt("diagnose")
    }
  });
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Local Coding Agent — Dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#090b10; color:#eef2ff; font-family:Inter,system-ui,Segoe UI,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:22px 18px 60px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h3 { margin:0 0 10px; font-size:14px; color:#9fb0c9; text-transform:uppercase; letter-spacing:.04em; }
  .sub { color:#7e8aa0; font-size:13px; margin:0 0 18px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin-bottom:18px; }
  .card { border:1px solid #1f2a3d; background:#10141d; border-radius:10px; padding:14px 16px; }
  .clab { color:#8896ad; font-size:12px; }
  .cval { font-size:26px; font-weight:700; margin:4px 0 2px; color:#eaf2ff; }
  .csub { color:#6b7790; font-size:12px; }
  .panel { border:1px solid #1f2a3d; background:#10141d; border-radius:10px; padding:16px; margin-bottom:16px; }
  canvas { width:100%; height:220px; display:block; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:820px){ .grid { grid-template-columns:1fr; } }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid #1a2335; }
  th { color:#8896ad; font-weight:600; }
  .row { padding:5px 0; border-bottom:1px solid #161e2d; font-size:13px; }
  .t { color:#6b7790; font-variant-numeric:tabular-nums; }
  .dim { color:#6b7790; }
  .ok { color:#2dd4bf; } .err { color:#f87171; }
  .errmsg { color:#f9a8a8; font-size:12px; }
  .pill { display:inline-block; font-size:12px; padding:2px 9px; border-radius:999px; background:#1e293b; color:#93c5fd; margin-left:6px; }
  #status { float:right; font-size:13px; color:#2dd4bf; }
  .note { color:#6b7790; font-size:12px; margin-top:6px; }
  .btn { display:inline-block; cursor:pointer; font-size:12px; padding:4px 11px; border-radius:7px; background:#1e293b; color:#93c5fd; border:1px solid #2a3a55; }
  .btn:hover { background:#243349; }
  .btn.active { background:#0f766e; color:#d7fff7; border-color:#0f766e; }
  .ide { display:grid; grid-template-columns:300px 1fr; gap:0; border:1px solid #1f2a3d; border-radius:10px; overflow:hidden; min-height:360px; }
  @media (max-width:820px){ .ide { grid-template-columns:1fr; } }
  .ide-tree { background:#0c1018; border-right:1px solid #1f2a3d; max-height:520px; overflow:auto; padding:8px 0; }
  .ide-view { background:#10141d; max-height:520px; overflow:auto; }
  .tnode { font-family:Consolas,monospace; font-size:12.5px; padding:3px 10px 3px 0; cursor:pointer; white-space:nowrap; color:#b9c6dc; }
  .tnode:hover { background:#172033; }
  .tnode.sel { background:#1c2942; color:#eaf2ff; }
  .tnode.dir { color:#9fb6d9; }
  .ide-head { padding:8px 12px; border-bottom:1px solid #1f2a3d; font-family:Consolas,monospace; font-size:12.5px; color:#9fb0c9; display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .ide-body { margin:0; padding:12px 14px; font-family:Consolas,monospace; font-size:12.5px; line-height:1.5; white-space:pre; color:#dbe6f7; }
  .ide-body.diff .add { color:#6ee7a8; } .ide-body.diff .del { color:#f9a8a8; } .ide-body.diff .hdr { color:#93c5fd; }
</style>
</head>
<body>
<div class="wrap">
  <div><span id="status">● live</span>
  <h1>Local Coding Agent <span class="pill" id="ver"></span> <span class="pill" id="modePill"></span></h1></div>
  <p class="sub">Số liệu cục bộ trên máy này · since <span id="since"></span> · tự cập nhật 2.5s · <span class="btn" id="clearBtn" onclick="clearMetrics()">Clear metrics</span></p>

  <div class="panel" style="margin-bottom:16px">
    <h3>Đường dẫn ChatGPT đang thao tác (workspace / roots)</h3>
    <div id="roots" style="font-family:Consolas,monospace;font-size:13px;color:#7fe0d2"></div>
    <div class="note">MCP endpoint: <span id="mcpep"></span> · Đây là thư mục mà ChatGPT đọc/ghi qua MCP. Để kiểm chứng, bảo ChatGPT chạy tool <b>workspace_info</b> — nó trả về đúng các path này.</div>
  </div>

  <div class="panel" style="margin-bottom:16px">
    <h3>AI Agent Quick Setup Prompts</h3>
    <div class="note">Copy one prompt into ChatGPT, Claude Code, Codex, or Cursor so the customer's AI can setup, update, or diagnose this repo with safe defaults.</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="btn" onclick="copyCustomerPrompt('setup')">Copy setup prompt</span>
      <span class="btn" onclick="copyCustomerPrompt('update')">Copy update prompt</span>
      <span class="btn" onclick="copyCustomerPrompt('diagnose')">Copy diagnose prompt</span>
      <span class="dim" id="promptCopied"></span>
    </div>
  </div>

  <div class="cards" id="cards"></div>

  <div class="panel">
    <h3>Pro speed & safety tips</h3>
    <div id="proTips"><div class="dim">Loading recommendations...</div></div>
  </div>

  <div class="panel">
    <h3>Tokens / phút (ước tính)</h3>
    <canvas id="chart" width="1140" height="220"></canvas>
    <div class="note">Ước tính = (ký tự input + output của tool) ÷ 4. Đây là token DỮ LIỆU đi qua connector, KHÔNG phải token tính phí của ChatGPT.</div>
  </div>

  <div class="grid">
    <div class="panel"><h3>Top tools</h3><table id="tools"></table></div>
    <div class="panel"><h3>Recent calls</h3><div id="recent"></div></div>
  </div>

  <div class="panel">
    <h3>Pending approvals</h3>
    <div id="approvals"><div class="dim">Không có yêu cầu đang chờ.</div></div>
    <div class="note">Quyết định tại dashboard cục bộ, tách khỏi MCP client. Approval chỉ dùng một lần và được scope theo workspace.</div>
  </div>

  <div class="panel">
    <h3>Files <span class="btn" id="refreshTree" onclick="loadTree()" style="margin-left:8px">Refresh</span> <span class="btn" id="diffBtn" onclick="toggleDiff()" style="margin-left:4px">Diff</span></h3>
    <div class="ide">
      <div class="ide-tree" id="tree"><div class="note" style="padding:8px 12px">Loading…</div></div>
      <div class="ide-view">
        <div class="ide-head"><span id="viewPath">Chọn một tệp ở bên trái để xem (read-only).</span><span id="viewMeta" class="dim"></span></div>
        <pre class="ide-body" id="viewBody"></pre>
      </div>
    </div>
    <div class="note">Read-only file browser for the workspace primary root. Diff shows <code>git diff</code> of the primary root. Local only — never tunneled.</div>
  </div>
</div>

<script>
function h(n){ return (n==null?0:n).toLocaleString(); }
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
var customerPrompts={};
async function loadCustomerPrompts(){
  try{
    var r=await fetch('/api/customer-prompts',{cache:'no-store'});
    var d=await r.json();
    customerPrompts=d.prompts||{};
  }catch(e){}
}
async function copyCustomerPrompt(kind){
  if(!customerPrompts[kind]) await loadCustomerPrompts();
  var text=customerPrompts[kind]||'';
  var el=document.getElementById('promptCopied');
  try{
    await navigator.clipboard.writeText(text);
    el.textContent='Copied '+kind+' prompt';
    setTimeout(function(){ el.textContent=''; },1600);
  }catch(e){
    el.textContent='Copy failed';
  }
}
function fmtDur(s){ var m=Math.floor(s/60),hh=Math.floor(m/60); if(hh>0) return hh+'h '+(m%60)+'m'; if(m>0) return m+'m '+(s%60)+'s'; return s+'s'; }
function fmtMs(ms){ if(ms>=1000) return (ms/1000).toFixed(ms>=10000?1:2)+'s'; return Math.round(ms||0)+'ms'; }
function card(label,val,sub){ return '<div class="card"><div class="clab">'+label+'</div><div class="cval">'+val+'</div><div class="csub">'+(sub||'')+'</div></div>'; }
function renderCards(d){
  var html='';
  html+=card('Health score', h(d.health_score||100)+'/100', (d.health_label||'excellent')+' - policy '+(d.policy||'balanced'));
  html+=card('Est. tokens (total)', h(d.est_tokens_total), 'in '+h(d.est_tokens_in)+' · out '+h(d.est_tokens_out));
  html+=card('Tool calls', h(d.total_calls), 'ok '+h(d.ok_calls)+' · err '+h(d.error_calls));
  html+=card('Success rate', (d.success_rate||0).toFixed(2)+'%', (d.calls_per_minute||0).toFixed(2)+' calls/phút');
  html+=card('Latency p95', fmtMs(d.p95_latency_ms), 'avg '+fmtMs(d.avg_latency_ms)+' · p99 '+fmtMs(d.p99_latency_ms));
  html+=card('Data qua connector', Math.round((d.in_chars+d.out_chars)/1024).toLocaleString()+' KB', 'tổng ký tự in/out');
  html+=card('Uptime', fmtDur(d.uptime_sec||0), 'mode '+d.mode);
  html+=card('Tiến trình nền', h(d.running_processes), 'đang chạy');
  document.getElementById('cards').innerHTML=html;
  document.getElementById('ver').textContent='v'+(d.version||'');
  document.getElementById('modePill').textContent=(d.mode||'')+' mode - '+(d.policy||'balanced')+' policy';
  document.getElementById('since').textContent=d.since? new Date(d.since).toLocaleString():'-';
  document.getElementById('roots').innerHTML=(d.roots||[]).map(function(r){return esc(r);}).join('<br>')||'-';
  document.getElementById('mcpep').textContent=d.mcp_endpoint||'-';
}
function renderChart(buckets){
  var c=document.getElementById('chart'), x=c.getContext('2d'); var W=c.width,H=c.height; x.clearRect(0,0,W,H);
  var data=(buckets||[]).slice(-60); var pad=34;
  if(!data.length){ x.fillStyle='#5b6b86'; x.font='13px sans-serif'; x.fillText('Chưa có dữ liệu',12,24); return; }
  var max=1; data.forEach(function(b){ if(b.tokens>max) max=b.tokens; });
  var bw=(W-pad-6)/data.length;
  x.strokeStyle='#223048'; x.beginPath(); x.moveTo(pad,H-pad); x.lineTo(W-4,H-pad); x.stroke();
  data.forEach(function(b,i){
    var bh=(H-pad*2)*(b.tokens/max); var bx=pad+i*bw; var by=H-pad-bh;
    x.fillStyle='#2dd4bf'; x.fillRect(bx+1,by,Math.max(1,bw-2),Math.max(0,bh));
  });
  x.fillStyle='#5b6b86'; x.font='12px sans-serif';
  x.fillText('max '+max.toLocaleString()+' tok/phút',pad,16);
}
function renderTools(t){
  var html='<tr><th>Tool</th><th>Calls</th><th>Err</th><th>Avg</th><th>P95</th><th>Est tokens</th></tr>';
  (t||[]).slice(0,15).forEach(function(r){ html+='<tr><td>'+r.name+'</td><td>'+h(r.calls)+'</td><td>'+h(r.err)+'</td><td>'+fmtMs(r.avg_ms)+'</td><td>'+fmtMs(r.p95_ms)+'</td><td>'+h(r.tokens)+'</td></tr>'; });
  document.getElementById('tools').innerHTML=html;
}
function renderRecent(r){
  var html='';
  (r||[]).slice(0,22).forEach(function(e){
    var tt=new Date(e.ts).toLocaleTimeString();
    var reason = (!e.ok && e.error) ? ' <span class="errmsg">'+esc(e.error)+'</span>' : '';
    html+='<div class="row"><span class="t">'+tt+'</span> <span class="'+(e.ok?'ok':'err')+'">'+(e.ok?'OK':'ERR')+'</span> <b>'+e.tool+'</b> <span class="dim">'+fmtMs(e.duration_ms)+' · '+h(e.tokens)+' tok</span>'+reason+'</div>';
  });
  document.getElementById('recent').innerHTML=html||'<div class="dim">Chưa có lệnh nào</div>';
}
function renderProTips(d){
  var tips=d.pro_tips||[];
  var bottlenecks=d.bottlenecks||[];
  var html='';
  if(bottlenecks.length) html+='<div class="row"><b>Bottlenecks:</b> <span class="dim">'+bottlenecks.map(esc).join(', ')+'</span></div>';
  tips.forEach(function(t){ html+='<div class="row">'+esc(t)+'</div>'; });
  document.getElementById('proTips').innerHTML=html||'<div class="dim">No recommendations yet.</div>';
}
async function loadApprovals(){
  try{
    var r=await fetch('/api/approvals',{cache:'no-store'}), d=await r.json(), html='';
    (d.pending||[]).forEach(function(a){
      var actions=Array.isArray(a.actions)?a.actions:[a.action];
      var label=actions.length>1?'Exact batch ('+actions.length+')':actions[0];
      var detail=actions.length>1?'<div class="dim">'+actions.map(esc).join('<br>')+'</div>':'';
      html+='<div class="row"><b>'+esc(label)+'</b>'+detail+'<div class="dim">'+esc(a.reason||'')+' · expires '+new Date(a.expires_at||a.created).toLocaleTimeString()+'</div>'+
        '<button class="btn" data-id="'+esc(a.id)+'" data-action="approve" onclick="decideApprovalFromButton(this)">Approve once</button> '+
        '<button class="btn" data-id="'+esc(a.id)+'" data-action="deny" onclick="decideApprovalFromButton(this)">Deny</button></div>';
    });
    document.getElementById('approvals').innerHTML=html||'<div class="dim">Không có yêu cầu đang chờ.</div>';
  }catch(e){}
}
function decideApprovalFromButton(btn){
  decideApproval(btn.getAttribute('data-id'), btn.getAttribute('data-action'));
}
async function decideApproval(id,action){
  await fetch('/api/approvals/'+encodeURIComponent(id)+'/'+action,{method:'POST'});
  loadApprovals();
}
async function tick(){
  try{
    var r=await fetch('/metrics',{cache:'no-store'}); var d=await r.json();
    renderCards(d); renderChart(d.buckets); renderTools(d.top_tools); renderRecent(d.recent); renderProTips(d); loadApprovals();
    document.getElementById('status').textContent='● live'; document.getElementById('status').className='';
    document.getElementById('status').style.color='#2dd4bf';
  }catch(e){
    document.getElementById('status').textContent='○ offline'; document.getElementById('status').style.color='#f87171';
  }
}
async function clearMetrics(){
  if(!confirm('Xóa toàn bộ số liệu (metrics)?')) return;
  try{ await fetch('/api/clear-metrics',{method:'POST'}); tick(); }
  catch(e){ alert('Clear failed: '+e); }
}

// ---- Mini-IDE (Files) ----
var diffMode=false, selPath=null;
function loadTree(){
  diffMode=false; var db=document.getElementById('diffBtn'); if(db) db.classList.remove('active');
  fetch('/api/tree',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('tree');
    if(d.error){ el.innerHTML='<div class="note" style="padding:8px 12px">'+esc(d.error)+'</div>'; return; }
    var html='';
    (d.entries||[]).forEach(function(e){
      var depth=(e.path.match(/\\//g)||[]).length;
      var name=e.path.split('/').pop();
      var pad=6+depth*14;
      if(e.type==='directory'){
        html+='<div class="tnode dir" style="padding-left:'+pad+'px">'+esc(name)+'/</div>';
      }else{
        html+='<div class="tnode" data-path="'+esc(e.path)+'" style="padding-left:'+pad+'px" onclick="openFile(this)">'+esc(name)+'</div>';
      }
    });
    if(d.truncated) html+='<div class="note" style="padding:6px 12px">… (truncated)</div>';
    el.innerHTML=html||'<div class="note" style="padding:8px 12px">(empty)</div>';
  }).catch(function(e){ document.getElementById('tree').innerHTML='<div class="note" style="padding:8px 12px">offline</div>'; });
}
function openFile(node){
  var p=node.getAttribute('data-path'); selPath=p; diffMode=false;
  var db=document.getElementById('diffBtn'); if(db) db.classList.remove('active');
  document.querySelectorAll('.tnode.sel').forEach(function(n){n.classList.remove('sel');});
  node.classList.add('sel');
  document.getElementById('viewPath').textContent=p;
  document.getElementById('viewMeta').textContent='';
  var body=document.getElementById('viewBody'); body.className='ide-body'; body.textContent='Loading…';
  fetch('/api/file?path='+encodeURIComponent(p),{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(d.error){ body.textContent='Error: '+d.error; return; }
    body.textContent=d.content||'';
    document.getElementById('viewMeta').textContent=h(d.total_lines)+' lines'+(d.truncated?' · truncated':'');
  }).catch(function(e){ body.textContent='offline'; });
}
function renderDiff(text){
  var body=document.getElementById('viewBody'); body.className='ide-body diff';
  if(!text){ body.textContent='(no changes)'; return; }
  var html=text.split('\\n').map(function(l){
    var c=esc(l);
    if(l.indexOf('+++')===0||l.indexOf('---')===0) return '<span class="hdr">'+c+'</span>';
    if(l[0]==='+') return '<span class="add">'+c+'</span>';
    if(l[0]==='-') return '<span class="del">'+c+'</span>';
    if(l.indexOf('@@')===0||l.indexOf('diff --git')===0) return '<span class="hdr">'+c+'</span>';
    return c;
  }).join('\\n');
  body.innerHTML=html;
}
function toggleDiff(){
  diffMode=!diffMode;
  var db=document.getElementById('diffBtn');
  if(!diffMode){ db.classList.remove('active'); document.getElementById('viewPath').textContent=selPath||'Chọn một tệp.'; var b=document.getElementById('viewBody'); b.className='ide-body'; b.textContent=''; return; }
  db.classList.add('active');
  document.getElementById('viewPath').textContent='git diff (primary root)';
  document.getElementById('viewMeta').textContent='';
  var body=document.getElementById('viewBody'); body.className='ide-body'; body.textContent='Loading…';
  fetch('/api/diff',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(d.error){ body.textContent='Error: '+d.error; return; }
    renderDiff(d.diff||'');
  }).catch(function(e){ body.textContent='offline'; });
}
loadTree();
tick(); setInterval(tick,2500);
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// ============================================================================
// v2.1 — Repo Intelligence
// ============================================================================

const REPO_INDEX_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function readRepoIndex() {
  try {
    const raw = await readFile(INDEX_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeRepoIndex(data) {
  await mkdir(path.dirname(INDEX_PATH), { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(data, null, 2), "utf8");
}

function indexFresh(idx) {
  if (!idx || !idx.ts) return false;
  return Date.now() - new Date(idx.ts).getTime() < REPO_INDEX_TTL_MS;
}

async function detectProjectProfile(rootDir) {
  const profile = { languages: [], frameworks: [], packageManagers: [], scripts: {}, manifests: [] };

  async function tryRead(rel) {
    try {
      return await readFile(path.join(rootDir, rel), "utf8");
    } catch {
      return null;
    }
  }

  // Node / JavaScript / TypeScript
  const pkgJson = await tryRead("package.json");
  if (pkgJson) {
    profile.manifests.push("package.json");
    try {
      const pkg = JSON.parse(pkgJson);
      profile.languages.push("javascript");
      profile.packageManagers.push("npm");
      if (existsSync(path.join(rootDir, "yarn.lock"))) profile.packageManagers.push("yarn");
      if (existsSync(path.join(rootDir, "pnpm-lock.yaml"))) profile.packageManagers.push("pnpm");
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["typescript"] || existsSync(path.join(rootDir, "tsconfig.json"))) profile.languages.push("typescript");
      if (deps["react"] || deps["react-dom"]) profile.frameworks.push("react");
      if (deps["next"]) profile.frameworks.push("next.js");
      if (deps["express"]) profile.frameworks.push("express");
      if (deps["@nestjs/core"]) profile.frameworks.push("nestjs");
      if (deps["vite"]) profile.frameworks.push("vite");
      if (deps["vue"]) profile.frameworks.push("vue");
      if (deps["svelte"]) profile.frameworks.push("svelte");
      if (pkg.scripts) profile.scripts = pkg.scripts;
    } catch {
      // invalid json
    }
  }

  // Flutter / Dart
  const pubspec = await tryRead("pubspec.yaml");
  if (pubspec) {
    profile.manifests.push("pubspec.yaml");
    profile.languages.push("dart");
    profile.frameworks.push("flutter");
    profile.packageManagers.push("pub");
  }

  // Python
  const reqTxt = await tryRead("requirements.txt");
  const pyproject = await tryRead("pyproject.toml");
  if (reqTxt || pyproject) {
    profile.languages.push("python");
    if (pyproject) {
      profile.manifests.push("pyproject.toml");
      profile.packageManagers.push("pip");
      if (pyproject.includes("[tool.poetry]")) profile.packageManagers.push("poetry");
      if (pyproject.includes("[tool.rye]")) profile.packageManagers.push("rye");
    }
    if (reqTxt) {
      profile.manifests.push("requirements.txt");
      if (!profile.packageManagers.includes("pip")) profile.packageManagers.push("pip");
    }
    const hasTests = existsSync(path.join(rootDir, "pytest.ini")) || existsSync(path.join(rootDir, "setup.cfg"));
    if (hasTests) profile.frameworks.push("pytest");
  }

  // Go
  const goMod = await tryRead("go.mod");
  if (goMod) {
    profile.manifests.push("go.mod");
    profile.languages.push("go");
    profile.packageManagers.push("go modules");
  }

  // Rust
  const cargoToml = await tryRead("Cargo.toml");
  if (cargoToml) {
    profile.manifests.push("Cargo.toml");
    profile.languages.push("rust");
    profile.packageManagers.push("cargo");
  }

  // .NET
  let items;
  try {
    items = await readdir(rootDir);
  } catch {
    items = [];
  }
  const csproj = items.find((f) => f.endsWith(".csproj"));
  const sln = items.find((f) => f.endsWith(".sln"));
  if (csproj || sln) {
    if (csproj) profile.manifests.push(csproj);
    if (sln) profile.manifests.push(sln);
    profile.languages.push("csharp");
    profile.packageManagers.push("dotnet");
    profile.frameworks.push(".NET");
  }

  // Java / Gradle / Maven
  const pomXml = await tryRead("pom.xml");
  const buildGradle = await tryRead("build.gradle");
  if (pomXml) {
    profile.manifests.push("pom.xml");
    profile.languages.push("java");
    profile.packageManagers.push("maven");
  }
  if (buildGradle) {
    profile.manifests.push("build.gradle");
    if (!profile.languages.includes("java")) profile.languages.push("java");
    profile.packageManagers.push("gradle");
  }

  // Deduplicate
  profile.languages = [...new Set(profile.languages)];
  profile.frameworks = [...new Set(profile.frameworks)];
  profile.packageManagers = [...new Set(profile.packageManagers)];

  return profile;
}

// Scan source files for symbol definitions
async function scanSymbols(rootDir, { maxFiles = 500, maxMatches = 2000 } = {}) {
  const symbols = [];
  const exts = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py"]);

  // JS/TS patterns
  const jsPatterns = [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/, kind: "function" },
    { re: /^(?:export\s+)?class\s+(\w+)(?:\s|{)/, kind: "class" },
    { re: /^(?:export\s+)?const\s+(\w+)\s*=/, kind: "const" },
    { re: /^\s{0,4}(\w+)\s*\([^)]*\)\s*\{/, kind: "method" },
    { re: /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/, kind: "route" }
  ];
  // Python patterns
  const pyPatterns = [
    { re: /^def\s+(\w+)\s*\(/, kind: "function" },
    { re: /^class\s+(\w+)(?:\s|:)/, kind: "class" },
    { re: /^\s{4}def\s+(\w+)\s*\(/, kind: "method" }
  ];

  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (symbols.length >= maxMatches) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (exts.has(path.extname(e.name).toLowerCase())) {
        if (symbols.length >= maxMatches) return;
        let content;
        try {
          content = await readFile(abs, "utf8");
        } catch {
          continue;
        }
        const isPy = e.name.endsWith(".py");
        const patterns = isPy ? pyPatterns : jsPatterns;
        const lines = content.split(/\r?\n/);
        let fileCount = 0;
        for (let i = 0; i < lines.length && symbols.length < maxMatches; i++) {
          for (const pat of patterns) {
            const m = lines[i].match(pat.re);
            if (m) {
              let name = m[1];
              if (pat.kind === "route") name = `${m[1].toUpperCase()} ${m[2]}`;
              if (name && name.length < 60) {
                symbols.push({ path: toRel(abs), line: i + 1, kind: pat.kind, name });
                fileCount++;
                break; // one match per line
              }
            }
          }
        }
      }
    }
  }

  await walk(rootDir, 1);
  return symbols;
}

async function collectImportantFiles(rootDir) {
  const IMPORTANT_GLOBS = [
    /^readme(\.\w+)?$/i,
    /^agents\.md$/i,
    /^package\.json$/i,
    /^package-lock\.json$/i,
    /^tsconfig.*\.json$/i,
    /^\.env\.example$/i,
    /^dockerfile$/i,
    /^docker-compose.*\.(yml|yaml)$/i,
    /^pubspec\.yaml$/i,
    /^makefile$/i,
    /^cargo\.toml$/i,
    /^go\.mod$/i,
    /^pyproject\.toml$/i,
    /^requirements.*\.txt$/i,
    /^\.eslintrc.*$/i,
    /^\.prettierrc.*$/i,
    /^\.gitignore$/i,
    /^changelog\.md$/i,
    /^security\.md$/i,
    /^license$/i,
    /^license\..*$/i
  ];
  const result = [];

  let rootItems;
  try {
    rootItems = await readdir(rootDir, { withFileTypes: true });
  } catch {
    rootItems = [];
  }
  for (const e of rootItems) {
    if (!e.isFile()) continue;
    if (IMPORTANT_GLOBS.some((re) => re.test(e.name))) {
      const abs = path.join(rootDir, e.name);
      try {
        const info = await stat(abs);
        result.push({ path: toRel(abs), size: info.size });
      } catch { /* skip */ }
    }
  }

  const ghDir = path.join(rootDir, ".github", "workflows");
  try {
    const wfItems = await readdir(ghDir, { withFileTypes: true });
    for (const e of wfItems) {
      if (e.isFile() && /\.(yml|yaml)$/i.test(e.name)) {
        const abs = path.join(ghDir, e.name);
        try {
          const info = await stat(abs);
          result.push({ path: toRel(abs), size: info.size });
        } catch { /* skip */ }
      }
    }
  } catch { /* no .github/workflows */ }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function compactGitStatus(rootDir) {
  const status = await spawnCapture("git", ["status", "--porcelain"], rootDir, DEFAULT_CMD_TIMEOUT);
  if (status.exit_code !== 0) {
    return {
      is_git_repo: false,
      clean: null,
      error: (status.stderr || "not a git repository").split(/\r?\n/)[0]
    };
  }
  const branchRes = await spawnCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], rootDir, DEFAULT_CMD_TIMEOUT);
  const files = parsePorcelain(status.stdout || "");
  const counts = {};
  for (const f of files) {
    const key = `${f.index || " "}${f.worktree || " "}`.trim() || "changed";
    counts[key] = (counts[key] || 0) + 1;
  }
  return {
    is_git_repo: true,
    branch: (branchRes.stdout || "").trim() || null,
    clean: files.length === 0,
    count: files.length,
    counts,
    files: files.slice(0, 60)
  };
}

function recommendNextActions({ profile, git, commands, health, truncated }) {
  const actions = [];
  if (health?.bottlenecks?.length) {
    actions.push("Stabilize the session first: inspect health.tips and avoid repeating failing/high-latency call patterns.");
  }
  if (git?.is_git_repo && git.count > 0) {
    actions.push("Review current changes with git_diff/change_summary before large edits.");
  }
  if (truncated) {
    actions.push("Call repo_map with a narrower path/depth if you need more tree detail.");
  }
  if (commands?.test || commands?.build || commands?.lint) {
    const gates = [commands.lint && "lint", commands.typecheck && "typecheck", commands.test && "test", commands.build && "build"].filter(Boolean).join(",");
    actions.push(`Use quality_gate after edits (include: ${gates}) for one structured verification report.`);
  } else {
    actions.push("No test/build/lint command detected; provide explicit command when verifying changes.");
  }
  if ((profile?.languages || []).length) {
    actions.push(`Detected stack: ${(profile.languages || []).join(", ")}${profile.frameworks?.length ? ` / ${(profile.frameworks || []).join(", ")}` : ""}.`);
  }
  actions.push("Prefer read_many/search_text/apply_patch batches to keep MCP tunnel round-trips low.");
  return actions.slice(0, 6);
}

async function collectWorkspaceDoctor(rootDir) {
  const [profile, commands, git, importantFiles] = await Promise.all([
    detectProjectProfile(rootDir).catch(() => ({ languages: [], frameworks: [], packageManagers: [], manifests: [], scripts: {} })),
    getTestCommandsMerged(rootDir).catch((error) => ({ error: error?.message || String(error) })),
    compactGitStatus(rootDir),
    collectImportantFiles(rootDir).catch(() => [])
  ]);
  const checks = [];
  const add = (id, status, title, detail, recommendation) => checks.push({ id, status, title, detail, recommendation });

  add("version", "pass", "Version", `Local Coding Agent ${VERSION} (${PRODUCT_TIER})`, null);
  add("roots", ROOTS.length ? "pass" : "fail", "Workspace roots", `${ROOTS.length} root(s) configured`, ROOTS.length ? null : "Set AGENT_WORKSPACE to the repository you want to work on.");
  add("policy", AGENT_POLICY === "balanced" ? "pass" : "warn", "Policy", `AGENT_POLICY=${AGENT_POLICY}`, AGENT_POLICY === "full" ? "Use balanced for day-to-day work unless this is trusted automation." : AGENT_POLICY === "strict" ? "Strict is safe but write/test flows will be blocked." : null);
  add("mode", MODE === "safe" ? "pass" : "warn", "Command mode", `AGENT_MODE=${MODE}`, MODE === "full" ? "Use safe mode for normal agent work; full is best reserved for trusted automation." : null);
  add("auth", AUTH_TOKEN ? "pass" : "warn", "MCP auth", AUTH_TOKEN ? "Bearer auth enabled" : "MCP_AUTH_TOKEN is not set", AUTH_TOKEN ? null : "Set MCP_AUTH_TOKEN if exposing beyond the private OpenAI tunnel/local loopback.");
  add("origin", ALLOWED_ORIGINS.size ? "warn" : "pass", "Browser Origin policy", ALLOWED_ORIGINS.size ? `${ALLOWED_ORIGINS.size} browser origin(s) allowed` : "Browser-origin MCP calls blocked by default", ALLOWED_ORIGINS.size ? "Keep MCP_ALLOWED_ORIGINS as narrow as possible." : null);
  add("rg", RG_BIN ? "pass" : "warn", "ripgrep", RG_BIN ? `Found: ${RG_BIN}` : "ripgrep not found; search_text falls back to slower scanning", RG_BIN ? null : "Install ripgrep for faster searches on large repos.");
  add("git", git.is_git_repo ? "pass" : "warn", "Git repository", git.is_git_repo ? `${git.clean ? "clean" : `${git.count} changed file(s)`} on ${git.branch || "unknown branch"}` : "Not a git repo or git unavailable", git.is_git_repo ? (git.count > 0 ? "Review current changes before large edits." : null) : "Initialize git or run from the repository root for better change tracking.");
  add("profile", (profile.languages || []).length ? "pass" : "warn", "Project profile", (profile.languages || []).length ? `Detected ${(profile.languages || []).join(", ")}` : "No language/framework detected", (profile.languages || []).length ? null : "Add standard manifests or verify AGENT_WORKSPACE points at the repo root.");
  add("commands", commands?.test || commands?.build || commands?.lint ? "pass" : "warn", "Quality commands", JSON.stringify(commands), commands?.test || commands?.build || commands?.lint ? null : "Add package scripts or use quality_gate with explicit commands through profile.testCommands.");
  const hasReadme = importantFiles.some((f) => /^README/i.test(path.basename(f.path)));
  const hasSecurityDoc = importantFiles.some((f) => /^security\.md$/i.test(path.basename(f.path)));
  add("docs", hasReadme ? "pass" : "warn", "README", "README presence checked", hasReadme ? null : "Add a README so agents and contributors understand the repo quickly.");
  add("security_doc", hasSecurityDoc ? "pass" : "warn", "Security docs", "SECURITY.md presence checked", hasSecurityDoc ? null : "Add SECURITY.md for MCP/local-command safety expectations.");

  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const score = Math.max(0, Math.min(100, 100 - fail * 25 - warn * 6));
  const status = fail ? "fail" : warn ? "warn" : "pass";
  return {
    status,
    score,
    root: toRel(rootDir),
    version: VERSION,
    tier: PRODUCT_TIER,
    mode: MODE,
    policy: AGENT_POLICY,
    checks,
    summary: { pass: checks.filter((c) => c.status === "pass").length, warn, fail },
    profile,
    commands,
    git,
    important_files: importantFiles.slice(0, 80),
    recommendations: checks.filter((c) => c.recommendation).map((c) => ({ id: c.id, recommendation: c.recommendation })).slice(0, 10)
  };
}

function normalizeGatePlan(include, commands) {
  const wanted = include?.length ? include : ["lint", "typecheck", "test", "build"];
  const allowed = new Set(["lint", "typecheck", "test", "build"]);
  return wanted
    .filter((name) => allowed.has(name))
    .map((name) => ({ name, command: commands?.[name] || null }));
}

async function runQualityGate({ cwd = ".", include, timeout_ms = 120_000, stop_on_failure = true, dry_run = false }) {
  const rootDir = resolvePath(cwd);
  const commands = await getTestCommandsMerged(rootDir);
  const plan = normalizeGatePlan(include, commands);
  const started = Date.now();
  const gates = [];
  if (dry_run) {
    return { ok: true, dry_run: true, root: toRel(rootDir), plan, commands, duration_ms: 0 };
  }
  for (const gate of plan) {
    if (!gate.command) {
      gates.push({ name: gate.name, status: "skipped", ok: true, reason: "command not detected" });
      continue;
    }
    assertCommandAllowed(gate.command);
    const result = await runGatedCommand(gate.command, rootDir, timeout_ms);
    const entry = { name: gate.name, status: result.ok ? "pass" : "fail", ...result };
    gates.push(entry);
    if (gate.name === "test") recordTestRun(gate.command, result.ok, result.summary);
    if (!result.ok && stop_on_failure) break;
  }
  const failed = gates.filter((g) => g.status === "fail");
  const ran = gates.filter((g) => g.status === "pass" || g.status === "fail");
  return {
    ok: failed.length === 0,
    root: toRel(rootDir),
    commands,
    gates,
    ran: ran.length,
    skipped: gates.filter((g) => g.status === "skipped").length,
    failed: failed.length,
    duration_ms: Date.now() - started
  };
}

async function buildSessionReport(rootDir) {
  const [doctor, git] = await Promise.all([
    collectWorkspaceDoctor(rootDir),
    compactGitStatus(rootDir)
  ]);
  const snapshot = metricsSnapshot();
  return {
    kind: "session_report",
    version: VERSION,
    tier: PRODUCT_TIER,
    ts: isoNow(),
    root: toRel(rootDir),
    mode: MODE,
    policy: AGENT_POLICY,
    health: {
      score: snapshot.health_score,
      label: snapshot.health_label,
      bottlenecks: snapshot.bottlenecks,
      tips: snapshot.pro_tips
    },
    metrics: {
      total_calls: snapshot.total_calls,
      ok_calls: snapshot.ok_calls,
      error_calls: snapshot.error_calls,
      success_rate: snapshot.success_rate,
      calls_per_minute: snapshot.calls_per_minute,
      avg_latency_ms: snapshot.avg_latency_ms,
      p95_latency_ms: snapshot.p95_latency_ms,
      est_tokens_total: snapshot.est_tokens_total,
      top_tools: snapshot.top_tools.slice(0, 12).map((t) => ({ name: t.name, calls: t.calls, err: t.err, tokens: t.tokens, avg_ms: t.avg_ms, p95_ms: t.p95_ms }))
    },
    git,
    doctor: {
      status: doctor.status,
      score: doctor.score,
      summary: doctor.summary,
      recommendations: doctor.recommendations
    },
    recent_errors: (metrics.recent || []).filter((r) => !r.ok).slice(0, 10)
  };
}

function registerRepoIntelTools(mcp) {
  reg(
    mcp,
    "workspace_doctor",
    {
      title: "Workspace doctor Pro",
      description: "PRO readiness check for the active workspace: roots, safety settings, auth/origin posture, git state, ripgrep, project profile, quality commands, docs, score, and recommendations.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to inspect (default: primary root).")
      }
    },
    async ({ path: rel = "." }) => {
      const rootDir = resolvePath(rel);
      return jsonResult(await collectWorkspaceDoctor(rootDir));
    }
  );

  reg(
    mcp,
    "workspace_snapshot",
    {
      title: "Workspace snapshot Pro",
      description: "PRO one-call briefing: roots, mode/policy, project profile, important files, compact tree, git status, test/build/lint commands, metrics health, and recommended next actions. Use this FIRST to reduce MCP round-trips.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to inspect (default: primary root)."),
        depth: z.number().int().min(1).max(5).optional().describe("Tree depth (default 3)."),
        max_entries: z.number().int().min(20).max(1200).optional().describe("Max tree entries (default 350)."),
        include_symbols: z.boolean().optional().describe("Include compact symbol sample (default false)."),
        refresh: z.boolean().optional().describe("Refresh cached profile/index.")
      }
    },
    async ({ path: rel = ".", depth = 3, max_entries = 350, include_symbols = false, refresh = false }) => {
      const rootDir = resolvePath(rel);
      const idx = await readRepoIndex();
      let profile;
      if (!refresh && idx && indexFresh(idx) && idx.profile && idx.profile.rootDir === rootDir) {
        profile = idx.profile;
      } else {
        profile = await detectProjectProfile(rootDir);
        const newIdx = { ...(idx || {}), ts: isoNow(), profile: { rootDir, ...profile } };
        await writeRepoIndex(newIdx);
        profile = newIdx.profile;
      }

      const [{ tree, dirs, files }, importantFiles, commands, git, symbols] = await Promise.all([
        buildTree(rootDir, depth, max_entries),
        collectImportantFiles(rootDir),
        getTestCommandsMerged(rootDir).catch((error) => ({ error: error?.message || String(error) })),
        compactGitStatus(rootDir),
        include_symbols ? scanSymbols(rootDir, { maxFiles: 120, maxMatches: 80 }).catch(() => []) : Promise.resolve([])
      ]);
      const health = computeHealthInsights();
      const metricSummary = metricsSnapshot();
      const next = recommendNextActions({ profile, git, commands, health, treeCount: tree.length, truncated: tree.length >= max_entries });

      return jsonResult({
        kind: "workspace_snapshot",
        pro: true,
        version: VERSION,
        tier: PRODUCT_TIER,
        ts: isoNow(),
        root: toRel(rootDir),
        roots: ROOTS,
        mode: MODE,
        policy: AGENT_POLICY,
        auth: AUTH_TOKEN ? "bearer" : "none",
        safety: {
          file_tools_root_confined: true,
          command_cwd_root_confined: true,
          command_os_sandbox: false,
          browser_origin_mcp_default: ALLOWED_ORIGINS.size ? "allowlist" : "blocked"
        },
        profile: {
          languages: profile.languages || [],
          frameworks: profile.frameworks || [],
          packageManagers: profile.packageManagers || [],
          manifests: profile.manifests || [],
          scripts: profile.scripts || {}
        },
        commands,
        git,
        tree: {
          depth,
          dirs: dirs.length,
          files: files.length,
          truncated: tree.length >= max_entries,
          entries: tree.map(toRel).slice(0, max_entries)
        },
        important_files: importantFiles.slice(0, 80),
        symbols: include_symbols ? symbols.slice(0, 80) : undefined,
        metrics: {
          total_calls: metricSummary.total_calls,
          success_rate: metricSummary.success_rate,
          calls_per_minute: metricSummary.calls_per_minute,
          avg_latency_ms: metricSummary.avg_latency_ms,
          p95_latency_ms: metricSummary.p95_latency_ms,
          top_tools: metricSummary.top_tools.slice(0, 8).map((t) => ({ name: t.name, calls: t.calls, err: t.err, avg_ms: t.avg_ms, p95_ms: t.p95_ms }))
        },
        health,
        next_best_actions: next
      });
    }
  );

  reg(
    mcp,
    "project_profile",
    {
      title: "Project profile",
      description: "Detect languages, frameworks, package managers, and scripts in the workspace. Reads root manifests (package.json, pubspec.yaml, go.mod, Cargo.toml, etc.). Results are cached for 5 min.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to inspect (default: primary root)."),
        refresh: z.boolean().optional().describe("Force re-scan even if cache is fresh.")
      }
    },
    async ({ path: rel = ".", refresh = false }) => {
      const rootDir = resolvePath(rel);
      const idx = await readRepoIndex();
      if (!refresh && idx && indexFresh(idx) && idx.profile && idx.profile.rootDir === rootDir) {
        return jsonResult({ ...idx.profile, cached: true, ts: idx.ts });
      }
      const profile = await detectProjectProfile(rootDir);
      const entry = { rootDir, ...profile };
      const newIdx = { ...(idx || {}), ts: isoNow(), profile: entry };
      await writeRepoIndex(newIdx);
      return jsonResult({ ...entry, cached: false, ts: newIdx.ts });
    }
  );

  reg(
    mcp,
    "important_files",
    {
      title: "Important files",
      description: "List key project files (README, config, CI, Docker, etc.) with their sizes.",
      inputSchema: {
        path: z.string().optional().describe("Root dir (default: primary root).")
      }
    },
    async ({ path: rel = "." }) => {
      const rootDir = resolvePath(rel);
      const result = await collectImportantFiles(rootDir);
      return jsonResult({ count: result.length, files: result });
    }
  );

  reg(
    mcp,
    "repo_map",
    {
      title: "Repo map",
      description: "One call: directory tree + detected manifests + package scripts + project profile summary. Use this FIRST to understand a repo. Results cached 5 min.",
      inputSchema: {
        path: z.string().optional(),
        depth: z.number().int().min(1).max(6).optional(),
        max_entries: z.number().int().min(10).max(4000).optional(),
        refresh: z.boolean().optional()
      }
    },
    async ({ path: rel = ".", depth = 3, max_entries = 800, refresh = false }) => {
      const rootDir = resolvePath(rel);
      const idx = await readRepoIndex();
      let profile;
      if (!refresh && idx && indexFresh(idx) && idx.profile && idx.profile.rootDir === rootDir) {
        profile = idx.profile;
      } else {
        profile = await detectProjectProfile(rootDir);
        const newIdx = { ...(idx || {}), ts: isoNow(), profile: { rootDir, ...profile } };
        await writeRepoIndex(newIdx);
        profile = newIdx.profile;
      }

      const { tree, dirs, files } = await buildTree(rootDir, depth, max_entries);
      const manifests = files.filter((f) => MANIFEST_NAMES.has(path.basename(f).toLowerCase()));

      return jsonResult({
        root: toRel(rootDir),
        depth,
        dirs: dirs.length,
        files: files.length,
        truncated: tree.length >= max_entries,
        manifests: manifests.map(toRel).slice(0, 100),
        tree: tree.map(toRel),
        profile: {
          languages: profile.languages,
          frameworks: profile.frameworks,
          packageManagers: profile.packageManagers,
          scripts: profile.scripts || {}
        },
        cached: !refresh && idx && indexFresh(idx)
      });
    }
  );

  reg(
    mcp,
    "repo_symbols",
    {
      title: "Repo symbols",
      description: "Scan source files for function/class/route definitions. Returns [{path, line, kind, name}]. Useful for navigation without reading entire files.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to scan."),
        max_files: z.number().int().min(1).max(2000).optional(),
        max_matches: z.number().int().min(1).max(5000).optional(),
        kind: z.enum(["function", "class", "const", "method", "route"]).optional().describe("Filter by symbol kind.")
      }
    },
    async ({ path: rel = ".", max_files = 500, max_matches = 2000, kind }) => {
      const rootDir = resolvePath(rel);
      const symbols = await scanSymbols(rootDir, { maxFiles: max_files, maxMatches: max_matches });
      const filtered = kind ? symbols.filter((s) => s.kind === kind) : symbols;
      return jsonResult({ count: filtered.length, symbols: filtered });
    }
  );

  reg(
    mcp,
    "index_status",
    {
      title: "Index status",
      description: "Return the current repo index cache status (age, freshness, profile summary).",
      inputSchema: {}
    },
    async () => {
      const idx = await readRepoIndex();
      if (!idx) return jsonResult({ cached: false, message: "No index cached yet. Call repo_map to build it." });
      const ageMs = Date.now() - new Date(idx.ts).getTime();
      return jsonResult({
        cached: true,
        fresh: indexFresh(idx),
        ts: idx.ts,
        age_seconds: Math.floor(ageMs / 1000),
        ttl_seconds: Math.floor(REPO_INDEX_TTL_MS / 1000),
        profile_languages: idx.profile?.languages || [],
        profile_frameworks: idx.profile?.frameworks || []
      });
    }
  );
}

// ============================================================================
// v2.2 — Patch Engine + Undo
// ============================================================================

async function readPatchHistory() {
  try {
    return JSON.parse(await readFile(PATCH_HISTORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function writePatchHistory(history) {
  await mkdir(path.dirname(PATCH_HISTORY_PATH), { recursive: true });
  await writeFile(PATCH_HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
}

async function createBackupBatch(tool, filePaths) {
  const batchId = randomUUID();
  const batchDir = path.join(BACKUPS_DIR, batchId);
  await mkdir(batchDir, { recursive: true });

  const files = [];
  for (const fp of filePaths) {
    let hadContent = false;
    try {
      const abs = resolvePath(fp);
      if (existsSync(abs)) {
        const info = await stat(abs);
        const backupFile = path.join(batchDir, `${files.length}-${path.basename(abs) || "root"}`);
        if (info.isDirectory()) await cp(abs, backupFile, { recursive: true, force: true });
        else await copyFile(abs, backupFile);
        hadContent = true;
        files.push({ path: abs, backupFile, hadContent, kind: info.isDirectory() ? "directory" : "file" });
      } else {
        files.push({ path: abs, backupFile: null, hadContent: false, kind: "missing" });
      }
    } catch {
      files.push({ path: String(fp), backupFile: null, hadContent, kind: "unknown" });
    }
  }

  const record = { id: batchId, ts: isoNow(), tool, batchDir, files };
  const history = await readPatchHistory();
  history.push(record);
  if (history.length > 50) {
    const expired = history.splice(0, history.length - 50);
    for (const old of expired) rm(old.batchDir, { recursive: true, force: true }).catch(() => {});
  }
  await writePatchHistory(history);
  return record;
}

// Dry-run a unified diff: return per-file before/after + match status
async function dryRunUnifiedDiff(diffText) {
  const results = [];
  const lines = diffText.split(/\r?\n/);
  const fileChunks = [];
  let current = null;

  const stripPrefix = (p) => p.replace(/^["']|["']$/g, "").replace(/^[ab]\//, "").trim();

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("--- ")) {
      const next = lines[i + 1] || "";
      const minus = stripPrefix(ln.slice(4));
      const plus = next.startsWith("+++ ") ? stripPrefix(next.slice(4)) : "";
      current = { minus, plus, hunks: [], hunk: null };
      fileChunks.push(current);
      if (next.startsWith("+++ ")) i++;
      continue;
    }
    if (!current) continue;
    if (ln.startsWith("@@")) {
      current.hunk = { before: [], after: [] };
      current.hunks.push(current.hunk);
      continue;
    }
    if (!current.hunk) continue;
    const tag = ln[0];
    const body = ln.slice(1);
    if (tag === " ") { current.hunk.before.push(body); current.hunk.after.push(body); }
    else if (tag === "-") { current.hunk.before.push(body); }
    else if (tag === "+") { current.hunk.after.push(body); }
  }

  for (const fc of fileChunks) {
    const isNew = fc.minus === "/dev/null";
    const isDelete = fc.plus === "/dev/null";
    const relPath = isNew ? fc.plus : fc.minus || fc.plus;
    try {
      const target = resolvePath(relPath);
      if (isDelete) {
        const exists = existsSync(target);
        results.push({ path: relPath, action: "delete", exists, ok: exists, conflict: !exists ? "file not found" : null });
        continue;
      }
      if (isNew) {
        const exists = existsSync(target);
        const content = fc.hunks.flatMap((h) => h.after).join("\n");
        results.push({ path: relPath, action: "create", exists, ok: true, preview_chars: content.length });
        continue;
      }
      const content = await readFile(target, "utf8");
      const hunkResults = [];
      let previewContent = content;
      let allMatch = true;
      for (const h of fc.hunks) {
        const before = h.before.join("\n");
        const after = h.after.join("\n");
        if (before === after) { hunkResults.push({ match: true, skipped: true }); continue; }
        const match = before ? content.includes(before) : true;
        if (!match) allMatch = false;
        hunkResults.push({ match, before_chars: before.length, after_chars: after.length });
        if (match && before) previewContent = previewContent.replace(before, after);
        else if (!before) previewContent += (previewContent.endsWith("\n") ? "" : "\n") + after;
      }
      results.push({ path: relPath, action: "update", ok: allMatch, hunks: hunkResults, conflict: allMatch ? null : "one or more hunks did not match" });
    } catch (err) {
      results.push({ path: relPath, action: "unknown", ok: false, conflict: String(err?.message || err) });
    }
  }
  return results;
}

function registerPatchEngineTools(mcp) {
  reg(
    mcp,
    "preview_patch",
    {
      title: "Preview patch (dry run)",
      description: "DRY RUN — compute what a patch/operations would change WITHOUT writing. Returns per-file match status and before/after summary.",
      inputSchema: {
        diff: z.string().optional().describe("Unified diff to preview."),
        operations: z.array(z.object({
          op: z.enum(["create", "update", "delete", "rename"]),
          path: z.string().min(1),
          content: z.string().optional(),
          rename_to: z.string().optional(),
          recursive: z.boolean().optional(),
          edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() })).optional()
        })).optional()
      }
    },
    async ({ diff, operations }) => {
      if (diff && diff.trim()) {
        const results = await dryRunUnifiedDiff(diff);
        const allOk = results.every((r) => r.ok);
        return jsonResult({ ok: allOk, mode: "diff", files: results });
      }
      if (!operations || !operations.length) throw new Error("Provide diff or operations.");
      const results = [];
      for (const op of operations) {
        try {
          const target = resolvePath(op.path);
          if (op.op === "create") {
            results.push({ op: "create", path: op.path, ok: true, bytes: Buffer.byteLength(op.content ?? "") });
          } else if (op.op === "update") {
            const content = await readFile(target, "utf8");
            const checks = (op.edits || []).map((e) => ({ old_text_chars: e.old_text.length, match: content.includes(e.old_text), new_text_chars: e.new_text.length }));
            const allMatch = checks.every((c) => c.match);
            results.push({ op: "update", path: op.path, ok: allMatch, edits: checks, conflict: allMatch ? null : "old_text not found" });
          } else if (op.op === "delete") {
            const exists = existsSync(target);
            results.push({ op: "delete", path: op.path, ok: exists, conflict: exists ? null : "file not found" });
          } else if (op.op === "rename") {
            const exists = existsSync(target);
            results.push({ op: "rename", path: op.path, rename_to: op.rename_to, ok: exists, conflict: exists ? null : "source not found" });
          }
        } catch (err) {
          results.push({ op: op.op, path: op.path, ok: false, conflict: String(err?.message || err) });
        }
      }
      return jsonResult({ ok: results.every((r) => r.ok), mode: "operations", files: results });
    }
  );

  reg(
    mcp,
    "validate_patch",
    {
      title: "Validate patch",
      description: "Like preview_patch but only returns ok status and a list of conflicts (ambiguous/not-found hunks). Fast check before apply.",
      inputSchema: {
        diff: z.string().optional(),
        operations: z.array(z.object({
          op: z.enum(["create", "update", "delete", "rename"]),
          path: z.string().min(1),
          content: z.string().optional(),
          rename_to: z.string().optional(),
          edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string() })).optional()
        })).optional()
      }
    },
    async ({ diff, operations }) => {
      if (diff && diff.trim()) {
        const results = await dryRunUnifiedDiff(diff);
        const conflicts = results.filter((r) => !r.ok).map((r) => ({ path: r.path, conflict: r.conflict }));
        return jsonResult({ ok: conflicts.length === 0, conflicts });
      }
      if (!operations || !operations.length) throw new Error("Provide diff or operations.");
      const conflicts = [];
      for (const op of operations) {
        try {
          const target = resolvePath(op.path);
          if (op.op === "update") {
            const content = await readFile(target, "utf8");
            for (const e of op.edits || []) {
              if (!content.includes(e.old_text)) {
                conflicts.push({ path: op.path, conflict: `old_text not found: "${e.old_text.slice(0, 60)}..."` });
              }
            }
          } else if (op.op === "delete" || op.op === "rename") {
            if (!existsSync(target)) conflicts.push({ path: op.path, conflict: "file not found" });
          }
        } catch (err) {
          conflicts.push({ path: op.path, conflict: String(err?.message || err) });
        }
      }
      return jsonResult({ ok: conflicts.length === 0, conflicts });
    }
  );

  reg(
    mcp,
    "undo_last_patch",
    {
      title: "Undo last patch",
      description: "Restore files from the most recent backup batch. Reverts modified files, recreates deleted files, removes created files.",
      inputSchema: {}
    },
    async () => {
      const history = await readPatchHistory();
      if (!history.length) throw new Error("No patch history to undo.");
      const batch = history[history.length - 1];
      const restored = [];
      const errors = [];
      for (const f of batch.files) {
        try {
          const abs = resolvePath(f.path);
          if (f.hadContent && f.backupFile && existsSync(f.backupFile)) {
            await rm(abs, { recursive: true, force: true });
            await mkdir(path.dirname(abs), { recursive: true });
            if (f.kind === "directory") await cp(f.backupFile, abs, { recursive: true, force: true });
            else if (f.kind === "file") await copyFile(f.backupFile, abs);
            else await writeFile(abs, await readFile(f.backupFile, "utf8"), "utf8");
            restored.push({ path: f.path, action: "restored" });
          } else if (!f.hadContent && existsSync(abs)) {
            await rm(abs, { recursive: true, force: true });
            restored.push({ path: f.path, action: "removed (was created)" });
          } else {
            restored.push({ path: f.path, action: "skipped (no backup)" });
          }
        } catch (err) {
          errors.push({ path: f.path, error: String(err?.message || err) });
        }
      }
      // Pop the history entry
      history.pop();
      await writePatchHistory(history);
      // Clean up backup dir
      try { await rm(batch.batchDir, { recursive: true, force: true }); } catch { /* ok */ }
      return jsonResult({ ok: errors.length === 0, tool: batch.tool, ts: batch.ts, restored, errors });
    }
  );
}

// Wire backup into write_file / replace_in_file / apply_patch / delete_path / move_path
// We do this by wrapping the handlers — patch the tool registration functions:
const _origApplyOne = applyOne;
async function applyOneWithBackup(op, batchId) {
  // backup is handled at the batch level before execution
  return _origApplyOne(op);
}

// ============================================================================
// v2.3 — Smart Test / Build Runner
// ============================================================================

async function detectTestCommands(rootDir) {
  const commands = { test: null, build: null, lint: null, dev: null, typecheck: null };

  async function tryRead(rel) {
    try { return await readFile(path.join(rootDir, rel), "utf8"); } catch { return null; }
  }

  // npm / Node
  const pkgJson = await tryRead("package.json");
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      const scripts = pkg.scripts || {};
      if (scripts.test) commands.test = `npm test`;
      if (scripts.build) commands.build = `npm run build`;
      if (scripts.lint) commands.lint = `npm run lint`;
      if (scripts.dev) commands.dev = `npm run dev`;
      if (scripts.typecheck || scripts["type-check"] || scripts["type:check"]) {
        commands.typecheck = `npm run ${Object.keys(scripts).find((k) => /typecheck|type.check/.test(k))}`;
      }
    } catch { /* skip */ }
  }

  // Python / pytest
  const pyproject = await tryRead("pyproject.toml");
  const reqTxt = await tryRead("requirements.txt");
  if (pyproject || reqTxt) {
    if (!commands.test) commands.test = "python -m pytest";
    if (!commands.lint) commands.lint = "python -m flake8";
  }

  // Go
  if (await tryRead("go.mod")) {
    if (!commands.test) commands.test = "go test ./...";
    if (!commands.build) commands.build = "go build ./...";
  }

  // Rust
  if (await tryRead("Cargo.toml")) {
    if (!commands.test) commands.test = "cargo test";
    if (!commands.build) commands.build = "cargo build";
    if (!commands.lint) commands.lint = "cargo clippy";
  }

  // Flutter
  if (await tryRead("pubspec.yaml")) {
    if (!commands.test) commands.test = "flutter test";
    if (!commands.build) commands.build = "flutter build";
  }

  // .NET
  let items;
  try { items = await readdir(rootDir); } catch { items = []; }
  if (items.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
    if (!commands.test) commands.test = "dotnet test";
    if (!commands.build) commands.build = "dotnet build";
  }

  // Gradle
  if (await tryRead("build.gradle")) {
    if (!commands.test) commands.test = "gradle test";
    if (!commands.build) commands.build = "gradle build";
  }

  // Maven
  if (await tryRead("pom.xml")) {
    if (!commands.test) commands.test = "mvn test";
    if (!commands.build) commands.build = "mvn package";
  }

  return commands;
}

function parseTestFailures(output) {
  const failures = [];
  const lines = output.split(/\r?\n/);
  const patterns = [
    // Jest / Vitest: "FAIL src/foo.test.ts" or "✕ test name"
    /^(FAIL|FAILED)\s+(.+)$/,
    // Node assert / mocha
    /AssertionError/,
    // file:line:col error
    /^(.+):(\d+):(\d+):\s*(Error|error)/,
    // "expected X got Y"
    /expected.*got\b/i,
    // "× test name" (Unicode ×)
    /^[\s]*[×✕✗]\s+(.+)/
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of patterns) {
      const m = line.match(pat);
      if (m) {
        failures.push({ message: line.slice(0, 300), context: lines.slice(Math.max(0, i - 1), i + 3).join("\n").slice(0, 500) });
        break;
      }
    }
    if (failures.length >= 30) break;
  }
  return failures;
}

async function runGatedCommand(command, cwd, timeoutMs = 120_000) {
  const result = await runShellCommand(command, cwd, undefined, timeoutMs);
  const output = (result.stdout + "\n" + result.stderr).trim();
  const ok = result.exit_code === 0;
  const failures = ok ? [] : parseTestFailures(output);
  const summary = output.slice(0, 3000);
  return { ok, command, exit_code: result.exit_code, timed_out: result.timed_out, summary, failures };
}

function registerTestRunnerTools(mcp) {
  reg(
    mcp,
    "quality_gate",
    {
      title: "Quality gate Pro",
      description: "PRO structured verification runner. Detects and runs lint/typecheck/test/build commands in order, with compact pass/fail summaries. Use after code edits before reporting done.",
      inputSchema: {
        cwd: z.string().optional(),
        include: z.array(z.enum(["lint", "typecheck", "test", "build"])).optional().describe("Gate order/subset. Default: lint,typecheck,test,build."),
        timeout_ms: z.number().int().min(1000).max(600000).optional(),
        stop_on_failure: z.boolean().optional(),
        dry_run: z.boolean().optional().describe("Return planned gates without executing.")
      }
    },
    async ({ cwd = ".", include, timeout_ms = 120_000, stop_on_failure = true, dry_run = false }) =>
      jsonResult(await runQualityGate({ cwd, include, timeout_ms, stop_on_failure, dry_run }))
  );

  reg(
    mcp,
    "detect_test_commands",
    {
      title: "Detect test commands",
      description: "Detect test/build/lint/dev commands from workspace manifests (package.json, go.mod, Cargo.toml, etc.).",
      inputSchema: { path: z.string().optional() }
    },
    async ({ path: rel = "." }) => {
      const rootDir = resolvePath(rel);
      const cmds = await getTestCommandsMerged(rootDir);
      const profile = await detectProjectProfile(rootDir);
      return jsonResult({ commands: cmds, languages: profile.languages, packageManagers: profile.packageManagers });
    }
  );

  reg(
    mcp,
    "run_tests",
    {
      title: "Run tests",
      description: "Run the detected (or provided) test command. Returns {ok, exit_code, summary, failures}.",
      inputSchema: {
        command: z.string().optional().describe("Override detected test command."),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ command, cwd = ".", timeout_ms = 120_000 }) => {
      const rootDir = resolvePath(cwd);
      let cmd = command;
      if (!cmd) {
        const cmds = await getTestCommandsMerged(rootDir);
        cmd = cmds.test;
        if (!cmd) throw new Error("Could not detect test command. Provide command explicitly.");
      }
      assertCommandAllowed(cmd);
      const res = await runGatedCommand(cmd, rootDir, timeout_ms);
      recordTestRun(cmd, res.ok, res.summary);
      return jsonResult(res);
    }
  );

  reg(
    mcp,
    "run_build",
    {
      title: "Run build",
      description: "Run the detected (or provided) build command. Returns {ok, exit_code, summary, failures}.",
      inputSchema: {
        command: z.string().optional(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ command, cwd = ".", timeout_ms = 120_000 }) => {
      const rootDir = resolvePath(cwd);
      let cmd = command;
      if (!cmd) {
        const cmds = await getTestCommandsMerged(rootDir);
        cmd = cmds.build;
        if (!cmd) throw new Error("Could not detect build command. Provide command explicitly.");
      }
      assertCommandAllowed(cmd);
      return jsonResult(await runGatedCommand(cmd, rootDir, timeout_ms));
    }
  );

  reg(
    mcp,
    "run_lint",
    {
      title: "Run lint",
      description: "Run the detected (or provided) lint command. Returns {ok, exit_code, summary, failures}.",
      inputSchema: {
        command: z.string().optional(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ command, cwd = ".", timeout_ms = 60_000 }) => {
      const rootDir = resolvePath(cwd);
      let cmd = command;
      if (!cmd) {
        const cmds = await getTestCommandsMerged(rootDir);
        cmd = cmds.lint;
        if (!cmd) throw new Error("Could not detect lint command. Provide command explicitly.");
      }
      assertCommandAllowed(cmd);
      return jsonResult(await runGatedCommand(cmd, rootDir, timeout_ms));
    }
  );

  reg(
    mcp,
    "run_changed_tests",
    {
      title: "Run changed tests",
      description: "Run tests for changed files only (git diff + untracked). Maps src files to test files heuristically; falls back to full test suite.",
      inputSchema: {
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ cwd = ".", timeout_ms = 120_000 }) => {
      const rootDir = resolvePath(cwd);
      // Get changed files
      const diffRes = await spawnCapture("git", ["diff", "--name-only"], rootDir, DEFAULT_CMD_TIMEOUT);
      const untrackedRes = await spawnCapture("git", ["ls-files", "--others", "--exclude-standard"], rootDir, DEFAULT_CMD_TIMEOUT);
      const changedFiles = [
        ...(diffRes.stdout || "").split(/\r?\n/).filter(Boolean),
        ...(untrackedRes.stdout || "").split(/\r?\n/).filter(Boolean)
      ];

      // Map to test files
      const testFiles = new Set();
      for (const f of changedFiles) {
        const base = path.basename(f, path.extname(f));
        const dir = path.dirname(f);
        // Direct test file check
        for (const pattern of [
          path.join(dir, `${base}.test${path.extname(f)}`),
          path.join(dir, `${base}.spec${path.extname(f)}`),
          path.join(dir, "__tests__", `${base}.test${path.extname(f)}`),
          path.join(dir, "__tests__", `${base}.spec${path.extname(f)}`),
          path.join("test", `${base}.test${path.extname(f)}`),
          path.join("tests", `test_${base}.py`),
          path.join("tests", `${base}_test.py`)
        ]) {
          if (existsSync(path.join(rootDir, pattern))) testFiles.add(pattern);
        }
      }

      const cmds = await getTestCommandsMerged(rootDir);
      if (testFiles.size === 0) {
        // Fall back to full test run
        if (!cmds.test) throw new Error("No changed test files found and no test command detected.");
        assertCommandAllowed(cmds.test);
        const res = await runGatedCommand(cmds.test, rootDir, timeout_ms);
        recordTestRun(cmds.test, res.ok, res.summary);
        return jsonResult({ ...res, strategy: "full_fallback", changed_files: changedFiles.length });
      }

      // Build targeted test command
      const fileList = [...testFiles].join(" ");
      let cmd;
      if (cmds.test && cmds.test.startsWith("npm")) {
        // Jest / Vitest — pass file list
        cmd = `${cmds.test} -- ${fileList}`;
      } else if (cmds.test && cmds.test.includes("pytest")) {
        cmd = `python -m pytest ${fileList}`;
      } else {
        cmd = cmds.test || `echo "No test command"`;
      }

      assertCommandAllowed(cmd);
      const res = await runGatedCommand(cmd, rootDir, timeout_ms);
      recordTestRun(cmd, res.ok, res.summary);
      return jsonResult({ ...res, strategy: "targeted", test_files: [...testFiles], changed_files: changedFiles });
    }
  );
}

// Record test run into metrics
function recordTestRun(command, ok, summary) {
  if (!metrics.testRuns) metrics.testRuns = [];
  metrics.testRuns.unshift({ ts: isoNow(), command: command.slice(0, 200), ok, summary: summary.slice(0, 500) });
  if (metrics.testRuns.length > 20) metrics.testRuns.length = 20;
  scheduleSave();
}

// ============================================================================
// v2.4 — Review Mode
// ============================================================================

function registerReviewTools(mcp) {
  reg(
    mcp,
    "session_report",
    {
      title: "Session report Pro",
      description: "PRO end-of-session report: health score, bottlenecks, metrics, top tools, git state, doctor summary, recommendations, and recent errors.",
      inputSchema: {
        cwd: z.string().optional().describe("Repository directory inside a root (default primary root).")
      }
    },
    async ({ cwd = "." }) => {
      const rootDir = resolvePath(cwd);
      return jsonResult(await buildSessionReport(rootDir));
    }
  );

  reg(
    mcp,
    "review_diff",
    {
      title: "Review diff",
      description: "Run heuristic code-review checks on git diff (working tree). Returns findings as P1/P2/P3 file:line items + verdict.",
      inputSchema: {
        staged: z.boolean().optional().describe("Review staged changes instead of working tree."),
        cwd: z.string().optional()
      }
    },
    async ({ staged = false, cwd = "." }) => {
      const rootDir = resolvePath(cwd);
      const args = ["diff"];
      if (staged) args.push("--staged");
      const result = await spawnCapture("git", args, rootDir, DEFAULT_CMD_TIMEOUT);
      if (result.exit_code !== 0) {
        return jsonResult({ ok: false, error: "Not a git repo or git error.", diff: "" });
      }
      const diff = result.stdout || "";
      if (!diff.trim()) return jsonResult({ ok: true, verdict: "CLEAN", findings: [], message: "No changes in working tree." });

      const findings = [];
      // Parse diff to check added lines
      let currentFile = null;
      let lineNum = 0;
      const diffLines = diff.split(/\r?\n/);

      for (let i = 0; i < diffLines.length; i++) {
        const line = diffLines[i];
        if (line.startsWith("--- ") || line.startsWith("+++ ")) {
          if (line.startsWith("+++ ")) {
            currentFile = line.slice(4).replace(/^b\//, "").trim();
          }
          continue;
        }
        if (line.startsWith("@@ ")) {
          const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
          lineNum = m ? Number(m[1]) - 1 : 0;
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
          lineNum++;
          const added = line.slice(1);
          const loc = `${currentFile}:${lineNum}`;

          // P1: dangerous calls
          if (/\beval\s*\(/.test(added)) findings.push({ priority: "P1", loc, issue: "eval() usage — potential code injection" });
          if (/\binnerHTML\s*=/.test(added)) findings.push({ priority: "P1", loc, issue: "innerHTML assignment — potential XSS" });
          if (/dangerouslySetInnerHTML/.test(added)) findings.push({ priority: "P1", loc, issue: "dangerouslySetInnerHTML — XSS risk" });
          if (/\bchild_process\.exec\s*\(/.test(added) || /\brequire\(['"]child_process['"]\)/.test(added)) {
            findings.push({ priority: "P1", loc, issue: "child_process exec — command injection risk" });
          }
          if (/\bexec\s*\(/.test(added) && /python|subprocess/.test(added)) {
            findings.push({ priority: "P1", loc, issue: "exec() in Python context — verify input is sanitized" });
          }

          // P2: code hygiene
          if (/\bconsole\.(log|debug|info)\s*\(/.test(added)) {
            findings.push({ priority: "P2", loc, issue: "console.log/debug left in code" });
          }
          if (/\bdebugger\b/.test(added)) findings.push({ priority: "P2", loc, issue: "debugger statement" });
          if (/\b(TODO|FIXME)\b/.test(added)) findings.push({ priority: "P2", loc, issue: `${added.match(/\b(TODO|FIXME)\b/)[1]} comment added` });

          // P3: style
          if (/\bHACK\b/.test(added)) findings.push({ priority: "P3", loc, issue: "HACK comment added" });
        } else if (!line.startsWith("-")) {
          lineNum++;
        }
      }

      // Check large added functions (>100 consecutive added lines)
      let addedStreak = 0;
      let streakStart = null;
      let streakFile = null;
      for (const line of diffLines) {
        if (line.startsWith("+++ ")) { streakFile = line.slice(4).replace(/^b\//, ""); streakStart = 0; addedStreak = 0; }
        else if (line.startsWith("@@ ")) { addedStreak = 0; }
        else if (line.startsWith("+") && !line.startsWith("+++")) {
          addedStreak++;
          if (addedStreak === 1) streakStart = lineNum;
          if (addedStreak > 100) {
            findings.push({ priority: "P3", loc: `${streakFile}:~${streakStart}`, issue: "Very large added block (>100 lines) — consider splitting" });
            addedStreak = -9999; // don't repeat
          }
        } else if (!line.startsWith("-")) {
          addedStreak = 0;
        }
      }

      // Check changed src without test change
      const changedSrc = diffLines.filter((l) => l.startsWith("+++ ")).map((l) => l.slice(4).replace(/^b\//, "")).filter((f) => /\.(js|ts|mjs|cjs|jsx|tsx|py)$/.test(f) && !/test|spec|__tests__/.test(f));
      const changedTest = diffLines.filter((l) => l.startsWith("+++ ")).map((l) => l.slice(4).replace(/^b\//, "")).filter((f) => /test|spec|__tests__/.test(f));
      if (changedSrc.length > 0 && changedTest.length === 0) {
        findings.push({ priority: "P3", loc: changedSrc[0], issue: "Source file changed without a corresponding test file change" });
      }

      const p1 = findings.filter((f) => f.priority === "P1").length;
      const verdict = p1 > 0 ? "BLOCK" : findings.length > 0 ? "WARN" : "PASS";
      return jsonResult({ ok: verdict !== "BLOCK", verdict, findings_count: findings.length, findings: findings.slice(0, 100), p1, p2: findings.filter((f) => f.priority === "P2").length, p3: findings.filter((f) => f.priority === "P3").length });
    }
  );

  reg(
    mcp,
    "security_scan",
    {
      title: "Security scan",
      description: "Scan changed (or all, capped) files for secret patterns (AWS keys, private keys, API tokens, etc.) and unsafe usage. Reports file:line — never echoes the secret value.",
      inputSchema: {
        path: z.string().optional().describe("Dir to scan (default primary root)."),
        changed_only: z.boolean().optional().describe("Only scan files changed in git diff (default false)."),
        cwd: z.string().optional()
      }
    },
    async ({ path: rel = ".", changed_only = false, cwd = "." }) => {
      const rootDir = resolvePath(rel);
      const SECRET_PATTERNS = [
        { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/ },
        { name: "Private Key", re: /-----BEGIN [A-Z ]* PRIVATE KEY-----/ },
        { name: "Generic API key", re: /['"](api[_-]?key|apikey|api_secret)['"]\s*[:=]\s*['"][^'"]{10,}['"]/i },
        { name: "Password assignment", re: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i },
        { name: "Token assignment", re: /\b(token|access_token|auth_token|bearer)\s*[:=]\s*['"][^'"]{10,}['"]/i },
        { name: "Slack token", re: /xox[baprs]-[0-9A-Za-z]{10,}/ },
        { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
        { name: "Generic secret", re: /\bsecret\s*[:=]\s*['"][^'"]{10,}['"]/i }
      ];

      let filesToScan = [];
      if (changed_only) {
        const diffRes = await spawnCapture("git", ["diff", "--name-only"], rootDir, DEFAULT_CMD_TIMEOUT);
        filesToScan = (diffRes.stdout || "").split(/\r?\n/).filter(Boolean).map((f) => path.join(rootDir, f));
      } else {
        const { files } = await buildTree(rootDir, 4, 500);
        filesToScan = files.filter((f) => {
          const ext = path.extname(f).toLowerCase();
          return [".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".py", ".json", ".env", ".sh", ".yml", ".yaml"].includes(ext);
        });
      }

      const hits = [];
      for (const fp of filesToScan.slice(0, 300)) {
        let content;
        try { content = await readFile(fp, "utf8"); } catch { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          for (const pat of SECRET_PATTERNS) {
            if (pat.re.test(lines[i])) {
              hits.push({ file: toRel(fp), line: i + 1, pattern: pat.name });
              break;
            }
          }
          if (hits.length >= 100) break;
        }
        if (hits.length >= 100) break;
      }

      return jsonResult({ ok: hits.length === 0, scanned_files: filesToScan.length, hits_count: hits.length, hits });
    }
  );

  reg(
    mcp,
    "todo_scan",
    {
      title: "TODO scan",
      description: "Find all TODO/FIXME/HACK/XXX comments in the workspace. Returns file:line locations.",
      inputSchema: {
        path: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ path: rel = ".", limit = 200 }) => {
      const start = resolvePath(rel);
      let matches;
      if (RG_BIN) {
        matches = await ripgrepGrep(start, "TODO|FIXME|HACK|XXX", { regex: true, limit, glob: null });
      }
      if (!matches) {
        matches = await searchTree(start, "TODO|FIXME|HACK|XXX", { regex: true, limit, glob: null });
      }
      const categorized = (matches || []).map((m) => {
        const kind = m.text.match(/\b(TODO|FIXME|HACK|XXX)\b/i)?.[1]?.toUpperCase() || "TODO";
        return { ...m, kind };
      });
      return jsonResult({ count: categorized.length, items: categorized });
    }
  );

  reg(
    mcp,
    "change_summary",
    {
      title: "Change summary",
      description: "Summarize git diff --stat and list changed files with a bullet summary.",
      inputSchema: {
        cwd: z.string().optional(),
        staged: z.boolean().optional()
      }
    },
    async ({ cwd = ".", staged = false }) => {
      const rootDir = resolvePath(cwd);
      const statArgs = ["diff", "--stat"];
      if (staged) statArgs.push("--staged");
      const statRes = await spawnCapture("git", statArgs, rootDir, DEFAULT_CMD_TIMEOUT);

      const nameArgs = ["diff", "--name-status"];
      if (staged) nameArgs.push("--staged");
      const nameRes = await spawnCapture("git", nameArgs, rootDir, DEFAULT_CMD_TIMEOUT);

      if (statRes.exit_code !== 0) {
        return jsonResult({ ok: false, error: "Not a git repo." });
      }

      const stat_output = (statRes.stdout || "").trim();
      const files = (nameRes.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => {
        const [status, ...parts] = line.split(/\t/);
        return { status: status.trim(), path: parts.join("\t").trim() };
      });

      return jsonResult({ ok: true, stat: stat_output, files_changed: files.length, files: files.slice(0, 100) });
    }
  );
}

// ============================================================================
// v2.5 — Planner / Thread Memory
// ============================================================================

function registerPlannerTools(mcp) {
  reg(
    mcp,
    "task_plan",
    {
      title: "Task plan",
      description: "Create or update the current task plan. Stores goal + steps in .agent/state/current-task.json.",
      inputSchema: {
        goal: z.string().min(1).describe("High-level goal description."),
        steps: z.array(z.string()).min(1).describe("Ordered list of steps to complete the goal.")
      }
    },
    async ({ goal, steps }) => {
      await mkdir(AGENT_STATE_DIR, { recursive: true });
      const plan = {
        goal,
        steps: steps.map((text) => ({ text, done: false })),
        created: isoNow(),
        updated: isoNow()
      };
      await writeFile(TASK_PLAN_PATH, JSON.stringify(plan, null, 2), "utf8");
      return jsonResult({ ok: true, goal, steps_count: steps.length, path: TASK_PLAN_PATH });
    }
  );

  reg(
    mcp,
    "task_state",
    {
      title: "Task state",
      description: "Get or update the current task plan. Call with no args to read; pass set_step_done/add_steps/status to update.",
      inputSchema: {
        set_step_done: z.number().int().min(0).optional().describe("Mark step N (0-indexed) as done."),
        add_steps: z.array(z.string()).optional().describe("Append new steps to the plan."),
        status: z.string().optional().describe("Set overall status string.")
      }
    },
    async ({ set_step_done, add_steps, status }) => {
      let plan;
      try {
        plan = JSON.parse(await readFile(TASK_PLAN_PATH, "utf8"));
      } catch {
        return textResult("No task plan found. Call task_plan to create one.");
      }

      let changed = false;
      if (set_step_done !== undefined) {
        if (plan.steps[set_step_done]) { plan.steps[set_step_done].done = true; changed = true; }
      }
      if (add_steps && add_steps.length > 0) {
        plan.steps.push(...add_steps.map((text) => ({ text, done: false })));
        changed = true;
      }
      if (status !== undefined) {
        plan.status = status;
        changed = true;
      }
      if (changed) {
        plan.updated = isoNow();
        await writeFile(TASK_PLAN_PATH, JSON.stringify(plan, null, 2), "utf8");
      }

      const done = plan.steps.filter((s) => s.done).length;
      const total = plan.steps.length;
      return jsonResult({ ...plan, progress: `${done}/${total}` });
    }
  );

  reg(
    mcp,
    "decision_log",
    {
      title: "Decision log",
      description: "Append a decision + reasoning to decisions.md in .agent/state/.",
      inputSchema: {
        decision: z.string().min(1).describe("What was decided."),
        why: z.string().min(1).describe("Why this decision was made.")
      }
    },
    async ({ decision, why }) => {
      await mkdir(AGENT_STATE_DIR, { recursive: true });
      const entry = `\n## ${isoNow()}\n\n**Decision:** ${decision}\n\n**Why:** ${why}\n`;
      await appendFile(DECISIONS_PATH, entry, "utf8");
      return jsonResult({ ok: true, appended_to: DECISIONS_PATH });
    }
  );
}

// Also update checkpoint to snapshot current-task.json
const _origCheckpoint = null; // we'll patch via the registration

// ============================================================================
// v2.6 — Approval / Policy Layer
// ============================================================================

const POLICY_RULES = {
  strict: {
    description: "Read and analyze only. No writes, installs, network, deletes, or git mutations.",
    blocked: ["write_file", "replace_in_file", "apply_patch", "make_dir", "move_path", "delete_path",
              "run_command", "proc_start", "git"],
    needs_approval: [],
    allowed_patterns: []
  },
  balanced: {
    description: "Read + edit + test/build allowed. Delete, install, network commands need approval.",
    blocked: [],
    needs_approval: [],
    dangerous_patterns: [
      /\b(npm|pip|pip3|yarn|pnpm|cargo|apt|brew|gem|composer)\s+install\b/i,
      /\bcurl\b.*-[oO]/i,
      /\bwget\b/i,
      /\bgit\s+(push|fetch|pull|clone)\b/i,
      /\bdocker\s+(push|pull|run|build)\b/i
    ],
    allowed: ["read_file", "write_file", "replace_in_file", "apply_patch", "search_text", "find_files"]
  },
  full: {
    description: "Full access (same as before, catastrophic commands still blocked).",
    blocked: [],
    needs_approval: [],
    allowed: ["*"]
  }
};

const STRICT_MUTATION_TOOLS = new Set([
  "save_note", "checkpoint", "write_file", "replace_in_file", "apply_patch", "make_dir", "move_path", "delete_path",
  "run_command", "run_commands", "proc_start", "proc_stop", "git", "create_skill", "delete_skill", "undo_last_patch",
  "quality_gate", "run_tests", "run_build", "run_lint", "run_changed_tests", "task_plan", "task_state", "decision_log"
]);

function approvalActionForTool(tool, args) {
  if (tool === "delete_path") return `delete_path:${String(args.path || "")}`;
  if (tool === "delete_skill") return `delete_skill:${String(args.name || "")}`;
  if (tool === "run_command" || tool === "proc_start") {
    const command = String(args.command || "");
    return policyCheck(command).needsApproval ? `${tool}:${command}` : null;
  }
  if (tool === "run_commands") {
    const risky = (Array.isArray(args.commands) ? args.commands : [])
      .filter((item) => policyCheck(String(item?.command || "")).needsApproval)
      .map((item) => ({ command: String(item.command), cwd: String(item.cwd || "."), shell: item.shell || null }));
    return risky.length ? `run_commands:${JSON.stringify(risky)}` : null;
  }
  if (tool === "git") {
    const argv = Array.isArray(args.args) ? args.args : [];
    const sub = (argv.find((a) => !String(a).startsWith("-")) || "").toLowerCase();
    return GIT_READONLY.has(sub) || argv.some((a) => /^(--version|--help)$/i.test(String(a)))
      ? null
      : `git:${JSON.stringify(argv)}`;
  }
  if (tool === "apply_patch") {
    const deletes = Array.isArray(args.operations) && args.operations.some((op) => op?.op === "delete");
    const diffDeletes = typeof args.diff === "string" && /^\+\+\+\s+\/dev\/null$/m.test(args.diff);
    if (deletes || diffDeletes) return `apply_patch:delete`;
  }
  return null;
}

async function dashApiApprovals(res) {
  try {
    const records = [];
    for (const file of await readdir(APPROVALS_DIR).catch(() => [])) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(path.join(APPROVALS_DIR, file), "utf8"));
        if (record.status === "pending" && approvalIsExpired(record)) {
          record.status = "expired";
          record.expired_at = isoNow();
          await writeFile(path.join(APPROVALS_DIR, file), JSON.stringify(record, null, 2), "utf8");
        } else if (record.status === "pending") records.push(record);
      } catch {}
    }
    records.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return sendJson(res, 200, { pending: records });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || "error" });
  }
}

async function dashApiApprovalAction(url, res) {
  try {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2] || "";
    const action = parts[3] || "";
    if (!APPROVAL_ID_RE.test(id) || !["approve", "deny"].includes(action)) {
      return sendJson(res, 400, { error: "invalid approval action" });
    }
    const fp = path.join(APPROVALS_DIR, `${id}.json`);
    if (!existsSync(fp)) return sendJson(res, 404, { error: "approval not found" });
    const record = JSON.parse(await readFile(fp, "utf8"));
    if (record.status !== "pending") return sendJson(res, 409, { error: `approval is ${record.status}` });
    if (approvalIsExpired(record)) {
      record.status = "expired";
      record.expired_at = isoNow();
      await writeFile(fp, JSON.stringify(record, null, 2), "utf8");
      return sendJson(res, 409, { error: "approval is expired" });
    }
    record.status = action === "approve" ? "approved" : "denied";
    record[`${record.status}_at`] = isoNow();
    record.approved_via = "local_dashboard";
    await writeFile(fp, JSON.stringify(record, null, 2), "utf8");
    audit({ ts: isoNow(), event: "approval_decision", id, action: record.action, status: record.status, via: "local_dashboard" });
    return sendJson(res, 200, { ok: true, id, status: record.status });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || "error" });
  }
}

async function enforceToolPolicy(tool, args) {
  if (["policy_status", "explain_risk", "request_approval", "request_approval_batch", "approve_request", "deny_request"].includes(tool)) return;
  if (AGENT_POLICY === "full") return;
  if (AGENT_POLICY === "strict" && STRICT_MUTATION_TOOLS.has(tool)) {
    throw new Error(`Tool "${tool}" is blocked by policy=strict.`);
  }
  if (AGENT_POLICY !== "balanced") return;
  const action = approvalActionForTool(tool, args);
  if (!action) return;
  const previous = approvalLock;
  let release;
  approvalLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const approval = await checkApprovalExists(action);
    if (!approval) {
      throw new Error(`Approval required. Call request_approval with action=${JSON.stringify(action)}, then have the local operator approve it.`);
    }
    const consumed = new Set(Array.isArray(approval.consumed_actions) ? approval.consumed_actions : []);
    consumed.add(action);
    approval.consumed_actions = [...consumed];
    const actions = approvalActions(approval);
    if (actions.every((candidate) => consumed.has(candidate))) {
      approval.status = "consumed";
      approval.consumed_at = isoNow();
    }
    await writeFile(path.join(APPROVALS_DIR, `${approval.id}.json`), JSON.stringify(approval, null, 2), "utf8");
  } finally {
    release();
  }
}

function approvalActions(record) {
  if (Array.isArray(record?.actions)) return record.actions.map(String);
  return record?.action ? [String(record.action)] : [];
}

function approvalIsExpired(record) {
  return Boolean(record?.expires_at && Date.parse(record.expires_at) <= Date.now());
}

function classifyAction(action) {
  const patterns = {
    install: /\b(npm|pip|pip3|yarn|pnpm|cargo|apt|brew|gem|composer)\s+install\b/i,
    network: /\b(curl|wget|fetch|git\s+push|git\s+fetch|git\s+pull|git\s+clone)\b/i,
    delete: /\b(delete_path|rm\s+-rf|remove-item)\b/i,
    git_mutation: /\bgit\s+(push|reset|clean|restore|checkout)\b/i,
    catastrophic: CATASTROPHIC
  };

  for (const [kind, pat] of Object.entries(patterns)) {
    if (Array.isArray(pat)) {
      if (pat.some((p) => p.test(action))) return kind;
    } else if (pat.test(action)) {
      return kind;
    }
  }
  return "general";
}

function policyCheck(action) {
  const rules = POLICY_RULES[AGENT_POLICY];
  const kind = classifyAction(action);

  if (AGENT_POLICY === "strict") {
    if (kind !== "general") {
      throw new Error(`Action blocked by policy=strict: "${kind}" operations are not allowed. Use policy_status to see what's allowed.`);
    }
  }

  if (AGENT_POLICY === "balanced") {
    const dangerous = rules.dangerous_patterns || [];
    if (dangerous.some((p) => p.test(action))) {
      // Check if there's a valid approval
      return { needsApproval: true, kind };
    }
    if (kind === "delete" || kind === "git_mutation") {
      return { needsApproval: true, kind };
    }
  }

  return { needsApproval: false, kind };
}

async function checkApprovalExists(action) {
  try {
    const files = await readdir(APPROVALS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(path.join(APPROVALS_DIR, f), "utf8"));
        if (rec.status !== "approved") continue;
        if (approvalIsExpired(rec)) {
          rec.status = "expired";
          rec.expired_at = isoNow();
          await writeFile(path.join(APPROVALS_DIR, f), JSON.stringify(rec, null, 2), "utf8");
          continue;
        }
        const consumed = new Set(Array.isArray(rec.consumed_actions) ? rec.consumed_actions : []);
        if (approvalActions(rec).includes(action) && !consumed.has(action)) return rec;
      } catch { /* skip */ }
    }
  } catch { /* dir may not exist */ }
  return null;
}

function registerPolicyTools(mcp) {
  reg(
    mcp,
    "policy_status",
    {
      title: "Policy status",
      description: "Return current policy (strict|balanced|full) and what operations are allowed, need approval, or are blocked.",
      inputSchema: {}
    },
    async () => {
      const rules = POLICY_RULES[AGENT_POLICY];
      return jsonResult({
        policy: AGENT_POLICY,
        mode: MODE,
        description: rules.description,
        allowed: AGENT_POLICY === "full" ? ["*"] : AGENT_POLICY === "balanced" ? ["read", "write", "edit", "test", "build"] : ["read", "search", "analyze"],
        needs_approval: AGENT_POLICY === "balanced" ? ["delete_path", "npm/pip install", "curl/wget", "git push/fetch/pull", "risky run_commands batch"] : [],
        approval_options: AGENT_POLICY === "balanced" ? ["one exact action", "2-20 exact actions in one expiring batch"] : [],
        approval_ttl_minutes: APPROVAL_TTL_MINUTES,
        blocked: AGENT_POLICY === "strict" ? ["all writes", "installs", "network", "delete", "git mutations"] : []
      });
    }
  );

  reg(
    mcp,
    "explain_risk",
    {
      title: "Explain risk",
      description: "Classify a proposed action and explain the risk level + policy decision.",
      inputSchema: {
        action: z.string().min(1).describe("The action or command you want to run.")
      }
    },
    async ({ action }) => {
      const kind = classifyAction(action);
      const riskLevels = {
        install: "HIGH — installs packages, may download malicious code or change locked dependencies",
        network: "HIGH — network operation, may expose data or fetch untrusted content",
        delete: "HIGH — permanently removes files",
        git_mutation: "MEDIUM — mutates git history or remote state",
        catastrophic: "CRITICAL — system-level destructive operation",
        general: "LOW — standard operation"
      };
      const risk = riskLevels[kind] || "LOW";

      let decision;
      if (AGENT_POLICY === "strict") {
        decision = kind === "general" ? "ALLOWED" : "BLOCKED";
      } else if (AGENT_POLICY === "balanced") {
        decision = (kind === "general") ? "ALLOWED" : "NEEDS_APPROVAL";
      } else {
        decision = kind === "catastrophic" ? "BLOCKED" : "ALLOWED";
      }

      return jsonResult({ action, kind, risk, decision, policy: AGENT_POLICY });
    }
  );

  reg(
    mcp,
    "request_approval",
    {
      title: "Request approval",
      description: "Create an expiring pending request for one exact action. The local operator should approve it in the dashboard; MCP token approval is an optional fallback.",
      inputSchema: {
        action: z.string().min(1),
        reason: z.string().min(1).describe("Why this action is needed.")
      }
    },
    async ({ action, reason }) => {
      const id = randomUUID();
      const created = isoNow();
      const record = {
        id,
        action,
        actions: [action],
        consumed_actions: [],
        reason,
        status: "pending",
        created,
        expires_at: new Date(Date.now() + APPROVAL_TTL_MINUTES * 60_000).toISOString()
      };
      await mkdir(APPROVALS_DIR, { recursive: true });
      await writeFile(path.join(APPROVALS_DIR, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
      return jsonResult({
        id,
        status: "pending",
        expires_at: record.expires_at,
        message: "Approval request created. Ask the local operator to approve it in the dashboard.",
        action,
        reason
      });
    }
  );

  reg(
    mcp,
    "request_approval_batch",
    {
      title: "Request exact batch approval",
      description: "Request one local decision for 2-20 exact risky actions. Each listed action can be consumed once before expiry; wildcards and implicit extra permissions are not supported.",
      inputSchema: {
        actions: z.array(z.string().min(1).max(4000)).min(2).max(20),
        reason: z.string().min(1).max(2000).describe("Why this exact action batch is needed."),
        expires_in_minutes: z.number().int().min(1).max(30).optional()
      }
    },
    async ({ actions, reason, expires_in_minutes = APPROVAL_TTL_MINUTES }) => {
      const exactActions = dedupe(actions.map((action) => action.trim()).filter(Boolean));
      if (exactActions.length < 2) throw new Error("Provide at least two distinct exact actions.");
      const id = randomUUID();
      const record = {
        id,
        action: `batch:${exactActions.length}`,
        actions: exactActions,
        consumed_actions: [],
        reason,
        status: "pending",
        created: isoNow(),
        expires_at: new Date(Date.now() + expires_in_minutes * 60_000).toISOString()
      };
      await mkdir(APPROVALS_DIR, { recursive: true });
      await writeFile(path.join(APPROVALS_DIR, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
      return jsonResult({
        id,
        status: "pending",
        actions: exactActions,
        expires_at: record.expires_at,
        message: "Exact batch approval created. Ask the local operator to review and approve it in the dashboard."
      });
    }
  );

  reg(
    mcp,
    "approve_request",
    {
      title: "Approve request",
      description: "Approve a pending action using the local operator token configured in AGENT_APPROVAL_TOKEN.",
      inputSchema: { id: z.string().min(1), approval_token: z.string().min(1) }
    },
    async ({ id, approval_token }) => {
      if (!APPROVAL_TOKEN) throw new Error("MCP approval is disabled. Set AGENT_APPROVAL_TOKEN locally or approve out of band.");
      if (!safeEqual(approval_token, APPROVAL_TOKEN)) throw new Error("Invalid local operator approval token.");
      if (!APPROVAL_ID_RE.test(id)) throw new Error("Invalid approval id.");
      const fp = path.join(APPROVALS_DIR, `${id}.json`);
      if (!existsSync(fp)) throw new Error(`No approval request with id ${id}`);
      const rec = JSON.parse(await readFile(fp, "utf8"));
      if (rec.status !== "pending") throw new Error(`Approval is ${rec.status}; only pending requests can be approved.`);
      if (approvalIsExpired(rec)) throw new Error("Approval request is expired.");
      rec.status = "approved";
      rec.approved_at = isoNow();
      rec.approved_via = "mcp_operator_token";
      await writeFile(fp, JSON.stringify(rec, null, 2), "utf8");
      return jsonResult({ ok: true, id, action: rec.action, status: "approved" });
    }
  );

  reg(
    mcp,
    "deny_request",
    {
      title: "Deny request",
      description: "Deny a pending action using the local operator token configured in AGENT_APPROVAL_TOKEN.",
      inputSchema: { id: z.string().min(1), approval_token: z.string().min(1) }
    },
    async ({ id, approval_token }) => {
      if (!APPROVAL_TOKEN) throw new Error("MCP denial is disabled. Set AGENT_APPROVAL_TOKEN locally or deny out of band.");
      if (!safeEqual(approval_token, APPROVAL_TOKEN)) throw new Error("Invalid local operator approval token.");
      if (!APPROVAL_ID_RE.test(id)) throw new Error("Invalid approval id.");
      const fp = path.join(APPROVALS_DIR, `${id}.json`);
      if (!existsSync(fp)) throw new Error(`No approval request with id ${id}`);
      const rec = JSON.parse(await readFile(fp, "utf8"));
      if (rec.status !== "pending") throw new Error(`Approval is ${rec.status}; only pending requests can be denied.`);
      if (approvalIsExpired(rec)) throw new Error("Approval request is expired.");
      rec.status = "denied";
      rec.denied_at = isoNow();
      await writeFile(fp, JSON.stringify(rec, null, 2), "utf8");
      return jsonResult({ ok: true, id, action: rec.action, status: "denied" });
    }
  );
}

// ============================================================================
// v2.8 — Workspace Profile
// ============================================================================

async function loadWorkspaceProfile() {
  const profilePath = path.join(PRIMARY_ROOT, ".agent", "profile.json");
  try {
    const raw = await readFile(profilePath, "utf8");
    WORKSPACE_PROFILE = JSON.parse(raw);
    log(`Loaded workspace profile from ${profilePath}`);
  } catch {
    WORKSPACE_PROFILE = null;
  }
}

function registerProfileTools(mcp) {
  reg(
    mcp,
    "profile_status",
    {
      title: "Profile status",
      description: "Return the loaded workspace profile (.agent/profile.json) and explain what it configures.",
      inputSchema: {}
    },
    async () => {
      if (!WORKSPACE_PROFILE) {
        return jsonResult({
          loaded: false,
          path: path.join(PRIMARY_ROOT, ".agent", "profile.json"),
          message: "No profile.json found. Create one to configure test commands, ignored dirs, conventions, and policy.",
          schema: {
            mode: "safe|full",
            policy: "strict|balanced|full",
            extraRoots: ["array of extra root paths"],
            testCommands: { test: "command", build: "command", lint: "command" },
            ignoredDirs: ["array of dir names to skip"],
            conventions: "string describing project conventions",
            description: "short project description"
          }
        });
      }
      return jsonResult({ loaded: true, profile: WORKSPACE_PROFILE });
    }
  );

  reg(
    mcp,
    "reload_profile",
    {
      title: "Reload profile",
      description: "Reload .agent/profile.json from disk (e.g. after editing it).",
      inputSchema: {}
    },
    async () => {
      await loadWorkspaceProfile();
      return jsonResult({ ok: true, loaded: WORKSPACE_PROFILE !== null, profile: WORKSPACE_PROFILE });
    }
  );
}

// Helper: get test commands merging profile overrides
async function getTestCommandsMerged(rootDir) {
  const detected = await detectTestCommands(rootDir);
  if (WORKSPACE_PROFILE && WORKSPACE_PROFILE.testCommands) {
    return { ...detected, ...WORKSPACE_PROFILE.testCommands };
  }
  return detected;
}
