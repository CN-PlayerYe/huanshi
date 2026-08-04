import { describe, expect, it } from "vitest";
import { buildSystemPrompt, toProviderMsg } from "../server/agent/engine";
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
