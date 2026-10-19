import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 本地模型(llama.cpp)生命周期管理:让幻世自己拉起 llama-server,不必每次先手动开它。
 * - 随幻世启动(spawn,参数:--model <gguf> --port <port> --jinja + extraArgs)
 * - 轮询 /health 直到就绪(否则聊天第一次请求会打到未启动的端口)
 * - 退出幻世时结束进程(Windows 用 taskkill /T 连带子进程,防 CUDA 进程残留)
 * - stdout/stderr 落 logs/llama-server.log
 */

export type LocalModelState = "stopped" | "starting" | "ready" | "error";

export interface LocalModelConfig {
  autoStart?: boolean;
  serverPath?: string;
  modelPath?: string;
  port?: number;
  extraArgs?: string;
}

let proc: ChildProcess | null = null;
let state: LocalModelState = "stopped";
let stateDetail = "";
let currentPort = 8080;

export function localModelStatus(): { state: LocalModelState; detail: string; port: number; pid?: number } {
  return { state, detail: stateDetail, port: currentPort, pid: proc?.pid };
}

function logFile(dataDir: string): string {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "llama-server.log");
}

function writeLog(file: string, line: string): void {
  try {
    appendFileSync(file, `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${line}\n`, "utf8");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 把 "a b \"c d\"" 拆成参数数组(支持双引号包裹的路径) */
export function splitArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(m[1] ?? m[2]);
  return out.filter(Boolean);
}

/** 轮询 /health,直到就绪或超时 */
async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!proc) return false; // 进程已退出
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

export async function startLocalModel(cfg: LocalModelConfig | undefined, dataDir: string): Promise<void> {
  if (!cfg?.autoStart) return;
  if (!cfg.serverPath || !cfg.modelPath) {
    state = "error";
    stateDetail = "未填 llama-server 路径或模型路径";
    return;
  }
  if (!existsSync(cfg.serverPath)) {
    state = "error";
    stateDetail = `找不到 llama-server:${cfg.serverPath}`;
    return;
  }
  if (!existsSync(cfg.modelPath)) {
    state = "error";
    stateDetail = `找不到模型文件:${cfg.modelPath}`;
    return;
  }
  const port = Number(cfg.port) || 8080;
  currentPort = port;
  // 端口已有服务(用户已手动开着 llm) → 直接当就绪,不重复启动
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      state = "ready";
      stateDetail = `端口 ${port} 已有服务,直接使用`;
      return;
    }
  } catch {
    /* 端口空着,正常 */
  }

  const log = logFile(dataDir);
  const args = ["--model", cfg.modelPath, "--port", String(port), "--jinja", ...splitArgs(cfg.extraArgs ?? "")];
  state = "starting";
  stateDetail = `启动中(:${port})`;
  writeLog(log, `start: ${cfg.serverPath} ${args.join(" ")}`);
  try {
    proc = spawn(cfg.serverPath, args, {
      cwd: dirname(cfg.serverPath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    state = "error";
    stateDetail = `启动失败:${(err as Error).message}`;
    return;
  }
  proc.stdout?.on("data", (d) => writeLog(log, String(d).trimEnd()));
  proc.stderr?.on("data", (d) => writeLog(log, String(d).trimEnd()));
  proc.on("exit", (code) => {
    if (state !== "stopped") {
      state = "error";
      stateDetail = `llama-server 已退出(code=${code}),详见 logs/llama-server.log`;
    }
    proc = null;
  });

  const ready = await waitForReady(port, 90_000);
  if (ready) {
    state = "ready";
    stateDetail = `就绪(:${port})`;
    writeLog(log, `ready on ${port}`);
  } else if (state === "starting") {
    state = "error";
    stateDetail = "启动超时(90 秒),详见 logs/llama-server.log";
    writeLog(log, "ready timeout");
  }
}

export function stopLocalModel(): void {
  const p = proc;
  state = "stopped";
  stateDetail = "";
  if (!p?.pid) return;
  proc = null;
  try {
    if (process.platform === "win32") {
      // taskkill /T 连带子进程:pip 版 llama-server 会再 spawn worker,CUDA 上下文不连带会残留
      spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      p.kill("SIGTERM");
    }
  } catch {
    /* 已经没了 */
  }
}
