import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerHandle } from "../server";

// 必须在 app ready 前调用:禁用 GPU 加速,避免 Windows 驱动/远程桌面下 GPU 进程崩溃导致窗口闪退
app.disableHardwareAcceleration();

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

// 记录未捕获异常/崩溃,便于定位窗口闪退
process.on("uncaughtException", (err) => log(`uncaughtException: ${err.stack ?? String(err)}`));
process.on("unhandledRejection", (reason) => log(`unhandledRejection: ${String(reason)}`));
app.on("render-process-gone", (_event, _wc, details) => log(`render-process-gone: ${JSON.stringify(details)}`));
app.on("child-process-gone", (_event, details) => log(`child-process-gone: ${JSON.stringify(details)}`));
app.on("before-quit", () => log("before-quit"));

let backendUrl = "";
let serverHandle: ServerHandle | null = null;

// 窗口引用必须保持模块级,否则可能被 GC 回收导致窗口自动关闭
let mainWindow: BrowserWindow | null = null;
let lastThemeBg = "#f2eddf";

// 各主题对应的窗口背景色(避免加载白闪 / 边框与主题一致)
const THEME_BG: Record<string, string> = {
  dark: "#17181c",
  light: "#f3f5fa",
  ink: "#f2eddf",
};

function themeBg(theme: string): string {
  return THEME_BG[theme] ?? "#17181c";
}

/** 中文应用菜单(文件/编辑/视图/帮助),菜单行为为系统标准:点击弹出、再次点击收起 */
function installMenu(win: BrowserWindow): void {
  // 右键菜单:正文选中文字后右键 → “复制”(用 clipboard 硬写,不依赖 selection,100% 有效)
  // 避免 Electron 默认右键菜单不可靠/被吞导致“右键点不出东西、复制无效”
  win.webContents.on("context-menu", (_e, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push(
        { role: "undo", label: "撤销" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      );
    } else if (params.selectionText) {
      items.push({ label: "复制", click: () => clipboard.writeText(params.selectionText) });
    }
    items.push({ label: "全选", click: () => win.webContents.selectAll() });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  const send = (action: string) => () => win.webContents.send("menu", action);
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "文件(&F)",
      submenu: [
        { label: "新建会话", accelerator: "CmdOrCtrl+N", click: send("new-session") },
        { label: "设置", accelerator: "CmdOrCtrl+,", click: send("open-settings") },
        { type: "separator" },
        { label: "退出", role: "quit" },
      ],
    },
    {
      label: "编辑(&E)",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图(&V)",
      submenu: [
        { label: "切换主题(暗色/亮色/水墨)", accelerator: "CmdOrCtrl+Shift+L", click: send("toggle-theme") },
        { label: "折叠/展开侧栏", accelerator: "CmdOrCtrl+B", click: send("toggle-sidebar") },
        { type: "separator" },
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    {
      label: "帮助(&H)",
      submenu: [
        {
          label: "关于 幻世",
          click: () => {
            void dialog.showMessageBox(win, {
              type: "info",
              title: "幻世",
              message: "幻世 · 有记忆、有人格的私人 AI 助手",
              detail: `版本 ${app.getVersion()}\n数据与记忆仅存本机,可通过设置页修改数据目录。`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(bgColor: string): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: bgColor,
    title: "幻世",
    // 自绘标题栏:去掉 Windows 原生白色标题栏,颜色跟随主题(应用内 .titlebar 提供拖拽区)
    titleBarStyle: "hidden",
    titleBarOverlay: { color: bgColor, symbolColor: "#888888", height: 40 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.on("closed", () => {
    log("window closed");
    mainWindow = null;
  });
  mainWindow.on("close", () => {
    log("window close event");
  });
  // 窗口获得系统焦点时,确保键盘事件进入页面(避免点击后 caret 不出现/打字无效)
  mainWindow.on("focus", () => {
    mainWindow?.webContents.focus();
  });
  const win = mainWindow;

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
    if (serverHandle.dataFix) {
      log(`dataFix: 清理空消息 ${serverHandle.dataFix.cleanedEmpty} 条,思考归位 ${serverHandle.dataFix.fixedThinking} 条`);
    }

    ipcMain.handle("get-backend-url", () => backendUrl);
    ipcMain.handle("get-app-version", () => app.getVersion());

    // 原生确认对话框(避免 window.confirm 的焦点 bug)
    ipcMain.handle("confirm-dialog", async (_e, message: string): Promise<boolean> => {
      if (!mainWindow) return false;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: "question",
        buttons: ["取消", "确定"],
        defaultId: 1,
        cancelId: 0,
        message,
      });
      return response === 1;
    });

    // Windows 本地语音识别(SAPI,离线):听一句话(约 8 秒),返回识别文本
    ipcMain.handle("recognize-speech", async (): Promise<{ text: string; error?: string }> => {
      const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech | Out-Null
$ErrorActionPreference = "Stop"
try {
  $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine("zh-CN")
} catch {
  $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
}
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$r.SetInputToDefaultAudioDevice()
$result = $r.Recognize([TimeSpan]::FromSeconds(8))
if ($null -ne $result -and $result.Text) { Write-Output ("RESULT:" + $result.Text) } else { Write-Output "RESULT:" }
$r.Dispose()`;
      return await new Promise((resolve) => {
        execFile(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
          { timeout: 15_000, windowsHide: true },
          (err, stdout) => {
            if (err) {
              resolve({ text: "", error: `语音识别引擎启动失败:${err.message}` });
              return;
            }
            const m = /RESULT:(.*)/s.exec(stdout ?? "");
            resolve({ text: m ? m[1].trim() : "" });
          },
        );
      });
    });

    // 主题切换时同步窗口背景色(暗色下边框不再是白色)
    ipcMain.on("set-theme-bg", (_e, theme: string) => {
      mainWindow?.setBackgroundColor(themeBg(theme));
    });

    // 窗口整体透明度(可看到桌面)
    ipcMain.on("set-window-opacity", (_e, opacity: number) => {
      const v = Math.min(1, Math.max(0.1, Number(opacity) || 1));
      mainWindow?.setOpacity(v);
    });

    // 自绘标题栏按钮区颜色跟随聊天区遮罩(透明度联动;overlay 是系统层,尽力接近)
    ipcMain.on("set-titlebar-overlay", (_e, color: string) => {
      if (typeof color === "string" && color) {
        mainWindow?.setTitleBarOverlay({ color, symbolColor: "#888888", height: 40 });
      }
    });

    const settings = serverHandle.getSettings();
    lastThemeBg = themeBg(settings.theme ?? "ink");
    createWindow(lastThemeBg);
    installMenu(mainWindow!);
    log("window created");
  } catch (err) {
    log(`bootstrap failed: ${(err as Error).stack ?? String(err)}`);
  }
}

log("module loaded");
// 单实例锁:防止双击打开多个实例导致窗口叠加、点击错乱
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(bootstrap);
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(lastThemeBg);
    installMenu(mainWindow!);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

// 退出时关闭后端
app.on("before-quit", () => {
  void serverHandle?.close().catch(() => undefined);
});
