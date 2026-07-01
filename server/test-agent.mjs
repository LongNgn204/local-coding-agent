// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = process.env.TEST_ENDPOINT || "http://127.0.0.1:8787/mcp";
const client = new Client({ name: "agent-test-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

let pass = 0;
let fail = 0;

async function call(name, args, { expectError = false } = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  const isError = Boolean(result.isError);
  const ok = expectError ? isError : !isError;
  if (ok) pass++;
  else fail++;
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name} ${expectError ? "(expected error)" : ""}`);
  console.log(text.slice(0, 600));
  return text;
}

await call("workspace_info", {});
await call("write_file", { path: "demo/hello.js", content: 'console.log("hello from local coding agent");\n' });
await call("read_file", { path: "demo/hello.js" });
await call("read_file", { path: "demo/hello.js", start_line: 1, line_count: 1 });
await call("replace_in_file", { path: "demo/hello.js", old_text: "hello from", new_text: "hi from" });
await call("apply_patch", {
  operations: [
    { op: "create", path: "demo/pkg/util.js", content: "export const sum = (a, b) => a + b;\n" },
    { op: "update", path: "demo/hello.js", edits: [{ old_text: "hi from", new_text: "greetings from" }] }
  ]
});
await call("make_dir", { path: "demo/newdir" });
await call("stat_path", { path: "demo/hello.js" });
await call("search_text", { query: "greetings", path: "demo" });
await call("list_files", { path: "demo", recursive: true });
await call("read_many", { paths: ["demo/hello.js", "demo/pkg/util.js", "demo/does-not-exist.js"] });
await call("read_many", {
  requests: [
    { path: "demo/hello.js", start_line: 1, line_count: 1, max_chars: 500 },
    { path: "demo/pkg/util.js", max_chars: 500 }
  ],
  concurrency: 2
});
await call("repo_overview", { path: ".", depth: 3 });
await call("move_path", { from: "demo/newdir", to: "demo/renamed" });
await call("run_command", { command: "node demo/hello.js", timeout_ms: 10000 });
await call("run_commands", {
  commands: [
    { command: "node --version", timeout_ms: 10000 },
    { command: "git --version", timeout_ms: 10000 }
  ]
});
await call("list_skills", {});
await call("read_skill", { name: "code-review" });
await call("create_skill", {
  name: "demo-skill",
  description: "Temporary skill created by the regression test.",
  body: "# Demo Skill\n\nUse only for regression tests.\n"
});
await call("read_skill", { name: "demo-skill" });
await call("delete_skill", { name: "demo-skill" });

// background process: short ticker
const startText = await call("proc_start", {
  command: "node -e \"setInterval(()=>console.log('tick'),200)\"",
  name: "ticker"
});
const id = JSON.parse(startText).id;
await new Promise((r) => setTimeout(r, 700));
await call("proc_list", {});
await call("proc_output", { id });
await call("proc_stop", { id });

// git (exercise; --version always works)
await call("git", { args: ["--version"] });

// safety: a path escaping the roots must error
await call("read_file", { path: "../../../etc/passwd" }, { expectError: true });

// cleanup
await call("delete_path", { path: "demo/renamed", recursive: true });
await call("delete_path", { path: "demo/pkg", recursive: true });
await call("delete_path", { path: "demo/hello.js" });

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
