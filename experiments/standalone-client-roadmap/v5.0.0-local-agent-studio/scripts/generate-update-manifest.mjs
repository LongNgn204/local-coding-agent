#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUpdateEnvelope } from "../core/update-service.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const appManifest = JSON.parse(readFileSync(join(ROOT, "version-manifest.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const privateKeyPem = loadPrivateKey();
if (!privateKeyPem) {
  throw new Error("Set LCA_UPDATE_SIGNING_PRIVATE_KEY_FILE or LCA_RELEASE_SIGNING_PRIVATE_KEY_FILE. Private keys must never be committed or bundled.");
}
const artifactPath = requireArg(args, "artifact");
const platform = requireArg(args, "platform");
const platformSignature = signatureMetadata(args);
if ((platform === "win32" || platform === "darwin") && !platformSignature) {
  throw new Error("Windows/macOS release manifests require --publisher/--thumbprint or --team-id.");
}
const payload = {
  channel: args.channel || appManifest.channel || "local-agent-studio",
  version: requireArg(args, "version"),
  buildNumber: Number(requireArg(args, "build-number")),
  minAppVersion: args["min-app-version"] || appManifest.version,
  publishedAt: args["published-at"] || new Date().toISOString(),
  releaseNotesUrl: args["release-notes-url"] || "",
  artifacts: [{
    platform,
    arch: requireArg(args, "arch"),
    url: requireArg(args, "url"),
    sha256: sha256File(artifactPath),
    size: statSync(artifactPath).size,
    signature: platformSignature
  }]
};

const envelope = createUpdateEnvelope({ payload, privateKeyPem });
const output = args.out || join(ROOT, "update-manifest.json");
writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
console.log(JSON.stringify({
  ok: true,
  output,
  artifact: artifactPath,
  version: payload.version,
  buildNumber: payload.buildNumber,
  platform: payload.artifacts[0].platform,
  arch: payload.artifacts[0].arch,
  sha256: payload.artifacts[0].sha256
}, null, 2));

function parseArgs(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const inline = key.indexOf("=");
    if (inline >= 0) {
      out[key.slice(0, inline)] = key.slice(inline + 1);
    } else {
      out[key] = values[index + 1];
      index += 1;
    }
  }
  return out;
}

function requireArg(args, name) {
  const value = args[name];
  if (value === undefined || value === "") throw new Error(`Missing --${name}`);
  return value;
}

function loadPrivateKey() {
  const file = process.env.LCA_UPDATE_SIGNING_PRIVATE_KEY_FILE || process.env.LCA_RELEASE_SIGNING_PRIVATE_KEY_FILE;
  if (!file) return "";
  if (!existsSync(file)) throw new Error(`Update signing private key file not found: ${file}`);
  return readFileSync(file, "utf8");
}

function sha256File(file) {
  if (!existsSync(file)) throw new Error(`Artifact not found: ${file}`);
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function signatureMetadata(args) {
  if (args.platform === "win32" && (args.publisher || args.thumbprint)) {
    return {
      type: "authenticode",
      publisher: args.publisher || "",
      thumbprints: String(args.thumbprint || "").split(",").map((value) => value.trim()).filter(Boolean)
    };
  }
  if (args.platform === "darwin" && args["team-id"]) {
    return { type: "apple-codesign", teamId: args["team-id"] };
  }
  return null;
}
