import assert from "node:assert/strict";
import test from "node:test";
import { compactContext } from "../core/context-compactor.mjs";

test("context compactor keeps recent messages and advances summary sequence", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `item_${index + 1}`,
    seq: index + 1,
    role: index % 2 ? "assistant" : "user",
    content: `message ${index + 1} ${"x".repeat(900)}`
  }));
  const result = compactContext({
    thread: { summary: "Existing summary", summarySeq: 0 },
    messages,
    maxChars: 6_000,
    minRecent: 4
  });
  assert.ok(result.stats.omittedMessages > 0);
  assert.ok(result.history.length >= 4);
  assert.equal(result.history.at(-1).seq, 20);
  assert.ok(result.summary.includes("Existing summary"));
  assert.ok(result.summarySeq < result.history[0].seq);
  assert.ok(result.stats.outputChars < result.stats.inputChars);
});

test("context compactor bounds oversized individual messages", () => {
  const huge = "A".repeat(50_000);
  const result = compactContext({
    messages: [{ id: "one", seq: 1, role: "user", content: huge }],
    itemMaxChars: 2_000,
    minRecent: 1
  });
  assert.ok(result.history[0].content.length <= 2_050);
  assert.match(result.history[0].content, /content compacted/);
  assert.equal(result.stats.truncatedMessages, 1);
});
