#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrityService, loadReleasePublicKey } from "../core/integrity-service.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRED_SCRIPTS = [
  "check",
  "test",
  "security:audit",
  "desktop:pack",
  "desktop:smoke:packaged",
  "credential:smoke",
  "license:keygen",
  "license:issue",
  "signature:verify",
  "release:doctor",
  "integrity:generate",
  "update:manifest"
];
const REQUIRED_BUILD_FILES = [
  "core/**/*",
  "desktop/**/*",
  "dist/ui/**/*",
  "standalone-app.mjs",
  "version-manifest.json",
  "integrity-manifest.json",
  "package.json"
];
const REQUIRED_PUBLIC_KEYS = [
  "license-public-key.pem",
  "release-public-key.pem",
  "update-public-key.pem"
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectReleaseReadiness(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

export function inspectReleaseReadiness(options = {}) {
  const root = resolve(options.root || ROOT);
  const target = String(options.target || "manifest");
  const packageJson = readJson(join(root, "package.json"));
  const manifest = readJson(join(root, "version-manifest.json"));
  const actualStage = String(manifest.releaseStage || "preview");
  const targetStage = target === "manifest" ? actualStage : target;
  const stableTarget = targetStage === "stable";
  const findings = [];
  const warnings = [];

  requireStage(actualStage, findings);
  if (!["manifest", "preview", "stable"].includes(target)) {
    findings.push(finding("args.target", `Unsupported target: ${target}`, "Use --target preview or --target stable."));
  }
  if (stableTarget && actualStage !== "stable") {
    findings.push(finding("version-manifest.json", "Stable target requested, but version-manifest.json is not releaseStage=stable.", "Flip releaseStage only in a signed release branch."));
  }
  if (!stableTarget && actualStage !== "stable") {
    warnings.push("Preview release doctor allows unsigned preview keys/artifacts, but stable release doctor will fail closed.");
  }

  checkPackageScripts(packageJson, findings);
  checkPackageSurface(packageJson, findings);
  checkPublicKeys(root, { stableTarget, findings, warnings });
  checkIntegrity(root, manifest, { stableTarget, findings, warnings });
  checkArtifact(root, options, { stableTarget, findings, warnings });
  checkSignatureInputs(options, { stableTarget, findings, warnings });

  return {
    ok: findings.length === 0,
    target: targetStage,
    releaseStage: actualStage,
    version: manifest.version,
    buildNumber: manifest.buildNumber,
    productName: manifest.productName,
    artifact: options.artifact || "",
    findings,
    warnings
  };
}

function checkPackageScripts(packageJson, findings) {
  for (const name of REQUIRED_SCRIPTS) {
    if (!packageJson.scripts?.[name]) {
      findings.push(finding("package.json", `Missing npm script: ${name}`, "Keep release gates callable from CI and local release machines."));
    }
  }
}

function checkPackageSurface(packageJson, findings) {
  if (packageJson.build?.asar !== true) {
    findings.push(finding("package.json", "Electron ASAR packaging is not enabled.", "Set build.asar=true before customer builds."));
  }
  const files = new Set(packageJson.build?.files || []);
  for (const item of REQUIRED_BUILD_FILES) {
    if (!files.has(item)) {
      findings.push(finding("package.json", `Build file allowlist is missing ${item}.`, "Customer packages must include only the explicit runtime surface."));
    }
  }
}

function checkPublicKeys(root, { stableTarget, findings, warnings }) {
  for (const keyFile of REQUIRED_PUBLIC_KEYS) {
    const full = join(root, keyFile);
    if (!existsSync(full)) {
      const message = `Missing public key file: ${keyFile}.`;
      if (stableTarget) findings.push(finding(keyFile, message, "Stable builds must ship public verification keys, never private keys."));
      else warnings.push(message);
      continue;
    }
    const text = readFileSync(full, "utf8").trim();
    if (!text || !/-----BEGIN PUBLIC KEY-----/.test(text)) {
      const message = `Invalid public key file: ${keyFile}.`;
      if (stableTarget) findings.push(finding(keyFile, message, "Use PEM public keys generated outside the app."));
      else warnings.push(message);
    }
  }
}

function checkIntegrity(root, manifest, { stableTarget, findings, warnings }) {
  const status = new IntegrityService({
    appDir: root,
    manifest: { ...manifest, releaseStage: stableTarget ? "stable" : manifest.releaseStage },
    publicKeyPem: loadReleasePublicKey(root)
  }).status();
  if (!status.allowed) {
    findings.push(finding("integrity-manifest.json", status.reason || "Integrity manifest failed.", "Regenerate and sign release integrity before shipping."));
    return;
  }
  if (!status.verified) {
    const message = status.reason || "Integrity manifest is unsigned.";
    if (stableTarget) findings.push(finding("integrity-manifest.json", message, "Stable builds require a release-signed integrity manifest."));
    else warnings.push(message);
  }
}

function checkArtifact(root, options, { stableTarget, findings, warnings }) {
  if (!options.artifact) {
    const message = "No packaged artifact was provided to release doctor.";
    if (stableTarget) findings.push(finding("artifact", message, "Pass --artifact dist/win-unpacked/Local Agent Studio.exe or the signed installer path."));
    else warnings.push(message);
    return;
  }
  const artifact = resolve(root, options.artifact);
  if (!existsSync(artifact)) {
    findings.push(finding("artifact", `Packaged artifact does not exist: ${artifact}`, "Run npm run desktop:pack or npm run desktop:dist first."));
  }
}

function checkSignatureInputs(options, { stableTarget, findings, warnings }) {
  const platform = String(options.platform || process.platform);
  const hasWindowsPolicy = Boolean(options.publisher && options.thumbprint);
  const hasMacPolicy = Boolean(options.teamId);
  if (platform === "win32" && !hasWindowsPolicy) {
    const message = "Windows signature policy was not provided.";
    if (stableTarget) findings.push(finding("signature", message, "Pass --publisher and --thumbprint for stable Windows releases."));
    else warnings.push(message);
  }
  if (platform === "darwin" && !hasMacPolicy) {
    const message = "macOS signature policy was not provided.";
    if (stableTarget) findings.push(finding("signature", message, "Pass --team-id for stable macOS releases."));
    else warnings.push(message);
  }
}

function requireStage(stage, findings) {
  if (!["preview", "stable"].includes(stage)) {
    findings.push(finding("version-manifest.json", `Unsupported releaseStage: ${stage}`, "Use releaseStage preview or stable."));
  }
}

function finding(id, message, fix) {
  return { id, message, fix };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      if (index + 1 >= values.length) throw new Error(`Missing value for ${arg}`);
      return values[++index];
    };
    switch (arg) {
      case "--target":
        parsed.target = next();
        break;
      case "--artifact":
        parsed.artifact = next();
        break;
      case "--platform":
        parsed.platform = next();
        break;
      case "--publisher":
        parsed.publisher = next();
        break;
      case "--thumbprint":
        parsed.thumbprint = next();
        break;
      case "--team-id":
        parsed.teamId = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
