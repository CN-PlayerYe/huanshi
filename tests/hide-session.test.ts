import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/storage";

/** 隐私保险:隐藏会话(从列表消失 + 消息文件移出 db/ 到 .私藏/) */
describe("隐藏会话(隐私保险)", () => {
  let dir: string;
  let db: Db;
  let sid: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hana-hide-"));
    db = new Db(dir);
    const s = db.createSession("私密对话", "agent_x");
    sid = s.id;
    db.appendMessage({ id: "m1", sessionId: sid, role: "user", parts: [{ type: "text", text: "这是私密内容" }], createdAt: Date.now() });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("隐藏后从所有列表消失,且消息文件移出 db/", () => {
    const msgFile = join(dir, "db", `messages-${sid}.json`);
    expect(existsSync(msgFile)).toBe(true);

    db.hideSession(sid);

    // 列表消失(含 includeArchived)
    expect(db.listSessions().find((x) => x.id === sid)).toBeUndefined();
    expect(db.listSessions(true).find((x) => x.id === sid)).toBeUndefined();
    // 消息文件移出 db/
    expect(existsSync(msgFile)).toBe(false);
    // 出现在隐藏列表
    expect(db.listHiddenSessions().map((x) => x.id)).toContain(sid);
    // 数据还在 .私藏/
    const vault = join(dir, ".私藏", `messages-${sid}.json`);
    expect(existsSync(vault)).toBe(true);
    expect(readFileSync(vault, "utf8")).toContain("私密内容");
  });

  it("恢复后回到列表,消息文件移回 db/", () => {
    db.hideSession(sid);
    db.unhideSession(sid);
    expect(db.listSessions().find((x) => x.id === sid)?.hidden).toBeFalsy();
    expect(existsSync(join(dir, "db", `messages-${sid}.json`))).toBe(true);
    expect(db.listHiddenSessions().length).toBe(0);
  });

  it("隐藏对不存在会话无害", () => {
    expect(db.hideSession("nope")).toBeUndefined();
    expect(db.unhideSession("nope")).toBeUndefined();
  });
});
