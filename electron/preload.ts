import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hanalite", {
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke("get-backend-url"),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("get-app-version"),
});
