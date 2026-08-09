import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types";

/**
 * 数据目录解析优先级:
 *   1. 环境变量 HANA_HOME / HANALITE_HOME
 *   2. 启动参数 --data-dir <path>
 *   3. portable 模式:可执行文件旁的 data-dir.txt 指向的目录,或 exe 旁 data/ 目录
 *   4. 重定向文件 %APPDATA%/HanaLite/data-dir.txt(旧版路径,兼容老用户;新版为 %APPDATA%/幻世)
 *   5. 默认 ~/.huanshi
 */

const REDIRECT_FILE = "data-dir.txt";

export interface ResolvedPaths {
  dataDir: string;
  portable: boolean;
  redirectFile: string;
  dirs: {
    db: string;
    memory: string;
    workspace: string;
    logs: string;
  };
}

export function resolveDataDir(opts: {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  appPath?: string;
  isPackaged?: boolean;
}): ResolvedPaths {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv;
  const isPackaged = opts.isPackaged ?? false;

  // 1. 环境变量
  for (const key of ["HANA_HOME", "HANALITE_HOME"]) {
    const v = env[key];
    if (v && v.trim()) {
      return buildPaths(resolve(v.trim()), false, "");
    }
  }

  // 2. 启动参数 --data-dir
  const idx = argv.indexOf("--data-dir");
  if (idx >= 0 && argv[idx + 1]) {
    return buildPaths(resolve(argv[idx + 1]), false, "");
  }

  // 3. portable 模式:可执行文件/应用所在目录
  //    electron-builder 的 portable 单文件会设置 PORTABLE_EXECUTABLE_DIR 指向用户放置的位置
  const portableExeDir = env.PORTABLE_EXECUTABLE_DIR;
  const exeDir = portableExeDir || (isPackaged && opts.appPath ? dirname(opts.appPath) : "");
  if (exeDir) {
    const portableDir = join(exeDir, "data");
    const marker = join(exeDir, "portable.txt");
    if (existsSync(marker) || existsSync(portableDir)) {
      return buildPaths(portableDir, true, join(exeDir, REDIRECT_FILE));
    }
  }

  // 4. 重定向文件(设置页修改数据目录)
  const appData = env.APPDATA || join(homedir(), ".config");
  const redirectFile = join(appData, "HanaLite", REDIRECT_FILE);
  if (existsSync(redirectFile)) {
    const target = readFileSync(redirectFile, "utf-8").trim();
    if (target) {
      return buildPaths(resolve(target), false, redirectFile);
    }
  }

  // 5. 默认
  return buildPaths(join(homedir(), ".huanshi"), false, redirectFile);
}

function buildPaths(dataDir: string, portable: boolean, redirectFile: string): ResolvedPaths {
  return {
    dataDir,
    portable,
    redirectFile,
    dirs: {
      db: join(dataDir, "db"),
      memory: join(dataDir, "memory"),
      workspace: join(dataDir, "workspace"),
      logs: join(dataDir, "logs"),
    },
  };
}

export function ensureDirs(paths: ResolvedPaths): void {
  for (const dir of [paths.dataDir, ...Object.values(paths.dirs)]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function writeDataDirRedirect(redirectFile: string, target: string): void {
  const dir = dirname(redirectFile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(redirectFile, resolve(target), "utf-8");
}

// ---- Settings 加载/保存 ----

const SETTINGS_FILE = "settings.json";

export function loadSettings(dataDir: string): Settings {
  const file = join(dataDir, SETTINGS_FILE);
  if (!existsSync(file)) {
    return { ...DEFAULT_SETTINGS, dataDir };
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...raw,
      memory: { ...DEFAULT_SETTINGS.memory, ...(raw.memory ?? {}) },
      providers: raw.providers ?? {},
    };
    merged.dataDir = dataDir;
    return merged;
  } catch (err) {
    console.error("[config] settings.json 解析失败,使用默认设置:", err);
    return { ...DEFAULT_SETTINGS, dataDir };
  }
}

export function saveSettings(dataDir: string, settings: Settings): void {
  const file = join(dataDir, SETTINGS_FILE);
  writeFileSync(file, JSON.stringify(settings, null, 2), "utf-8");
}
