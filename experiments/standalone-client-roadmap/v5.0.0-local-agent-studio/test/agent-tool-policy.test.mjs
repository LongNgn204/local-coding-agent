import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAgentTool, normalizeAgentToolPolicy } from "../core/agent-tool-policy.mjs";

test("agent tool policy defaults to read-only and honors MCP annotations", () => {
  assert.equal(evaluateAgentTool({ name: "read_file" }).allowed, true);
  assert.equal(evaluateAgentTool({ name: "unknown_report", annotations: { readOnlyHint: true } }).allowed, true);
  assert.equal(evaluateAgentTool({ name: "write_file" }).allowed, false);
  assert.equal(evaluateAgentTool({ name: "run_command" }).allowed, false);
  assert.equal(evaluateAgentTool({ name: "get_shell", annotations: { readOnlyHint: true, destructiveHint: true } }).allowed, false);
});

test("workspace policy allows scoped edits but blocks commands and destructive hints", () => {
  assert.equal(evaluateAgentTool({ name: "apply_patch" }, "workspace").allowed, true);
  assert.equal(evaluateAgentTool({ name: "run_command" }, "workspace").allowed, false);
  assert.equal(evaluateAgentTool({ name: "write_file", annotations: { destructiveHint: true } }, "workspace").allowed, false);
});

test("full policy allows commands only after explicit mode selection", () => {
  assert.equal(evaluateAgentTool({ name: "run_command" }, "full").allowed, true);
  assert.throws(() => normalizeAgentToolPolicy("bypass"), /Unsupported agent tool policy/);
});
