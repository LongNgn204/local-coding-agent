// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// v5.0.0-preview.2 Local Sub-Agent Manager.
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
  repo_setup_agent: {
    name: "repo_setup_agent",
    description: "Helps install, verify, and diagnose Local Coding Agent setup problems.",
    allowed_task_type: "setup/install/verify diagnosis",
    safety_notes: [
      "Never install system dependencies without asking.",
      "Never download or commit the tunnel client.",
      "Never print or store secrets."
    ],
    default_output: "checklist"
  },
  bug_fix_agent: {
    name: "bug_fix_agent",
    description: "Investigates errors, points at relevant files, and proposes a focused fix plan.",
    allowed_task_type: "bug investigation / focused fix plan",
    safety_notes: [
      "Prefer preview_patch/validate_patch before applying edits.",
      "Do not run destructive commands.",
      "Keep changes minimal and scoped."
    ],
    default_output: "investigation report"
  },
  network_doctor_agent: {
    name: "network_doctor_agent",
    description: "Runs network/customer diagnostics and writes a redacted report.",
    allowed_task_type: "network/customer diagnostics",
    safety_notes: [
      "The report is redacted; still review before sending.",
      "Does not require the proprietary tunnel client."
    ],
    default_output: "redacted diagnostic report"
  },
  release_agent: {
    name: "release_agent",
    description: "Prepares changelog, version notes, build checklist, and a release-readiness report.",
    allowed_task_type: "release preparation",
    safety_notes: [
      "Never publish or tag without maintainer approval.",
      "A preview build must stay clearly experimental."
    ],
    default_output: "release readiness checklist"
  },
  readme_agent: {
    name: "readme_agent",
    description: "Updates bilingual Vietnamese/English docs with matching content.",
    allowed_task_type: "documentation update",
    safety_notes: [
      "Keep English and Vietnamese sections in sync.",
      "Keep Windows PowerShell snippets ASCII-only."
    ],
    default_output: "doc update plan"
  },
  security_review_agent: {
    name: "security_review_agent",
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
// script_runner is the only provider implemented in preview.2. It runs a
// deterministic local "specialist planner" that produces a structured,
// redacted report + log from the role, the task, and the local environment.
// It performs NO network calls and spawns NO subprocess, so it is safe and
// deterministic. Real AI providers (claude_cli / codex_cli / openai_api) are
// declared for discovery but are not implemented yet (see docs/V5_SUBAGENTS.md).

function envSnapshot(meta) {
  return [
    `- node: ${process.version}`,
    `- platform: ${os.platform()} ${os.arch()}`,
    `- workspace_root: ${meta.workspace_root}`,
    `- mode: ${meta.mode ?? "n/a"} / policy: ${meta.policy ?? "n/a"}`
  ].join("\n");
}

const ROLE_PLAYBOOK = {
  repo_setup_agent: () => [
    "1. Check `node -v` is >= 18.",
    "2. Install: `scripts\\lca.cmd install` (Windows) or `bash scripts/lca install`.",
    "3. Configure a workspace and start with `--no-tunnel` for a first check.",
    "4. Verify health at http://127.0.0.1:8787/healthz and dashboard at :8790/ui.",
    "5. Run `npm run test:agent` from server/."
  ],
  bug_fix_agent: () => [
    "1. Reproduce the error and capture the exact message + stack.",
    "2. Locate the relevant files with search_text / repo_symbols.",
    "3. Read only the needed line ranges.",
    "4. Draft a minimal fix; validate with preview_patch/validate_patch.",
    "5. Run run_changed_tests after applying."
  ],
  network_doctor_agent: () => [
    "1. Run `node scripts/network-doctor.mjs` on the failing network.",
    "2. Check DNS, TCP 443, TLS, local health (8787) and dashboard (8790).",
    "3. Inspect proxy env vars; confirm no public tunnel without MCP_AUTH_TOKEN.",
    "4. Send the redacted network-doctor-report.txt to the developer."
  ],
  release_agent: () => [
    "1. Run test:agent, test:pro, test:security, validate-skills.",
    "2. Confirm version constants (stable + PREVIEW_VERSION).",
    "3. Update CHANGELOG with a dated, clearly-labeled section.",
    "4. Confirm preview flags default to off (stable behavior unchanged).",
    "5. Only tag/publish after maintainer approval."
  ],
  readme_agent: () => [
    "1. Identify the English section to change.",
    "2. Mirror the same meaning in the Vietnamese section.",
    "3. Keep PowerShell snippets ASCII-only.",
    "4. Cross-link related docs."
  ],
  security_review_agent: () => [
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

/** Detect available providers safely (no throwing, no assuming CLIs exist). */
export function detectProviders(env = process.env) {
  const onPath = (exe) => {
    const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
    const names = process.platform === "win32" ? [`${exe}.exe`, `${exe}.cmd`, `${exe}.bat`, exe] : [exe];
    // Pure lookup: we only REPORT availability. We never execute the binary here.
    for (const d of dirs) {
      for (const n of names) {
        try {
          if (existsSync(path.join(d, n))) return true;
        } catch {
          /* ignore unreadable PATH entry */
        }
      }
    }
    return false;
  };
  return [
    { name: "script_runner", available: true, note: "Local deterministic planner (implemented)." },
    { name: "claude_cli", available: onPath("claude"), note: "TODO: run Claude Code CLI as a provider." },
    { name: "codex_cli", available: onPath("codex"), note: "TODO: run Codex CLI as a provider." },
    { name: "openai_api", available: Boolean(env.OPENAI_API_KEY), note: "TODO: call OpenAI API directly." }
  ];
}

// ----------------------------------------------------------------------------
// Agent Manager
// ----------------------------------------------------------------------------
export class AgentManager {
  constructor({ agentsDir, defaultWorkspace, mode = null, policy = null, maxAgents = 500, providers = null } = {}) {
    if (!agentsDir) throw new Error("AgentManager requires agentsDir");
    this.agentsDir = agentsDir;
    this.indexPath = path.join(agentsDir, "index.json");
    this.defaultWorkspace = defaultWorkspace || process.cwd();
    this.mode = mode;
    this.policy = policy;
    this.maxAgents = maxAgents;
    this.providers = providers || { script_runner: scriptRunner };
    this.agents = new Map(); // agent_id -> meta
    this._runs = new Map(); // agent_id -> Promise
    this._cancelled = new Set();
  }

  async init() {
    await mkdir(this.agentsDir, { recursive: true });
    try {
      const list = JSON.parse(await readFile(this.indexPath, "utf8"));
      if (Array.isArray(list)) {
        for (const m of list) {
          // Anything left "running"/"queued" after a restart is interrupted.
          if (m && !TERMINAL_STATES.has(m.status)) {
            m.status = "failed";
            m.error = m.error || "interrupted by server restart";
          }
          if (m?.agent_id) this.agents.set(m.agent_id, m);
        }
      }
    } catch {
      /* no index yet */
    }
    return this;
  }

  _compact(meta) {
    return {
      agent_id: meta.agent_id,
      role: meta.role,
      title: meta.title,
      status: meta.status,
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

  async spawn({ role, title, task, workspace_root, max_runtime_ms, dry_run = false, provider = "script_runner" } = {}) {
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
      max_runtime_ms: Number(max_runtime_ms) || null,
      dry_run: Boolean(dry_run),
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
    meta.updated_at = isoNow();
    await this._saveIndex();
    const p = this._execute(meta).catch((err) => this._fail(meta, err));
    this._runs.set(meta.agent_id, p);
    return this._compact(meta);
  }

  async _execute(meta) {
    const provider = this.providers[meta.provider];
    const out = await provider.run(meta);
    if (this._cancelled.has(meta.agent_id)) {
      return this._finalizeCancelled(meta);
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

  async _finalizeCancelled(meta) {
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
