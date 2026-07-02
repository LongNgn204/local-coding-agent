import { createHash, sign, verify } from "node:crypto";
import { once } from "node:events";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

const MAX_ARTIFACT_BYTES = 5_000_000_000;
const ALLOWED_EXTENSIONS = new Set([".exe", ".msi", ".zip", ".dmg", ".pkg", ".appimage", ".deb", ".rpm"]);

export class UpdateService {
  constructor({ storageDir, manifest, publicKeyPem = "", now = () => Date.now() }) {
    this.stateFile = join(storageDir, "update-state.json");
    this.stagingDir = join(storageDir, "updates", "staging");
    this.manifest = manifest;
    this.publicKeyPem = publicKeyPem;
    this.now = now;
    this.preview = manifest.releaseStage !== "stable";
  }

  status() {
    const state = this.readState();
    return {
      enabled: Boolean(this.publicKeyPem),
      mode: this.preview ? "preview" : "enforced",
      currentVersion: this.manifest.version,
      currentBuild: currentBuildNumber(this.manifest),
      channel: this.manifest.channel || "local-agent-studio",
      highestVerifiedBuild: state.highestVerifiedBuild || currentBuildNumber(this.manifest),
      lastVerified: state.lastVerified || null,
      lastStaged: publicStagedState(state.lastStaged),
      reason: this.publicKeyPem
        ? "Signed update manifest verification is available."
        : "No update verification key is configured."
    };
  }

  verifyEnvelope(envelope, { persist = true } = {}) {
    if (!this.publicKeyPem) throw new Error("Update verification key is not configured.");
    const { payload, payloadBytes } = parseEnvelope(envelope);
    validateUpdatePayload(payload, this.manifest);
    if (!envelope.signature) throw new Error("Update manifest signature is missing.");
    const signature = Buffer.from(envelope.signature, "base64url");
    if (!verify(null, payloadBytes, this.publicKeyPem, signature)) {
      throw new Error("Update manifest signature is invalid.");
    }
    const state = this.readState();
    const currentBuild = currentBuildNumber(this.manifest);
    const highest = Number(state.highestVerifiedBuild || currentBuild);
    if (payload.buildNumber < currentBuild) {
      throw new Error("Update manifest build is older than this app.");
    }
    if (payload.buildNumber < highest) {
      throw new Error("Update manifest would roll back a previously verified build.");
    }
    if (payload.minAppVersion && compareVersions(this.manifest.version, payload.minAppVersion) < 0) {
      throw new Error(`Update requires app ${payload.minAppVersion} or newer.`);
    }
    const publicPayload = publicUpdatePayload(payload, currentBuild);
    if (persist) {
      this.writeState({
        ...state,
        highestVerifiedBuild: Math.max(highest, payload.buildNumber),
        lastVerified: {
          at: new Date(this.now()).toISOString(),
          version: payload.version,
          buildNumber: payload.buildNumber,
          channel: payload.channel,
          artifactCount: payload.artifacts.length,
          available: publicPayload.available
        }
      });
    }
    return {
      ok: true,
      verified: true,
      mode: this.preview ? "preview" : "enforced",
      update: publicPayload
    };
  }

