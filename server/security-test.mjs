// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Security regression tests. Run against a server started on a NON-git scratch
// workspace in safe mode:
//   TEST_ENDPOINT=http://127.0.0.1:8799/mcp AUDIT_LOG=<server>/data/audit.log \
//     node security-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";

const ENDPOINT = process.env.TEST_ENDPOINT || "http://127.0.0.1:8799/mcp";
const AUDIT_LOG = process.env.AUDIT_LOG || "";
const client = new Client({ name: "sec-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)));

let pass = 0, fail = 0;
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content?.[0]?.text ?? "", isError: Boolean(r.isError) };
}
function check(label, cond) {
  if (cond) { pass++; console.log("[PASS]", label); }
  else { fail++; console.log("[FAIL]", label); }
}

// 1. Path escape via .. must be blocked.
check("path traversal blocked", (await call("read_file", { path: "../../../etc/passwd" })).isError);

// 2. Dangerous git flag --output blocked (write-file escape).
check("git --output blocked", (await call("git", { args: ["diff", "--output=../escape.txt"] })).isError);

// 3. git -c (config injection / pager exec) blocked.
check("git -c blocked", (await call("git", { args: ["-c", "core.pager=calc", "log"] })).isError);

// 4. Mutating git blocked in safe mode.
check("git restore blocked (safe)", (await call("git", { args: ["restore", "."] })).isError);

// 5. Non-git workspace reported honestly (not "clean").
const gs = JSON.parse((await call("git_status", {})).text);
check("git_status non-repo -> is_git_repo:false", gs.is_git_repo === false);

// 6. Audit redaction: a secret in apply_patch content must NOT appear in audit.log.
const SENTINEL = "SENTINEL_SECRET_" + "abc123XYZ";
await call("apply_patch", { operations: [{ op: "create", path: "sec-tmp.txt", content: `API_KEY=${SENTINEL}` }] });
await call("delete_path", { path: "sec-tmp.txt" });
if (AUDIT_LOG) {
  let audit = "";
  try { audit = readFileSync(AUDIT_LOG, "utf8"); } catch {}
  check("audit log does NOT contain the secret", audit.length > 0 && !audit.includes(SENTINEL));
} else {
  console.log("[skip] audit-file check (set AUDIT_LOG to enable)");
}

console.log(`\n==== SECURITY: ${pass} passed, ${fail} failed ====`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
