import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertMessage, importCherryStudio, isCherryStudioDataDir, probeCherryStudioDirs } from "../server/import/cherrystudio";
import { Db } from "../server/storage";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hanalite-cs-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 构造一个 Cherry Studio v1 格式的 agents.db fixture */
function makeFixture(): string {
  const dir = join(tmp, "CherryStudio");
  const dataDir = join(dir, "Data");
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "agents.db"));

  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, type TEXT, name TEXT, description TEXT, accessible_paths TEXT, instructions TEXT, model TEXT, plan_model TEXT, small_model TEXT, mcps TEXT, allowed_tools TEXT, configuration TEXT, created_at TEXT, updated_at TEXT, sort_order INTEGER, deleted_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_type TEXT, agent_id TEXT, name TEXT, description TEXT, accessible_paths TEXT, instructions TEXT, model TEXT, plan_model TEXT, small_model TEXT, mcps TEXT, allowed_tools TEXT, configuration TEXT, created_at TEXT, updated_at TEXT, slash_commands TEXT, sort_order INTEGER);
    CREATE TABLE session_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, metadata TEXT, created_at TEXT, updated_at TEXT, agent_session_id TEXT);
  `);

  db.prepare(
    "INSERT INTO agents (id,type,name,description,instructions,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("cherry-claw-default", "claude-code", "小柒", "测试 Agent", "你是小柒,一个助手。", "mimo:mimo-v2.5", "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z");

  db.prepare(
    "INSERT INTO sessions (id,agent_type,agent_id,name,description,instructions,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "session_test_001",
    "claude-code",
    "cherry-claw-default",
    "测试会话",
    "",
    "",
    "mimo:v2.5",
    "2026-05-02T01:00:00Z",
    "2026-05-02T02:00:00Z",
  );

  const userContent = JSON.stringify({
    message: { id: "u1", role: "user", topicId: "agent-session:session_test_001", createdAt: "2026-05-02T01:00:00Z" },
    blocks: [{ id: "b1", type: "main_text", content: "帮我看看这个文件", createdAt: "2026-05-02T01:00:00Z" }],
  });
  const asstContent = JSON.stringify({
    message: { id: "a1", role: "assistant", topicId: "agent-session:session_test_001", createdAt: "2026-05-02T01:01:00Z", model: { name: "mimo-v2.5" } },
    blocks: [
      { id: "t1", type: "thinking", content: "用户想看文件,我需要用工具", createdAt: "2026-05-02T01:01:00Z" },
      {
        id: "t2",
        type: "tool",
        status: "success",
        createdAt: "2026-05-02T01:01:01Z",
        metadata: {
          rawMcpToolResponse: {
            tool: { name: "read_file" },
            arguments: { path: "a.txt" },
            response: { content: [{ type: "text", text: "文件内容:hello" }] },
            status: "done",
          },
        },
      },
      { id: "t3", type: "main_text", content: "文件内容是 hello", createdAt: "2026-05-02T01:01:02Z" },
    ],
  });

  const ins = db.prepare("INSERT INTO session_messages (session_id,role,content,created_at,updated_at) VALUES (?,?,?,?,?)");
  ins.run("session_test_001", "user", userContent, "2026-05-02T01:00:00Z", "2026-05-02T01:00:00Z");
  ins.run("session_test_001", "assistant", asstContent, "2026-05-02T01:01:00Z", "2026-05-02T01:01:02Z");
  db.close();
  return dir;
}

describe("Cherry Studio 迁移", () => {
  it("isCherryStudioDataDir 识别", () => {
    const dir = makeFixture();
    expect(isCherryStudioDataDir(dir)).toBe(true);
    expect(isCherryStudioDataDir(join(tmp, "nope"))).toBe(false);
  });

  it("probeCherryStudioDirs 返回有效目录", () => {
    const dir = makeFixture();
    // 写入 fake appData 配置指向 fixture
    const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const homeCfg = join(tmp, "home", ".cherrystudio", "config");
    mkdirSync(homeCfg, { recursive: true });
    writeFileSync(join(homeCfg, "config.json"), JSON.stringify({ appDataPath: [{ dataPath: dir }] }));
    const old = process.env.USERPROFILE;
    process.env.USERPROFILE = join(tmp, "home");
    try {
      const found = probeCherryStudioDirs();
      expect(found).toContain(dir);
    } finally {
      if (old === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = old;
    }
  });

  it("convertMessage 解析正文/思考/工具调用", () => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(tmp, { recursive: true });
    const asst = {
      id: 2,
      session_id: "session_test_001",
      role: "assistant",
      content: JSON.stringify({
        message: { id: "a1", role: "assistant", createdAt: "2026-05-02T01:01:00Z", model: { name: "mimo-v2.5" } },
        blocks: [
          { id: "t1", type: "thinking", content: "思考中", createdAt: "2026-05-02T01:01:00Z" },
          {
            id: "t2",
            type: "tool",
            status: "success",
            createdAt: "2026-05-02T01:01:01Z",
            metadata: { rawMcpToolResponse: { tool: { name: "read_file" }, arguments: { path: "a.txt" }, response: { content: [{ type: "text", text: "hello" }] } } },
          },
          { id: "t3", type: "main_text", content: "文件内容是 hello", createdAt: "2026-05-02T01:01:02Z" },
        ],
      }),
      created_at: "2026-05-02T01:01:00Z",
    };
    const m = convertMessage(asst, "s", false)!;
    expect(m.role).toBe("assistant");
    const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join();
    expect(text).toBe("文件内容是 hello"); // thinking 未包含
    const tools = m.parts.filter((p) => p.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].tool?.name).toBe("read_file");
    expect(tools[0].tool?.output).toContain("hello");
    expect(m.model).toBe("mimo-v2.5");

    // includeThinking=true 时思考保存为独立 part(回放时作 reasoning_content 回传)
    const m2 = convertMessage(asst, "s", true)!;
    const text2 = m2.parts.filter((p) => p.type === "text").map((p) => p.text).join();
    expect(text2).not.toContain("思考中"); // 不再内嵌进正文
    const thinkParts = m2.parts.filter((p) => p.type === "thinking").map((p) => p.text);
    expect(thinkParts).toContain("思考中"); // 独立 thinking part 保存思考
  });

  it("importCherryStudio 完整导入到 Db", () => {
    const dir = makeFixture();
    const db = new Db(join(tmp, "hanalite"));
    const stats = importCherryStudio(db, { cherryDataDir: dir, includeThinking: false });

    expect(stats.agents).toBe(1);
    expect(stats.sessions).toBe(1);
    expect(stats.messages).toBe(2);

    const agents = db.listAgents();
    expect(agents[0].name).toBe("小柒");
    expect(agents[0].systemPrompt).toBe("你是小柒,一个助手。");

    const session = db.getSession("session_test_001");
    expect(session?.title).toBe("测试会话");
    expect(session?.agentId).toBe("cherry-claw-default");

    const msgs = db.getMessages("session_test_001");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].parts[0].text).toBe("帮我看看这个文件");
    expect(msgs[1].parts.some((p) => p.type === "tool")).toBe(true);

    // 幂等:重复导入不重复
    const stats2 = importCherryStudio(db, { cherryDataDir: dir, includeThinking: false });
    expect(stats2.skippedSessions).toBe(1);
    expect(stats2.skippedAgents).toBe(1);
    expect(db.listSessions()).toHaveLength(1);
    expect(db.getMessages("session_test_001")).toHaveLength(2);
  });
});
