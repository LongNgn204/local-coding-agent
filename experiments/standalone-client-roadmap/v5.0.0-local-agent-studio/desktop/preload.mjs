import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("localAgentStudio", {
  platform: process.platform,
  privileged(action, payload = {}) {
    return ipcRenderer.invoke("lca:privileged", { action, payload });
  }
});
