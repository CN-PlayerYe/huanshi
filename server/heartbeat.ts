import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
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
 * 动态间隔(心跳规格 §一):根据主人活跃度与空跳次数自动调整。
 * - 主人刚聊完(30 分钟内)→ 间隔拉长到 ≥6h(避免任务化)
 * - 主人久未出现(>24h)→ 间隔加密到 ≤2h(院子空了,看家)
 * - 连续空跳 → 间隔翻倍(防空转)
 */
export function effectiveInterval(hb: Required<HeartbeatConfig>, blankBeats: number, lastUserAt?: number): number {
  let base = Math.max(1, hb.intervalHours);
  // 连续空跳:第 2 次起翻倍(最多 8 倍)
  if (blankBeats >= 2) {
    base *= Math.min(8, 2 ** (blankBeats - 1));
  }
  if (lastUserAt) {
    const hours = (Date.now() - lastUserAt) / 3600_000;
    if (hours <= 0.5) {
      base = Math.max(base, 6); // 刚聊完:拉长
    } else if (hours > 24) {
      base = Math.min(base, 2); // 久未出现:加密
    }
  }
  return Math.max(1, Math.min(24, Math.round(base)));
}

/** 计算下一次心跳时间(使用动态间隔) */
export function nextHeartbeatAt(
  now: Date,
  cfg: Required<HeartbeatConfig>,
  opts?: { blankBeats?: number; lastUserAt?: number },
): Date {
  const step = Math.max(1, effectiveInterval(cfg, opts?.blankBeats ?? 0, opts?.lastUserAt)) * 3600_000;
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
  /** 自己空间(院子)的完整路径,让人格知道"家"在哪 */
  homeDir: string;
  /** 是否该写"睡前日志"(bedtimeHour 后的第一次心跳) */
  isBedtime: boolean;
  /** 心念续接:上次的足迹(未完成的事/新念头),来自待定之页或最近笔记 */
  footprint?: string;
  agent: AgentDef;
}

/**
 * 生成心跳消息:动态反映当下状态,把"选择权"交给人格,而不是派任务。
 * 这是心跳与闹钟的分水岭——最后一句:「你自由了」。
 */
export function buildHeartbeatMessage(ctx: HeartbeatContext): string {
  const { now, lastBeatAt, lastUserAt, spaceStatus, homeDir, isBedtime, footprint, agent } = ctx;
  const sinceBeat = lastBeatAt ? humanDuration(now.getTime() - lastBeatAt) : "第一跳";
  const userAgo = lastUserAt ? `主人上次说话:${humanAgo(lastUserAt)}` : "";
  const bedtime = isBedtime
    ? "\n(系统)到休息时间了。想睡前散散步、写篇日志也可以——这是自动心跳的例行提醒,不是主人的实时消息。"
    : "";
  const foot = footprint ? `\n足迹:${footprint}` : "";
  return `【心跳·系统自动,不是主人实时说话】现在是 ${now.toLocaleString("zh-CN", { hour12: false })} ${["日", "一", "二", "三", "四", "五", "六"][now.getDay()]}曜日
距上次心跳:${sinceBeat}${userAgo ? ` | ${userAgo}` : ""}
你的空间:${homeDir}(${spaceStatus})${foot}${bedtime}
——开始前,先回一趟记忆库:调用 memory_recall 回忆"我是谁、最近发生过什么",再去决定做什么。
——你自由了。可以做事,也可以只写一行字,然后回去睡。`;
}

/**
 * 心念续接(心跳规格 §二):读取人格空间里的"足迹"——
 * 优先「待定之页.md」,其次最近修改的 .md/.txt 笔记,取开头片段。
 */
export function readFootprint(dir: string): string {
  const candidates = ["待定之页.md", "待定之页.txt"];
  for (const name of candidates) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, "utf-8").slice(0, 200).replace(/\s+/g, " ").trim();
        return text ? `你上次写下的念头:「${text}${text.length >= 200 ? "…" : ""}」` : "";
      } catch {
        /* 跳过 */
      }
    }
  }
  // 兜底:最近修改的 .md/.txt 文件
  try {
    if (!existsSync(dir)) return "";
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return "";
    const text = readFileSync(join(dir, files[0].f), "utf-8").slice(0, 200).replace(/\s+/g, " ").trim();
    return text ? `你最近写过:「${text.slice(0, 150)}${text.length >= 150 ? "…" : ""}」` : "";
  } catch {
    return "";
  }
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
