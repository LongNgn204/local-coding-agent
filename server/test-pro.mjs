// Local Coding Agent Pro regression tests
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = process.env.TEST_ENDPOINT || "http://127.0.0.1:8787/mcp";
const client = new Client({ name: "agent-pro-test-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
await client.connect(transport);

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function callJson(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

try {
  await callJson("write_file", {
    path: "package.json",
    content: JSON.stringify({ scripts: { test: "node --version", build: "node --version", lint: "node --version", typecheck: "node --version" }, dependencies: { express: "^4.0.0" } }, null, 2)
  });
  await callJson("write_file", { path: "README.md", content: "# Pro workspace\n" });
  await callJson("write_file", { path: "src/index.js", content: "export function hello(){ return 'pro'; }\n" });

  const info = await callJson("workspace_info");
  check("workspace_info exposes pro tier", info.tier === "pro", `tier=${info.tier}`);
  check("workspace_info exposes policy", typeof info.policy === "string" && info.policy.length > 0);

  const contextBefore = await callJson("context_status");
  check("context_status identifies MCP-only estimate", typeof contextBefore.disclaimer === "string" && contextBefore.disclaimer.includes("actual context window"));
  const compact = await callJson("compact_context", {
    goal: "Verify stable compact and resume",
    summary: "The Pro fixture is ready. api_key=super-secret-context-test-value",
    decisions: ["Keep the checkpoint local"],
    constraints: ["Do not include private release channels"],
    completed: ["Created the isolated fixture"],
    open_tasks: ["Run the Pro suite"],
    next_action: "Continue the Pro checks",
    files_touched: ["package.json", "README.md", "src/index.js"]
  });
  check("compact_context creates a checkpoint", compact.ok === true && /^ctx_[0-9a-f]{16}$/.test(compact.checkpoint_id));
  const resumed = await callJson("resume_context");
  check("resume_context restores structured state", resumed.kind === "chatgpt_web_context_checkpoint" && resumed.context?.next_action === "Continue the Pro checks");
  check("compact_context redacts secrets", JSON.stringify(resumed).includes("super-secret-context-test-value") === false && Number(resumed.privacy?.redactions) >= 1);

  const snap = await callJson("workspace_snapshot", { depth: 3, max_entries: 120, include_symbols: true, refresh: true });
  check("snapshot kind is workspace_snapshot", snap.kind === "workspace_snapshot");
  check("snapshot is pro", snap.pro === true && snap.tier === "pro");
  check("snapshot version is 4.4.3", snap.version === "4.4.3", `version=${snap.version}`);
  check("snapshot includes safety model", snap.safety?.file_tools_root_confined === true && snap.safety?.command_os_sandbox === false);
  check("snapshot detects javascript", snap.profile?.languages?.includes("javascript"), JSON.stringify(snap.profile));
  check("snapshot detects test command", snap.commands?.test === "npm test", JSON.stringify(snap.commands));
  check("snapshot includes important files", snap.important_files?.some((f) => f.path === "README.md"));
  check("snapshot includes tree entries", snap.tree?.entries?.includes("src/index.js"));
  check("snapshot includes symbols when requested", snap.symbols?.some((s) => s.name === "hello"));
  check("snapshot includes health score", Number.isInteger(snap.health?.score) && snap.health.score >= 0 && snap.health.score <= 100);
  check("snapshot includes next actions", Array.isArray(snap.next_best_actions) && snap.next_best_actions.length > 0);

  const doctor = await callJson("workspace_doctor", {});
  check("doctor returns score", Number.isInteger(doctor.score) && doctor.score >= 0 && doctor.score <= 100);
  check("doctor checks policy", doctor.checks?.some((c) => c.id === "policy"));
  check("doctor checks commands", doctor.checks?.some((c) => c.id === "commands" && c.status === "pass"));

  const gatePlan = await callJson("quality_gate", { dry_run: true });
  check("quality_gate dry run plans gates", gatePlan.dry_run === true && gatePlan.plan?.some((g) => g.name === "test"));
  check("quality_gate dry run detects typecheck", gatePlan.plan?.some((g) => g.name === "typecheck" && g.command === "npm run typecheck"));

  const gateRun = await callJson("quality_gate", { include: ["lint", "typecheck", "test", "build"], timeout_ms: 30000, stop_on_failure: true });
  check("quality_gate run passes", gateRun.ok === true, JSON.stringify(gateRun.gates));
  check("quality_gate ran four gates", gateRun.ran === 4, JSON.stringify(gateRun));

  const report = await callJson("session_report", {});
  check("session_report kind", report.kind === "session_report");
  check("session_report exposes doctor summary", report.doctor?.summary && Number.isInteger(report.doctor.score));
  check("session_report exposes metrics", Number.isInteger(report.metrics?.total_calls));

  if (process.env.DASHBOARD_PORT && process.env.DASHBOARD_PORT !== "0") {
    const metricsRes = await fetch(`http://127.0.0.1:${process.env.DASHBOARD_PORT}/metrics`);
    const metrics = await metricsRes.json();
    check("metrics exposes pro tier", metrics.tier === "pro");
    check("metrics exposes health score", Number.isInteger(metrics.health_score));
  } else {
    check("metrics skipped when dashboard disabled", true);
  }
} finally {
  await client.close();
}

console.log(`\n==== PRO RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
