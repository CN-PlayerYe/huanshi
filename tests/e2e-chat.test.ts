import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionMeta, StreamEvent } from "../shared/types";
import { AgentEngine } from "../server/agent/engine";
import { defaultAgents } from "../server/agents";
import { MemoryService } from "../server/memory/service";
import { createProvider } from "../server/providers";
import { Db } from "../server/storage";
import { datetimeTool, fileTools, shellTool, webTool } from "../server/tools/files";
import { memoryTools } from "../server/tools/memory";
import { ToolRegistry } from "../server/tools/registry";

/** 模拟 OpenAI 兼容服务器:第一轮返回 get_datetime 工具调用,第二轮返回最终文本 */
class MockOpenAI {
  server: Server | null = null;
  port = 0;
  calls = 0;
  /** 每次请求的最后一条 user 消息文本(测试断言用) */
  lastUserContents: string[] = [];

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createHttpServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const payload = JSON.parse(body || "{}");
          const messages = payload.messages ?? [];
          const lastUser = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
          if (lastUser) this.lastUserContents.push(lastUser.content);
          this.calls++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });

          if (this.calls === 1) {
            // 第一轮:思考 + 要求调用 get_datetime 工具
            const toolCall = {
              index: 0,
              id: "call_1",
              function: { name: "get_datetime", arguments: "{}" },
            };
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "用户在问时间" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
          } else {
            // 第二轮:正常回答
            const toolMsg = messages.filter((m) => m.role === "tool");
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "现在是" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ` 2026年(工具结果 ${toolMsg.length} 条已回填)` } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        });
      });
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as any).port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }
}

let mock: MockOpenAI;
let tmp: string;
let db: Db;
let engine: AgentEngine;
let memory: MemoryService;

