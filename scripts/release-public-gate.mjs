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
  ["private experiment tree", (file) => file.startsWith("experiments/")],
  ["private desktop tree", (file) => file.startsWith("desktop-app/")],
  ["nested AI worktree", (file) => file.includes("/.claude/worktrees/")],
  ["preview-named path", (file) => /(^|[/_.-])preview([/_.-]|$)/i.test(file)]
];
const privateContentRules = [
  ["private major-version marker", /\b5\.0\.0[-_.]/i]
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
  const content = readFileSync(path.join(root, file), "utf8");
  for (const [label, pattern] of privateContentRules) {
    if (pattern.test(content)) violations.push(`${label}: ${file}`);
  }
}

if (violations.length) {
  console.error("Public release boundary failed:");
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Public release boundary: ${candidates.length} tracked/untracked candidate files checked, 0 private-tree/channel leaks.`);
