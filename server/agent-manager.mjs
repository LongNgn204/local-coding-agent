// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// v5.0.0-preview.4 Local Sub-Agent Manager.
//
// ChatGPT Web does NOT run native sub-agents here. ChatGPT calls MCP tools;
// this module runs and tracks sub-agent tasks LOCALLY, stores heavy
// logs/reports on disk, and returns only compact summaries to the chat.
//
// The module depends only on Node built-ins so it can be unit-tested without a
// running server. The server injects config (paths, mode/policy) at startup.

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

export const AGENT_STATES = ["queued", "running", "done", "failed", "cancelled"];
export const TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);
export const AGENT_ID_RE = /^a_[0-9a-f]{16}$/;

function isoNow() {
  return new Date().toISOString();
}

// ----------------------------------------------------------------------------
// Helpers (exported for reuse + tests)
// ----------------------------------------------------------------------------

/** Stable, path-safe agent id: a_ + 16 hex. */
export function generateAgentId() {
  return `a_${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16)}`;
}

/**
 * Redact secrets before anything is written to a customer-facing report/log.
 * Covers API keys, bearer tokens, runtime/tunnel keys, and common secret fields.
 */
export function redactSecrets(input) {
  let text = typeof input === "string" ? input : JSON.stringify(input ?? "", null, 2);
  text = text.replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-<redacted>");
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>");
  text = text.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "gh_<redacted>");
  text = text.replace(/xox[baprs]-[A-Za-z0-9-]{8,}/g, "xox-<redacted>");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>");
  text = text.replace(/tunnel_[A-Za-z0-9]{12,}/g, "tunnel_<redacted>");
  text = text.replace(/(CONTROL_PLANE_API_KEY\s*[:=]\s*)[^\s"']+/gi, "$1<redacted>");
  text = text.replace(/(MCP_AUTH_TOKEN\s*[:=]\s*)[^\s"']+/gi, "$1<redacted>");
  text = text.replace(/(AGENT_APPROVAL_TOKEN\s*[:=]\s*)[^\s"']+/gi, "$1<redacted>");
  text = text.replace(
    /("?(?:api[_-]?key|token|secret|password|passwd|authorization|access[_-]?token|refresh[_-]?token)"?\s*[:=]\s*")[^"]+(")/gi,
    "$1<redacted>$2"
  );
  // Long opaque secret-looking blobs (base64/hex) >= 40 chars with no spaces.
  text = text.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, (m) => (/[a-z]/.test(m) && /[A-Z0-9]/.test(m) ? "<redacted-blob>" : m));
  return text;
}

/**
 * Keep chat payloads small. Returns the (possibly truncated) text plus flags so
 * ChatGPT Web never receives thousands of lines by default.
 */
export function truncateForChat(input, maxChars = 2000) {
  const text = typeof input === "string" ? input : String(input ?? "");
  const total = text.length;
  const cap = Math.max(1, Number(maxChars) || 2000);
  if (total <= cap) return { text, truncated: false, total_chars: total, returned_chars: total };
  const head = text.slice(0, cap);
  return {
    text: `${head}\n...[truncated ${total - cap} of ${total} chars - read the local report/log for the full output]`,
    truncated: true,
    total_chars: total,
    returned_chars: cap
  };
}

/** Build a local file path for an agent artifact (log/report). */
export function makeLocalReportPath(agentsDir, agentId, kind) {
  const safe = AGENT_ID_RE.test(agentId) ? agentId : "a_invalid";
  const ext = kind === "report" ? "report.md" : "log";
  return path.join(agentsDir, `${safe}.${ext}`);
}

/** Mirror the server's workspace-scoped data dir so the CLI finds the same agents. */
export function comparePath(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function workspaceAgentsDir(dataDir, workspaceRoot) {
  const id = createHash("sha256").update(comparePath(workspaceRoot)).digest("hex").slice(0, 16);
  return path.join(dataDir, "workspaces", id, "agents");
}

// ----------------------------------------------------------------------------
// Specialist roles
// ----------------------------------------------------------------------------
export const ROLES = {
  repo_setup: {
    name: "repo_setup",
    description: "Helps install, verify, and diagnose Local Coding Agent setup problems.",
    allowed_task_type: "setup/install/verify diagnosis",
    safety_notes: [
      "Never install system dependencies without asking.",
      "Never download or commit the tunnel client.",
      "Never print or store secrets."
    ],
    default_output: "checklist"
  },
  bug_fix: {
    name: "bug_fix",
    description: "Investigates errors, points at relevant files, and proposes a focused fix plan.",
    allowed_task_type: "bug investigation / focused fix plan",
    safety_notes: [
      "Prefer preview_patch/validate_patch before applying edits.",
      "Do not run destructive commands.",
      "Keep changes minimal and scoped."
    ],
    default_output: "investigation report"
  },
  network_check: {
    name: "network_check",
    description: "Runs network/customer diagnostics and writes a redacted report.",
    allowed_task_type: "network/customer diagnostics",
    safety_notes: [
      "The report is redacted; still review before sending.",
      "Does not require the proprietary tunnel client."
    ],
    default_output: "redacted diagnostic report"
  },
  release_prep: {
    name: "release_prep",
    description: "Prepares changelog, version notes, build checklist, and a release-readiness report.",
    allowed_task_type: "release preparation",
    safety_notes: [
      "Never publish or tag without maintainer approval.",
      "A preview build must stay clearly experimental."
    ],
    default_output: "release readiness checklist"
  },
  docs_update: {
    name: "docs_update",
    description: "Updates bilingual Vietnamese/English docs with matching content.",
    allowed_task_type: "documentation update",
    safety_notes: [
      "Keep English and Vietnamese sections in sync.",
      "Keep Windows PowerShell snippets ASCII-only."
    ],
    default_output: "doc update plan"
  },
  safety_review: {
    name: "safety_review",
    description: "Checks permission risks, token leaks, unsafe commands, public tunnel exposure, and log redaction.",
    allowed_task_type: "security review",
    safety_notes: [
      "Report findings without echoing secret values.",
      "Flag any public-tunnel exposure without MCP_AUTH_TOKEN."
    ],
    default_output: "security findings checklist"
  }
};

export function getRole(name) {
  const role = ROLES[String(name)];
  if (!role) {
    throw new Error(`Unknown role "${name}". Valid roles: ${Object.keys(ROLES).join(", ")}`);
  }
  return role;
}

// ----------------------------------------------------------------------------
// Providers
// ----------------------------------------------------------------------------
// script_runner runs a deterministic local "specialist planner" that produces a
// structured, redacted report + log from the role, the task, and the local
// environment. It performs NO network calls and spawns NO subprocess, so it is
// safe and deterministic.
//
// codex_cli (preview.4) runs the locally installed, already-authenticated
// OpenAI Codex CLI in its non-interactive `codex exec` mode, with the sandbox
// mapped from the agent mode, approvals disabled, a runtime timeout, and full
// cancellation (tree-kill on Windows). claude_cli / openai_api remain declared
// for discovery only (see docs/V5_SUBAGENTS.md).

function envSnapshot(meta) {
  return [
    `- node: ${process.version}`,
    `- platform: ${os.platform()} ${os.arch()}`,
    `- workspace_root: ${meta.workspace_root}`,
    `- mode: ${meta.mode ?? "n/a"} / policy: ${meta.policy ?? "n/a"}`
  ].join("\n");
}

const ROLE_PLAYBOOK = {
  repo_setup: () => [
    "1. Check `node -v` is >= 18.",
    "2. Install: `scripts\\lca.cmd install` (Windows) or `bash scripts/lca install`.",
    "3. Configure a workspace and start with `--no-tunnel` for a first check.",
    "4. Verify health at http://127.0.0.1:8787/healthz and dashboard at :8790/ui.",
    "5. Run `npm run test:agent` from server/."
  ],
  bug_fix: () => [
    "1. Reproduce the error and capture the exact message + stack.",
    "2. Locate the relevant files with search_text / repo_symbols.",
    "3. Read only the needed line ranges.",
    "4. Draft a minimal fix; validate with preview_patch/validate_patch.",
    "5. Run run_changed_tests after applying."
  ],
  network_check: () => [
    "1. Run `node scripts/network-doctor.mjs` on the failing network.",
    "2. Check DNS, TCP 443, TLS, local health (8787) and dashboard (8790).",
    "3. Inspect proxy env vars; confirm no public tunnel without MCP_AUTH_TOKEN.",
    "4. Send the redacted network-doctor-report.txt to the developer."
  ],
  release_prep: () => [
    "1. Run test:agent, test:pro, test:security, validate-skills.",
    "2. Confirm official release and compatibility version constants.",
    "3. Update CHANGELOG with a dated, clearly-labeled section.",
    "4. Confirm preview flags default to off (stable behavior unchanged).",
    "5. Only tag/publish after maintainer approval."
  ],
  docs_update: () => [
    "1. Identify the English section to change.",
    "2. Mirror the same meaning in the Vietnamese section.",
    "3. Keep PowerShell snippets ASCII-only.",
    "4. Cross-link related docs."
  ],
  safety_review: () => [
    "1. Check for tokens/keys in code, logs, and reports (should be redacted).",
    "2. Review command execution paths and mode/policy gates.",
    "3. Confirm the server binds loopback and is not on a public tunnel without auth.",
    "4. Verify approvals are one-time and workspace-scoped."
  ]
};

const scriptRunner = {
  name: "script_runner",
  available: () => true,
  async run(meta) {
    // Yield once so a cancel() issued right after spawn can take effect.
    await new Promise((resolve) => setImmediate(resolve));
    const role = getRole(meta.role);
    const steps = (ROLE_PLAYBOOK[meta.role] || (() => ["1. Review the task and produce a plan."]))();
    const log = [
      `[${isoNow()}] agent ${meta.agent_id} started (role=${meta.role}, provider=script_runner)`,
      `[${isoNow()}] task: ${meta.task}`,
      `[${isoNow()}] environment probed in-process (no subprocess, no network)`,
      `[${isoNow()}] built ${steps.length}-step ${role.default_output}`,
      `[${isoNow()}] agent ${meta.agent_id} finished ok`
    ].join("\n");
    const report = [
      `# ${meta.title || role.name}`,
      "",
      `> v5.0.0-preview.2 sub-agent report (provider: script_runner). This preview`,
      `> runs a local deterministic planner, not a live AI model. See`,
      `> docs/V5_SUBAGENTS.md for the roadmap to real providers.`,
      "",
      `- **Role:** ${role.name} - ${role.description}`,
      `- **Allowed task type:** ${role.allowed_task_type}`,
      `- **Default output:** ${role.default_output}`,
      "",
      "## Task",
      "",
      meta.task,
      "",
      "## Environment",
      "",
      envSnapshot(meta),
      "",
      `## Plan (${role.default_output})`,
      "",
      ...steps,
      "",
      "## Safety notes",
      "",
      ...role.safety_notes.map((s) => `- ${s}`),
      ""
    ].join("\n");
    const summary = `${role.name}: produced a ${steps.length}-step ${role.default_output} for "${meta.title || meta.task}".`;
    return { ok: true, summary, report, log };
  }
};

// ----------------------------------------------------------------------------
// codex_cli provider (preview.4)
// ----------------------------------------------------------------------------
// Runs the locally installed, already-authenticated OpenAI Codex CLI in its
// non-interactive `codex exec` mode. Flags below are taken from the real
// `codex exec --help` of the installed version (0.140.0):
//   codex exec [OPTIONS] [PROMPT]        prompt read from stdin if `-` is used
//   -s, --sandbox <read-only|workspace-write|danger-full-access>
//   -C, --cd <DIR>                        working root
//   --skip-git-repo-check                 allow running outside a git repo
//   -o, --output-last-message <FILE>      write the agent's final message cleanly
//   --color never                         no ANSI escape codes in the output
// `codex exec` is already non-interactive and never prompts for approval, so
// there is no --ask-for-approval flag on the exec subcommand (it is top-level
// only). The task text is passed on stdin (prompt = "-") to avoid ALL shell
// quoting of user input.

/** Look up an executable on PATH, returning its full resolved path or null. */
export function resolveOnPath(exe, env = process.env) {
  const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [`${exe}.cmd`, `${exe}.exe`, `${exe}.bat`, exe] : [exe];
  for (const d of dirs) {
    for (const n of names) {
      try {
        const full = path.join(d, n);
        if (existsSync(full)) return full;
      } catch {
        /* ignore unreadable PATH entry */
      }
    }
  }
  return null;
}

/** Map the agent mode to a Codex sandbox policy. safe -> read-only, full -> workspace-write. */
export function codexSandboxForMode(mode) {
  return String(mode) === "full" ? "workspace-write" : "read-only";
}

export function codexSandboxForMeta(meta = {}) {
  if (["read-only", "workspace-write"].includes(String(meta.sandbox_mode))) return String(meta.sandbox_mode);
  return codexSandboxForMode(meta.mode);
}

/**
 * Pure builder for the `codex exec` argument vector (unit-tested). Does NOT
 * include the prompt itself: the prompt is fed on stdin (args end with "-").
 * `opts.outputFile` (optional) adds `-o <file>` to capture the final message.
 */
export function buildCodexExecArgs(meta, opts = {}) {
  const args = ["exec"];
  const sandbox = codexSandboxForMeta(meta);
  args.push("--sandbox", sandbox);
  args.push("--skip-git-repo-check");
  args.push("--color", "never");
  if (meta.workspace_root) args.push("--cd", meta.workspace_root);
  if (sandbox === "workspace-write") {
    const working = meta.workspace_root ? path.resolve(meta.workspace_root) : null;
    const seen = new Set(working ? [process.platform === "win32" ? working.toLowerCase() : working] : []);
    for (const root of Array.isArray(meta.writable_roots) ? meta.writable_roots : []) {
      const absolute = path.resolve(String(root));
      const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
      if (seen.has(key)) continue;
      seen.add(key);
      args.push("--add-dir", absolute);
    }
  }
  if (opts.outputFile) args.push("--output-last-message", opts.outputFile);
  args.push("-"); // read the prompt from stdin (no shell quoting of user text)
  return args;
}

/** Compose the instruction that prefixes the user's task for a concise report. */
export function buildCodexPrompt(meta) {
  const role = ROLES[meta.role];
  const roleLine = role ? `You are acting as the "${role.name}" specialist: ${role.description}` : "";
  const permissionLines = Array.isArray(meta.permission_roots) && meta.permission_roots.length
    ? [
        "",
        `Permission profile: ${meta.permission_profile || "task"}`,
        ...meta.permission_roots.map((root) => `- ${root.path} [${root.preset}; fs=${root.filesystem}; commands=${root.commands}]`)
      ]
    : [];
  return [
    roleLine,
    "Keep your output concise. Do the task, then end your final message with a short",
    "3-6 line summary of what you did or found.",
    "",
    "TASK:",
    meta.task,
    ...permissionLines
  ].filter(Boolean).join("\n");
}

const HARD_CAP_MS = 600000;
const DEFAULT_RUNTIME_MS = 300000;
const CAPTURE_LIMIT = 200000;
const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Is the given OS pid currently alive? Cross-platform, never throws.
 *   process.kill(pid, 0) sends no signal; it just probes existence.
 *   - success            -> the process exists and we may signal it -> alive.
 *   - throws EPERM       -> the process exists but is not ours -> alive.
 *   - throws ESRCH       -> no such process -> dead.
 * We treat our own pid as alive without probing.
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

/**
 * Kill a process tree by pid (best effort, never throws). On Windows uses
 * `taskkill /PID <pid> /T /F` to reach the whole tree (node -> cmd.exe -> codex),
 * only ever targeting a specific pid/tree (never /IM). Returns a promise that
 * resolves { ok, code } once taskkill exits (or immediately on POSIX / no pid),
 * so callers can log an "Access is denied" without hanging. Accepts either a
 * ChildProcess (uses child.pid) or a bare numeric pid (for orphan cleanup on
 * restart, where the ChildProcess object is gone).
 */
export function killProcessTree(target) {
  const isChild = target && typeof target === "object";
  if (isChild && (target.exitCode !== null || target.signalCode)) {
    return Promise.resolve({ ok: true, code: 0 });
  }
  const pid = isChild ? target.pid : Number(target);
  if (!pid || !Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    return Promise.resolve({ ok: false, code: null });
  }
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      try {
        const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        tk.on("error", () => resolve({ ok: false, code: null }));
        tk.on("close", (code) => resolve({ ok: code === 0, code }));
      } catch {
        try { if (isChild) target.kill(); } catch { /* ignore */ }
        resolve({ ok: false, code: null });
      }
    });
  }
  try { if (isChild) target.kill("SIGKILL"); else process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  return Promise.resolve({ ok: true, code: 0 });
}

const codexCli = {
  name: "codex_cli",
  available: () => Boolean(resolveOnPath("codex")),
  async run(meta, ctx = {}) {
    const signal = ctx.signal;
    const codexPath = resolveOnPath("codex");
    if (!codexPath) {
      return { ok: false, summary: "codex CLI not found on PATH.", report: "", log: "codex CLI not found on PATH.", error: "codex CLI not found on PATH" };
    }
    const runtimeMs = Math.min(Number(meta.max_runtime_ms) || DEFAULT_RUNTIME_MS, HARD_CAP_MS);
    const graceMs = Number.isFinite(ctx.killGraceMs) ? ctx.killGraceMs : DEFAULT_KILL_GRACE_MS;

    // Capture the final message to a temp file so we get a clean report.
    const outFile = path.join(os.tmpdir(), `codex-last-${meta.agent_id}.txt`);
    const args = buildCodexExecArgs(meta, { outputFile: outFile });
    const prompt = buildCodexPrompt(meta);

    const startedAt = Date.now();
    const logLines = [
      `[${isoNow()}] agent ${meta.agent_id} started (role=${meta.role}, provider=codex_cli)`,
      `[${isoNow()}] codex ${args.join(" ")}`,
      `[${isoNow()}] sandbox=${codexSandboxForMeta(meta)} cwd=${meta.workspace_root} writable_roots=${(meta.writable_roots || []).length} timeout=${runtimeMs}ms`,
      ""
    ];

    // On Windows `codex` is an npm `.cmd` shim, which cannot be spawned directly
    // without a shell. Instead of shell:true (which concatenates args unescaped
    // -> DEP0190), we invoke cmd.exe with a command line we quote ourselves and
    // set windowsVerbatimArguments so Node does not re-quote. The prompt is fed
    // on STDIN (args end with "-"), so user task text never touches this line;
    // the only variable args are file paths we control (cwd / output file).
    let child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    if (process.platform === "win32") {
      const q = (s) => (/[\s"&|<>^()%]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
      const cmdline = `${q(codexPath)} ${args.map(q).join(" ")}`;
      child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdline], {
        cwd: meta.workspace_root,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: process.env
      });
    } else {
      child = spawn(codexPath, args, {
        cwd: meta.workspace_root,
        windowsHide: true,
        env: process.env
      });
    }

    ctx.onChild?.(child);

    let killResult = null; // { ok, code } from the last killProcessTree, if any.

    const cap = (buf, chunk) => {
      const next = buf + chunk.toString();
      return next.length > CAPTURE_LIMIT ? next.slice(next.length - CAPTURE_LIMIT) : next;
    };
    child.stdout?.on("data", (d) => { stdout = cap(stdout, d); });
    child.stderr?.on("data", (d) => { stderr = cap(stderr, d); });

    // Feed the prompt on stdin then close it.
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* stdin may already be closed if spawn failed */
    }

    // Resolve the run promise on a GRACE RACE: the child's natural 'close'/'error'
    // wins, but the moment a kill is requested (timeout or cancel) we also start a
    // grace timer. If the child does not close within `graceMs` after the kill
    // request (e.g. taskkill "Access is denied", or the child ignores the kill),
    // we resolve anyway with reason "grace" so settle() never hangs. We never wait
    // unbounded on 'close' once a kill has been requested.
    let resolveExit;
    const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolveExit(v); } };

    let graceTimer = null;
    const requestKill = async (reasonFlag) => {
      if (reasonFlag === "timeout") timedOut = true;
      if (reasonFlag === "abort") aborted = true;
      // Start the grace fallback BEFORE the (async) kill so a kill that hangs or
      // an unkillable child can never wedge the run promise.
      if (!graceTimer) {
        graceTimer = setTimeout(() => finish({ code: null, error: null, reason: "grace" }), graceMs);
        if (typeof graceTimer.unref === "function") graceTimer.unref();
      }
      killResult = await killProcessTree(child);
    };

    const timer = setTimeout(() => { requestKill("timeout"); }, runtimeMs);
    const onAbort = () => { requestKill("abort"); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => finish({ code: null, error: err }));
    child.on("close", (code) => finish({ code, error: null }));

    const exit = await exitPromise;

    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    if (signal) signal.removeEventListener("abort", onAbort);

    const killedButAlive = exit.reason === "grace";

    const elapsed = Date.now() - startedAt;
    let finalMessage = "";
    try {
      finalMessage = await readFile(outFile, "utf8");
    } catch {
      /* no output-last-message file (e.g. codex errored early) */
    }
    await rm(outFile, { force: true }).catch(() => {});

    // If we resolved on the grace fallback, the child may still be alive: taskkill
    // may have returned non-zero (e.g. "Access is denied") or the child ignored
    // the kill. Warn clearly and tell the user which pid to kill by hand.
    const stuckSuffix =
      killedButAlive && child.pid && killResult && killResult.ok === false
        ? ` (child pid ${child.pid} may still be running; kill it manually)`
        : "";

    if (stdout) logLines.push("--- stdout ---", stdout);
    if (stderr) logLines.push("--- stderr ---", stderr);
    if (killedButAlive) {
      logLines.push(
        "",
        `[${isoNow()}] kill requested but child did not exit within ${graceMs}ms grace` +
          (killResult ? ` (taskkill ok=${killResult.ok} code=${killResult.code})` : "")
      );
    }
    logLines.push("", `[${isoNow()}] codex exited code=${exit.code} elapsed=${elapsed}ms`);
    const log = logLines.join("\n");

    if (aborted) {
      // Cancellation is finalized by the manager; report a failed-ish result.
      return {
        ok: false,
        summary: "Cancelled while codex was running.",
        report: finalMessage || stdout,
        log,
        error: `cancelled${stuckSuffix}`
      };
    }
    if (timedOut) {
      return {
        ok: false,
        summary: `codex timed out after ${runtimeMs}ms`,
        report: finalMessage || stdout,
        log,
        error: `timed out after ${runtimeMs}ms${stuckSuffix}`
      };
    }
    if (exit.error) {
      return { ok: false, summary: `codex failed to start: ${exit.error.message}`, report: finalMessage || stdout, log, error: String(exit.error.message) };
    }
    if (exit.code !== 0) {
      return {
        ok: false,
        summary: `codex exited with code ${exit.code}`,
        report: finalMessage || stdout || stderr,
        log,
        error: `codex exited with code ${exit.code}`
      };
    }

    const report = finalMessage.trim() || stdout.trim() || "(codex produced no final message)";
    const summary = report.replace(/\s+/g, " ").trim().slice(0, 300);
    return { ok: true, summary, report, log };
  }
};

/** Detect available providers safely (no throwing, no assuming CLIs exist). */
export function detectProviders(env = process.env) {
  const onPath = (exe) => Boolean(resolveOnPath(exe, env));
  return [
    { name: "script_runner", available: true, note: "Local deterministic planner (implemented)." },
    { name: "claude_cli", available: onPath("claude"), note: "TODO: run Claude Code CLI as a provider." },
    { name: "codex_cli", available: onPath("codex"), note: "Runs the local, authenticated Codex CLI in non-interactive exec mode (implemented)." },
    { name: "openai_api", available: Boolean(env.OPENAI_API_KEY), note: "TODO: call OpenAI API directly." }
  ];
}

// ----------------------------------------------------------------------------
// Agent Manager
// ----------------------------------------------------------------------------
export class AgentManager {
  constructor({ agentsDir, defaultWorkspace, mode = null, policy = null, maxAgents = 500, providers = null, killGraceMs = DEFAULT_KILL_GRACE_MS } = {}) {
    if (!agentsDir) throw new Error("AgentManager requires agentsDir");
    this.agentsDir = agentsDir;
    this.indexPath = path.join(agentsDir, "index.json");
    this.defaultWorkspace = defaultWorkspace || process.cwd();
    this.mode = mode;
    this.policy = policy;
    this.maxAgents = maxAgents;
    this.killGraceMs = Number.isFinite(killGraceMs) ? killGraceMs : DEFAULT_KILL_GRACE_MS;
    this.providers = providers || { script_runner: scriptRunner, codex_cli: codexCli };
    this.agents = new Map(); // agent_id -> meta
    this._runs = new Map(); // agent_id -> Promise
    this._cancelled = new Set();
    this._controllers = new Map(); // agent_id -> AbortController
    this._children = new Map(); // agent_id -> ChildProcess (running provider child)
    this._timeouts = new Set(); // agent_ids that were aborted by the runtime timeout
  }

  async init() {
    await mkdir(this.agentsDir, { recursive: true });
    let changed = false;
    try {
      const list = JSON.parse(await readFile(this.indexPath, "utf8"));
      if (Array.isArray(list)) {
        for (const m of list) {
          // A non-terminal (queued/running) task in the shared store may belong to
          // ANOTHER live manager (the CLI and the server share one workspace store
          // via separate in-memory managers). Only mark it interrupted if its owner
          // process is gone; if the owner pid is still alive (or is this process on
          // resume), leave the task untouched so we never clobber a live run.
          if (m && !TERMINAL_STATES.has(m.status)) {
            const owner = Number(m.owner_pid);
            const ownerAlive = Number.isInteger(owner) && owner > 0 && isPidAlive(owner);
            if (!ownerAlive) {
              m.status = "failed";
              m.error = m.error || "interrupted by server restart";
              changed = true;
              // Best-effort: clean up an orphaned child this dead run left behind,
              // so a restart tidies its own orphans. Never throw/hang here.
              if (m.child_pid) killProcessTree(Number(m.child_pid)).catch(() => {});
            }
          }
          if (m?.agent_id) this.agents.set(m.agent_id, m);
        }
      }
    } catch {
      /* no index yet */
    }
    // Persist any interrupted-flip so a subsequent manager sees the terminal state.
    if (changed) await this._saveIndex().catch(() => {});
    return this;
  }

  _compact(meta) {
    return {
      agent_id: meta.agent_id,
      role: meta.role,
      title: meta.title,
      status: meta.status,
      provider: meta.provider || "script_runner",
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      summary: meta.summary || "",
      report_path: meta.report_path || null,
      log_path: meta.log_path || null,
      error: meta.error || null
    };
  }

  async _saveIndex() {
    const list = [...this.agents.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    await mkdir(this.agentsDir, { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  }

  async spawn({ role, title, task, workspace_root, max_runtime_ms, dry_run = false, provider = "script_runner", sandbox_mode, writable_roots = [], permission_profile = null, permission_roots = [] } = {}) {
    getRole(role); // throws on invalid role
    if (!task || !String(task).trim()) throw new Error("task is required");
    if (!this.providers[provider]) throw new Error(`Unknown provider "${provider}".`);
    const now = isoNow();
    const meta = {
      agent_id: generateAgentId(),
      role: String(role),
      title: String(title || task).slice(0, 200),
      task: String(task).slice(0, 8000),
      provider,
      workspace_root: workspace_root || this.defaultWorkspace,
      mode: this.mode,
      policy: this.policy,
      sandbox_mode: sandbox_mode || null,
      writable_roots: Array.isArray(writable_roots) ? writable_roots.map(String) : [],
      permission_profile: permission_profile ? String(permission_profile) : null,
      permission_roots: Array.isArray(permission_roots) ? permission_roots : [],
      max_runtime_ms: Number(max_runtime_ms) || null,
      dry_run: Boolean(dry_run),
      pid: null,
      owner_pid: null,
      child_pid: null,
      status: "queued",
      created_at: now,
      updated_at: now,
      summary: "",
      report_path: null,
      log_path: null,
      error: null
    };
    this.agents.set(meta.agent_id, meta);

    // Bound stored history.
    if (this.agents.size > this.maxAgents) {
      const oldest = [...this.agents.values()]
        .filter((m) => TERMINAL_STATES.has(m.status))
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))[0];
      if (oldest) {
        this.agents.delete(oldest.agent_id);
        await this._deleteFiles(oldest).catch(() => {});
      }
    }

    if (meta.dry_run) {
      meta.status = "done";
      meta.summary = `Dry run: role "${meta.role}" and task validated. No work executed.`;
      meta.updated_at = isoNow();
      await this._saveIndex();
      return this._compact(meta);
    }

    meta.status = "running";
    // Stamp the owning process so another live manager sharing this store can tell
    // (via a liveness probe on init) that this run is genuinely still ours, and
    // must not be clobbered to "failed".
    meta.owner_pid = process.pid;
    meta.updated_at = isoNow();
    await this._saveIndex();
    const p = this._execute(meta).catch((err) => this._fail(meta, err));
    this._runs.set(meta.agent_id, p);
    return this._compact(meta);
  }

  async _execute(meta) {
    const provider = this.providers[meta.provider];
    const controller = new AbortController();
    this._controllers.set(meta.agent_id, controller);

    // Central runtime timeout: aborts the signal so signal-aware providers stop.
    // The provider (e.g. codex_cli) also tree-kills its child on abort/timeout.
    let timer = null;
    const runtimeMs = Number(meta.max_runtime_ms) || null;
    if (runtimeMs) {
      timer = setTimeout(() => {
        this._timeouts.add(meta.agent_id);
        controller.abort();
      }, Math.min(runtimeMs, 600000));
    }

    const ctx = {
      signal: controller.signal,
      killGraceMs: this.killGraceMs,
      onChild: (child) => {
        this._children.set(meta.agent_id, child);
        meta.pid = child?.pid || null;
        // Persist the child pid so a later manager.init() can tree-kill this run's
        // orphaned child if the owning process died without cleaning up (Bug 2).
        if (child?.pid) {
          meta.child_pid = child.pid;
          this._saveIndex().catch(() => {});
        }
      }
    };

    let out;
    try {
      out = await provider.run(meta, ctx);
    } finally {
      if (timer) clearTimeout(timer);
      this._controllers.delete(meta.agent_id);
      this._children.delete(meta.agent_id);
      meta.pid = null;
      // The run has settled; the child (if any) is no longer ours to track. Clear
      // owner/child so the persisted terminal record carries no stale live pids.
      meta.owner_pid = null;
      meta.child_pid = null;
    }

    // A runtime-timeout abort becomes a failed status with a timeout error,
    // even if a signal-aware provider returned early without ok:false.
    if (this._timeouts.has(meta.agent_id)) {
      this._timeouts.delete(meta.agent_id);
      if (!this._cancelled.has(meta.agent_id)) {
        return this._finalizeTimeout(meta, out, runtimeMs);
      }
    }

    if (this._cancelled.has(meta.agent_id)) {
      return this._finalizeCancelled(meta, out);
    }
    await mkdir(this.agentsDir, { recursive: true });
    const logPath = makeLocalReportPath(this.agentsDir, meta.agent_id, "log");
    await writeFile(logPath, redactSecrets(out.log || ""), "utf8");
    meta.log_path = logPath;
    if (out.report) {
      const reportPath = makeLocalReportPath(this.agentsDir, meta.agent_id, "report");
      await writeFile(reportPath, redactSecrets(out.report), "utf8");
      meta.report_path = reportPath;
    }
    meta.summary = truncateForChat(redactSecrets(out.summary || ""), 500).text;
    meta.status = out.ok ? "done" : "failed";
    if (!out.ok) meta.error = out.error || "agent failed";
    meta.updated_at = isoNow();
    await this._saveIndex();
    return this._compact(meta);
  }

  async _fail(meta, err) {
    if (this._cancelled.has(meta.agent_id)) return this._finalizeCancelled(meta);
    meta.status = "failed";
    meta.error = redactSecrets(String(err?.message || err)).slice(0, 500);
    meta.updated_at = isoNow();
    await this._saveIndex();
    return this._compact(meta);
  }

  /**
   * Persist whatever partial log/report a provider captured on an interrupted
   * run (timeout/cancel), so the user can inspect partial work. Only writes when
   * the provider actually reported the interruption (out.error is "cancelled" or
   * a timeout). A provider that completed cleanly before an after-the-fact cancel
   * has no partial state, so we keep the "no files" behavior for that case.
   */
  async _writePartialArtifacts(meta, out) {
    if (!out || !out.error) return;
    const interrupted = /^cancelled\b/i.test(out.error) || /timed out/i.test(out.error);
    if (!interrupted) return;
    await mkdir(this.agentsDir, { recursive: true }).catch(() => {});
    if (out.log) {
      const logPath = makeLocalReportPath(this.agentsDir, meta.agent_id, "log");
      await writeFile(logPath, redactSecrets(out.log), "utf8").catch(() => {});
      meta.log_path = logPath;
    }
    if (out.report) {
      const reportPath = makeLocalReportPath(this.agentsDir, meta.agent_id, "report");
      await writeFile(reportPath, redactSecrets(out.report), "utf8").catch(() => {});
      meta.report_path = reportPath;
    }
  }

  async _finalizeTimeout(meta, out, runtimeMs) {
    // Keep partial work so the user can see what codex did before the cutoff.
    await this._writePartialArtifacts(meta, out);
    meta.status = "failed";
    meta.error = `timed out after ${Math.min(Number(runtimeMs) || 0, 600000)}ms`;
    meta.summary = truncateForChat(redactSecrets((out && out.summary) || meta.error), 500).text;
    meta.updated_at = isoNow();
    await this._saveIndex();
    return this._compact(meta);
  }

  async _finalizeCancelled(meta, out) {
    // Preserve any partial log so the user can inspect what ran before cancel.
    await this._writePartialArtifacts(meta, out);
    meta.status = "cancelled";
    meta.summary = meta.summary || "Cancelled before completion.";
    meta.updated_at = isoNow();
    await this._saveIndex();
    return this._compact(meta);
  }

  /** Await the background work of an agent (used by tests, cancel, and the CLI). */
  async settle(agentId) {
    const p = this._runs.get(agentId);
    if (p) {
      try {
        await p;
      } catch {
        /* recorded on meta */
      }
    }
    return this.get(agentId);
  }

  list({ status, limit = 50 } = {}) {
    let items = [...this.agents.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (status) items = items.filter((m) => m.status === status);
    return items.slice(0, Math.max(1, Math.min(Number(limit) || 50, 500))).map((m) => this._compact(m));
  }

  get(agentId) {
    const meta = this.agents.get(agentId);
    return meta ? { ...meta } : null;
  }

  async result(agentId, maxChars = 2000) {
    const meta = this.agents.get(agentId);
    if (!meta) throw new Error(`No agent with id ${agentId}.`);
    let content = "";
    let source = null;
    if (meta.report_path) {
      try {
        content = await readFile(meta.report_path, "utf8");
        source = "report";
      } catch {
        /* missing file */
      }
    }
    if (!content && meta.log_path) {
      try {
        content = await readFile(meta.log_path, "utf8");
        source = "log";
      } catch {
        /* missing file */
      }
    }
    const trimmed = truncateForChat(content, maxChars);
    return {
      agent_id: meta.agent_id,
      status: meta.status,
      summary: meta.summary || "",
      source: source || "none",
      report_path: meta.report_path || null,
      log_path: meta.log_path || null,
      truncated: trimmed.truncated,
      total_chars: trimmed.total_chars,
      content: source ? trimmed.text : "",
      error: meta.error || null
    };
  }

  /**
   * Read one agent artifact (report or log) with line pagination, for the
   * dashboard viewer. Files were already redacted at write time.
   */
  async readArtifact(agentId, kind, { offset = 0, limit = 200 } = {}) {
    const meta = this.agents.get(agentId);
    if (!meta) throw new Error(`No agent with id ${agentId}.`);
    const which = kind === "log" ? "log" : "report";
    const file = which === "log" ? meta.log_path : meta.report_path;
    const empty = { kind: which, exists: false, path: file || null, total_lines: 0, offset: 0, returned_lines: 0, has_more: false, content: "" };
    if (!file) return empty;
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return empty;
    }
    const lines = raw.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const off = Math.max(0, Math.min(Number(offset) || 0, lines.length));
    const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const slice = lines.slice(off, off + lim);
    return {
      kind: which,
      exists: true,
      path: file,
      total_lines: lines.length,
      offset: off,
      returned_lines: slice.length,
      has_more: off + slice.length < lines.length,
      content: slice.join("\n")
    };
  }

  async cancel(agentId) {
    const meta = this.agents.get(agentId);
    if (!meta) throw new Error(`No agent with id ${agentId}.`);
    if (TERMINAL_STATES.has(meta.status)) {
      return { agent_id: agentId, status: meta.status, message: `Agent already ${meta.status}.` };
    }
    this._cancelled.add(agentId);
    // Abort the signal so a signal-aware provider stops; tree-kill any child.
    const controller = this._controllers.get(agentId);
    if (controller && !controller.signal.aborted) controller.abort();
    const child = this._children.get(agentId);
    if (child) killProcessTree(child);
    if (this._runs.has(agentId)) {
      await this.settle(agentId);
    } else {
      await this._finalizeCancelled(meta);
    }
    const after = this.agents.get(agentId);
    return { agent_id: agentId, status: after.status, message: `Agent ${after.status}.` };
  }

  async _deleteFiles(meta) {
    for (const p of [meta.log_path, meta.report_path]) {
      if (p) await rm(p, { force: true }).catch(() => {});
    }
  }

  /** Remove terminal agents older than cutoffMs. Returns the count removed. */
  async clean({ olderThanMs = 7 * 24 * 60 * 60 * 1000, keepRunning = true } = {}) {
    const cutoff = Date.now() - Math.max(0, olderThanMs);
    let removed = 0;
    for (const meta of [...this.agents.values()]) {
      const isTerminal = TERMINAL_STATES.has(meta.status);
      if (keepRunning && !isTerminal) continue;
      if (new Date(meta.updated_at).getTime() > cutoff) continue;
      await this._deleteFiles(meta);
      this.agents.delete(meta.agent_id);
      removed += 1;
    }
    if (removed) await this._saveIndex();
    return removed;
  }
}
