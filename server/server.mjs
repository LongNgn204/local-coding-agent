// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rename,
  rm,
  appendFile,
  access
} from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ----------------------------------------------------------------------------
// Configuration (all overridable via environment variables)
// ----------------------------------------------------------------------------
const VERSION = "1.2.0";
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

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = path.resolve(APP_DIR, "..", "agent-workspace");
const PRIMARY_ROOT = path.resolve(process.env.AGENT_WORKSPACE || DEFAULT_WORKSPACE);
const EXTRA_ROOTS = (process.env.AGENT_EXTRA_ROOTS || "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));
const ROOTS = dedupe([PRIMARY_ROOT, ...EXTRA_ROOTS]);

// "safe" (default): file/command tools are confined to roots, destructive
// commands and absolute Windows paths inside commands are blocked.
// "full": full power inside roots, only catastrophic system commands stay
// blocked (unless AGENT_ALLOW_DANGEROUS=1).
const MODE = String(process.env.AGENT_MODE || "safe").toLowerCase() === "full" ? "full" : "safe";
const ALLOW_DANGEROUS = process.env.AGENT_ALLOW_DANGEROUS === "1";

// Optional defense-in-depth bearer token. If set, every /mcp request must send
// Authorization: Bearer <token> (or ?token=). Leave empty when relying on the
// OpenAI Secure MCP Tunnel, whose channel is already private to your account.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

const DATA_DIR = path.resolve(APP_DIR, "data");
const NOTES_PATH = path.resolve(DATA_DIR, "notes.json");
const AUDIT_PATH = path.resolve(DATA_DIR, "audit.log");
const METRICS_PATH = path.resolve(DATA_DIR, "metrics.json");

const MAX_READ_CHARS = Number(process.env.AGENT_MAX_READ_CHARS || 200_000);
const MAX_COMMAND_OUTPUT = Number(process.env.AGENT_MAX_COMMAND_OUTPUT || 200_000);
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
  "__pycache__"
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
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/ // fork bomb
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
const bootStartedAt = Date.now();

// ----------------------------------------------------------------------------
// Bootstrap
// ----------------------------------------------------------------------------
await mkdir(DATA_DIR, { recursive: true });
await mkdir(PRIMARY_ROOT, { recursive: true });

const metrics = loadMetrics();

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
    log(`${req.method} ${req.url} ua=${req.headers["user-agent"] || ""}`);
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
    if (req.method === "GET" && url.pathname === "/") {
      return sendHtml(res, homeHtml());
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, {
        status: "ok",
        version: VERSION,
        mode: MODE,
        auth: AUTH_TOKEN ? "bearer" : "none",
        roots: ROOTS,
        workspace: PRIMARY_ROOT,
        mcp_endpoint: `http://${HOST}:${PORT}/mcp`
      });
    }
    if (url.pathname === "/mcp") {
      if (!checkAuth(req, url)) {
        return sendJson(res, 401, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized." },
          id: null
        });
      }
      return handleMcp(req, res);
    }
    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || "Internal Server Error" });
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
      if (url.pathname === "/metrics") return sendJson(res, 200, metricsSnapshot());
      if (url.pathname === "/ui") return sendHtml(res, dashboardHtml());
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
  const provided = fromHeader || url.searchParams.get("token") || "";
  return safeEqual(provided, AUTH_TOKEN);
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
  await transport.handleRequest(req, res);
}

function createMcpServer() {
  const mcp = new McpServer({ name: "Local Coding Agent", version: VERSION });
  registerBasicTools(mcp);
  registerFsReadTools(mcp);
  registerFsWriteTools(mcp);
  registerExecTools(mcp);
  registerProcessTools(mcp);
  registerGitTool(mcp);
  return mcp;
}

