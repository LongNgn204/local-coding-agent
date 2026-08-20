// Local Coding Agent Tray — preload bridge.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs in a sandboxed, context-isolated preload. Exposes window.lcat with
// promise methods that forward to the main process over IPC. The renderer never
// touches Node, the filesystem, or child processes directly. CommonJS (.cjs) is
// required because sandboxed preloads do not support ESM import.

const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getConfig: () => ipcRenderer.invoke("lcat:getConfig"),
  setConfig: (patch) => ipcRenderer.invoke("lcat:setConfig", patch),
  saveSecret: (name, value) => ipcRenderer.invoke("lcat:saveSecret", name, value),
  clearSecret: (name) => ipcRenderer.invoke("lcat:clearSecret", name),
  pickDir: (title) => ipcRenderer.invoke("lcat:pickDir", title),
  pickFile: (title) => ipcRenderer.invoke("lcat:pickFile", title),
  start: (opts) => ipcRenderer.invoke("lcat:start", opts),
  stop: () => ipcRenderer.invoke("lcat:stop"),
  reconnectTunnel: () => ipcRenderer.invoke("lcat:reconnectTunnel"),
  getStatus: () => ipcRenderer.invoke("lcat:getStatus"),
  openDashboard: () => ipcRenderer.invoke("lcat:openDashboard"),
  copyMcpUrl: () => ipcRenderer.invoke("lcat:copyMcpUrl"),
  copyTunnelId: () => ipcRenderer.invoke("lcat:copyTunnelId"),
  getLogs: () => ipcRenderer.invoke("lcat:getLogs"),
  copyLogs: () => ipcRenderer.invoke("lcat:copyLogs"),
  openLogFolder: () => ipcRenderer.invoke("lcat:openLogFolder"),
  openConfigFolder: () => ipcRenderer.invoke("lcat:openConfigFolder"),
  getProfiles: () => ipcRenderer.invoke("lcat:getProfiles"),
  saveProfiles: (store) => ipcRenderer.invoke("lcat:saveProfiles", store),
  onStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on("lcat:status", handler);
    return () => ipcRenderer.removeListener("lcat:status", handler);
  },
  onLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on("lcat:log", handler);
    return () => ipcRenderer.removeListener("lcat:log", handler);
  },
  onOpenModal: (cb) => {
    const handler = (_e, name) => cb(name);
    ipcRenderer.on("lcat:openModal", handler);
    return () => ipcRenderer.removeListener("lcat:openModal", handler);
  }
};

contextBridge.exposeInMainWorld("lcat", api);