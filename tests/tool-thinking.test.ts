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
 * 集成测试:模拟 DeepSeek thinking 模式端点。
 * 规则:带 tool_calls 的 assistant 消息必须携带 reasoning_content,否则 400。
 * 第一轮返回"思考 + 正文 + 工具调用";第二轮校验请求体后返回普通流。
 */
function startMockDeepSeek() {
  let requests = 0;
  let secondReqAssistantHasReasoning = false;
  let sawToolCall = false;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests++;
      const sse = (chunks: string[]) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const c of chunks) res.write(`data: ${c}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      const doneChunk = { id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
      if (requests === 1) {
        sawToolCall = true;
        sse([
          JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { reasoning_content: "让我先查一下" }, finish_reason: null }] }),
          JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "好的,查一下" }, finish_reason: null }] }),
          JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            model: "m",
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "mock_tool", arguments: '{"x":1}' } }] },
                finish_reason: null,
              },
            ],
          }),
          JSON.stringify(doneChunk),
        ]);
        return;
      }
      // 第二轮:校验带 tool_calls 的 assistant 是否带了 reasoning_content(DeepSeek 规则)
      const assistants = parsed.messages.filter((m: any) => m.role === "assistant");
      const withTools = assistants.find((m: any) => m.tool_calls?.length);
      secondReqAssistantHasReasoning = Boolean(withTools && typeof withTools.reasoning_content === "string" && withTools.reasoning_content.length > 0);
      if (!secondReqAssistantHasReasoning) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "The reasoning_content in the thinking mode must be passed back to the API." } }));
        return;
      }
      sse([
        JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { reasoning_content: "第二次思考" }, finish_reason: null }] }),
        JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "查完了,结果是 42" }, finish_reason: null }] }),
        JSON.stringify(doneChunk),
      ]);
    });
  });

  return new Promise<{ port: number; checks: () => { sawToolCall: boolean; secondReqAssistantHasReasoning: boolean }; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        checks: () => ({ sawToolCall, secondReqAssistantHasReasoning }),
        close: () => server.close(),
      });
    });
  });
}

describe("工具调用轮的 reasoning_content 回传(DeepSeek thinking 模式)", () => {
  const servers: { close: () => void }[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
  });

  it("带工具调用时,第二轮请求回传本轮思考", async () => {
    const mock = await startMockDeepSeek();
    servers.push(mock);
    const dir = mkdtempSync(join(tmpdir(), "hanalite-tool-"));
    const db = Db.fromPaths({ dataDir: dir } as never);
    const memory = new MemoryService(
      { mode: "local", hindsightBaseUrl: "", hindsightApiKey: "", hindsightBankId: "t", localEnabled: true, experienceCap: 2000 },
      dir,
    );
    const registry = new ToolRegistry();
    registry.register({
      name: "mock_tool",
      description: "mock",
      parameters: { type: "object", properties: {} },
      run: () => "工具结果:42",
    });
    const engine = new AgentEngine({
      db,
      memory,
      registry,
      dataDir: dir,
      getSettings: () => ({
        providers: {
          main: { kind: "openai", baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "x", model: "deepseek-reasoner" },
        },
        activeProvider: "main",
        mainModel: "deepseek-reasoner",
        toolWhitelistDir: dir,
      }),
    });

    const agent: AgentDef = {
      id: newId("agent"),
      name: "测试",
      description: "",
      systemPrompt: "测试",
      memoryEnabled: false,
      tools: ["mock_tool"],
      createdAt: Date.now(),
    };
    const session = db.createSession("s", agent.id);
    const events: string[] = [];
    const msg = await engine.runChat(session, agent, "帮我查一下", (e) => events.push(e.type));

    const { sawToolCall, secondReqAssistantHasReasoning } = mock.checks();
    expect(sawToolCall).toBe(true);
    expect(secondReqAssistantHasReasoning).toBe(true); // 关键:第二轮请求回传了思考
    expect(msg.parts.some((p) => p.type === "thinking" && p.text === "让我先查一下第二次思考")).toBe(true);
    expect(msg.parts.some((p) => p.type === "tool" && p.tool?.name === "mock_tool")).toBe(true);
    const finalText = msg.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
    expect(finalText).toContain("查完了");
  });
});
