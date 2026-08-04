import { describe, expect, it } from "vitest";
import { buildSystemPrompt, historyToProviderMessages, toProviderMsg } from "../server/agent/engine";
import { defaultAgents } from "../server/agents";
import type { ChatMessage } from "../shared/types";

describe("toProviderMsg 历史消息转换", () => {
  it("user 消息", () => {
    const m: ChatMessage = {
      id: "1",
      sessionId: "s",
      role: "user",
      parts: [{ type: "text", text: "你好" }],
      createdAt: 0,
    };
    expect(toProviderMsg(m)).toEqual({ role: "user", content: "你好" });
  });

  it("assistant 带工具调用", () => {
    const m: ChatMessage = {
      id: "2",
      sessionId: "s",
      role: "assistant",
      parts: [
        { type: "text", text: "让我查一下" },
        { type: "tool", tool: { id: "t1", name: "get_datetime", input: "{}", output: "2025", status: "done", startedAt: 0 } },
      ],
      createdAt: 0,
    };
    const out = toProviderMsg(m);
    expect(out.role).toBe("assistant");
    expect(out.content).toBe("让我查一下");
    expect(out.toolCalls).toEqual([{ id: "t1", name: "get_datetime", arguments: "{}" }]);
  });
});

describe("buildSystemPrompt", () => {
  it("包含人格、环境与记忆块", () => {
    const agent = defaultAgents()[0];
    const prompt = buildSystemPrompt(agent, "C:\\data", "C:\\work", "\n\n【长期记忆】\n- 用户喜欢咖啡");
    expect(prompt).toContain("小和");
    expect(prompt).toContain("C:\\work");
    expect(prompt).toContain("用户喜欢咖啡");
  });

  it("无记忆块时正常", () => {
    const agent = defaultAgents()[0];
    const prompt = buildSystemPrompt(agent, "C:\\data", "", "");
    expect(prompt).not.toContain("【长期记忆】");
  });
});

describe("defaultAgents", () => {
  it("内置 3 个人格且工具齐全", () => {
    const agents = defaultAgents();
    expect(agents).toHaveLength(3);
    for (const a of agents) {
      expect(a.tools).toContain("read_file");
      expect(a.tools).toContain("memory_recall");
      expect(a.memoryEnabled).toBe(true);
    }
  });
});

describe("historyToProviderMessages(工具调用历史回放)", () => {
  it("assistant 带 tool_calls 后生成对应的 tool 结果消息", () => {
    const msgs: ChatMessage[] = [
      { id: "1", sessionId: "s", role: "user", parts: [{ type: "text", text: "现在几点?" }], createdAt: 0 },
      {
        id: "2",
        sessionId: "s",
        role: "assistant",
        parts: [
          { type: "text", text: "查一下" },
          { type: "tool", tool: { id: "t1", name: "get_datetime", input: "{}", output: "2026-08-04", status: "done", startedAt: 0, finishedAt: 1 } },
        ],
        createdAt: 0,
      },
      { id: "3", sessionId: "s", role: "assistant", parts: [{ type: "text", text: "现在是 2026-08-04" }], createdAt: 0 },
    ];
    const out = historyToProviderMessages(msgs);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: "user", content: "现在几点?" });
    expect(out[1].role).toBe("assistant");
    expect(out[1].toolCalls).toEqual([{ id: "t1", name: "get_datetime", arguments: "{}" }]);
    // 关键:tool_calls 后必须有 role=tool 消息
    expect(out[2]).toEqual({ role: "tool", content: "2026-08-04", toolCallId: "t1" });
    expect(out[3]).toEqual({ role: "assistant", content: "现在是 2026-08-04" });
  });

  it("纯文本历史不受影响", () => {
    const msgs: ChatMessage[] = [
      { id: "1", sessionId: "s", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 },
      { id: "2", sessionId: "s", role: "assistant", parts: [{ type: "text", text: "hello" }], createdAt: 0 },
    ];
    const out = historyToProviderMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[1].toolCalls).toBeUndefined();
  });
});