// ----------------------------------------------------------------------------
// Tool registration helper: audit + uniform error handling
// ----------------------------------------------------------------------------
function reg(mcp, name, def, handler) {
  mcp.registerTool(name, def, async (args, extra) => {
    const startedAt = isoNow();
    const inChars = safeLen(args);
    let result;
    let ok = true;
    try {
      result = await handler(args ?? {}, extra);
    } catch (err) {
      ok = false;
      result = { content: [{ type: "text", text: `ERROR: ${err?.message || err}` }], isError: true };
    }
    const success = ok && !result?.isError;
    const outChars = resultLen(result);
    const errText = success ? null : firstText(result).slice(0, 200);
    audit({ ts: startedAt, tool: name, ok: success, inChars, outChars, error: errText || undefined, args: summarizeArgs(args) });
    recordMetric(name, success, inChars, outChars, errText);
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
        mode: MODE,
        allow_dangerous: ALLOW_DANGEROUS,
        auth: AUTH_TOKEN ? "bearer" : "none",
        roots: ROOTS,
        primary_root: PRIMARY_ROOT,
        host: { platform: os.platform(), release: os.release(), hostname: os.hostname(), cwd: process.cwd(), node: process.version },
        limits: { max_read_chars: MAX_READ_CHARS, max_command_output: MAX_COMMAND_OUTPUT, max_procs: MAX_PROCS },
        running_processes: [...processes.values()].filter((p) => p.status === "running").length,
        safety:
          MODE === "full"
            ? ["File and command tools work fully inside the configured roots.", "Catastrophic system commands stay blocked unless AGENT_ALLOW_DANGEROUS=1.", "Paths outside the roots are rejected."]
            : ["File/command tools are confined to the roots.", "Destructive commands and absolute Windows paths in commands are blocked.", "Switch to AGENT_MODE=full for unrestricted in-root work."]
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
        max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional()
      }
    },
    async ({ path: rel, start_line, line_count, max_chars = MAX_READ_CHARS }) => {
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
      let engine = "scan";
      let matches = null;
      const info = await stat(start).catch(() => null);
      const isDir = info && info.isDirectory();
      if (isDir && RG_BIN) {
        matches = await ripgrepGrep(start, query, { regex, limit, glob });
        if (matches) engine = "ripgrep";
      }
      if (matches === null && isDir) {
        matches = await gitGrep(start, query, { regex, limit, glob });
        if (matches) engine = "git";
      }
      if (matches === null) matches = await searchTree(start, query, { regex, limit, glob });
      if (context > 0 && matches.length) await attachContext(matches, context);
      return jsonResult({ query, regex, engine, context, count: matches.length, matches });
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
      description: "Read several files in ONE call. Use this instead of many read_file calls to cut round-trips and latency.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(50).describe("File paths to read."),
        max_chars_per_file: z.number().int().min(1).max(MAX_READ_CHARS).optional()
      }
    },
    async ({ paths, max_chars_per_file = 40_000 }) => {
      const files = [];
      for (const p of paths) {
        try {
          const fp = resolvePath(p);
          const content = await readFile(fp, "utf8");
          const truncated = content.length > max_chars_per_file;
          files.push({
            path: toRel(fp),
            chars: content.length,
            truncated,
            content: truncated ? content.slice(0, max_chars_per_file) : content
          });
        } catch (err) {
          files.push({ path: p, error: String(err?.message || err) });
        }
      }
      return jsonResult({ count: files.length, files });
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
      description: "Apply multiple file operations in one call: create, update (text edits), delete, rename.",
      inputSchema: {
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
          .min(1)
      }
    },
    async ({ operations }) => {
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
      return jsonResult({ ok, applied: results.filter((r) => r.ok).length, results });
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
      await rm(target, { recursive, force: false });
      return jsonResult({ ok: true, deleted: toRel(target) });
    }
  );
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
      description: "Run a command and wait for it to finish. Use proc_start for long-running servers.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional().describe("Working directory inside a root."),
        shell: z.enum(["cmd", "powershell", "bash"]).optional().describe("Shell to use (default cmd on Windows)."),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ command, cwd = ".", shell, timeout_ms = DEFAULT_CMD_TIMEOUT }) => {
      assertCommandAllowed(command);
      const workdir = resolvePath(cwd);
      const result = await runShellCommand(command, workdir, shell, timeout_ms);
      return jsonResult({ cwd: workdir, command, shell: shell || defaultShell(), ...result });
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
        shell: z.enum(["cmd", "powershell", "bash"]).optional(),
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
      if (MODE !== "full") {
        const danger = args.join(" ").toLowerCase();
        if (/(^|\s)(clean)(\s|$)/.test(danger) || /reset\s+--hard/.test(danger)) {
          throw new Error("Destructive git command blocked in safe mode.");
        }
      }
      const workdir = resolvePath(cwd);
      const result = await spawnCapture("git", args, workdir, DEFAULT_CMD_TIMEOUT);
      return jsonResult({ cwd: workdir, args, ...result });
    }
  );
}

// ----------------------------------------------------------------------------
// Path safety
// ----------------------------------------------------------------------------
function resolvePath(input = ".") {
  const raw = String(input ?? ".").trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(PRIMARY_ROOT, raw);
  if (!isWithinRoots(resolved)) throw new Error(`Path is outside the allowed roots: ${input}`);
  return resolved;
}

