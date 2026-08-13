// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import {
  SHUTDOWN_CONFIRMATION,
  normalizeShutdownRequest,
  scheduleWindowsShutdown,
  cancelWindowsShutdown
} from "./system-power.mjs";

test("shutdown requests require explicit prompt confirmation and default to immediate", () => {
  assert.throws(
    () => normalizeShutdownRequest({ delay_seconds: 120, reason: "done", confirmation: "yes" }),
    /SHUTDOWN_AFTER_TASK/
  );
  assert.throws(
    () => normalizeShutdownRequest({ delay_seconds: -1, reason: "done", confirmation: SHUTDOWN_CONFIRMATION }),
    /0 to 3600/
  );
  assert.deepEqual(
    normalizeShutdownRequest({ reason: "  verified   task  ", confirmation: SHUTDOWN_CONFIRMATION }),
    { delay_seconds: 0, reason: "verified task", confirmation: SHUTDOWN_CONFIRMATION }
  );
});

test("Windows shutdown uses a fixed executable and argument list without a shell", () => {
  let observed;
  const result = scheduleWindowsShutdown(
    { delay_seconds: 0, reason: "checks passed", confirmation: SHUTDOWN_CONFIRMATION },
    {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl(file, args, options) {
        observed = { file, args, options };
        return { status: 0, stdout: "", stderr: "" };
      }
    }
  );
  assert.equal(result.ok, true);
  assert.equal(observed.file, "C:\\Windows\\System32\\shutdown.exe");
  assert.deepEqual(observed.args.slice(0, 3), ["/s", "/t", "0"]);
  assert.equal(observed.options.shell, false);
});

test("test mode never invokes the operating-system process", () => {
  let calls = 0;
  const result = scheduleWindowsShutdown(
    { delay_seconds: 60, reason: "dry run", confirmation: SHUTDOWN_CONFIRMATION },
    {
      platform: "win32",
      testMode: true,
      spawnSyncImpl() {
        calls++;
        throw new Error("must not run");
      }
    }
  );
  assert.equal(result.test_mode, true);
  assert.equal(calls, 0);
});

test("cancel uses only shutdown.exe /a", () => {
  let observed;
  const result = cancelWindowsShutdown({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnSyncImpl(file, args, options) {
      observed = { file, args, options };
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(observed.args, ["/a"]);
  assert.equal(observed.options.shell, false);
});
