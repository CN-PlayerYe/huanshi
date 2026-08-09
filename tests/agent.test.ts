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
    expect(prompt).toContain("小盏");
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
  it("assistant 带 tool_calls 后生成对应的 tool 结果消息", async () => {
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
    const out = await historyToProviderMessages(msgs);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: "user", content: "现在几点?" });
    expect(out[1].role).toBe("assistant");
    expect(out[1].toolCalls).toEqual([{ id: "t1", name: "get_datetime", arguments: "{}" }]);
    // 关键:tool_calls 后必须有 role=tool 消息
    expect(out[2]).toEqual({ role: "tool", content: "2026-08-04", toolCallId: "t1" });
    expect(out[3]).toEqual({ role: "assistant", content: "现在是 2026-08-04" });
  });

  it("纯文本历史不受影响", async () => {
    const msgs: ChatMessage[] = [
      { id: "1", sessionId: "s", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 },
      { id: "2", sessionId: "s", role: "assistant", parts: [{ type: "text", text: "hello" }], createdAt: 0 },
    ];
    const out = await historyToProviderMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[1].toolCalls).toBeUndefined();
    expect(out[1].reasoningContent).toBeUndefined();
  });

  it("assistant 带思考 part 时回传 reasoningContent", async () => {
    const msgs: ChatMessage[] = [
      { id: "1", sessionId: "s", role: "user", parts: [{ type: "text", text: "推理题" }], createdAt: 0 },
      {
        id: "2",
        sessionId: "s",
        role: "assistant",
        parts: [
          { type: "thinking", text: "让我一步步想…" },
          { type: "text", text: "答案是 42" },
        ],
        createdAt: 0,
      },
    ];
    const out = await historyToProviderMessages(msgs);
    expect(out[1].reasoningContent).toBe("让我一步步想…");
    expect(out[1].content).toBe("答案是 42");
  });

  it("兼容存量数据:正文内嵌 <thinking> 块也提取为 reasoningContent", async () => {
    const msgs: ChatMessage[] = [
      { id: "1", sessionId: "s", role: "user", parts: [{ type: "text", text: "问题" }], createdAt: 0 },
      {
        id: "2",
        sessionId: "s",
        role: "assistant",
        parts: [{ type: "text", text: "先想\n<thinking>\n内嵌思考\n</thinking>\n回答" }],
        createdAt: 0,
      },
    ];
    const out = await historyToProviderMessages(msgs);
    expect(out[1].reasoningContent).toBe("内嵌思考");
  });

  it("超长工具调用与文本被压缩(迁移会话提速)", async () => {
    const bigOutput = "x".repeat(10000);
    const manyTools = Array.from({ length: 25 }, (_, i) => ({
      type: "tool" as const,
      tool: { id: `t${i}`, name: "read_file", input: "{}", output: bigOutput, status: "done" as const, startedAt: 0 },
    }));
    const msgs: ChatMessage[] = [
      {
        id: "1",
        sessionId: "s",
        role: "user",
        parts: [{ type: "text", text: "y".repeat(50000) }],
        createdAt: 0,
      },
      {
        id: "2",
        sessionId: "s",
        role: "assistant",
        parts: [{ type: "text", text: "正文" }, ...manyTools],
        createdAt: 0,
      },
    ];
    const out = await historyToProviderMessages(msgs);
    // 25 个工具调用 → 只回放最近 15 个
    expect(out.filter((m) => m.role === "tool")).toHaveLength(15);
    // 工具输出被截断(不再有 1 万字符的原始输出)
    const toolMsgs = out.filter((m) => m.role === "tool");
    expect(toolMsgs[0].content.length).toBeLessThan(3200);
    expect(toolMsgs[0].content).toContain("[已截断]");
    // 超长 user 正文被截断
    expect(out[0].content.length).toBeLessThan(21000);
  });

  it("空 assistant 消息被跳过(避免 content or tool_calls must be set)", async () => {
    const msgs: ChatMessage[] = [
      { id: "1", sessionId: "s", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 },
      { id: "2", sessionId: "s", role: "assistant", parts: [], createdAt: 0 }, // 空占位
      { id: "3", sessionId: "s", role: "assistant", parts: [{ type: "text", text: "hello" }], createdAt: 0 },
    ];
    const out = await historyToProviderMessages(msgs);
    expect(out).toHaveLength(2); // 空 assistant 被跳过
    expect(out[1].content).toBe("hello");
  });
});
