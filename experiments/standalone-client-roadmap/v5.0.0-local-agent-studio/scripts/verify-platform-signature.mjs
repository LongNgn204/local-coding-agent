#!/usr/bin/env node
import { existsSync } from "node:fs";
import { PlatformSignatureVerifier } from "../core/platform-signature.mjs";

const args = parseArgs(process.argv.slice(2));
try {
  const file = required(args, "artifact");
  if (!existsSync(file)) throw new Error(`Artifact not found: ${file}`);
  const platform = args.platform || process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error("Platform signature verification currently supports win32 and darwin.");
  }
  const signature = platform === "win32"
    ? {
      type: "authenticode",
      publisher: args.publisher || "",
      thumbprints: String(args.thumbprint || "").split(",").map((value) => value.trim()).filter(Boolean)
    }
    : {
      type: "apple-codesign",
      teamId: required(args, "team-id")
    };
  const result = await new PlatformSignatureVerifier().verify({ file, platform, signature });
  console.log(JSON.stringify({ ok: true, file, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}

function parseArgs(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const inline = key.indexOf("=");
    if (inline >= 0) out[key.slice(0, inline)] = key.slice(inline + 1);
    else {
      out[key] = values[index + 1];
      index += 1;
    }
  }
  return out;
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
