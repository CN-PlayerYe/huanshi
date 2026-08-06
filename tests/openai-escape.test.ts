import { describe, expect, it } from "vitest";

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
