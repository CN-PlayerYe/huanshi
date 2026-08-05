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
  /** 调整整个窗口透明度(0.1-1,可看到桌面) */
  setWindowOpacity: (opacity: number): void => {
    ipcRenderer.send("set-window-opacity", opacity);
  },
  /** Windows 本地语音识别(SAPI,离线):听一句话返回文本 */
  recognizeSpeech: (): Promise<{ text: string; error?: string }> => ipcRenderer.invoke("recognize-speech"),
});
