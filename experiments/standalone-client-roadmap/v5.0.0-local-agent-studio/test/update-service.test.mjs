import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createUpdateEnvelope, UpdateService } from "../core/update-service.mjs";

const manifest = {
  productName: "Local Agent Studio",
  version: "v5.0.0",
  buildNumber: 500000,
  channel: "local-agent-studio",
  releaseStage: "stable"
};

test("update service verifies signed manifests and persists rollback guard", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const storage = mkdtempSync(join(tmpdir(), "lca-update-"));
  try {
    const service = new UpdateService({
      storageDir: storage,
      manifest,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      now: () => Date.parse("2026-07-02T00:00:00.000Z")
    });
    const envelope = createUpdateEnvelope({
      payload: updatePayload({ buildNumber: 500100, version: "v5.0.1" }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    });
    const verified = service.verifyEnvelope(envelope);
    assert.equal(verified.verified, true);
    assert.equal(verified.update.available, true);
    assert.equal(service.status().highestVerifiedBuild, 500100);

    const older = createUpdateEnvelope({
      payload: updatePayload({ buildNumber: 500050, version: "v5.0.0+rollback" }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    });
    assert.throws(() => service.verifyEnvelope(older), /roll back/);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test("update service rejects tampered signatures and unsafe artifacts", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const storage = mkdtempSync(join(tmpdir(), "lca-update-tamper-"));
  try {
    const service = new UpdateService({
      storageDir: storage,
      manifest,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" })
    });
    const envelope = createUpdateEnvelope({
      payload: updatePayload({ buildNumber: 500100, version: "v5.0.1" }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    });
    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
    decoded.artifacts[0].url = "https://example.com/evil.exe";
    envelope.payload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    assert.throws(() => service.verifyEnvelope(envelope), /signature is invalid/);

    assert.throws(() => createUpdateEnvelope({
      payload: updatePayload({ buildNumber: 500200, version: "v5.0.2", url: "http://example.com/app.exe" }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    }), /must use HTTPS/);

    const requiresNewerApp = createUpdateEnvelope({
      payload: updatePayload({ buildNumber: 500300, version: "v5.0.3", minAppVersion: "v6.0.0" }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    });
    assert.throws(() => service.verifyEnvelope(requiresNewerApp), /requires app v6\.0\.0/);

    const missingPlatformPolicy = createUpdateEnvelope({
      payload: updatePayload({ buildNumber: 500400, version: "v5.0.4", signature: null }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    });
    assert.throws(() => service.verifyEnvelope(missingPlatformPolicy), /require a platform signature policy/);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test("update service streams, hashes, and stages a signed artifact without executing it", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const storage = mkdtempSync(join(tmpdir(), "lca-update-stage-"));
  const bytes = Buffer.from("verified update artifact bytes");
  const signatureCalls = [];
  try {
    const service = new UpdateService({
      storageDir: storage,
      manifest,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      signatureVerifier: {
        verify: async (request) => {
          signatureCalls.push(request);
          return { required: true, verified: true, platform: request.platform, type: "authenticode" };
        }
      }
    });
    const envelope = createUpdateEnvelope({
      payload: updatePayload({
        buildNumber: 500100,
        version: "v5.0.1",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    });
    const staged = await service.stageArtifact(envelope, {
      platform: "win32",
      arch: "x64",
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: (name) => name === "content-length" ? String(bytes.length) : null },
        body: Readable.from([bytes.subarray(0, 7), bytes.subarray(7)])
      })
    });
    assert.equal(staged.verified, true);
    assert.equal(staged.installReady, false);
    assert.equal(staged.platformSignature.verified, true);
    assert.equal(signatureCalls.length, 1);
    assert.equal(signatureCalls[0].file.includes(".partial-"), true);
    assert.equal(readFileSync(staged.path).equals(bytes), true);
    assert.equal(service.status().lastVerified.buildNumber, 500100);
    assert.equal(service.readState().lastStaged.installReady, false);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test("update staging rejects an invalid platform signature and removes the artifact", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const storage = mkdtempSync(join(tmpdir(), "lca-update-signature-fail-"));
  const bytes = Buffer.from("correctly hashed but unsigned artifact");
  try {
    const service = new UpdateService({
      storageDir: storage,
      manifest,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      signatureVerifier: { verify: async () => { throw new Error("Authenticode signature is not valid: NotSigned."); } }
    });
    const envelope = createUpdateEnvelope({
      payload: updatePayload({
        buildNumber: 500100,
        version: "v5.0.1",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    });

    await assert.rejects(() => service.stageArtifact(envelope, {
      platform: "win32",
      arch: "x64",
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => String(bytes.length) },
        body: Readable.from([bytes])
      })
    }), /NotSigned/);

    const dir = join(storage, "updates", "staging");
    assert.equal(readdirSync(dir).length, 0);
    assert.equal(service.readState().lastStaged, undefined);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test("update staging rejects hash mismatch and removes partial files", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const storage = mkdtempSync(join(tmpdir(), "lca-update-stage-fail-"));
  const bytes = Buffer.from("tampered artifact");
  try {
    const service = new UpdateService({
      storageDir: storage,
      manifest,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" })
    });
    const envelope = createUpdateEnvelope({
      payload: updatePayload({ buildNumber: 500100, version: "v5.0.1", size: bytes.length, sha256: "b".repeat(64) }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
    });
    await assert.rejects(() => service.stageArtifact(envelope, {
      platform: "win32",
      arch: "x64",
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => String(bytes.length) },
        body: Readable.from([bytes])
      })
    }), /SHA-256/);
    const dir = join(storage, "updates", "staging");
    assert.equal(existsSync(dir), true);
    assert.equal(readdirSync(dir).some((name) => name.includes(".partial-")), false);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

function updatePayload({
  buildNumber,
  version,
  url = "https://downloads.example.com/LocalAgentStudio.exe",
  sha256 = "a".repeat(64),
  size = 123456,
  minAppVersion = "v5.0.0",
  signature = {
    type: "authenticode",
    publisher: "Local Coding Agent",
    thumbprints: ["A1".repeat(20)]
  }
}) {
  return {
    channel: "local-agent-studio",
    version,
    buildNumber,
    minAppVersion,
    publishedAt: "2026-07-02T00:00:00.000Z",
    releaseNotesUrl: "https://github.com/LongNgn204/local-coding-agent/releases",
    artifacts: [{
      platform: "win32",
      arch: "x64",
      url,
      sha256,
      size,
      signature
    }]
  };
}
