import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { newId, type AgentDef } from "../shared/types";
import { AgentEngine } from "../server/agent/engine";
import { MemoryService } from "../server/memory/service";
import { Db } from "../server/storage";
import { ToolRegistry } from "../server/tools/registry";

/**
 * 群聊测试:mock 固定输出的 OpenAI 端点,验证:
 * 1. 每个成员各发一次 message_start(带真实消息 id 与 agentId)
 * 2. delta 事件顺序到达
 * 3. done 的 message 是最后一条 assistant(最后一个人格)
 * 4. db 中每条 assistant 消息独立落库且带正确的 agentId
 */
function startMockOpenAI() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const sse = (chunks: string[]) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const c of chunks) res.write(`data: ${c}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      const doneChunk = { id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
      sse([
        JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "我" }, finish_reason: null }] }),
        JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "来" }, finish_reason: null }] }),
        JSON.stringify(doneChunk),
      ]);
    });
  });
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => server.close() });
    });
  });
}

function makeAgent(name: string): AgentDef {
  return {
    id: newId("agent"),
    name,
    description: "",
    systemPrompt: `你是${name}`,
    memoryEnabled: false,
  };
}

const servers: { close: () => void }[] = [];
afterEach(() => servers.forEach((s) => s.close()));

describe("群聊 groupChat", () => {
  it("每个成员独立发 message_start,消息各自落库并带 agentId,done 指向最后一条", async () => {
    const mock = await startMockOpenAI();
    servers.push(mock);
    const dir = mkdtempSync(join(tmpdir(), "group-"));
    const db = Db.fromPaths({ dataDir: dir } as never);
    const memory = new MemoryService(
      { mode: "local", hindsightBaseUrl: "", hindsightApiKey: "", hindsightBankId: "t", localEnabled: true, experienceCap: 2000 },
      dir,
    );
    const registry = new ToolRegistry();
    const engine = new AgentEngine({
      db,
      memory,
      registry,
      dataDir: dir,
      getSettings: () => ({
        providers: { main: { kind: "openai", baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "x", model: "m" } },
        activeProvider: "main",
        mainModel: "m",
        toolWhitelistDir: dir,
      }),
    });

    const a1 = makeAgent("小盏");
    const a2 = makeAgent("小尺");
    const session = db.createSession("群聊测试", a1.id);

    const events: { type: string; id?: string; agentId?: string; content?: string }[] = [];
    const onEvent = (e: any) => {
      if (e.type === "message_start") events.push({ type: e.type, id: e.message.id, agentId: e.message.agentId });
      else if (e.type === "delta") events.push({ type: e.type, content: e.content });
      else if (e.type === "done") events.push({ type: e.type, id: e.message.id, agentId: e.message.agentId });
      else events.push({ type: e.type });
    };

    await engine.groupChat(session, [a1, a2], "大家好啊", onEvent);

    // 1. 两次 message_start,id 不同,agentId 对应(发言顺序随机,不假定谁先)
    const starts = events.filter((e) => e.type === "message_start");
    expect(starts).toHaveLength(2);
    expect(starts[0].id).not.toBe(starts[1].id);
    expect(starts.map((s) => s.agentId).sort()).toEqual([a1.id, a2.id].sort()); // 两人都发言了(顺序随机)

    // 2. delta 为模型输出本身,不含【名字】前缀(前缀由前端按 agentId 显示人格名)
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.content ?? "");
    expect(deltas.join("")).toContain("我");
    expect(deltas.join("")).toContain("来");
    expect(deltas.join("")).not.toContain("【");

    // 3. done 指向最后一条 assistant(发言顺序随机,取最后一个发言者)
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done!.agentId).toBe(starts[starts.length - 1].agentId);
    expect(done!.id).toBe(starts[starts.length - 1].id);

    // 4. db 落库:1 user + 2 assistant,每条 assistant 独立且带 agentId(发言顺序随机,不假定谁先)
    const msgs = db.getMessages(session.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("assistant");
    expect([msgs[1].agentId, msgs[2].agentId].sort()).toEqual([a1.id, a2.id].sort());
    for (const m of [msgs[1], msgs[2]]) {
      expect(m.parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("我来") });
    }
  });

  it("群聊结束后每个参与者各记一条经历(单人聊天时能想起群里聊过什么)", async () => {
    const mock = await startMockOpenAI();
    servers.push(mock);
    const dir = mkdtempSync(join(tmpdir(), "group-mem-"));
    const db = Db.fromPaths({ dataDir: dir } as never);
    const memory = new MemoryService(
      { mode: "local", hindsightBaseUrl: "", hindsightApiKey: "", hindsightBankId: "t", localEnabled: true, experienceCap: 2000 },
      dir,
    );
    const registry = new ToolRegistry();
    const engine = new AgentEngine({
      db,
      memory,
      registry,
      dataDir: dir,
      getSettings: () => ({
        providers: { mock: { kind: "openai", baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "t", model: "m" } },
        activeProvider: "mock",
        mainModel: "m",
        toolWhitelistDir: join(dir, "work"),
      }),
    } as never);
    const a1: AgentDef = { ...makeAgent("甲"), memoryEnabled: true, isolatedMemory: true };
    const a2: AgentDef = { ...makeAgent("乙"), memoryEnabled: true, isolatedMemory: true };
    db.saveAgent(a1);
    db.saveAgent(a2);
    const session = db.createSession("群聊测试", a1.id);
    db.updateSession(session.id, { groupAgents: [a1.id, a2.id] });
    await engine.groupChat(db.getSession(session.id)!, [a1, a2], "中秋快乐", () => {});
    // 沉淀是 async(void),给它一点时间
    await new Promise((r) => setTimeout(r, 100));
    const m1 = await memory.list(a1.id);
    const m2 = await memory.list(a2.id);
    expect(m1.some((m) => m.content.includes("群聊") && m.content.includes("中秋快乐"))).toBe(true);
    expect(m2.some((m) => m.content.includes("群聊") && m.content.includes("中秋快乐"))).toBe(true);
    // 关键:沉淀里要能看到【别人的发言】——否则她们彼此记不住对方在群里说了什么(小柒的验收发现)
    const gc1 = m1.find((m) => m.content.includes("【群聊"));
    expect(gc1?.content).toContain("甲说:");
    expect(gc1?.content).toContain("乙说:");

    // 第二轮群聊(不同的话)必须再记一条:模板若用固定前缀,会被记忆库"前 40 字重合"去重掉,
    // 导致多轮群聊只存第一条(实锤 bug:6 人群聊 5 轮只沉淀 1 条)
    await engine.groupChat(db.getSession(session.id)!, [a1, a2], "今晚月亮真圆", () => {});
    await new Promise((r) => setTimeout(r, 100));
    const m1b = await memory.list(a1.id);
    expect(m1b.filter((m) => m.content.includes("【群聊")).length).toBe(2);
  });
});

describe("群聊历史回放", () => {
  it("回放 assistant 消息时带人格名,让模型分清谁说的", async () => {
    const { historyToProviderMessages } = await import("../server/agent/engine");
    const msgs: any[] = [
      { id: "m1", sessionId: "s", role: "user", parts: [{ type: "text", text: "大家好啊" }], createdAt: 1 },
      { id: "m2", sessionId: "s", role: "assistant", agentId: "agent-a", parts: [{ type: "text", text: "我来了" }], createdAt: 2 },
      { id: "m3", sessionId: "s", role: "assistant", agentId: "agent-b", parts: [{ type: "text", text: "我也在" }], createdAt: 3 },
    ];
    const out = await historyToProviderMessages(msgs as any, undefined, false, "all", (id) => (id === "agent-a" ? "小盏" : id === "agent-b" ? "小尺" : undefined));
    expect(out[1].content).toBe("（小盏）我来了");
    expect(out[2].content).toBe("（小尺）我也在");
    expect(out[0].content).toBe("大家好啊");
  });
});

describe("read_group_chat 工具(回忆群聊全貌)", () => {
  it("不传 session → 列出群聊;传标题 → 读出完整记录(带说话人)", async () => {
    const { groupTools } = await import("../server/tools/group");
    const tool = groupTools.find((t) => t.name === "read_group_chat")!;
    const chats = [
      { id: "s1", title: "🏮 群聊", updatedAt: Date.now() },
      { id: "s2", title: "🏮 中秋夜", updatedAt: Date.now() - 1000 },
    ];
    const ctx = {
      cwd: "",
      allowedWriteDirs: [],
      dataDir: "",
      env: {},
      memory: null,
      listGroupChats: () => chats,
      readGroupChat: (sid: string, limit: number) =>
        sid === "s2"
          ? [
              { who: "主人", text: "中秋快乐", at: Date.now() - 5000 },
              { who: "夜玲珑", text: "月亮真圆", at: Date.now() - 4000 },
              { who: "小柒", text: "我要吃月饼", at: Date.now() - 3000 },
            ].slice(-limit)
          : [],
    } as never;
    // 不传 session:列出最近的群聊
    const list = await tool.run({}, ctx);
    expect(list).toContain("🏮 群聊");
    expect(list).toContain("🏮 中秋夜");
    // 传标题关键词:读出完整记录
    const detail = await tool.run({ session: "中秋", limit: 10 }, ctx);
    expect(detail).toContain("主人:中秋快乐");
    expect(detail).toContain("夜玲珑:月亮真圆");
    expect(detail).toContain("小柒:我要吃月饼");
    // 找不到时给出提示
    const miss = await tool.run({ session: "不存在的群" }, ctx);
    expect(miss).toContain("没找到");
    // 按人翻:只捞某人的发言(小柒的验收标准:单捞玄漪/星回看她俩聊了啥)
    const onlyXiaoqi = await tool.run({ session: "中秋", who: "小柒" }, ctx);
    expect(onlyXiaoqi).toContain("小柒:我要吃月饼");
    expect(onlyXiaoqi).not.toContain("夜玲珑:月亮真圆");
    // 某人没发言时明确说明
    const none = await tool.run({ session: "中秋", who: "星回" }, ctx);
    expect(none).toContain("没有「星回」的发言");
  });
});
