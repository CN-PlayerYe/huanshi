import { describe, expect, it } from "vitest";
import { CronError, describeCron, nextRunTime, parseCron } from "../server/cron";

describe("parseCron", () => {
  it("每天 9:00", () => {
    const s = parseCron("0 9 * * *");
    expect(s.minute.has(0)).toBe(true);
    expect(s.hour.has(9)).toBe(true);
    expect(s.day.size).toBe(31);
    expect(s.month.size).toBe(12);
    expect(s.dow.size).toBe(7);
  });

  it("每 30 分钟", () => {
    const s = parseCron("*/30 * * * *");
    expect(s.minute.has(0)).toBe(true);
    expect(s.minute.has(30)).toBe(true);
    expect(s.minute.has(15)).toBe(false);
  });

  it("范围与列表", () => {
    const s = parseCron("0 9-11,14 * * 1-5");
    expect(s.hour.has(9)).toBe(true);
    expect(s.hour.has(11)).toBe(true);
    expect(s.hour.has(14)).toBe(true);
    expect(s.hour.has(12)).toBe(false);
    expect(s.dow.has(1)).toBe(true);
    expect(s.dow.has(5)).toBe(true);
    expect(s.dow.has(0)).toBe(false);
  });

  it("非法表达式抛错", () => {
    expect(() => parseCron("60 * * * *")).toThrow(CronError); // 分钟越界
    expect(() => parseCron("* * * *")).toThrow(CronError); // 只有 4 段
    expect(() => parseCron("a b c d e")).toThrow(CronError); // 非数字
    expect(() => parseCron("5-1 * * * *")).toThrow(CronError); // 顺序错误
  });
});

describe("nextRunTime", () => {
  it("每天 9:00 的下一次", () => {
    const s = parseCron("0 9 * * *");
    const from = new Date("2026-08-04T10:30:00");
    const next = nextRunTime(s, from)!;
    expect(next.getTime()).toBe(new Date("2026-08-05T09:00:00").getTime());
  });

  it("每 30 分钟的下一次", () => {
    const s = parseCron("*/30 * * * *");
    const from = new Date("2026-08-04T10:15:00");
    const next = nextRunTime(s, from)!;
    expect(next.getTime()).toBe(new Date("2026-08-04T10:30:00").getTime());
  });

  it("工作日 9 点(周五后跳到周一)", () => {
    const s = parseCron("0 9 * * 1-5");
    const from = new Date("2026-08-07T12:00:00"); // 2026-08-07 是周五
    const next = nextRunTime(s, from)!;
    expect(next.getDay()).toBe(1); // 周一
    expect(next.getHours()).toBe(9);
  });
});

describe("describeCron", () => {
  it("人类可读描述", () => {
    expect(describeCron("0 9 * * *")).toContain("9");
    expect(describeCron("*/30 * * * *")).toContain("30");
  });
});
