import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, HeartbeatConfig } from "../shared/types";

/** 心跳默认配置 */
export const DEFAULT_HEARTBEAT: Required<HeartbeatConfig> = {
  intervalHours: 3,
  quietStart: 23,
  quietEnd: 7,
  bedtimeHour: 21,
  scope: "self",
  network: "off",
  commands: "off",
  maxMinutes: 10,
  interruptible: true,
};

export function mergeHeartbeat(cfg?: HeartbeatConfig): Required<HeartbeatConfig> {
  return { ...DEFAULT_HEARTBEAT, ...cfg };
}

/** 当前时间是否在静默时段(23:00-7:00)内 */
export function inQuietWindow(now: Date, cfg: Required<HeartbeatConfig>): boolean {
  const h = now.getHours();
  if (cfg.quietStart <= cfg.quietEnd) {
    return h >= cfg.quietStart && h < cfg.quietEnd;
  }
  // 跨天(如 23-7):h>=23 或 h<7
  return h >= cfg.quietStart || h < cfg.quietEnd;
}

/**
 * 计算下一次心跳时间:now 后最近的"不在静默时段"的心跳点。
 * 心跳点在每个 intervalHours 的整数倍时刻(对齐 0 点),与 cron 无关。
 */
export function nextHeartbeatAt(now: Date, cfg: Required<HeartbeatConfig>): Date {
  const step = Math.max(1, cfg.intervalHours) * 3600_000;
  // 从 0 点对齐:找 now 之后第一个整数倍心跳点
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const since = now.getTime() - dayStart.getTime();
  const beatsToday = Math.floor(since / step) + 1; // 下一个心跳点(第 beatsToday 个)
  let candidate = new Date(dayStart.getTime() + beatsToday * step);
  // 跳过静默时段:若落在静默内,推到静默结束后的第一个心跳点
  for (let i = 0; i < 48; i++) {
    if (!inQuietWindow(candidate, cfg)) return candidate;
    candidate = new Date(candidate.getTime() + step);
  }
  return candidate;
}

/** 人性化时长(如 "2小时57分") */
function humanDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 主人上次说话距今(人性化) */
function humanAgo(ts?: number): string {
  if (!ts) return "很久以前";
  return humanDuration(Date.now() - ts) + "前";
}

export interface HeartbeatContext {
  now: Date;
  lastBeatAt?: number;
  lastUserAt?: number;
  /** 自己空间目录状态:文件数 + 最后修改时间(人性化) */
  spaceStatus: string;
  /** 是否该写"睡前日志"(bedtimeHour 后的第一次心跳) */
  isBedtime: boolean;
  agent: AgentDef;
}

/**
 * 生成心跳消息:动态反映当下状态,把"选择权"交给人格,而不是派任务。
 * 这是心跳与闹钟的分水岭——最后一句:「你自由了」。
 */
export function buildHeartbeatMessage(ctx: HeartbeatContext): string {
  const { now, lastBeatAt, lastUserAt, spaceStatus, isBedtime, agent } = ctx;
  const sinceBeat = lastBeatAt ? humanDuration(now.getTime() - lastBeatAt) : "第一跳";
  const bedtime = isBedtime
    ? "\n该睡了——如果你愿意,睡前散散步,写一篇日志再睡。"
    : "";
  return `【心跳】现在是 ${now.toLocaleString("zh-CN", { hour12: false })} ${["日", "一", "二", "三", "四", "五", "六"][now.getDay()]}曜日
距上次心跳:${sinceBeat}
主人上次说话:${humanAgo(lastUserAt)}
你的空间:${spaceStatus}
${bedtime}
——你自由了。可以做事,也可以只写一行字,然后回去睡。`;
}

/**
 * 扫描人格空间(workspace/<agent名>/)并返回一行状态描述。
 */
export function scanAgentSpace(dir: string): string {
  if (!existsSync(dir)) return "空(还没有自己的院子)";
  try {
    const entries = readdirSync(dir);
    if (!entries.length) return "空(还没有自己的院子)";
    let last = 0;
    let newest = "";
    for (const e of entries) {
      try {
        const st = statSync(join(dir, e));
        if (st.mtimeMs > last) {
          last = st.mtimeMs;
          newest = e;
        }
      } catch {
        /* 跳过 */
      }
    }
    const ago = last ? humanDuration(Date.now() - last) + "前" : "";
    return `${entries.length} 个文件${newest ? `,最近动过「${newest}」(${ago})` : ""}`;
  } catch {
    return "读取失败";
  }
}
