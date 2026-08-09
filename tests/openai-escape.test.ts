import { describe, expect, it } from "vitest";
import { shrinkMessages, hardenEscape, sanitizeToolMessages, stripLoneSurrogates } from "../server/providers/openai";
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
  it("超限时优先砍思考/工具,正文(记忆)保留到上限,role 顺序合法", () => {
    // 构造:小正文 + 巨大思考(模拟长会话)
    const msgs: ProviderMsg[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: "user", content: "问题" });
      msgs.push({ role: "assistant", content: "回答", reasoningContent: "思".repeat(20000) });
    }
    const before = Buffer.byteLength(JSON.stringify(msgs));
    expect(before).toBeGreaterThan(512 * 1024);

    const shrunk = shrinkMessages(msgs);
    const after = Buffer.byteLength(JSON.stringify(shrunk));
    expect(after).toBeLessThanOrEqual(512 * 1024);

    // 思考被删(最多 3 条 500 字符)
    const keptThinking = shrunk.filter((m) => m.reasoningContent);
    expect(keptThinking.length).toBeLessThanOrEqual(3);
    keptThinking.forEach((m) => expect((m.reasoningContent || "").length).toBeLessThanOrEqual(500));
    // 正文消息保留完整("回答"未被截断)
    const keptText = shrunk.filter((m) => m.role === "assistant" && m.content === "回答");
    expect(keptText.length).toBeGreaterThan(0);
    // 无孤立 tool
    let lastHad = false;
    for (const m of shrunk) {
      if (m.role === "tool") expect(lastHad).toBe(true);
      lastHad = m.role === "assistant" && !!m.toolCalls?.length;
    }
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

describe("sanitizeToolMessages(tool 消息配对)", () => {
  it("删除前面没有 tool_calls 的孤立 tool 消息", () => {
    const msgs: ProviderMsg[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "好", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
      { role: "tool", content: "结果1", toolCallId: "c1" },
      { role: "assistant", content: "继续" }, // 无 tool_calls
      { role: "tool", content: "孤立", toolCallId: "cX" }, // 必须被删
      { role: "user", content: "再问" },
    ];
    const out = sanitizeToolMessages(msgs);
    expect(out.some((m) => m.role === "tool" && m.toolCallId === "cX")).toBe(false);
    expect(out.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("压缩后不会留下孤立 tool(丢消息以 user 为边界)", () => {
    // 构造:user + assistant(tc) + tool 组,模拟压缩触发
    const big = "长".repeat(20000);
    const msgs: ProviderMsg[] = [];
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: "user", content: big });
      msgs.push({ role: "assistant", content: big, toolCalls: [{ id: `c${i}`, name: "t", arguments: "{}" }] });
      msgs.push({ role: "tool", content: "结果", toolCallId: `c${i}` });
    }
    const shrunk = shrinkMessages(msgs);
    // 无孤立 tool:每个 tool 前一条必须是带 tool_calls 的 assistant
    let lastHad = false;
    for (const m of shrunk) {
      if (m.role === "tool") expect(lastHad).toBe(true);
      lastHad = m.role === "assistant" && !!m.toolCalls?.length;
    }
    expect(shrunk.length).toBeGreaterThan(0);
  });
});

