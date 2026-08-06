import { describe, expect, it } from "vitest";
import { shrinkMessages, hardenEscape } from "../server/providers/openai";
import type { ProviderMsg } from "../shared/types";

// 与 server/providers/openai.ts 中 hardenEscape 使用的正则完全一致
const HARDEN_RE = /\\(?=u(?![\da-fA-F]{4}))/g;
function harden(text: string): string {
  return text.replace(HARDEN_RE, "\\\\");
}

describe("hardenEscape(残缺 \\u 字面加固)", () => {
  it("残缺 \\u(后跟非 4 hex)翻倍,正常 \\uXXXX 不动", () => {
    const s = String.raw`路径 G:\u123x 结束,unicode \u4e2d 正常,尾部 \u`;
    const out = harden(s);
    // 残缺 \u → \\u(JSON.stringify 后为 \\\\u,一次解析还原为 \\u)
    expect(out).toContain(String.raw`G:\\u123x`);
    // 正常 4 hex 不动
    expect(out).toContain(String.raw`\u4e2d`);
    // 字符串尾部残缺 \u 也加固
    expect(out.endsWith(String.raw`\\u`)).toBe(true);
  });

  it("加固后模型端即使对 content 二次 JSON 解析也不会报 hex escape 错误", () => {
    const s = String.raw`G:\u123x 后面 \u4e2d 正常 结尾\u`;
    const hardened = harden(s);
    const body = JSON.stringify({ content: hardened });
    // 请求体必须是合法 JSON
    expect(() => JSON.parse(body)).not.toThrow();
    const parsed = JSON.parse(body) as { content: string };
    // 模拟模型端把 content 当作 JSON 字符串再解析一次:不得抛 "unexpected end of hex escape"
    const esc = parsed.content.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    expect(() => JSON.parse(`"${esc}"`)).not.toThrow();
  });
});

describe("shrinkMessages(请求体压缩)", () => {
  it(">80KB 的请求体压缩到 <80KB,且 role 顺序合法", () => {
    // 构造超长消息:大 content + 大 thinking(模拟 historyUnlimited 会话)
    const bigText = "长".repeat(20000);
    const bigThink = "思".repeat(20000);
    const msgs: ProviderMsg[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: "user", content: bigText });
      msgs.push({ role: "assistant", content: bigText, reasoningContent: bigThink });
    }
    const before = Buffer.byteLength(JSON.stringify(msgs));
    expect(before).toBeGreaterThan(80 * 1024);

    const shrunk = shrinkMessages(msgs);
    const after = Buffer.byteLength(JSON.stringify(shrunk));
    expect(after).toBeLessThanOrEqual(80 * 1024);

    // role 顺序合法:不能以 tool 开头,user/assistant 交替完整
    const roles = shrunk.map((m) => m.role);
    expect(roles[0]).not.toBe("tool");
    expect(roles.filter((r) => r === "tool").length).toBe(0);
    expect(shrunk.length).toBeGreaterThan(4);
  });

  it("双反斜杠 + 残缺 \\u 也能安全加固(偶数反斜杠)", () => {
    const s = String.raw`G:\\u123x`; // 2 个反斜杠 + u + 非4hex(双重转义残留)
    const out = hardenEscape(s);
    const body = JSON.stringify({ content: out });
    const parsed = JSON.parse(body) as { content: string };
    // 模拟模型端二次解析:不得报错
    const esc = parsed.content.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    expect(() => JSON.parse(`"${esc}"`)).not.toThrow();
  });
});