function isWithinRoots(p) {
  return ROOTS.some((root) => {
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    return p === root || p.startsWith(withSep);
  });
}

// Shorten output paths: relative to the primary root (posix slashes) when the
// file lives under it, otherwise the absolute path. Round-trips back through
// resolvePath() because relative inputs resolve against the primary root.
function toRel(abs) {
  if (abs === PRIMARY_ROOT) return ".";
  const withSep = PRIMARY_ROOT.endsWith(path.sep) ? PRIMARY_ROOT : PRIMARY_ROOT + path.sep;
  if (abs.startsWith(withSep)) return abs.slice(withSep.length).split(path.sep).join("/");
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
  const args = ["--no-heading", "--with-filename", "-n", "-I", "-S", "--color", "never"];
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
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + re + "$", "i");
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
  return process.platform === "win32" ? "cmd" : "bash";
}

function buildSpawn(command, shell) {
  const s = shell || defaultShell();
  if (s === "powershell") {
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command], opts: {} };
  }
  if (s === "bash") {
    return { file: "bash", args: ["-lc", command], opts: {} };
  }
  // cmd / default: rely on the OS shell so pipes/redirects work.
  return { file: command, args: [], opts: { shell: true } };
}

function runShellCommand(command, cwd, shell, timeoutMs) {
  const { file, args, opts } = buildSpawn(command, shell);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, { cwd, windowsHide: true, env: { ...process.env, AGENT_WORKSPACE: PRIMARY_ROOT }, ...opts });
    } catch (err) {
      resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
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
      child = spawn(file, args, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
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
  const child = spawn(file, args, { cwd, windowsHide: true, env: { ...process.env, AGENT_WORKSPACE: PRIMARY_ROOT }, ...opts });
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
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.child.kill("SIGTERM");
    }
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
    perTool: {},
    recent: [], // newest first, capped
    buckets: [] // per-minute { t, calls, tokens }, capped
  };
}

