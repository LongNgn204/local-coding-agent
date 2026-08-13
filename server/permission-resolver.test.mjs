import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PermissionResolver,
  isPathInside,
  legacyPermissionProfile,
  loadPermissionProfileSync
} from "./permission-resolver.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-permissions-"));
  const work = path.join(dir, "work");
  const docs = path.join(dir, "docs");
  const secrets = path.join(work, "secrets");
  await mkdir(secrets, { recursive: true });
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(work, "readme.md"), "ok", "utf8");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, work, docs, secrets };
}

test("path boundary rejects sibling-prefix paths", async (t) => {
  const { dir, work } = await fixture(t);
  assert.equal(isPathInside(work, work), true);
  assert.equal(isPathInside(path.join(work, "src"), work), true);
  assert.equal(isPathInside(path.join(dir, "work-evil"), work), false);
});

test("legacy config becomes equivalent per-root presets", async (t) => {
  const { work, docs } = await fixture(t);
  const safe = legacyPermissionProfile({ primaryRoot: work, extraRoots: [docs], mode: "safe" });
  assert.deepEqual(safe.roots.map((root) => root.preset), ["develop", "develop"]);
  const full = legacyPermissionProfile({ primaryRoot: work, extraRoots: [docs], mode: "full" });
  assert.deepEqual(full.roots.map((root) => root.preset), ["full_control", "full_control"]);
});

test("most specific root grants rights but deny patterns always win", async (t) => {
  const { work, docs } = await fixture(t);
  const profile = loadPermissionProfileSync({
    primaryRoot: work,
    profileJson: JSON.stringify({
      name: "mixed",
      working_directory: work,
      roots: [
        { path: work, preset: "observe", deny: ["secrets/**"] },
        { path: path.join(work, "src"), preset: "develop" },
        { path: docs, preset: "edit" }
      ]
    })
  });
  const resolver = new PermissionResolver(profile);
  assert.equal(resolver.explain(path.join(work, "readme.md"), "read").allowed, true);
  assert.equal(resolver.explain(path.join(work, "readme.md"), "write").allowed, false);
  assert.equal(resolver.explain(path.join(work, "src", "new.ts"), "write").allowed, true);
  assert.equal(resolver.explain(path.join(work, "src"), "command").command_mode, "safe");
  assert.equal(resolver.explain(path.join(docs, "notes.md"), "write").allowed, true);
  const denied = resolver.explain(path.join(work, "secrets", "token.txt"), "read");
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "deny_pattern");
});

test("junction or symlink escape is rejected for existing and new targets", async (t) => {
  const { dir, work } = await fixture(t);
  const outside = path.join(dir, "outside");
  const link = path.join(work, "linked");
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${error.message}`);
    return;
  }
  const profile = loadPermissionProfileSync({ primaryRoot: work, mode: "safe" });
  const resolver = new PermissionResolver(profile);
  assert.throws(() => resolver.resolvePath(path.join(link, "existing.txt"), "write"), /outside_roots/);
  assert.throws(() => resolver.resolvePath(path.join(link, "new", "file.txt"), "write"), /outside_roots/);
});

test("session and once grants extend access without changing the profile", async (t) => {
  const { work, docs } = await fixture(t);
  const resolver = new PermissionResolver(loadPermissionProfileSync({
    primaryRoot: work,
    profileJson: JSON.stringify({ working_directory: work, roots: [{ path: work, preset: "observe" }] })
  }));
  assert.equal(resolver.explain(docs, "read").allowed, false);
  const grant = resolver.addGrant({ path: docs, preset: "edit", scope: "once" });
  assert.equal(resolver.resolvePath(path.join(docs, "one.txt"), "write"), path.join(docs, "one.txt"));
  assert.equal(grant.uses_remaining, 0);
  assert.equal(resolver.explain(path.join(docs, "two.txt"), "write").allowed, false);
  resolver.addGrant({ path: docs, preset: "develop", scope: "session" });
  assert.equal(resolver.commandModeFor(docs), "safe");
  resolver.addGrant({ path: work, preset: "develop", scope: "session" });
  assert.equal(resolver.explain(path.join(work, "upgraded.txt"), "write").allowed, true);
});

test("conflicting duplicate canonical roots fail closed", async (t) => {
  const { work } = await fixture(t);
  assert.throws(() => loadPermissionProfileSync({
    primaryRoot: work,
    profileJson: JSON.stringify({
      working_directory: work,
      roots: [{ path: work, preset: "observe" }, { path: path.join(work, "."), preset: "develop" }]
    })
  }), /conflicting rules/i);
});

test("task grants are visible only to their task id", async (t) => {
  const { work, docs } = await fixture(t);
  const resolver = new PermissionResolver(loadPermissionProfileSync({ primaryRoot: work, mode: "safe" }));
  resolver.addGrant({ path: docs, preset: "develop", scope: "task", task_id: "task-1" });
  assert.equal(resolver.explain(docs, "write", { taskId: "task-1" }).allowed, true);
  assert.equal(resolver.explain(docs, "write", { taskId: "task-2" }).allowed, false);
});
