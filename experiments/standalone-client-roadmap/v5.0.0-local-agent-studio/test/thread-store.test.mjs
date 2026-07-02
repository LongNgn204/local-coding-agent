import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThreadStore } from "../core/thread-store.mjs";

test("thread store persists threads, turns, and ordered items", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-studio-store-"));
  const file = join(dir, "studio.db");
  try {
    let store = new ThreadStore(file);
    const thread = store.createThread({ title: "  Fix   checkout bug  ", provider: "openai", model: "test-model", workspace: "C:/repo" });
    const turn = store.startTurn(thread.id, { provider: "openai", model: "test-model", toolPolicy: "workspace" });
    store.appendItem(thread.id, { turnId: turn.id, role: "user", content: "Inspect the bug" });
    store.appendItem(thread.id, { turnId: turn.id, type: "tool", content: "ok", metadata: { tool: "workspace_info", policy: "workspace", level: "read", ms: 8 } });
    store.appendItem(thread.id, { turnId: turn.id, role: "assistant", content: "Done" });
    const pending = store.startTurn(thread.id);
    assert.equal(store.getActiveTurn(thread.id).id, pending.id);
    store.setSummary(thread.id, "Earlier work summary", { throughSeq: 2 });
    store.finishTurn(turn.id);
    store.close();

    store = new ThreadStore(file);
    assert.equal(store.getThread(thread.id).title, "Fix checkout bug");
    assert.equal(store.getThread(thread.id).summary, "Earlier work summary");
    assert.equal(store.getThread(thread.id).summarySeq, 2);
    assert.equal(store.getTurn(turn.id).toolPolicy, "workspace");
    const turns = store.listTurns(thread.id);
    assert.equal(turns.length, 2);
    assert.equal(turns.find((entry) => entry.id === turn.id)?.toolPolicy, "workspace");
    assert.equal(store.getTurn(pending.id).status, "interrupted");
    assert.deepEqual(store.recentMessages(thread.id).map((item) => item.content), ["Inspect the bug", "Done"]);
    assert.deepEqual(store.messagesAfter(thread.id, 1).map((item) => item.content), ["Done"]);
    assert.deepEqual(store.listItems(thread.id).map((item) => item.seq), [1, 2, 3]);
    assert.equal(store.listItems(thread.id)[1].metadata.policy, "workspace");
    assert.equal(store.listThreads()[0].id, thread.id);
    store.archiveThread(thread.id);
    assert.equal(store.listThreads().length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
