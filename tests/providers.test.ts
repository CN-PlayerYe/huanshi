import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "../server/providers/anthropic";
import type { ProviderMsg } from "../server/providers/types";
import { guardWritePath, ToolError } from "../server/tools/registry";

describe("toAnthropicMessages 消息转换", () => {
  it("基本 user/assistant", () => {
    const msgs: ProviderMsg[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好!" },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("你好");
    expect(out[1].content[0]).toEqual({ type: "text", text: "你好!" });
  });

  it("system 提取到单独字段前被跳过", () => {
    const msgs: ProviderMsg[] = [{ role: "system", content: "你是助手" }, { role: "user", content: "hi" }];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  it("assistant 工具调用 + tool 结果聚合成 tool_result 块", () => {
    const msgs: ProviderMsg[] = [
      { role: "user", content: "查一下" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "get_datetime", arguments: "{}" }] },
      { role: "tool", content: "2025年1月1日", toolCallId: "t1" },
      { role: "assistant", content: "好的" },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(4);
    expect(out[1].content[0]).toEqual({ type: "tool_use", id: "t1", name: "get_datetime", input: {} });
    expect(out[2].role).toBe("user");
    expect(out[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "2025年1月1日" });
    expect(out[3].content[0]).toEqual({ type: "text", text: "好的" });
  });
});

describe("guardWritePath 路径守卫", () => {
  const cwd = "C:\\work";
  const allowed = ["C:\\work", "D:\\data"];

  it("允许目录内放行", () => {
    expect(guardWritePath("C:\\work\\a.txt", cwd, allowed)).toBe("C:\\work\\a.txt");
    expect(guardWritePath("D:\\data\\sub\\b.txt", cwd, allowed)).toBe("D:\\data\\sub\\b.txt");
  });

  it("相对路径基于 cwd 解析", () => {
    expect(guardWritePath("notes.md", cwd, allowed)).toBe("C:\\work\\notes.md");
    expect(guardWritePath("sub/../notes.md", cwd, allowed)).toBe("C:\\work\\notes.md");
  });

  it("目录外路径拒绝", () => {
    expect(() => guardWritePath("C:\\Windows\\system32\\a.txt", cwd, allowed)).toThrow(ToolError);
    expect(() => guardWritePath("C:\\other\\x.txt", cwd, allowed)).toThrow(ToolError);
  });
});