function loadMetrics() {
  try {
    if (existsSync(METRICS_PATH)) {
      const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
      return { ...emptyMetrics(), ...m, perTool: m.perTool || {}, recent: m.recent || [], buckets: m.buckets || [] };
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

function recordMetric(tool, ok, inChars, outChars, errText) {
  metrics.totalCalls += 1;
  if (ok) metrics.okCalls += 1;
  else metrics.errorCalls += 1;
  metrics.inChars += inChars;
  metrics.outChars += outChars;

  const pt = (metrics.perTool[tool] ||= { calls: 0, ok: 0, err: 0, inChars: 0, outChars: 0 });
  pt.calls += 1;
  if (ok) pt.ok += 1;
  else pt.err += 1;
  pt.inChars += inChars;
  pt.outChars += outChars;

  metrics.recent.unshift({ ts: isoNow(), tool, ok, inChars, outChars, tokens: estTokens(inChars + outChars), error: ok ? undefined : errText || undefined });
  if (metrics.recent.length > 60) metrics.recent.length = 60;

  const minute = Math.floor(Date.now() / 60000) * 60000;
  let b = metrics.buckets[metrics.buckets.length - 1];
  if (!b || b.t !== minute) {
    b = { t: minute, calls: 0, tokens: 0 };
    metrics.buckets.push(b);
    if (metrics.buckets.length > 180) metrics.buckets.shift();
  }
  b.calls += 1;
  b.tokens += estTokens(inChars + outChars);

  scheduleSave();
}

function metricsSnapshot() {
  const topTools = Object.entries(metrics.perTool)
    .map(([name, v]) => ({ name, ...v, tokens: estTokens(v.inChars + v.outChars) }))
    .sort((a, b) => b.calls - a.calls);
  return {
    version: VERSION,
    mode: MODE,
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
    top_tools: topTools,
    recent: metrics.recent,
    buckets: metrics.buckets
  };
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

function isoNow() {
  return new Date().toISOString();
}

function appendLimited(current, next, max) {
  const combined = current + next;
  if (combined.length <= max) return combined;
  return combined.slice(combined.length - max);
}

function summarizeArgs(args) {
  try {
    const clone = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (typeof v === "string" && v.length > 200) clone[k] = `${v.slice(0, 200)}…(${v.length} chars)`;
      else clone[k] = v;
    }
    const s = JSON.stringify(clone);
    return s.length > 800 ? `${s.slice(0, 800)}…` : s;
  } catch {
    return "<unserializable>";
  }
}

function log(message) {
  console.log(`${isoNow()} ${message}`);
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

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
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
      <p><code>workspace_info, repo_overview, list_files, find_files, read_file, read_many, stat_path, search_text, write_file, replace_in_file, apply_patch, make_dir, move_path, delete_path, run_command, proc_start, proc_list, proc_output, proc_stop, git, ping, save_note, list_notes</code></p>
    </div>
    <div class="panel"><p><strong>Local dashboard</strong> (this machine only): <code>http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/ui</code></p></div>
  </main>
</body>
</html>`;
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
</style>
</head>
<body>
<div class="wrap">
  <div><span id="status">● live</span>
  <h1>Local Coding Agent <span class="pill" id="ver"></span> <span class="pill" id="modePill"></span></h1></div>
  <p class="sub">Số liệu cục bộ trên máy này · since <span id="since"></span> · tự cập nhật 2.5s</p>

  <div class="cards" id="cards"></div>

  <div class="panel">
    <h3>Tokens / phút (ước tính)</h3>
    <canvas id="chart" width="1140" height="220"></canvas>
    <div class="note">Ước tính = (ký tự input + output của tool) ÷ 4. Đây là token DỮ LIỆU đi qua connector, KHÔNG phải token tính phí của ChatGPT.</div>
  </div>

  <div class="grid">
    <div class="panel"><h3>Top tools</h3><table id="tools"></table></div>
    <div class="panel"><h3>Recent calls</h3><div id="recent"></div></div>
  </div>
</div>

<script>
function h(n){ return (n==null?0:n).toLocaleString(); }
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDur(s){ var m=Math.floor(s/60),hh=Math.floor(m/60); if(hh>0) return hh+'h '+(m%60)+'m'; if(m>0) return m+'m '+(s%60)+'s'; return s+'s'; }
function card(label,val,sub){ return '<div class="card"><div class="clab">'+label+'</div><div class="cval">'+val+'</div><div class="csub">'+(sub||'')+'</div></div>'; }
function renderCards(d){
  var html='';
  html+=card('Est. tokens (total)', h(d.est_tokens_total), 'in '+h(d.est_tokens_in)+' · out '+h(d.est_tokens_out));
  html+=card('Tool calls', h(d.total_calls), 'ok '+h(d.ok_calls)+' · err '+h(d.error_calls));
  html+=card('Data qua connector', Math.round((d.in_chars+d.out_chars)/1024).toLocaleString()+' KB', 'tổng ký tự in/out');
  html+=card('Uptime', fmtDur(d.uptime_sec||0), 'mode '+d.mode);
  html+=card('Tiến trình nền', h(d.running_processes), 'đang chạy');
  document.getElementById('cards').innerHTML=html;
  document.getElementById('ver').textContent='v'+(d.version||'');
  document.getElementById('modePill').textContent=(d.mode||'')+' mode';
  document.getElementById('since').textContent=d.since? new Date(d.since).toLocaleString():'-';
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
  var html='<tr><th>Tool</th><th>Calls</th><th>Err</th><th>Est tokens</th></tr>';
  (t||[]).slice(0,15).forEach(function(r){ html+='<tr><td>'+r.name+'</td><td>'+h(r.calls)+'</td><td>'+h(r.err)+'</td><td>'+h(r.tokens)+'</td></tr>'; });
  document.getElementById('tools').innerHTML=html;
}
function renderRecent(r){
  var html='';
  (r||[]).slice(0,22).forEach(function(e){
    var tt=new Date(e.ts).toLocaleTimeString();
    var reason = (!e.ok && e.error) ? ' <span class="errmsg">'+esc(e.error)+'</span>' : '';
    html+='<div class="row"><span class="t">'+tt+'</span> <span class="'+(e.ok?'ok':'err')+'">'+(e.ok?'OK':'ERR')+'</span> <b>'+e.tool+'</b> <span class="dim">'+h(e.tokens)+' tok</span>'+reason+'</div>';
  });
  document.getElementById('recent').innerHTML=html||'<div class="dim">Chưa có lệnh nào</div>';
}
async function tick(){
  try{
    var r=await fetch('/metrics',{cache:'no-store'}); var d=await r.json();
    renderCards(d); renderChart(d.buckets); renderTools(d.top_tools); renderRecent(d.recent);
    document.getElementById('status').textContent='● live'; document.getElementById('status').className='';
    document.getElementById('status').style.color='#2dd4bf';
  }catch(e){
    document.getElementById('status').textContent='○ offline'; document.getElementById('status').style.color='#f87171';
  }
}
tick(); setInterval(tick,2500);
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