  async stageArtifact(envelope, {
    platform = process.platform,
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10 * 60_000
  } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("Update download requires fetch support.");
    const verified = this.verifyEnvelope(envelope, { persist: true });
    if (!verified.update.available) throw new Error("Signed update manifest does not contain a newer build.");
    const artifact = verified.update.artifacts.find((item) => item.platform === platform && item.arch === arch);
    if (!artifact) throw new Error(`Signed update manifest has no artifact for ${platform}-${arch}.`);
    const finalName = stagedFileName(verified.update.version, verified.update.buildNumber, artifact.url);
    await mkdir(this.stagingDir, { recursive: true });
    const finalPath = join(this.stagingDir, finalName);
    const tempPath = `${finalPath}.partial-${process.pid}-${Date.now()}`;
    try {
      const response = await fetchImpl(artifact.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/octet-stream" }
      });
      if (!response?.ok) throw new Error(`Update artifact download failed (${response?.status || "network"}).`);
      const finalUrl = String(response.url || artifact.url);
      if (!finalUrl.toLowerCase().startsWith("https://")) throw new Error("Update artifact redirect must remain HTTPS.");
      const contentLength = Number(response.headers?.get?.("content-length") || 0);
      if (contentLength && contentLength !== artifact.size) throw new Error("Update artifact Content-Length does not match signed manifest size.");
      if (!response.body) throw new Error("Update artifact response body is missing.");
      const downloaded = await writeVerifiedStream(response.body, tempPath, artifact);
      await rm(finalPath, { force: true });
      await rename(tempPath, finalPath);
      const state = this.readState();
      this.writeState({
        ...state,
        lastStaged: {
          at: new Date(this.now()).toISOString(),
          version: verified.update.version,
          buildNumber: verified.update.buildNumber,
          platform,
          arch,
          path: finalPath,
          sha256: downloaded.sha256,
          size: downloaded.size,
          installReady: false
        }
      });
      return {
        ok: true,
        verified: true,
        installReady: false,
        path: finalPath,
        version: verified.update.version,
        buildNumber: verified.update.buildNumber,
        platform,
        arch,
        sha256: downloaded.sha256,
        size: downloaded.size,
        reason: "Artifact is staged and verified but will not be executed automatically."
      };
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  readState() {
    if (!existsSync(this.stateFile)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  writeState(state) {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    try { chmodSync(this.stateFile, 0o600); } catch {}
  }
}

export function createUpdateEnvelope({ payload, privateKeyPem = "" }) {
  const normalized = normalizePayload(payload);
  const payloadBytes = Buffer.from(JSON.stringify(normalized));
  return {
    payload: payloadBytes.toString("base64url"),
    signature: privateKeyPem ? sign(null, payloadBytes, privateKeyPem).toString("base64url") : null
  };
}

export function loadUpdatePublicKey(appDir) {
  if (process.env.LCA_UPDATE_PUBLIC_KEY_PEM) return process.env.LCA_UPDATE_PUBLIC_KEY_PEM;
  if (process.env.LCA_RELEASE_PUBLIC_KEY_PEM) return process.env.LCA_RELEASE_PUBLIC_KEY_PEM;
  const updateFile = join(appDir, "update-public-key.pem");
  if (existsSync(updateFile)) return readFileSync(updateFile, "utf8");
  const releaseFile = join(appDir, "release-public-key.pem");
  return existsSync(releaseFile) ? readFileSync(releaseFile, "utf8") : "";
}

export function parseEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new Error("Update manifest envelope is required.");
  const payloadBytes = Buffer.from(String(envelope.payload || ""), "base64url");
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("Update manifest payload is invalid.");
  }
  return { payload, payloadBytes };
}

function normalizePayload(payload) {
  const candidate = {
    schemaVersion: 1,
    product: "local-agent-studio",
    ...payload
  };
  validateUpdatePayload(candidate, { channel: candidate.channel || "local-agent-studio", version: candidate.minAppVersion || "v0.0.0", buildNumber: 0 });
  return {
    schemaVersion: 1,
    product: "local-agent-studio",
    channel: candidate.channel,
    version: candidate.version,
    buildNumber: candidate.buildNumber,
    minAppVersion: candidate.minAppVersion || null,
    publishedAt: candidate.publishedAt || new Date().toISOString(),
    releaseNotesUrl: candidate.releaseNotesUrl || "",
    artifacts: candidate.artifacts.map((artifact) => ({
      platform: artifact.platform,
      arch: artifact.arch,
      url: artifact.url,
      sha256: artifact.sha256.toLowerCase(),
      size: Number(artifact.size || 0)
    })).sort((a, b) => `${a.platform}-${a.arch}`.localeCompare(`${b.platform}-${b.arch}`))
  };
}

function validateUpdatePayload(payload, manifest) {
  if (!payload || typeof payload !== "object") throw new Error("Update manifest payload is required.");
  if (payload.schemaVersion !== 1) throw new Error("Unsupported update manifest schema.");
  if (payload.product !== "local-agent-studio") throw new Error("Update manifest is for a different product.");
  if (payload.channel !== (manifest.channel || "local-agent-studio")) throw new Error("Update channel does not match this app.");
  if (!/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(payload.version || ""))) throw new Error("Update version is invalid.");
  if (!Number.isInteger(payload.buildNumber) || payload.buildNumber < 1) throw new Error("Update buildNumber is invalid.");
  if (payload.minAppVersion && !/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(payload.minAppVersion))) {
    throw new Error("Update minAppVersion is invalid.");
  }
  const publishedAt = Date.parse(payload.publishedAt || "");
  if (!Number.isFinite(publishedAt)) throw new Error("Update publishedAt is invalid.");
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length === 0) throw new Error("Update manifest has no artifacts.");
  for (const artifact of payload.artifacts) {
    if (!artifact || typeof artifact !== "object") throw new Error("Update artifact is invalid.");
    if (!/^(win32|darwin|linux)$/.test(String(artifact.platform || ""))) throw new Error("Update artifact platform is invalid.");
    if (!/^(x64|arm64)$/.test(String(artifact.arch || ""))) throw new Error("Update artifact arch is invalid.");
    if (!/^https:\/\/[^\s]+$/i.test(String(artifact.url || ""))) throw new Error("Update artifact URL must use HTTPS.");
    if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ""))) throw new Error("Update artifact sha256 is invalid.");
    if (!Number.isInteger(Number(artifact.size || 0)) || Number(artifact.size || 0) < 1 || Number(artifact.size || 0) > MAX_ARTIFACT_BYTES) {
      throw new Error("Update artifact size is invalid.");
    }
  }
}

