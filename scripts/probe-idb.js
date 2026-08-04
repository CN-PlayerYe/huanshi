// 验证:用 Electron 的 Chromium 引擎读取 Cherry Studio 的 IndexedDB(复制副本,无需关闭 Cherry Studio)
const { app, session, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const CS_IDB_DIR = process.env.CS_IDB_DIR || "G:/cnpla/Documents/CherryStudio/IndexedDB";
const TMP_ROOT = path.join(app.getPath("temp"), "cs-idb-probe-" + Date.now());

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f === "LOCK" || f === "LOG") continue;
    const s = path.join(src, f);
    const d = path.join(dst, f);
    try {
      if (fs.statSync(s).isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    } catch (e) {
      console.log("skip", f, e.message);
    }
  }
}

app.whenReady().then(async () => {
  try {
    copyDir(CS_IDB_DIR, path.join(TMP_ROOT, "IndexedDB"));
    console.log("copied to", TMP_ROOT);

    const ses = session.fromPath(TMP_ROOT);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: ses, contextIsolation: false, nodeIntegration: false },
    });

    let done = false;
    const finish = (tag) => {
      if (done) return;
      done = true;
      console.log(tag);
      app.quit();
    };

    win.webContents.on("page-title-updated", (_e, title) => {
      if (title.startsWith("DONE:") || title.startsWith("ERR:")) {
        console.log("TITLE:", title.slice(0, 3000));
        finish("PROBE_DONE");
      }
    });

    await win.loadFile(path.join(__dirname, "probe-idb.html"));
    setTimeout(() => finish("TIMEOUT(5s)"), 5000);
  } catch (e) {
    console.error("probe failed:", e);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
