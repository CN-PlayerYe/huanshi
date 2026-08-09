// 最小 Electron 探针:只创建窗口,不加载业务代码。用于区分"Electron 环境问题" vs "幻世代码问题"
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const log = (m) => fs.appendFileSync("C:/tmp/electron-probe.log", new Date().toISOString() + " " + m + "\n");

app.disableHardwareAcceleration();
let win;
log("start");
app.whenReady().then(() => {
  log("ready");
  win = new BrowserWindow({ width: 500, height: 400, title: "electron-probe" });
  win.loadURL("data:text/html,<h1>probe alive</h1>");
  win.on("closed", () => log("window closed"));
  log("window created");
});
app.on("before-quit", () => log("before-quit"));
app.on("render-process-gone", (_e, _w, d) => log("render-gone " + JSON.stringify(d)));
process.on("uncaughtException", (e) => log("uncaught " + e.message));
setInterval(() => log("tick"), 10000);
