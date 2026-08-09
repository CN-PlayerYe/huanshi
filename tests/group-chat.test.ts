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

    // 1. 两次 message_start,id 不同,agentId 对应
    const starts = events.filter((e) => e.type === "message_start");
    expect(starts).toHaveLength(2);
    expect(starts[0].id).not.toBe(starts[1].id);
    expect(starts[0].agentId).toBe(a1.id);
    expect(starts[1].agentId).toBe(a2.id);

    // 2. delta 为模型输出本身,不含【名字】前缀(前缀由前端按 agentId 显示人格名)
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.content ?? "");
    expect(deltas.join("")).toContain("我");
    expect(deltas.join("")).toContain("来");
    expect(deltas.join("")).not.toContain("【");

    // 3. done 指向最后一条 assistant = 小尺
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done!.agentId).toBe(a2.id);
    expect(done!.id).toBe(starts[1].id);

    // 4. db 落库:1 user + 2 assistant,每条 assistant 独立且带 agentId
    const msgs = db.getMessages(session.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].agentId).toBe(a1.id);
    expect(msgs[1].parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("我来") });
    expect(msgs[2].agentId).toBe(a2.id);
    expect(msgs[2].parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("我来") });
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
