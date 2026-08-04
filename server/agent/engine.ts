import { homedir, platform } from "node:os";
import { join } from "node:path";
import { newId, type AgentDef, type ChatMessage, type SessionMeta, type StreamEvent } from "../../shared/types";
import type { MemoryService } from "../memory/service";
import { createProvider } from "../providers";
import type { ProviderMsg, ProviderToolCall } from "../providers/types";
import type { Db } from "../storage";
import { ToolRegistry, type ToolContext } from "../tools/registry";

const MAX_HISTORY_MESSAGES = 40;
const MAX_TOOL_ITERATIONS = 15;

export interface EngineDeps {
  db: Db;
  memory: MemoryService;
  registry: ToolRegistry;
  dataDir: string;
  getSettings: () => { providers: Record<string, any>; activeProvider: string; mainModel: string; toolWhitelistDir: string; };
}

export class AgentEngine {
  constructor(private deps: EngineDeps) {}

  /** 处理一轮用户消息,产生 assistant 消息(可能含工具调用往返) */
  async runChat(
    session: SessionMeta,
    agent: AgentDef,
    userContent: string,
    onEvent: (e: StreamEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    const { db, memory, registry, dataDir } = this.deps;
    const settings = this.deps.getSettings();

    const userMsg: ChatMessage = {
      id: newId("msg"),
      sessionId: session.id,
      role: "user",
      parts: [{ type: "text", text: userContent }],
      createdAt: Date.now(),
    };
    db.appendMessage(userMsg);

    const providerCfg = settings.providers[settings.activeProvider];
    if (!providerCfg) {
      const err = new Error("尚未配置模型,请先在设置中填写 API Key 和模型。");
      return this.fail(db, session, onEvent, err);
    }
    const provider = createProvider(providerCfg);

    // 组装系统提示:人格 + 记忆 + 环境
    const memories = agent.memoryEnabled ? await memory.recall(userContent, 6) : [];
    const memoryBlock = memories.length
      ? `\n\n【长期记忆(可能相关,仅供参考)】\n${memories.map((m) => `- ${m.content}`).join("\n")}`
      : "";
    const systemPrompt = buildSystemPrompt(agent, dataDir, settings.toolWhitelistDir, memoryBlock);

    // 历史消息 → provider 消息
    const history = db.getMessages(session.id).slice(-MAX_HISTORY_MESSAGES);
    const providerMessages: ProviderMsg[] = [
      { role: "system", content: systemPrompt },
      ...historyToProviderMessages(history),
      { role: "user", content: userContent },
    ];

    const tools = registry
      .list()
      .filter((t) => agent.tools.includes(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    const assistant: ChatMessage = {
      id: newId("msg"),
      sessionId: session.id,
      role: "assistant",
      parts: [],
      createdAt: Date.now(),
      model: provider.model,
    };
    db.appendMessage(assistant);

    const toolCtx: ToolContext = {
      cwd: settings.toolWhitelistDir || join(dataDir, "workspace"),
      allowedWriteDirs: [join(dataDir, "workspace"), settings.toolWhitelistDir].filter(Boolean),
      dataDir,
      env: process.env,
      memory: agent.memoryEnabled ? memory : null,
    };

    let textBuf = "";
    let iteration = 0;
    let stop = false;

    try {
      while (!stop && iteration < MAX_TOOL_ITERATIONS) {
        iteration++;
        let toolCalls: ProviderToolCall[] = [];

        for await (const chunk of provider.chatStream(
          { messages: providerMessages, tools, temperature: 0.7, maxTokens: 4096 },
          signal,
        )) {
          if (chunk.delta) {
            textBuf += chunk.delta;
            await onEvent({ type: "delta", content: chunk.delta });
          }
          if (chunk.toolCalls) toolCalls = chunk.toolCalls;
        }

        if (!toolCalls.length) {
          stop = true;
          break;
        }

        // 执行工具
        const toolParts = [];
        for (const tc of toolCalls) {
          const startedAt = Date.now();
          const part = {
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
            status: "running" as const,
            startedAt,
          };
          await onEvent({ type: "tool_start", tool: part });
          const output = await registry.run(tc.name, safeParseArgs(tc.arguments), toolCtx);
          const donePart = { ...part, status: "done" as const, output, finishedAt: Date.now() };
          await onEvent({ type: "tool_end", tool: donePart });
          toolParts.push(donePart);

          // 追加到消息历史
          assistant.parts.push({ type: "tool", tool: donePart });
          providerMessages.push({
            role: "assistant",
            content: "",
            toolCalls: [{ id: tc.id, name: tc.name, arguments: tc.arguments }],
          });
          providerMessages.push({ role: "tool", content: output, toolCallId: tc.id });
        }
        // 无文本时也记录 assistant 文本
        if (textBuf && assistant.parts.find((p) => p.type === "text") === undefined) {
          // 文本已在 delta 中流式展示,这里只持久化
        }
      }

      // 记录最终文本
      if (textBuf) {
        assistant.parts.push({ type: "text", text: textBuf });
      } else if (!assistant.parts.length) {
        assistant.parts.push({ type: "text", text: "(模型没有返回内容)" });
      }
      db.updateMessage(assistant);
      db.updateSession(session.id, { title: deriveTitle(session, userContent), updatedAt: Date.now() });
      const updatedSession = db.getSession(session.id)!;
      await onEvent({ type: "done", message: assistant, session: updatedSession });

      // 异步记住本次对话要点
      if (agent.memoryEnabled) {
        const summary = summarize(userContent, textBuf);
        void memory.retain(summary, "experience");
      }

      return assistant;
    } catch (err: any) {
      return this.fail(db, session, onEvent, err);
    }
  }

  private async fail(db: Db, session: SessionMeta, onEvent: (e: StreamEvent) => void | Promise<void>, err: Error): Promise<ChatMessage> {
    const msg: ChatMessage = {
      id: newId("msg"),
      sessionId: session.id,
      role: "assistant",
      parts: [{ type: "text", text: `出错了:${err.message}` }],
      createdAt: Date.now(),
      error: err.message,
    };
    db.appendMessage(msg);
    db.updateSession(session.id, { updatedAt: Date.now() });
    await onEvent({ type: "error", message: err.message });
    return msg;
  }
}

/** 历史消息 → Provider 消息序列。
 * 关键:assistant 带 tool_calls 时,必须为每个工具调用生成一条 role="tool" 的结果消息
 * (OpenAI 兼容 API 严格校验 tool_calls 后必须有对应的 tool 消息,否则 400)。
 */
export function historyToProviderMessages(messages: ChatMessage[]): ProviderMsg[] {
  const out: ProviderMsg[] = [];
  for (const m of messages) {
    const text = m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
    if (m.role === "user") {
      out.push({ role: "user", content: text });
      continue;
    }
    const toolParts = m.parts.filter((p) => p.type === "tool" && p.tool);
    if (m.role === "assistant" && toolParts.length) {
      out.push({
        role: "assistant",
        content: text,
        toolCalls: toolParts.map((p) => ({
          id: p.tool!.id,
          name: p.tool!.name,
          arguments: p.tool!.input || "{}",
        })),
      });
      for (const p of toolParts) {
        out.push({ role: "tool", content: p.tool!.output ?? "(无输出)", toolCallId: p.tool!.id });
      }
    } else {
      out.push({ role: m.role === "system" ? "system" : "assistant", content: text });
    }
  }
  return out;
}

/** ChatMessage(parts) → 单条 Provider 消息(仅文本场景;带工具调用请用 historyToProviderMessages) */
export function toProviderMsg(m: ChatMessage): ProviderMsg {
  const text = m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  if (m.role === "user") {
    return { role: "user", content: text };
  }
  // assistant 或 system
  const toolParts = m.parts.filter((p) => p.type === "tool" && p.tool);
  if (m.role === "assistant" && toolParts.length) {
    const toolCalls: ProviderToolCall[] = toolParts.map((p) => ({
      id: p.tool!.id,
      name: p.tool!.name,
      arguments: p.tool!.input || "{}",
    }));
    const base: ProviderMsg = { role: "assistant", content: text, toolCalls };
    return base;
  }
  return { role: m.role === "system" ? "system" : "assistant", content: text };
}

export function buildSystemPrompt(agent: AgentDef, dataDir: string, whitelistDir: string, memoryBlock: string): string {
  const cwd = whitelistDir || join(dataDir, "workspace");
  return `${agent.systemPrompt || "你是一个乐于助人的私人 AI 助手。"}

【环境信息】
- 日期时间:${new Date().toLocaleString("zh-CN")}
- 操作系统:${platform()}${platform() === "win32" ? " (Windows)" : ""}
- 用户主目录:${homedir()}
- 你的工作目录(可读写):${cwd}
- 文件写入仅允许在工作目录或用户白名单目录内;读取不受限。执行命令以当前用户权限运行,请对危险操作保持谨慎并先征得同意。${memoryBlock}

【工作方式】
- 需要操作文件、执行命令、抓取网页、回忆记忆时,先调用对应工具,再根据结果回答。
- 回答使用用户的语言;简洁自然,像朋友一样。`;
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args || "{}");
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    return {};
  }
}

function deriveTitle(session: SessionMeta, content: string): string {
  if (session.title !== "新会话") return session.title;
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > 24 ? t.slice(0, 24) + "…" : t || "新会话";
}

function summarize(user: string, reply: string): string {
  const u = user.replace(/\s+/g, " ").trim().slice(0, 200);
  const r = reply.replace(/\s+/g, " ").trim().slice(0, 300);
  return `对话:用户说"${u}";助手回应"${r}"`;
}