describe("shrinkMessages 字节目标压缩(超长会话 400 修复)", () => {
  it("3835 条级超长会话压缩到 ≤200KB 且 ≥15 条", () => {
    // 构造 2000 条消息、每条含思考+文本,模拟 historyUnlimited 全量发送
    const msgs: any[] = [];
    for (let i = 0; i < 2000; i++) {
      msgs.push({ role: "user", content: `第 ${i} 条用户消息${"啊".repeat(200)}` });
      msgs.push({ role: "assistant", content: `第 ${i} 条回复${"好".repeat(300)}`, reasoningContent: `思考${"想".repeat(400)}` });
    }
    const raw = Buffer.byteLength(JSON.stringify(msgs));
    expect(raw).toBeGreaterThan(200 * 1024);
    const out = shrinkMessages(msgs);
    const len = Buffer.byteLength(JSON.stringify(out));
    expect(len).toBeLessThanOrEqual(200 * 1024);
    expect(out.length).toBeGreaterThanOrEqual(15);
  });

  it("单条超大正文兜底截断", () => {
    const msgs: any[] = [
      { role: "user", content: "X".repeat(500 * 1024) }, // 500KB 单条
      { role: "assistant", content: "ok" },
    ];
    const out = shrinkMessages(msgs, 64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("压缩优先级:工具/思考先清,正文最后动", () => {
  it("工具巨量的会话:正文几乎全保留", () => {
    const msgs: any[] = [];
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: "user", content: `用户问题${i}` });
      msgs.push({ role: "assistant", content: `简短回答${i}`, reasoningContent: "长思考".repeat(300) });
      msgs.push({ role: "assistant", content: null, toolCalls: [{ id: `t${i}`, name: "run_command", arguments: "{}" }] });
      msgs.push({ role: "tool", toolCallId: `t${i}`, content: "X".repeat(3000) }); // 每条工具输出 3K
    }
    const fullText = msgs.filter((x) => x.role !== "tool").map((x) => (x.content || "").length).reduce((a, b) => a + b, 0);
    const out = shrinkMessages(msgs);
    const keptText = out.filter((x) => x.role !== "tool").map((x) => (x.content || "").length).reduce((a, b) => a + b, 0);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(200 * 1024);
    // 正文保留比例应显著高于工具(工具全截,正文基本不动)
    expect(keptText / fullText).toBeGreaterThan(0.5);
  });
});

describe("孤立代理消毒(slice 截断 emoji 制造 400 的真凶)", () => {
  it("截断含 emoji 文本后消毒:JSON 中无孤立代理转义", () => {
    // 模拟:长文本含 emoji,压缩截断恰好切在 emoji 中间
    const emoji = "😏".repeat(500); // 代理对
    const text = "A".repeat(100) + emoji + "B".repeat(100);
    const cut = text.slice(0, 150); // 可能切在代理对中间
    const clean = stripLoneSurrogates(cut);
    const roundtrip = JSON.parse(JSON.stringify(clean));
    // 消毒后字符串里不允许再出现孤立代理码位
    for (let i = 0; i < roundtrip.length; i++) {
      const c = roundtrip.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDFFF) {
        const hi = c >= 0xD800 && c <= 0xDBFF;
        const next = roundtrip.charCodeAt(i + 1);
        const prev = roundtrip.charCodeAt(i - 1);
        if (hi && !(next >= 0xDC00 && next <= 0xDFFF)) throw new Error("残留孤立高代理");
        if (!hi && !(prev >= 0xD800 && prev <= 0xDBFF)) throw new Error("残留孤立低代理");
      }
    }
    // 完整压缩链路:构造含 emoji 的超长会话 → 压缩 → 消毒后无孤立代理
    const msgs: any[] = [];
    for (let i = 0; i < 500; i++) {
      msgs.push({ role: "user", content: `问题${i}${"😏".repeat(50)}` });
      msgs.push({ role: "assistant", content: `回答${i}${"🎵".repeat(50)}`, reasoningContent: "想".repeat(200) + "😊" });
    }
    const out = shrinkMessages(msgs);
    const body = JSON.stringify(out);
    // 模拟 serde_json:扫描 \uXXXX 转义,孤立代理(后无 \uDCxx)即视为非法
    for (let i = 0; i < body.length - 1; i++) {
      if (body[i] === "\\" && body[i + 1] === "u") {
        const hex = body.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("非法反斜杠u转义 @" + i + ": " + hex);
        const code = parseInt(hex, 16);
        if (code >= 0xD800 && code <= 0xDBFF) {
          const nextHex = body.slice(i + 8, i + 12);
          if (!body.startsWith("\\u", i + 6) || !/^[0-9a-fA-F]{4}$/.test(nextHex) || !(parseInt(nextHex, 16) >= 0xDC00 && parseInt(nextHex, 16) <= 0xDFFF)) {
            throw new Error("孤立高代理转义 @" + i + ": u" + hex);
          }
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          throw new Error("孤立低代理转义 @" + i + ": u" + hex);
        }
      }
    }
  });
});
