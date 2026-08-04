import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, type ChatMessage } from "../shared/types";
import { Db } from "../server/storage";

let tmp: string;
let db: Db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hanalite-db-"));
  db = new Db(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("Db 存储", () => {
  it("创建/读取会话", () => {
    const s = db.createSession("测试会话", "gentle");
    expect(db.getSession(s.id)?.title).toBe("测试会话");
    expect(db.listSessions()).toHaveLength(1);
  });

  it("更新会话(重命名)", () => {
    const s = db.createSession("旧标题", "gentle");
    db.updateSession(s.id, { title: "新标题" });
    expect(db.getSession(s.id)?.title).toBe("新标题");
    expect(db.getSession(s.id)?.updatedAt).toBeGreaterThanOrEqual(s.updatedAt);
  });

  it("归档过滤", () => {
    const s1 = db.createSession("a", "gentle");
    db.createSession("b", "gentle");
    db.updateSession(s1.id, { archived: true });
    expect(db.listSessions()).toHaveLength(1);
    expect(db.listSessions(true)).toHaveLength(2);
  });

  it("删除会话及其消息", () => {
    const s = db.createSession("x", "gentle");
    const msg: ChatMessage = {
      id: newId("msg"),
      sessionId: s.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      createdAt: Date.now(),
    };
    db.appendMessage(msg);
    expect(db.getMessages(s.id)).toHaveLength(1);
    db.deleteSession(s.id);
    expect(db.getSession(s.id)).toBeUndefined();
    expect(db.getMessages(s.id)).toHaveLength(0);
  });

  it("消息追加与更新", () => {
    const s = db.createSession("x", "gentle");
    const m: ChatMessage = {
      id: "m1",
      sessionId: s.id,
      role: "assistant",
      parts: [{ type: "text", text: "你好" }],
      createdAt: Date.now(),
    };
    db.appendMessage(m);
    db.updateMessage({ ...m, parts: [{ type: "text", text: "你好,更新版" }] });
    expect(db.getMessages(s.id)[0].parts[0].text).toBe("你好,更新版");
  });

  it("删除单条消息(压缩上下文)", () => {
    const s = db.createSession("x", "gentle");
    const m1: ChatMessage = { id: "m1", sessionId: s.id, role: "user", parts: [{ type: "text", text: "a" }], createdAt: 1 };
    const m2: ChatMessage = { id: "m2", sessionId: s.id, role: "assistant", parts: [{ type: "text", text: "b" }], createdAt: 2 };
    db.appendMessage(m1);
    db.appendMessage(m2);
    expect(db.deleteMessage(s.id, "m1")).toBe(true);
    expect(db.getMessages(s.id).map((m) => m.id)).toEqual(["m2"]);
    expect(db.deleteMessage(s.id, "nonexistent")).toBe(false);
  });

  it("人格 CRUD", () => {
    db.saveAgent({ id: "a1", name: "人格A", description: "", systemPrompt: "p", memoryEnabled: true, tools: [], createdAt: Date.now() });
    expect(db.getAgent("a1")?.name).toBe("人格A");
    db.saveAgent({ ...db.getAgent("a1")!, name: "人格A2" });
    expect(db.listAgents()).toHaveLength(1);
    expect(db.getAgent("a1")?.name).toBe("人格A2");
    db.deleteAgent("a1");
    expect(db.listAgents()).toHaveLength(0);
  });
});
