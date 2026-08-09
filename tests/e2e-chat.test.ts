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

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createHttpServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const payload = JSON.parse(body || "{}");
          const messages = payload.messages ?? [];
          const lastUser = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
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
  const memory = new MemoryService({ mode: "local", localEnabled: true }, join(tmp, "mem"));
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
