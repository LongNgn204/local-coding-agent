import assert from "node:assert/strict";
import test from "node:test";
import { PatchReviewError, PatchReviewService } from "../core/patch-review-service.mjs";

const diff = `--- a/demo.txt
+++ b/demo.txt
@@ -1 +1 @@
-old
+new
`;

test("patch review binds a validated diff to a one-time expiring ticket", () => {
  let now = Date.parse("2026-07-03T00:00:00.000Z");
  const service = new PatchReviewService({ now: () => now, ttlMs: 60_000 });
  const review = service.create({
    diff,
    preview: { ok: true, files: [{ path: "demo.txt", action: "update", ok: true }] },
    validation: { ok: true, conflicts: [] }
  });
  assert.equal(review.status, "ready");
  assert.match(review.diffSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(review, "diff"), false);

  const applying = service.beginApply(review.id);
  assert.equal(applying.diff, diff);
  assert.equal(applying.review.status, "applying");
  assert.throws(() => service.beginApply(review.id), /applying/);
  assert.equal(service.finishApply(review.id, { ok: true, result: { applied: 1 } }).status, "applied");
  assert.throws(() => service.beginApply(review.id), /applied/);

  const expiring = service.create({ diff, preview: { ok: true }, validation: { ok: true } });
  now += 61_000;
  assert.equal(service.get(expiring.id).status, "expired");
  assert.throws(() => service.beginApply(expiring.id), (error) => error instanceof PatchReviewError && error.status === 410);
  assert.throws(() => service.beginApply("patch_missing"), (error) => error instanceof PatchReviewError && error.status === 404);
});

test("patch review blocks conflicts, malformed diffs, and oversized input", () => {
  const service = new PatchReviewService({ maxBytes: 1_000, maxReportBytes: 1_000 });
  const blocked = service.create({
    diff,
    preview: { ok: false, files: [{ path: "demo.txt", conflict: "hunk did not match" }] },
    validation: { ok: false, conflicts: [{ path: "demo.txt", conflict: "hunk did not match" }] }
  });
  assert.equal(blocked.status, "blocked");
  assert.throws(() => service.beginApply(blocked.id), /blocked/);
  assert.throws(() => service.create({ diff: "not a diff", preview: {}, validation: {} }), /unified diff/);
  assert.throws(
    () => service.create({ diff: `${diff}${"x".repeat(2_000)}`, preview: {}, validation: {} }),
    (error) => error instanceof PatchReviewError && error.status === 413
  );
  assert.throws(
    () => service.create({ diff, preview: { ok: true, detail: "x".repeat(2_000) }, validation: { ok: true } }),
    (error) => error instanceof PatchReviewError && error.status === 502
  );
});