function publicUpdatePayload(payload, currentBuild) {
  return {
    product: payload.product,
    channel: payload.channel,
    version: payload.version,
    buildNumber: payload.buildNumber,
    minAppVersion: payload.minAppVersion || null,
    publishedAt: payload.publishedAt,
    releaseNotesUrl: payload.releaseNotesUrl || "",
    available: payload.buildNumber > currentBuild,
    artifacts: payload.artifacts.map((artifact) => ({
      platform: artifact.platform,
      arch: artifact.arch,
      url: artifact.url,
      sha256: artifact.sha256.toLowerCase(),
      size: Number(artifact.size || 0)
    }))
  };
}

function currentBuildNumber(manifest) {
  return Number.isInteger(manifest.buildNumber) ? manifest.buildNumber : 0;
}

function publicStagedState(value) {
  if (!value) return null;
  return {
    at: value.at || null,
    version: value.version || null,
    buildNumber: value.buildNumber || null,
    platform: value.platform || null,
    arch: value.arch || null,
    sha256: value.sha256 || null,
    size: value.size || 0,
    installReady: false
  };
}

function compareVersions(left, right) {
  const a = String(left || "").replace(/^v/, "").split(/[+-]/)[0].split(".").map(Number);
  const b = String(right || "").replace(/^v/, "").split(/[+-]/)[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

async function writeVerifiedStream(body, file, artifact) {
  const hash = createHash("sha256");
  const output = createWriteStream(file, { flags: "wx", mode: 0o600 });
  let size = 0;
  try {
    for await (const raw of body) {
      const chunk = Buffer.from(raw);
      size += chunk.length;
      if (size > artifact.size || size > MAX_ARTIFACT_BYTES) throw new Error("Update artifact exceeded signed manifest size.");
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    throw error;
  }
  const sha256 = hash.digest("hex");
  if (size !== artifact.size) throw new Error("Update artifact size does not match signed manifest.");
  if (sha256 !== artifact.sha256.toLowerCase()) throw new Error("Update artifact SHA-256 does not match signed manifest.");
  return { size, sha256 };
}

function stagedFileName(version, buildNumber, url) {
  const rawExtension = extname(new URL(url).pathname).toLowerCase();
  const extension = ALLOWED_EXTENSIONS.has(rawExtension) ? rawExtension : ".bin";
  const safeVersion = String(version).replace(/[^a-z0-9._-]+/gi, "-");
  return `local-agent-studio-${safeVersion}-${buildNumber}${extension}`;
}
