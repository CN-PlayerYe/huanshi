import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { newId, type AgentDef } from "../shared/types";
import { AgentEngine } from "../server/agent/engine";
import { MemoryService } from "../server/memory/service";
import { Db } from "../server/storage";
import { ToolRegistry } from "../server/tools/registry";

/** mock 服务器:第一次请求(带 vision)当辅助视觉模型,返回描述;之后当主模型,校验收到的是描述文本而非图片 */
function startMockDual() {
  let requests = 0;
  let mainGotVision = false;
  let mainGotDesc = false;
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
      const done = { id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
      const lastUser = [...parsed.messages].reverse().find((m: any) => m.role === "user");
      const hasImage = Array.isArray(lastUser?.content) && lastUser.content.some((c: any) => c.type === "image_url");
      if (requests === 1) {
        // 辅助视觉模型:收到图片 → 返回描述
        expect(hasImage).toBe(true);
        sse([
          JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "一只白色的狐狸在月光下的山谷" }, finish_reason: null }] }),
          JSON.stringify(done),
        ]);
        return;
      }
      // 主模型:不应收到图片,应收到描述文本
      mainGotVision = hasImage;
      mainGotDesc = typeof lastUser?.content === "string" && lastUser.content.includes("图片内容");
      sse([
        JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "好的,我明白了" }, finish_reason: null }] }),
        JSON.stringify(done),
      ]);
    });
  });
  return new Promise<{ port: number; checks: () => { mainGotVision: boolean; mainGotDesc: boolean }; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        checks: () => ({ mainGotVision, mainGotDesc }),
        close: () => server.close(),
      });
    });
  });
}

describe("视觉辅助模型(纯文本主模型 + 多模态辅助)", () => {
  const servers: { close: () => void }[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
  });

  it("图片先交给辅助模型转描述,主模型只收到文本", async () => {
    const mock = await startMockDual();
    servers.push(mock);
    const dir = mkdtempSync(join(tmpdir(), "hanalite-vision-"));
    // 造一张假图片文件
    const upDir = join(dir, "uploads");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(upDir, { recursive: true });
    writeFileSync(join(upDir, "t.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

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
        providers: {
          main: { kind: "openai", baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "x", model: "deepseek-v4" },
          vision: { kind: "openai", baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "x", model: "qwen-vl" },
        },
        activeProvider: "main",
        mainModel: "deepseek-v4",
        visionProvider: "vision",
        toolWhitelistDir: dir,
      }),
    });
    const agent: AgentDef = {
      id: newId("agent"),
      name: "测试",
      description: "",
      systemPrompt: "测试",
      memoryEnabled: false,
      tools: [],
      createdAt: Date.now(),
    };
    const session = db.createSession("s", agent.id);
    const msg = await engine.runChat(session, agent, "看看这张图", () => undefined, undefined, [{ file: "uploads/t.png", mime: "image/png" }]);

    const { mainGotVision, mainGotDesc } = mock.checks();
    expect(mainGotVision).toBe(false); // 主模型(纯文本)没收到图片
    expect(mainGotDesc).toBe(true); // 但收到了文字描述
    // 描述已缓存回消息
    const saved = db.getMessages(session.id).find((m) => m.role === "user");
    expect(saved?.parts.some((p) => p.type === "image" && p.image?.desc === "一只白色的狐狸在月光下的山谷")).toBe(true);
    expect(msg.parts.some((p) => p.type === "text" && p.text === "好的,我明白了")).toBe(true);
  });
});
