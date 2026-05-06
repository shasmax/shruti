/**
 * Preload bridge — exposes a typed `window.shruti` to the renderer.
 * Renderer cannot reach Node directly (contextIsolation = true);
 * everything goes through these named IPC channels.
 */
import { contextBridge, ipcRenderer } from "electron";

const api = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:set", patch),
  },
  meetings: {
    list: () => ipcRenderer.invoke("meetings:list"),
    get: (id: string) => ipcRenderer.invoke("meetings:get", id),
    delete: (id: string) => ipcRenderer.invoke("meetings:delete", id),
    update: (id: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke("meetings:update", id, patch),
    resummarize: (id: string) => ipcRenderer.invoke("meetings:resummarize", id),
  },
  recording: {
    start: () => ipcRenderer.invoke("recording:start"),
    stop: () => ipcRenderer.invoke("recording:stop"),
    status: () => ipcRenderer.invoke("recording:status"),
    onStatus: (cb: (evt: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on("recording:status", listener);
      return () => ipcRenderer.removeListener("recording:status", listener);
    },
  },
};

contextBridge.exposeInMainWorld("shruti", api);

export type ShrutiApi = typeof api;
