import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerHandle } from "../server";

// GUI 子系统下 console 可能不可见,关键路径写文件便于诊断
function bootLogPath(): string {
  return join(app.getPath("userData"), "boot.log");
}
function truncateLog(): void {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(bootLogPath(), "");
  } catch {
    /* ignore */
  }
}
function log(msg: string): void {
  try {
    writeFileSync(bootLogPath(), `${new Date().toISOString()} ${msg}\n`, { flag: "a" });
  } catch {
    /* ignore */
  }
}
truncateLog();

let backendUrl = "";
let serverHandle: ServerHandle | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: "#17181c",
    title: "HanaLite",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const dev = process.env.NODE_ENV === "development";
  if (dev) {
    void win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "..", "..", "dist-renderer", "index.html"));
  }

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
}

async function bootstrap(): Promise<void> {
  try {
    log("bootstrap start");
    serverHandle = await createServer({
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      appPath: app.isPackaged ? app.getPath("exe") : undefined,
    });
    backendUrl = `http://127.0.0.1:${serverHandle.port}`;
    log(`backend at ${backendUrl}`);

    ipcMain.handle("get-backend-url", () => backendUrl);
    ipcMain.handle("get-app-version", () => app.getVersion());

    createWindow();
    log("window created");
  } catch (err) {
    log(`bootstrap failed: ${(err as Error).stack ?? String(err)}`);
  }
}

log("module loaded");
void app.whenReady().then(bootstrap);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

// 退出时关闭后端
app.on("before-quit", () => {
  void serverHandle?.close().catch(() => undefined);
});
