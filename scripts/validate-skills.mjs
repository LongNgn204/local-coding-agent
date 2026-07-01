#!/usr/bin/env node
// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_DIRS = [join(REPO_ROOT, "skills")];

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bsk-proj-[A-Za-z0-9_-]+/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/,
  /\b[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_-]*\s*[:=]\s*["']?[^"'\s]{12,}/i,
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~-]+/i,
  /\btunnel_[A-Za-z0-9]{8,}\b/
];

const MOJIBAKE = /Ã|Â|â€|â€”|â€“|ðŸ|ï»¿|�/;

function usage() {
  console.log(`Validate Local Coding Agent skills

Usage:
  node scripts/validate-skills.mjs [skills-dir ...]

Checks:
  - every skill folder has SKILL.md
  - frontmatter includes name and description
  - names are unique
  - skill names are simple path-safe identifiers
  - descriptions are short and useful
  - common secrets/tunnel ids are not present
  - obvious mojibake is not present
`);
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true, dirs: [] };
  return { help: false, dirs: argv.length ? argv.map((p) => resolve(p)) : DEFAULT_DIRS };
}

function parseFrontmatter(text) {
  const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
  if (!fm) return { name: "", description: "", hasFrontmatter: false };
  const block = fm[1];
  const name = (block.match(/^\s*name\s*:\s*(.+?)\s*$/im)?.[1] || "").replace(/^["']|["']$/g, "").trim();
  const description = (block.match(/^\s*description\s*:\s*(.+?)\s*$/im)?.[1] || "").replace(/^["']|["']$/g, "").trim();
  return { name, description, hasFrontmatter: true };
}

function isSafeName(name) {
  return /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(name) && name !== "." && name !== "..";
}

function validateSkill(dir, seen) {
  const issues = [];
  const skillFile = join(dir, "SKILL.md");
  const folder = basename(dir);
  if (!existsSync(skillFile)) {
    issues.push({ level: "error", message: "missing SKILL.md" });
    return issues;
  }
  const text = readFileSync(skillFile, "utf8");
  const meta = parseFrontmatter(text);
  if (!meta.hasFrontmatter) issues.push({ level: "error", message: "missing YAML frontmatter" });
  if (!meta.name) issues.push({ level: "error", message: "missing frontmatter name" });
  if (!meta.description) issues.push({ level: "error", message: "missing frontmatter description" });
  if (meta.name && !isSafeName(meta.name)) issues.push({ level: "error", message: `invalid skill name: ${meta.name}` });
  if (meta.name && seen.has(meta.name.toLowerCase())) {
    issues.push({ level: "error", message: `duplicate skill name: ${meta.name}` });
  }
  if (meta.name) seen.add(meta.name.toLowerCase());
  if (meta.name && meta.name.toLowerCase() !== folder.toLowerCase()) {
    issues.push({ level: "warn", message: `frontmatter name differs from folder: ${meta.name} != ${folder}` });
  }
  if (meta.description.length > 220) issues.push({ level: "warn", message: "description is longer than 220 chars" });
  if (text.length > 20_000) issues.push({ level: "warn", message: "skill is longer than 20k chars" });
  if (MOJIBAKE.test(text)) issues.push({ level: "error", message: "possible mojibake/encoding artifact found" });
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({ level: "error", message: "possible secret, API key, token, or tunnel id found" });
      break;
    }
  }
  return issues;
}

function validateDirs(dirs) {
  const seen = new Set();
  const results = [];
  for (const base of dirs) {
    if (!existsSync(base)) {
      results.push({ dir: base, issues: [{ level: "error", message: "skills directory does not exist" }] });
      continue;
    }
    const entries = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const entry of entries) {
      const dir = join(base, entry.name);
      results.push({ dir, issues: validateSkill(dir, seen) });
    }
  }
  return results;
}

function main() {
  const { help, dirs } = parseArgs(process.argv.slice(2));
  if (help) return usage();
  const results = validateDirs(dirs);
  let errors = 0;
  let warnings = 0;
  for (const result of results) {
    if (!result.issues.length) {
      console.log(`OK   ${result.dir}`);
      continue;
    }
    for (const issue of result.issues) {
      if (issue.level === "error") errors++;
      else warnings++;
      console.log(`${issue.level === "error" ? "ERR" : "WARN"}  ${result.dir}: ${issue.message}`);
    }
  }
  console.log(`\nSkill validation: ${results.length} checked, ${errors} error(s), ${warnings} warning(s)`);
  if (errors) process.exit(1);
}

main();
