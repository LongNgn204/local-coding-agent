// Local Coding Agent Tray — shared helpers.
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function httpGet(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${url}`)));
  });
}

export async function httpGetJson(url, timeoutMs = 4000) {
  const res = await httpGet(url, timeoutMs);
  try {
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null, body: res.body };
  } catch {
    return { status: res.status, json: null, body: res.body };
  }
}

export function oneLine(value, maxLength = 180) {
  const compact = String(value || "").split(/\s+/).filter(Boolean).join(" ");
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

export function killTree(child, signal = "SIGTERM") {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.killed) return resolve(false);
    child.once("exit", () => resolve(true));
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill(signal);
      }
    } catch {
      resolve(false);
    }
    setTimeout(() => resolve(true), 3000);
  });
}