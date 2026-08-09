import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixEmbeddedThinking } from "../server/datafix";
import { Db } from "../server/storage";

describe("fixEmbeddedThinking 存量数据修复", () => {
  it("把正文内嵌 <thinking> 提取为独立 thinking part", () => {
    const dir = mkdtempSync(join(tmpdir(), "hanalite-fix-"));
    const db = Db.fromPaths({ dataDir: dir } as never);
    const s = db.createSession("测试", "agent_x");
    db.appendMessage({
      id: "m1",
      sessionId: s.id,
      role: "assistant",
      parts: [{ type: "text", text: "先思考\n<thinking>\n深层思考内容\n</thinking>\n再回答" }],
      createdAt: 0,
    });
    // 幂等:再跑一次不回改
    const c1 = fixEmbeddedThinking(db);
    const c2 = fixEmbeddedThinking(db);
    expect(c1).toBe(1);
    expect(c2).toBe(0);
    const msgs = db.getMessages(s.id);
    expect(msgs[0].parts.some((p) => p.type === "thinking" && p.text === "深层思考内容")).toBe(true);
    expect(msgs[0].parts.filter((p) => p.type === "text").map((p) => p.text).join()).toBe("先思考\n再回答");
  });
});
