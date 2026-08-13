// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { spawnSync } from "node:child_process";

export const SHUTDOWN_CONFIRMATION = "SHUTDOWN_AFTER_TASK";
export const MIN_SHUTDOWN_DELAY_SECONDS = 0;
export const MAX_SHUTDOWN_DELAY_SECONDS = 3600;
export const DEFAULT_SHUTDOWN_DELAY_SECONDS = 0;

export function normalizeShutdownRequest({ delay_seconds, reason, confirmation } = {}) {
  const delay = Number(delay_seconds ?? DEFAULT_SHUTDOWN_DELAY_SECONDS);
  if (!Number.isInteger(delay) || delay < MIN_SHUTDOWN_DELAY_SECONDS || delay > MAX_SHUTDOWN_DELAY_SECONDS) {
    throw new Error(
      `delay_seconds must be an integer from ${MIN_SHUTDOWN_DELAY_SECONDS} to ${MAX_SHUTDOWN_DELAY_SECONDS}.`
    );
  }
  const normalizedReason = String(reason || "").replace(/\s+/g, " ").trim();
  if (!normalizedReason) throw new Error("reason is required.");
  if (normalizedReason.length > 200) throw new Error("reason must be 200 characters or fewer.");
  if (confirmation !== SHUTDOWN_CONFIRMATION) {
    throw new Error(`confirmation must equal ${SHUTDOWN_CONFIRMATION}.`);
  }
  return { delay_seconds: delay, reason: normalizedReason, confirmation: SHUTDOWN_CONFIRMATION };
}

export function scheduleWindowsShutdown(
  request,
  {
    platform = process.platform,
    env = process.env,
    testMode = false,
    spawnSyncImpl = spawnSync
  } = {}
) {
  const normalized = normalizeShutdownRequest(request);
  if (platform !== "win32") throw new Error("Prompt-requested shutdown is currently supported on Windows only.");

  const comment = `Local Coding Agent finished the approved task: ${normalized.reason}`.slice(0, 220);
  const executable = path.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "shutdown.exe");
  const args = ["/s", "/t", String(normalized.delay_seconds), "/d", "p:0:0", "/c", comment];
  if (testMode) {
    return { ok: true, test_mode: true, executable, args, delay_seconds: normalized.delay_seconds, comment };
  }

  const result = spawnSyncImpl(executable, args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: 5000,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(`Windows rejected the shutdown request: ${detail}`);
  }
  return { ok: true, test_mode: false, delay_seconds: normalized.delay_seconds, comment };
}

export function cancelWindowsShutdown(
  {
    platform = process.platform,
    env = process.env,
    testMode = false,
    spawnSyncImpl = spawnSync
  } = {}
) {
  if (platform !== "win32") throw new Error("Shutdown cancellation is currently supported on Windows only.");
  const executable = path.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "shutdown.exe");
  const args = ["/a"];
  if (testMode) return { ok: true, test_mode: true, executable, args };

  const result = spawnSyncImpl(executable, args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: 5000,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(`Windows did not cancel a shutdown: ${detail}`);
  }
  return { ok: true, test_mode: false };
}
