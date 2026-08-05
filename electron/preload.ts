import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hanalite", {
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke("get-backend-url"),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("get-app-version"),
  /** 监听应用菜单动作 */
  onMenuEvent: (cb: (action: string) => void): void => {
    ipcRenderer.on("menu", (_e, action: string) => cb(action));
  },
  /** 主题变化时同步窗口背景色 */
  setThemeBg: (theme: string): void => {
    ipcRenderer.send("set-theme-bg", theme);
  },
});
