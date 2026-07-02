import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 200_000;

export class PlatformSignatureVerifier {
  constructor({ runner = runProcess } = {}) {
    this.runner = runner;
  }

  async verify({ file, platform = process.platform, signature }) {
    if (!signature) {
      return { required: false, verified: false, platform, reason: "Signed manifest does not require a platform signature." };
    }
    const policy = validateSignatureMetadata(signature, platform);
    if (platform === "win32") return this.verifyWindows(file, policy);
    if (platform === "darwin") return this.verifyMac(file, policy);
    throw new Error(`Platform signature verification is not implemented for ${platform}.`);
  }

  async verifyWindows(file, signature) {
    if (signature.type !== "authenticode") throw new Error("Windows update requires authenticode signature metadata.");
    const script = [
      "$s=Get-AuthenticodeSignature -LiteralPath $env:LCA_SIGNATURE_FILE;",
      "$p=if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''};",
      "$o=[pscustomobject]@{Status=[string]$s.Status;StatusMessage=$s.StatusMessage;Publisher=$p;Subject=$s.SignerCertificate.Subject;Thumbprint=$s.SignerCertificate.Thumbprint};",
      "$o|ConvertTo-Json -Compress"
    ].join("");
    const result = await this.runner({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      env: { ...process.env, LCA_SIGNATURE_FILE: file }
    });
    if (result.code !== 0) throw new Error(`Authenticode check failed: ${result.stderr || result.stdout}`);
    let parsed;
    try { parsed = JSON.parse(result.stdout.trim()); } catch { throw new Error("Authenticode check returned invalid output."); }
    if (parsed.Status !== "Valid") throw new Error(`Authenticode signature is not valid: ${parsed.Status || "unknown"}.`);
    const publisher = String(parsed.Publisher || "").trim();
    const subject = String(parsed.Subject || "");
    const thumbprint = normalizeThumbprint(parsed.Thumbprint);
    if (signature.publisher && publisher.toLowerCase() !== String(signature.publisher).trim().toLowerCase()) {
      throw new Error("Authenticode publisher does not match signed update manifest.");
    }
    const allowed = normalizeThumbprints(signature.thumbprints);
    if (allowed.length && !allowed.includes(thumbprint)) {
      throw new Error("Authenticode certificate thumbprint does not match signed update manifest.");
    }
    return { required: true, verified: true, platform: "win32", type: "authenticode", publisher, subject, thumbprint, reason: "Authenticode signature is valid." };
  }

  async verifyMac(file, signature) {
    if (signature.type !== "apple-codesign") throw new Error("macOS update requires apple-codesign signature metadata.");
    const verified = await this.runner({ command: "codesign", args: ["--verify", "--deep", "--strict", "--verbose=2", file], env: process.env });
    if (verified.code !== 0) throw new Error(`macOS code signature is invalid: ${verified.stderr || verified.stdout}`);
    const details = await this.runner({ command: "codesign", args: ["-dv", "--verbose=4", file], env: process.env });
    if (details.code !== 0) throw new Error(`Unable to inspect macOS code signature: ${details.stderr || details.stdout}`);
    const output = `${details.stdout}\n${details.stderr}`;
    const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || "";
    if (!teamId || teamId !== signature.teamId) throw new Error("macOS TeamIdentifier does not match signed update manifest.");
    return { required: true, verified: true, platform: "darwin", type: "apple-codesign", teamId, reason: "macOS code signature is valid." };
  }
}

export function validateSignatureMetadata(signature, platform) {
  if (!signature) return null;
  if (!signature || typeof signature !== "object") throw new Error("Update artifact signature metadata is invalid.");
  if (platform === "win32") {
    if (signature.type !== "authenticode") throw new Error("Windows artifact signature type must be authenticode.");
    const publisher = String(signature.publisher || "").trim();
    const thumbprints = normalizeThumbprints(signature.thumbprints);
    if (!publisher && thumbprints.length === 0) throw new Error("Authenticode metadata requires publisher or thumbprint.");
    return { type: "authenticode", publisher, thumbprints };
  }
  if (platform === "darwin") {
    const teamId = String(signature.teamId || "").trim();
    if (signature.type !== "apple-codesign" || !/^[A-Z0-9]{10}$/.test(teamId)) {
      throw new Error("macOS signature metadata requires a valid apple-codesign TeamIdentifier.");
    }
    return { type: "apple-codesign", teamId };
  }
  throw new Error(`Platform signature metadata is not supported for ${platform}.`);
}

function normalizeThumbprints(values) {
  if (!Array.isArray(values)) return [];
  const output = values.map(normalizeThumbprint).filter(Boolean);
  if (output.some((value) => !/^[A-F0-9]{40,64}$/.test(value))) throw new Error("Invalid certificate thumbprint in update manifest.");
  return [...new Set(output)].sort();
}

function normalizeThumbprint(value) {
  return String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
}

function runProcess({ command, args, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function appendBounded(current, chunk) {
  if (current.length >= OUTPUT_LIMIT) return current;
  return `${current}${String(chunk)}`.slice(0, OUTPUT_LIMIT);
}
