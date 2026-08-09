import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchSessions } from "../server/storage/search";
import { Db } from "../server/storage";

describe("跨会话全文搜索", () => {
  it("按关键词命中标题与消息正文/工具输出", () => {
    const dir = mkdtempSync(join(tmpdir(), "hanalite-search-"));
    const db = Db.fromPaths({ dataDir: dir } as never);
    const a = db.createSession("测试会话标题", "agent_x");
    db.appendMessage({ id: "m1", sessionId: a.id, role: "user", parts: [{ type: "text", text: "记得那只白狐吗" }], createdAt: 0 });
    db.appendMessage({
      id: "m2",
      sessionId: a.id,
      role: "assistant",
      parts: [
        { type: "tool", tool: { id: "t", name: "read_file", input: "{}", output: "山谷里的白狐在月光下", status: "done", startedAt: 0 } },
      ],
      createdAt: 0,
    });
    const b = db.createSession("无关", "agent_x");
    db.appendMessage({ id: "m3", sessionId: b.id, role: "user", parts: [{ type: "text", text: "今天天气不错" }], createdAt: 0 });

    // 标题命中
    const byTitle = searchSessions(db, "玲珑");
    expect(byTitle.map((h) => h.session.id)).toEqual([a.id]);
    expect(byTitle[0].matches).toBe(-1);
    // 正文命中
    const byText = searchSessions(db, "白狐");
    expect(byText.map((h) => h.session.id)).toEqual([a.id]);
    // 工具输出命中
    const byTool = searchSessions(db, "月光");
    expect(byTool.map((h) => h.session.id)).toEqual([a.id]);
    // 不命中
    expect(searchSessions(db, "不存在词")).toEqual([]);
  });
});
