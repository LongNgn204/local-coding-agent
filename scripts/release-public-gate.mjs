// Local Coding Agent public-release boundary gate
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const candidates = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"));

const self = "scripts/release-public-gate.mjs";
const pathRules = [
  ["nested AI worktree", (file) => file.includes("/.claude/worktrees/")],
  ["runtime data", (file) => file.startsWith("server/data/")],
  ["proprietary tools", (file) => file.startsWith("tools/")],
  ["generated build output", (file) => /(^|\/)(bin|obj|publish|node_modules|dist)\//i.test(file)],
  ["local configuration", (file) => /(^|\/)(config\.json|permission-profiles\.json|\.env)$/i.test(file)]
];
const textExtensions = new Set([
  ".cs", ".csproj", ".css", ".html", ".js", ".json", ".md", ".mjs",
  ".ps1", ".sh", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"
]);
const blockedArtifactExtensions = new Set([".exe", ".key", ".pem", ".pfx", ".zip"]);
const violations = [];

for (const file of candidates) {
  for (const [label, matches] of pathRules) {
    if (matches(file)) violations.push(`${label}: ${file}`);
  }
  if (blockedArtifactExtensions.has(path.extname(file).toLowerCase())) {
    violations.push(`tracked binary/secret artifact: ${file}`);
  }
  if (file === self || !textExtensions.has(path.extname(file).toLowerCase())) continue;
  readFileSync(path.join(root, file), "utf8");
}

if (violations.length) {
  console.error("Public release boundary failed:");
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Public release boundary: ${candidates.length} tracked/untracked candidate files checked, 0 runtime, proprietary, generated, or secret artifacts.`);
