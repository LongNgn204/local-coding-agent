// Local Coding Agent context-memory tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextMemory, contextPressure, sanitizeContextInput } from "./context-memory.mjs";

test("sanitizeContextInput redacts common credentials and bounds payloads", () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const { context, redactions } = sanitizeContextInput({
    goal: "Continue release work",
    summary: `API key: ${secret}\n${"x".repeat(10_000)}`,
    decisions: ["Keep stable public"],
    open_tasks: ["Run tests"]
  });
  assert.equal(context.summary.includes(secret), false);
  assert.match(context.summary, /REDACTED_OPENAI_KEY/);
  assert.ok(context.summary.length <= 4_000);
  assert.ok(redactions >= 1);
});

test("ContextMemory writes immutable checkpoints, resumes latest, and prunes old entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-context-"));
  try {
    const memory = new ContextMemory({
      dir,
      releaseVersion: "4.4.3",
      workspace: { id: "test", primary_root: dir, roots: [dir], mode: "safe", policy: "balanced" },
      maxCheckpoints: 2
    });
    await memory.init();
    for (let i = 1; i <= 3; i++) {
      await memory.compact({
        goal: `Goal ${i}`,
        summary: `Summary ${i}`,
        next_action: `Next ${i}`
      }, {
        activity: { total_calls: i, est_tokens_total: i * 100 },
        recent_tests: [{ command: "api_key=evidence-secret-value" }]
      });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    assert.equal(files.length, 2);
    assert.equal((await memory.latest()).context.goal, "Goal 3");
    assert.equal(JSON.stringify(await memory.latest()).includes("evidence-secret-value"), false);
    assert.equal((await memory.list()).length, 2);
    const raw = await readFile(path.join(dir, files[0]), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contextPressure is explicit, bounded, and recommends compaction", () => {
  const light = contextPressure({
    baseline: { total_calls: 10, est_tokens_total: 1_000 },
    current: { total_calls: 15, est_tokens_total: 5_000 }
  });
  assert.equal(light.recommendation, "continue");
  assert.ok(light.health_score > 65);

  const heavy = contextPressure({
    baseline: { total_calls: 0, est_tokens_total: 0 },
    current: { total_calls: 150, est_tokens_total: 120_000 }
  });
  assert.equal(heavy.health_score, 0);
  assert.equal(heavy.recommendation, "compact_now");
  assert.match(heavy.disclaimer, /cannot read ChatGPT Web/);
});
