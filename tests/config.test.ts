import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs, loadSettings, resolveDataDir, saveSettings, writeDataDirRedirect } from "../server/config";
import { DEFAULT_SETTINGS } from "../shared/types";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hanalite-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveDataDir 数据目录解析优先级", () => {
  it("环境变量 HANA_HOME 优先", () => {
    const r = resolveDataDir({ env: { HANA_HOME: join(tmp, "env-home") }, argv: [] });
    expect(r.dataDir).toBe(join(tmp, "env-home"));
    expect(r.portable).toBe(false);
  });

  it("HANALITE_HOME 同样生效", () => {
    const r = resolveDataDir({ env: { HANALITE_HOME: join(tmp, "lite-home") }, argv: [] });
    expect(r.dataDir).toBe(join(tmp, "lite-home"));
  });

  it("启动参数 --data-dir 优先于环境变量?不,环境变量优先", () => {
    const r = resolveDataDir({ env: { HANA_HOME: join(tmp, "env") }, argv: ["node", "x", "--data-dir", join(tmp, "arg")] });
    expect(r.dataDir).toBe(join(tmp, "env"));
  });

  it("无环境变量时 --data-dir 生效", () => {
    const r = resolveDataDir({ env: {}, argv: ["node", "x", "--data-dir", join(tmp, "arg")] });
    expect(r.dataDir).toBe(join(tmp, "arg"));
  });

  it("portable 模式:exe 旁有 data 目录", () => {
    const exeDir = join(tmp, "app");
    mkdirSync(join(exeDir, "data"), { recursive: true });
    writeFileSync(join(exeDir, "data", "x.txt"), "x");
    const r = resolveDataDir({ env: {}, argv: [], appPath: join(exeDir, "HanaLite.exe"), isPackaged: true });
    expect(r.dataDir).toBe(join(exeDir, "data"));
    expect(r.portable).toBe(true);
  });

  it("重定向文件生效", () => {
    const redirectFile = join(tmp, "appdata", "HanaLite", "data-dir.txt");
    mkdirSync(join(tmp, "appdata", "HanaLite"), { recursive: true });
    writeFileSync(redirectFile, join(tmp, "redirect-target"), "utf-8");
    const r = resolveDataDir({ env: { APPDATA: join(tmp, "appdata") }, argv: [] });
    expect(r.dataDir).toBe(join(tmp, "redirect-target"));
  });

  it("默认目录", () => {
    const r = resolveDataDir({ env: {}, argv: [] });
    expect(r.dataDir.endsWith(".huanshi")).toBe(true);
  });
});

describe("settings 保存/加载", () => {
  it("往返一致", () => {
    ensureDirs(resolveDataDir({ env: {}, argv: [] }));
    const s: typeof DEFAULT_SETTINGS = {
      ...DEFAULT_SETTINGS,
      dataDir: tmp,
      providers: { deepseek: { kind: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-123", model: "deepseek-chat" } },
      activeProvider: "deepseek",
      memory: { ...DEFAULT_SETTINGS.memory, mode: "hindsight", hindsightBaseUrl: "http://localhost:8888" },
    };
    saveSettings(tmp, s);
    const loaded = loadSettings(tmp);
    expect(loaded.providers.deepseek?.model).toBe("deepseek-chat");
    expect(loaded.memory.mode).toBe("hindsight");
    expect(loaded.dataDir).toBe(tmp);
  });

  it("损坏文件回退默认", () => {
    writeFileSync(join(tmp, "settings.json"), "{broken json", "utf-8");
    const loaded = loadSettings(tmp);
    expect(loaded.activeProvider).toBe("");
  });
});

describe("writeDataDirRedirect", () => {
  it("写入并读取", () => {
    const file = join(tmp, "rd", "data-dir.txt");
    writeDataDirRedirect(file, join(tmp, "new-data"));
    expect(require("node:fs").readFileSync(file, "utf-8")).toBe(join(tmp, "new-data"));
  });
});
