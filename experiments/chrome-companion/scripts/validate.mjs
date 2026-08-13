// Chrome Companion static release check
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background?.type, "module");
assert.equal(manifest.version_name, "5.0.0");
assert.deepEqual(manifest.host_permissions.sort(), ["http://127.0.0.1/*", "http://localhost/*"].sort());

const forbidden = new Set(["debugger", "history", "bookmarks", "downloads", "nativeMessaging", "management"]);
for (const permission of manifest.permissions || []) {
  assert.equal(forbidden.has(permission), false, `Forbidden broad permission: ${permission}`);
}
assert.equal((manifest.host_permissions || []).includes("<all_urls>"), false);

for (const file of [manifest.background.service_worker, manifest.action.default_popup, "popup.css", "popup.js"]) {
  const content = await readFile(path.join(extension, file), "utf8");
  assert.equal(/<script[^>]+src=["']https?:/i.test(content), false, `Remote script found in ${file}`);
  assert.equal(/eval\s*\(|new\s+Function\s*\(/.test(content), false, `Dynamic code execution found in ${file}`);
}

const background = await readFile(path.join(extension, manifest.background.service_worker), "utf8");
for (const capability of ["snapshot", "screenshot", "navigate", "tab_action", "click", "type", "scroll", "press", "select"]) {
  assert.match(background, new RegExp(`["]${capability}["]`), `Missing browser capability: ${capability}`);
}
assert.match(background, /captureVisibleTab/);
assert.match(background, /max_bytes/);
assert.match(background, /disarmTab/);
assert.equal(/chrome\.debugger|chrome\.history|chrome\.bookmarks|chrome\.downloads/.test(background), false);

console.log("Chrome Companion v5.0.0 check: 9 local capabilities, bounded screenshots, no broad privileged permissions, no remote code.");
