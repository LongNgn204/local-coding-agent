import assert from "node:assert/strict";
import test from "node:test";
import { TurnManager } from "../core/turn-manager.mjs";

test("turn manager buffers events, replays by sequence, and settles once", async () => {
  let time = Date.parse("2026-07-02T00:00:00.000Z");
  const manager = new TurnManager({ now: () => time++ });
  manager.create({ id: "turn_1", threadId: "thr_1", provider: "openai", model: "test" });
  manager.emit("turn_1", "turn.started", { phase: "context" });
  manager.emit("turn_1", "agent.status", { message: "Inspecting" });
  const replay = [];
  manager.subscribe("turn_1", (event) => replay.push(event), { after: 1 });
  assert.deepEqual(replay.map((event) => event.type), ["agent.status"]);

  manager.complete("turn_1", { text: "Done" });
  const settled = await manager.wait("turn_1");
  assert.equal(settled.status, "completed");
  assert.equal(settled.result.text, "Done");
  assert.equal(manager.get("turn_1").lastSeq, 3);
  assert.deepEqual(manager.getEvents("turn_1", { after: 2 }).map((event) => event.type), ["turn.completed"]);
  assert.equal(manager.complete("turn_1", { text: "ignored" }).status, "completed");
});

test("turn cancellation aborts the shared signal and emits terminal state", async () => {
  const manager = new TurnManager();
  manager.create({ id: "turn_cancel", threadId: "thr_1" });
  const internal = manager.require("turn_cancel");
  manager.requestCancel("turn_cancel");
  assert.equal(internal.controller.signal.aborted, true);
  assert.equal(manager.get("turn_cancel").status, "cancelling");
  manager.cancelled("turn_cancel");
  const settled = await manager.wait("turn_cancel");
  assert.equal(settled.status, "cancelled");
  assert.deepEqual(manager.getEvents("turn_cancel").map((event) => event.type), [
    "turn.cancel_requested",
    "turn.cancelled"
  ]);
});
