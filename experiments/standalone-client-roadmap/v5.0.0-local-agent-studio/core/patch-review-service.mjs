import { createHash, randomUUID } from "node:crypto";

export class PatchReviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PatchReviewError";
    this.status = status;
  }
}

export class PatchReviewService {
  constructor({ now = () => Date.now(), ttlMs = 10 * 60_000, maxBytes = 500_000, maxReportBytes = 200_000, maxReviews = 20 } = {}) {
    this.now = now;
    this.ttlMs = Math.max(10_000, Number(ttlMs) || 10 * 60_000);
    this.maxBytes = Math.max(1_000, Number(maxBytes) || 500_000);
    this.maxReportBytes = Math.max(1_000, Number(maxReportBytes) || 200_000);
    this.maxReviews = Math.max(1, Number(maxReviews) || 20);
    this.reviews = new Map();
  }

  validateDraft(diff) {
    const text = String(diff || "");
    const bytes = Buffer.byteLength(text, "utf8");
    if (!text.trim()) throw new PatchReviewError("Unified diff is required.");
    if (bytes > this.maxBytes) throw new PatchReviewError(`Unified diff exceeds ${this.maxBytes} bytes.`, 413);
    if (!/^---\s+\S+/m.test(text) || !/^\+\+\+\s+\S+/m.test(text) || !/^@@/m.test(text)) {
      throw new PatchReviewError("Patch must contain unified diff file headers and at least one hunk.");
    }
    return { text, bytes, diffSha256: createHash("sha256").update(text).digest("hex") };
  }

  create({ diff, preview, validation }) {
    const draft = this.validateDraft(diff);
    const previewReport = cloneBounded(preview || {}, "Patch preview", this.maxReportBytes);
    const validationReport = cloneBounded(validation || {}, "Patch validation", this.maxReportBytes);
    this.prune();
    const createdAtMs = this.now();
    const ready = previewReport.ok === true && validationReport.ok === true;
    const review = {
      id: `patch_${randomUUID().replaceAll("-", "")}`,
      diff: draft.text,
      diffSha256: draft.diffSha256,
      bytes: draft.bytes,
      status: ready ? "ready" : "blocked",
      preview: previewReport,
      validation: validationReport,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
      result: null,
      error: null
    };
    this.reviews.set(review.id, review);
    this.prune();
    return this.publicReview(review);
  }

  get(id) {
    const review = this.reviews.get(String(id || ""));
    if (!review) return null;
    this.expire(review);
    return this.publicReview(review);
  }

  beginApply(id) {
    const review = this.require(id);
    this.expire(review);
    if (review.status !== "ready") {
      const status = review.status === "expired" ? 410 : 409;
      throw new PatchReviewError(`Patch review is ${review.status}; create a new successful preview.`, status);
    }
    review.status = "applying";
    return { diff: review.diff, review: this.publicReview(review) };
  }

  finishApply(id, { ok, result = null, error = null } = {}) {
    const review = this.require(id);
    if (review.status !== "applying") throw new PatchReviewError(`Patch review is not applying: ${review.status}`, 409);
    const resultReport = cloneBounded(result, "Patch result", this.maxReportBytes);
    review.status = ok ? "applied" : "failed";
    review.result = resultReport;
    review.error = error ? String(error) : null;
    return this.publicReview(review);
  }

  summary() {
    this.prune();
    const reviews = [...this.reviews.values()];
    return {
      active: reviews.filter((review) => ["ready", "blocked", "applying"].includes(review.status)).length,
      ready: reviews.filter((review) => review.status === "ready").length,
      maxBytes: this.maxBytes,
      maxReportBytes: this.maxReportBytes,
      ttlMs: this.ttlMs
    };
  }

  publicReview(review) {
    return {
      id: review.id,
      diffSha256: review.diffSha256,
      bytes: review.bytes,
      status: review.status,
      createdAt: review.createdAt,
      expiresAt: review.expiresAt,
      preview: clone(review.preview),
      validation: clone(review.validation),
      result: clone(review.result),
      error: review.error
    };
  }

  require(id) {
    const review = this.reviews.get(String(id || ""));
    if (!review) throw new PatchReviewError("Patch review not found or already pruned.", 404);
    return review;
  }

  expire(review) {
    if (["ready", "blocked"].includes(review.status) && Date.parse(review.expiresAt) <= this.now()) {
      review.status = "expired";
    }
  }

  prune() {
    for (const review of this.reviews.values()) this.expire(review);
    while (this.reviews.size > this.maxReviews) {
      const removable = [...this.reviews.values()].find((review) => review.status !== "applying");
      if (!removable) break;
      this.reviews.delete(removable.id);
    }
  }
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function cloneBounded(value, label, maxBytes) {
  if (value == null) return value;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new PatchReviewError(`${label} is not valid JSON.`, 502);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new PatchReviewError(`${label} exceeds ${maxBytes} bytes.`, 502);
  }
  return JSON.parse(serialized);
}
