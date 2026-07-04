// Local Codex Studio — preload bridge.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs in a sandboxed, context-isolated preload. Exposes window.studio with
// promise methods that forward to the main process over IPC. The renderer never
// touches Node, the filesystem, or child processes directly. CommonJS (.cjs) is
// required because sandboxed preloads do not support ESM import.

const { contextBridge, ipcRenderer } = require("electron");

const api = {
  pickWorkspace: () => ipcRenderer.invoke("studio:pickWorkspace"),
  getConfig: () => ipcRenderer.invoke("studio:getConfig"),
  setConfig: (cfg) => ipcRenderer.invoke("studio:setConfig", cfg),
  start: (opts) => ipcRenderer.invoke("studio:start", opts),
  stop: () => ipcRenderer.invoke("studio:stop"),
  health: () => ipcRenderer.invoke("studio:health"),
  createTask: (args) => ipcRenderer.invoke("studio:createTask", args),
  listTasks: (args) => ipcRenderer.invoke("studio:listTasks", args),
  getTask: (id) => ipcRenderer.invoke("studio:getTask", id),
  getArtifact: (id, source, offset, limit) =>
    ipcRenderer.invoke("studio:getArtifact", id, source, offset, limit),
  cancelTask: (id) => ipcRenderer.invoke("studio:cancelTask", id),
  openDashboard: () => ipcRenderer.invoke("studio:openDashboard"),
  getServerLog: () => ipcRenderer.invoke("studio:getServerLog"),
  // Live server stdout/stderr stream. Returns an unsubscribe function.
  onServerLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on("studio:serverLog", handler);
    return () => ipcRenderer.removeListener("studio:serverLog", handler);
  }
};

contextBridge.exposeInMainWorld("studio", api);
