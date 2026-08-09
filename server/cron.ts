/**
 * 轻量 cron 表达式解析器(5 段:分 时 日 月 星期)。
 * 支持:*、步进(如 每15分钟)、范围(a-b)、列表(a,b)混合;星期 0-6(0=周日)。
 */

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  dow: Set<number>; // 0-6
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`cron 表达式需要 5 段(分 时 日 月 星期),收到 ${parts.length} 段:${expr}`);
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    day: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
  };
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const p = part.trim();
    if (!p) throw new CronError(`字段为空:${field}`);
    if (p === "*") {
      for (let i = min; i <= max; i++) out.add(i);
      continue;
    }
    const stepMatch = p.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (step <= 0) throw new CronError(`步长无效:${p}`);
      const base = stepMatch[1] === "*" ? null : parseRange(stepMatch[1], min, max);
      const start = base ? Math.min(...base) : min;
      const end = base ? Math.max(...base) : max;
      for (let v = start; v <= end; v += step) {
        if (!base || base.has(v)) out.add(v);
      }
      continue;
    }
    const range = parseRange(p, min, max);
    for (const v of range) out.add(v);
  }
  if (!out.size) throw new CronError(`字段无有效值:${field}`);
  return out;
}

function parseRange(part: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  const m = part.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new CronError(`无法解析 cron 字段:${part}`);
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (a < min || a > max || b < min || b > max || a > b) {
    throw new CronError(`cron 值越界或顺序错误:${part}(范围 ${min}-${max})`);
  }
  for (let v = a; v <= b; v++) out.add(v);
  return out;
}

/** 计算 from 之后的下一次执行时间(含 from 所在分钟,最多搜索 370 天) */
export function nextRunTime(schedule: CronSchedule, from: Date): Date | null {
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 0; i < 370 * 24 * 60; i++) {
    if (
      schedule.minute.has(d.getMinutes()) &&
      schedule.hour.has(d.getHours()) &&
      schedule.day.has(d.getDate()) &&
      schedule.month.has(d.getMonth() + 1) &&
      schedule.dow.has(d.getDay())
    ) {
      return new Date(d);
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export function describeCron(expr: string): string {
  try {
    const s = parseCron(expr);
    const parts: string[] = [];
    if (s.minute.size === 60) parts.push("每分钟");
    else parts.push(`第 ${fmt(s.minute)} 分`);
    if (s.hour.size !== 24) parts.push(`${fmt(s.hour)} 时`);
    if (s.day.size !== 31) parts.push(`${fmt(s.day)} 日`);
    if (s.month.size !== 12) parts.push(`${fmt(s.month)} 月`);
    if (s.dow.size === 7) parts.push("每天");
    else parts.push(`周${fmtDow(s.dow)}`);
    return parts.join(" ");
  } catch {
    return expr;
  }
}

function fmt(set: Set<number>): string {
  const arr = [...set].sort((a, b) => a - b);
  if (arr.length > 4) return `${arr[0]}-${arr[arr.length - 1]}`;
  return arr.join(",");
}

const DOW_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
function fmtDow(set: Set<number>): string {
  return [...set].sort((a, b) => a - b).map((d) => DOW_NAMES[d]).join(",");
}