beforeAll(async () => {
  mock = new MockOpenAI();
  await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hanalite-e2e-"));
  db = new Db(tmp);
  memory = new MemoryService({ mode: "local", localEnabled: true }, join(tmp, "mem"));
  const registry = new ToolRegistry();
  for (const t of [...fileTools, shellTool, webTool, datetimeTool, ...memoryTools(memory)]) registry.register(t);
  engine = new AgentEngine({
    db,
    memory,
    registry,
    dataDir: tmp,
    getSettings: () => ({
      providers: { mock: { kind: "openai", baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "test", model: "mock-model" } },
      activeProvider: "mock",
      mainModel: "mock-model",
      toolWhitelistDir: join(tmp, "work"),
    }),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("Agent 引擎端到端(OpenAI 兼容 + 工具调用)", () => {
  it("流式回复 + 工具调用往返 + 消息持久化", async () => {
    const agent = defaultAgents()[0];
    const session: SessionMeta = db.createSession("e2e", agent.id);
    const events: StreamEvent[] = [];

    const msg = await engine.runChat(session, agent, "现在几点了?", (e) => events.push(e));

    // 事件序列:tool_start → tool_end → delta ×2 → done
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("delta");
    expect(types[types.length - 1]).toBe("done");

    // 思考过程:流式事件 + 存档
    expect(events.some((e) => e.type === "thinking" && (e as any).content === "用户在问时间")).toBe(true);
    expect(msg.parts.some((p) => p.type === "thinking" && p.text === "用户在问时间")).toBe(true);

    const toolStart = events.find((e) => e.type === "tool_start")!;
    expect(toolStart.type).toBe("tool_start");
    expect((toolStart as any).tool.name).toBe("get_datetime");

    const done = events[events.length - 1] as Extract<StreamEvent, { type: "done" }>;
    expect(done.message.parts.some((p) => p.type === "text" && /2026/.test(p.text ?? ""))).toBe(true);
    expect(done.message.parts.some((p) => p.type === "tool" && p.tool?.status === "done")).toBe(true);

    // 持久化:user + assistant(含工具结果)两条消息
    const saved = db.getMessages(session.id);
    expect(saved).toHaveLength(2);
    expect(saved[1].parts.some((p) => p.type === "tool")).toBe(true);
    expect(msg.parts.length).toBeGreaterThan(0);
  });
});

describe("「唤醒」仪式(注入记忆)", () => {
  it("解析:以「唤醒」开头 → 剥触发词 + wake;普通消息原样", async () => {
    const { parseWakeCommand } = await import("../server/api/routes");
    expect(parseWakeCommand("唤醒 玲珑")).toEqual({ content: "玲珑", wake: true });
    expect(parseWakeCommand("唤醒夜玄漪")).toEqual({ content: "夜玄漪", wake: true });
    expect(parseWakeCommand("玲珑,今天好吗")).toEqual({ content: "玲珑,今天好吗", wake: false });
  });

  it("记忆只在唤醒/开窗第一轮注入:平时干净地聊,唤醒时把记忆摆上来;【井】常驻 system", async () => {
    const { buildSystemPrompt } = await import("../server/agent/engine");
    const agent = { ...defaultAgents()[0], isolatedMemory: true }; // 独立记忆人格(如玲珑),记忆按 agentId 隔离
    const session = db.createSession("wake", agent.id);
    await memory.retain("夜玲珑在院子里种了一棵梅树", "fact", agent.id);

    // 平时(非第一轮、未唤醒):不注入【背景资料】——记忆不再是"每轮都灌"
    mock.lastUserContents = [];
    await engine.runChat(session, agent, "玲珑,你院子里种了什么?", () => {});
    const normal = mock.lastUserContents.at(-1)!;
    expect(normal).not.toContain("梅树");
    expect(normal).not.toContain("【背景资料】");

    // 唤醒:注入记忆(把井边的水打上来给她看)
    mock.lastUserContents = [];
    await engine.runChat(session, agent, "玲珑,你院子里种了什么?", () => {}, undefined, undefined, { injectMemory: true });
    const wake = mock.lastUserContents.at(-1)!;
    expect(wake).toContain("梅树");
    expect(wake).toContain("【背景资料】");
    expect(wake).toContain("玲珑");

    // 【井】改成常驻 system prompt(想回忆自己打水),不再靠每轮 user 消息提醒
    expect(buildSystemPrompt(agent, tmp, tmp)).toContain("【井】");
  });
});

describe("自动事实沉淀(generateFacts)", () => {
  it("从对话提炼事实并入库(kind=fact)", async () => {
    const { generateFacts } = await import("../server/agent/engine");
    const agent = { ...defaultAgents()[0], isolatedMemory: true };
    const msgs = [
      { id: "1", sessionId: "s", role: "user", parts: [{ type: "text", text: "我喜欢吃火锅,我叫小明" }], createdAt: 0 },
    ] as never;
    const text = await generateFacts(
      { kind: "openai", baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "test", model: "mock-model" } as never,
      msgs,
      tmp,
    );
    expect(text.length).toBeGreaterThan(0); // mock 返回了提炼文本
    // 触发逻辑:对话积累 ≥20 条时,自动把提炼结果存进事实库
    const session = db.createSession("facts", agent.id);
    for (let i = 0; i < 22; i++) {
      db.appendMessage({ id: "u" + i, sessionId: session.id, role: "user", parts: [{ type: "text", text: "我们聊了点什么" + i }], createdAt: Date.now() + i });
      db.appendMessage({ id: "a" + i, sessionId: session.id, role: "assistant", parts: [{ type: "text", text: "嗯,记下了" + i }], createdAt: Date.now() + i });
    }
    await engine.runChat(session, agent, "今天聊得不错", () => {});
    // 异步沉淀:轮询等 facts 写入(factCount 推进)
    await new Promise((r) => setTimeout(r, 1000));
    const all = await memory.list(agent.id); // isolatedMemory:事实存在该人格自己的库里(LocalMemory 按目录隔离,条目无 agentId 字段)
    const facts = all.filter((m) => m.kind === "fact");
    expect(facts.length).toBeGreaterThan(0); // 自动沉淀出事实
    const s2 = db.getSession(session.id)!;
    expect(s2.factCount ?? 0).toBeGreaterThanOrEqual(44); // 沉淀时的消息数被记录
  });
});

describe("事实提炼解析(parseFacts)", () => {
  it("丢掉动作描写/语气碎片,只留完整事实(修 31% facts 是碎片的问题)", async () => {
    const { parseFacts } = await import("../server/agent/engine");
    const raw = [
      "- *(笑出声,额头抵着你额头)*",
      "……在岗。**一直在。** 下次也在。🌙",
      "*（顿了顿,抬头看你,眼睛在暗里亮亮的）*",
      "*(手在你手心里慢慢收紧,指节扣进你指缝)*",
      "……",
      "无",
      "",
      "- 小满的院子叫拾光居,是她自己写字的地方。",
      "- 主人答应中秋夜和小满一起看月亮。",
    ].join("\n");
    expect(parseFacts(raw)).toEqual([
      "小满的院子叫拾光居,是她自己写字的地方。",
      "主人答应中秋夜和小满一起看月亮。",
    ]);
  });

  it("没有值得记的事实时不写库(「无」/空 → 空数组)", async () => {
    const { parseFacts } = await import("../server/agent/engine");
    expect(parseFacts("无")).toEqual([]);
    expect(parseFacts("无。")).toEqual([]);
    expect(parseFacts("")).toEqual([]);
  });
});
