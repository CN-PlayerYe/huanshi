import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 后台/降级路径的日志管道(console + 落盘)。
 * 生产环境 Electron 主进程没有控制台,console 输出会凭空消失——落盘后用户可查:
 *   数据目录/logs/errors.log
 * 判据:凡是"用户可见行为会变、或磁盘状态可能与内存不一致"的吞错,都留一行。
 */
function write(tag: string, msg: string, dataDir?: string): void {
  console.error(`[${tag}]`, msg);
  if (!dataDir) return;
  try {
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    appendFileSync(join(dataDir, "logs", "errors.log"), `${new Date().toISOString()} [${tag}] ${msg}\n`);
  } catch {
    /* 日志写入失败无所谓 */
  }
}

/** 后台任务失败(API 调用、生成任务等) */
export function logError(tag: string, err: unknown, dataDir?: string): void {
  write(tag, err instanceof Error ? err.message : String(err), dataDir);
}

/** 可容忍但有影响的降级(文件移动失败、启动修复失败等)——状态可能与预期不一致 */
export function logWarn(tag: string, detail: unknown, dataDir?: string): void {
  write(`${tag}·warn`, detail instanceof Error ? detail.message : String(detail), dataDir);
}
