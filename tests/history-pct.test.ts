import { describe, expect, it } from "vitest";
import { sliceHistoryByPct } from "../server/agent/engine";
import type { AgentDef, ChatMessage } from "../shared/types";

function msg(role: "user" | "assistant", text: string): ChatMessage {
  return { id: `m-${Math.random()}`, sessionId: "s", role, parts: [{ type: "text", text }], createdAt: Date.now() };
}
function agent(over: Partial<AgentDef> = {}): AgentDef {
  return { id: "a", name: "t", description: "", systemPrompt: "x", memoryEnabled: false, ...over };
}

describe("sliceHistoryByPct(历史上下文百分比)", () => {
  it("pct=100 真无限(全部发送),pct=50 大约只留一半", () => {
    // 每条约 100 字 ≈ 50 token,20 条总 1000 token
    const msgs = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? "assistant" : "user", "长".repeat(100)));
    const all = sliceHistoryByPct(msgs, agent({ historyContextPct: 100 }));
    expect(all).toHaveLength(20);
    const half = sliceHistoryByPct(msgs, agent({ historyContextPct: 50 }));
    expect(half.length).toBeGreaterThanOrEqual(8);
    expect(half.length).toBeLessThanOrEqual(14);
    // 保留的是最近的
    expect(half[half.length - 1]).toBe(msgs[19]);
  });

  it("pct=0 几乎不保留(只留最近一条)", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user", "长".repeat(100)));
    const r = sliceHistoryByPct(msgs, agent({ historyContextPct: 0 }));
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it("兼容旧配置:historyUnlimited=true 等效 100,未设置用默认窗口", () => {
    const msgs = Array.from({ length: 500 }, (_, i) => msg(i % 2 ? "assistant" : "user", "字"));
    expect(sliceHistoryByPct(msgs, agent({ historyUnlimited: true })).length).toBe(500);
    expect(sliceHistoryByPct(msgs, agent({})).length).toBe(30);
  });
});
