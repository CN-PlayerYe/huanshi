import { describe, expect, it } from "vitest";
import { nextHeartbeatAt, inQuietWindow, buildHeartbeatMessage, mergeHeartbeat, DEFAULT_HEARTBEAT } from "../server/heartbeat";
import type { AgentDef } from "../shared/types";

const agent: AgentDef = { id: "a", name: "星回", description: "", systemPrompt: "x", memoryEnabled: false };

describe("心跳节奏", () => {
  it("默认:每 3 小时一跳,23:00-7:00 静默", () => {
    const cfg = mergeHeartbeat();
    // 22:00 → 下一跳 0:00?22:00+3h=1:00 在静默内 → 推到 7:00 后第一个整点…验证逻辑:从 22:30 起下一跳
    const t = new Date(2026, 7, 7, 22, 30); // 22:30
    const next = nextHeartbeatAt(t, cfg);
    expect(next.getTime()).toBeGreaterThan(t.getTime());
    expect(inQuietWindow(next, cfg)).toBe(false); // 下一跳不能在静默时段
    // 静默时段判断
    expect(inQuietWindow(new Date(2026, 7, 7, 23, 30), cfg)).toBe(true);
    expect(inQuietWindow(new Date(2026, 7, 8, 3, 0), cfg)).toBe(true);
    expect(inQuietWindow(new Date(2026, 7, 7, 21, 0), cfg)).toBe(false);
  });

  it("自定义间隔与静默", () => {
    const cfg = mergeHeartbeat({ intervalHours: 1, quietStart: 22, quietEnd: 6 });
    expect(inQuietWindow(new Date(2026, 7, 7, 23, 0), cfg)).toBe(true);
    expect(inQuietWindow(new Date(2026, 7, 7, 21, 0), cfg)).toBe(false);
    const next = nextHeartbeatAt(new Date(2026, 7, 7, 21, 30), cfg);
    expect(next.getTime()).toBeGreaterThan(new Date(2026, 7, 7, 21, 30).getTime());
  });

  it("静默后第一跳落在 7:00 后", () => {
    const cfg = mergeHeartbeat({ intervalHours: 3 });
    // 23:30 触发(其实被静默拦)→ 直接算下一跳
    const next = nextHeartbeatAt(new Date(2026, 7, 7, 23, 30), cfg);
    expect(next.getHours()).toBeGreaterThanOrEqual(7);
    expect(next.getHours()).toBeLessThan(23);
  });
});

describe("心跳消息", () => {
  it("包含当下状态与「你自由了」", () => {
    const now = new Date(2026, 7, 7, 21, 30);
    const msg = buildHeartbeatMessage({
      now,
      lastBeatAt: now.getTime() - 3 * 3600_000,
      lastUserAt: now.getTime() - 2 * 3600_000,
      spaceStatus: "3 个文件,最近动过「心跳设计草案.md」",
      isBedtime: true,
      agent,
    });
    expect(msg).toContain("【心跳】");
    expect(msg).toContain("距上次心跳");
    expect(msg).toContain("主人上次说话");
    expect(msg).toContain("你自由了");
    expect(msg).toContain("睡前");
    expect(msg).not.toContain("undefined");
  });

  it("默认配置齐全", () => {
    expect(DEFAULT_HEARTBEAT.scope).toBe("self");
    expect(DEFAULT_HEARTBEAT.network).toBe("off");
    expect(DEFAULT_HEARTBEAT.commands).toBe("off");
    expect(DEFAULT_HEARTBEAT.maxMinutes).toBe(10);
    expect(DEFAULT_HEARTBEAT.interruptible).toBe(true);
  });
});
