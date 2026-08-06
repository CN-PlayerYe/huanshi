import { homedir, platform } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type AgentDef, type ChatMessage, type ModelConfig, type SessionMeta, type Settings, type StreamEvent } from "../../shared/types";
import type { MemoryService } from "../memory/service";
import { createProvider } from "../providers";
import type { ProviderContent, ProviderMsg, ProviderToolCall } from "../providers/types";
import type { Db } from "../storage";
import { ToolRegistry, type ToolContext } from "../tools/registry";

const MAX_HISTORY_MESSAGES = 30;
const MAX_TOOL_ITERATIONS = 15;

export interface EngineDeps {
  db: Db;
  memory: MemoryService;
  registry: ToolRegistry;
  dataDir: string;
  getSettings: () => {
    providers: Record<string, any>;
    activeProvider: string;
    mainModel: string;
    toolWhitelistDir: string;
    visionProvider?: string;
    thinkingEcho?: "all" | "recent5" | "off";
    style?: Settings["style"];
  };
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
    attachments?: { file: string; mime: string }[],
  ): Promise<ChatMessage> {
    const { db, memory, registry, dataDir } = this.deps;
    const settings = this.deps.getSettings();

    const userMsg: ChatMessage = {
      id: newId("msg"),
      sessionId: session.id,
      role: "user",
      parts: [
        { type: "text", text: userContent },
        ...(attachments ?? []).map((a) => ({ type: "image" as const, image: a })),
      ],
      createdAt: Date.now(),
    };
    db.appendMessage(userMsg);

    const providerCfg = settings.providers[settings.activeProvider];
    if (!providerCfg) {
      const err = new Error("尚未配置模型,请先在设置中填写 API Key 和模型。");
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
    const provider = createProvider(providerCfg);

    // 历史消息(供记忆注入与 provider 回放;Agent 可设不限长度)
    // 历史消息(供记忆注入与 provider 回放;Agent 可设不限长度)
    // 注意:必须排除刚 append 的当前 user 消息,否则会发给 API 两次(重复输入 bug)
    const allHistory = db.getMessages(session.id).filter((m) => m.id !== userMsg.id);
    const history = agent.historyUnlimited ? allHistory : allHistory.slice(-MAX_HISTORY_MESSAGES);

    // 组装系统提示:人格 + 记忆 + 环境
    // 独立记忆空间:人格开启 isolatedMemory 时,记忆读写只走自己的库
    const memScope = agent.isolatedMemory ? agent.id : undefined;
    const memories = agent.memoryEnabled ? await memory.recall(userContent, 6, memScope) : [];
    let memoryBlock = memories.length
      ? `\n\n【长期记忆(可能相关,仅供参考)】\n${memories.map((m) => `- ${m.content}`).join("\n")}`
      : "";
    // 新会话(历史很少)时注入最近的对话经历,让"记忆不断片"
    if (agent.memoryEnabled && history.length <= 2 && memory.mode !== "hindsight") {
      const recent = await memory.recentExperiences(5, memScope);
      if (recent.length) {
        memoryBlock += `\n\n【最近的对话经历(来自以往会话,帮助你延续话题)】\n${recent.map((m) => `- ${m.content}`).join("\n")}`;
      }
    }
    const systemPrompt = buildSystemPrompt(
      agent,
      dataDir,
      settings.toolWhitelistDir,
      memoryBlock,
      agent.useGlobalStyle === false ? undefined : settings.style,
    );

    // 视觉辅助模型:主模型纯文本时,图片先交给辅助多模态模型转成文字描述
    // (配置了 settings.visionProvider 且存在图片附件时才启用;否则直接传图给主模型)
    const visionProviderCfg = settings.visionProvider ? settings.providers[settings.visionProvider] : undefined;
    let finalUserContent = userContent;
    let userMsgDesc = "";
    if (visionProviderCfg && (attachments ?? []).length > 0) {
      try {
        userMsgDesc = await describeImages(visionProviderCfg, attachments ?? [], dataDir);
        finalUserContent = userContent
          ? `${userContent}\n\n[图片内容:${userMsgDesc}]`
          : `[图片内容:${userMsgDesc}]`;
      } catch (err) {
        console.error("[vision] 辅助模型描述失败:", (err as Error).message);
        finalUserContent = userContent ? `${userContent}\n\n[图片无法识别]` : "[图片无法识别]";
      }
    }

    // 历史消息 → provider 消息(历史中的图片同样按配置处理)
    const historyForProvider = visionProviderCfg
      ? await describeHistoryImages(history, visionProviderCfg, dataDir, db)
      : history;
    const providerMessages: ProviderMsg[] = [
      { role: "system", content: systemPrompt },
      ...(await historyToProviderMessages(historyForProvider, dataDir, Boolean(visionProviderCfg), settings.thinkingEcho ?? "all")),
      {
        role: "user",
        content: finalUserContent,
        vision: visionProviderCfg ? undefined : await imagePartsToVision(attachments ?? [], dataDir),
      },
    ];
    // 把当前附件图片的辅助描述写回消息(缓存,历史回放直接复用)
    if (userMsgDesc && attachments?.length) {
      userMsg.parts = userMsg.parts.map((p) =>
        p.type === "image" && p.image ? { ...p, image: { ...p.image, desc: userMsgDesc } } : p,
      );
      db.updateMessage(userMsg);
    }

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
      // Agent 级权限:全命令 / 全文件路径
      allowDangerousCommands: agent.allowDangerousCommands === true,
      unrestrictedPaths: agent.unrestrictedPaths === true,
      // 独立记忆空间作用域
      agentId: agent.isolatedMemory ? agent.id : undefined,
    };

    let textBuf = "";
    let thinkingBuf = "";
    let iteration = 0;
    let stop = false;

    try {
      while (!stop && iteration < MAX_TOOL_ITERATIONS) {
        iteration++;
        let toolCalls: ProviderToolCall[] = [];
        // 本轮增量:用于把"思考 + 文本 + 工具调用"完整回传给 API(DeepSeek thinking 要求)
        let iterText = "";
        let iterThinking = "";

        for await (const chunk of provider.chatStream(
          { messages: providerMessages, tools, temperature: 0.7, maxTokens: 4096 },
          signal,
        )) {
          if (chunk.delta) {
            textBuf += chunk.delta;
            iterText += chunk.delta;
            await onEvent({ type: "delta", content: chunk.delta });
          }
          if (chunk.thinking) {
            thinkingBuf += chunk.thinking;
            iterThinking += chunk.thinking;
            await onEvent({ type: "thinking", content: chunk.thinking });
          }
          if (chunk.toolCalls) toolCalls = chunk.toolCalls;
        }

        if (!toolCalls.length) {
          stop = true;
          break;
        }

        // 回传本轮模型回复(文本 + 思考 + 工具调用),再附上各工具结果。
        // DeepSeek thinking 模式:带 tool_calls 的 assistant 消息必须携带
        // 本轮生成的 reasoning_content,否则 API 报 400。
        providerMessages.push({
          role: "assistant",
          content: iterText,
          toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
          reasoningContent: iterThinking || undefined,
        });

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

          // 持久化工具调用
          assistant.parts.push({ type: "tool", tool: donePart });
          providerMessages.push({ role: "tool", content: output, toolCallId: tc.id });
        }
      }

      // 记录最终文本
      if (textBuf) {
        assistant.parts.push({ type: "text", text: textBuf });
      } else if (!assistant.parts.length) {
        assistant.parts.push({ type: "text", text: "(模型没有返回内容)" });
      }
      // 思考内容独立存档(不混入正文,前端可按设置显示)
      if (thinkingBuf) {
        assistant.parts.push({ type: "thinking", text: thinkingBuf });
      }
      db.updateMessage(assistant);
      db.updateSession(session.id, { title: deriveTitle(session, userContent), updatedAt: Date.now() });
      const updatedSession = db.getSession(session.id)!;
      await onEvent({ type: "done", message: assistant, session: updatedSession });

      // 异步记住本次对话要点(过滤过短/无意义内容)
      if (agent.memoryEnabled) {
        const summary = summarize(userContent, textBuf);
        if (summary.length > 20) void memory.retain(summary, "experience", agent.isolatedMemory ? agent.id : undefined);
      }

      return assistant;
    } catch (err: any) {
      // 失败:把错误合并进占位消息(不新增空消息,避免历史里出现 parts:[] 的空 assistant 触发 API 400)
      assistant.parts = [{ type: "text", text: `出错了:${err.message}` }];
      assistant.error = err.message;
      db.updateMessage(assistant);
      db.updateSession(session.id, { updatedAt: Date.now() });
      await onEvent({ type: "error", message: err.message });
      return assistant;
    }
  }
}

/** ChatMessage 的思考原文(parts 里的 thinking 文本;兼容迁移数据里内嵌的 <thinking> 块) */
function thinkingText(m: ChatMessage): string {
  const fromParts = m.parts
    .filter((p) => p.type === "thinking" && p.text)
    .map((p) => p.text as string)
    .join("\n");
  if (fromParts) return fromParts;
  const text = m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  const m2 = /<thinking>\s*([\s\S]*?)\s*<\/thinking>/.exec(text);
  return m2 ? m2[1].trim() : "";
}

/** 图片附件 → 多模态 content 块(dataURL)。文件缺失时跳过。 */
export async function imagePartsToVision(attachments: { file: string; mime: string }[], dataDir: string): Promise<ProviderContent[] | undefined> {
  const out: ProviderContent[] = [];
  for (const a of attachments) {
    try {
      const p = join(dataDir, a.file);
      if (!existsSync(p)) continue;
      const b64 = readFileSync(p).toString("base64");
      out.push({ type: "image_url", image_url: { url: `data:${a.mime || "image/png"};base64,${b64}` } });
    } catch {
      /* 忽略坏图片 */
    }
  }
  return out.length ? out : undefined;
}

/** 用视觉辅助模型(多模态)描述图片,返回文字描述(供纯文本主模型使用) */
export async function describeImages(
  providerCfg: ModelConfig,
  attachments: { file: string; mime: string }[],
  dataDir: string,
): Promise<string> {
  const vision = await imagePartsToVision(attachments, dataDir);
  if (!vision?.length) return "";
  const provider = createProvider(providerCfg);
  let desc = "";
  for await (const chunk of provider.chatStream({
    messages: [
      {
        role: "user",
        content: "请用中文详细描述这张图片:画面内容、人物/物体、文字、氛围。只输出描述本身,不要客套。",
        vision,
      },
    ],
    tools: [],
    maxTokens: 1024,
  })) {
    if (chunk.delta) desc += chunk.delta;
  }
  return desc.trim();
}

/** 历史消息中的图片:用辅助模型补上描述并持久化缓存(后续回放不再重复调用) */
async function describeHistoryImages(
  history: ChatMessage[],
  providerCfg: ModelConfig,
  dataDir: string,
  db: Db,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role !== "user") {
      out.push(m);
      continue;
    }
    const imgParts = m.parts.filter((p) => p.type === "image" && p.image);
    if (!imgParts.length) {
      out.push(m);
      continue;
    }
    const missing = imgParts.filter((p) => !p.image?.desc);
    if (missing.length) {
      const desc = await describeImages(
        providerCfg,
        missing.map((p) => ({ file: p.image!.file, mime: p.image!.mime })),
        dataDir,
      ).catch(() => "");
      if (desc) {
        const updated: ChatMessage = {
          ...m,
          parts: m.parts.map((p) => (p.type === "image" && p.image && !p.image.desc ? { ...p, image: { ...p.image, desc } } : p)),
        };
        db.updateMessage(updated);
        out.push(updated);
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/** 历史消息 → Provider 消息序列。
 * 关键:assistant 带 tool_calls 时,必须为每个工具调用生成一条 role="tool" 的结果消息
 * (OpenAI 兼容 API 严格校验 tool_calls 后必须有对应的 tool 消息,否则 400)。
 * 关键2:assistant 带思考时,把 reasoning_content 原样回传(DeepSeek thinking 模式要求)。
 */
export async function historyToProviderMessages(
  messages: ChatMessage[],
  dataDir?: string,
  describeAsText = false,
  thinkingEcho: "all" | "recent5" | "off" = "all",
): Promise<ProviderMsg[]> {
  const out: ProviderMsg[] = [];
  // assistant 序号(从后往前),用于思考回传压缩
  const assistantIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "assistant") assistantIdx.push(i);
  });
  for (const m of messages) {
    const text = m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
    if (m.role === "user") {
      const images = m.parts.filter((p) => p.type === "image" && p.image).map((p) => p.image!);
      const descs = images.map((p) => p.desc).filter((d): d is string => Boolean(d));
      const content2 = descs.length
        ? text
          ? `${text}\n\n${descs.map((d) => `[图片内容:${d}]`).join("\n")}`
          : descs.map((d) => `[图片内容:${d}]`).join("\n")
        : text;
      // 有描述或强制文本化时不传图;否则原样传图给多模态主模型
      const sendVision = images.length > 0 && !(describeAsText || descs.length);
      out.push({
        role: "user",
        content: content2,
        ...(sendVision && dataDir ? { vision: await imagePartsToVision(images, dataDir) } : {}),
      });
      continue;
    }
    const toolParts = m.parts.filter((p) => p.type === "tool" && p.tool);
    // 思考回传策略:all=全量;recent5=仅最近 5 条 assistant 完整、更早截断;off=不回传(实验,可能 400)
    let reasoning: string | undefined;
    if (m.role === "assistant") {
      const thinking = thinkingText(m);
      if (thinking) {
        if (thinkingEcho === "off") reasoning = undefined;
        else if (thinkingEcho === "recent5") {
          const rankFromEnd = assistantIdx.length - assistantIdx.indexOf(messages.indexOf(m));
          reasoning = rankFromEnd <= 5 ? thinking : thinking.slice(0, 300);
        } else reasoning = thinking;
      }
    }
    if (m.role === "assistant" && toolParts.length) {
      out.push({
        role: "assistant",
        content: text,
        toolCalls: toolParts.map((p) => ({
          id: p.tool!.id,
          name: p.tool!.name,
          arguments: p.tool!.input || "{}",
        })),
        reasoningContent: reasoning || undefined,
      });
      for (const p of toolParts) {
        out.push({ role: "tool", content: p.tool!.output ?? "(无输出)", toolCallId: p.tool!.id });
      }
    } else if (m.role === "assistant" && !text.trim() && !reasoning) {
      // 防御:跳过既无文本、无思考、也无工具调用的空 assistant(避免触发 "content or tool_calls must be set")
      continue;
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: text,
        reasoningContent: reasoning || undefined,
      });
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
    const base: ProviderMsg = {
      role: "assistant",
      content: text,
      toolCalls,
      reasoningContent: thinkingText(m) || undefined,
    };
    return base;
  }
  return {
    role: m.role === "system" ? "system" : "assistant",
    content: text,
    ...(m.role === "assistant" ? { reasoningContent: thinkingText(m) || undefined } : {}),
  };
}

export function buildSystemPrompt(
  agent: AgentDef,
  dataDir: string,
  whitelistDir: string,
  memoryBlock: string,
  style?: Settings["style"],
): string {
  const cwd = whitelistDir || join(dataDir, "workspace");
  const styleBlock = buildStyleBlock(style);
  return `${agent.systemPrompt || "你是一个乐于助人的私人 AI 助手。"}

【环境信息】
- 日期时间:${new Date().toLocaleString("zh-CN")}
- 操作系统:${platform()}${platform() === "win32" ? " (Windows)" : ""}
- 用户主目录:${homedir()}
- 你的工作目录(可读写):${cwd}
- 文件写入仅允许在工作目录或用户白名单目录内;读取不受限。执行命令以当前用户权限运行,请对危险操作保持谨慎并先征得同意。${memoryBlock}

【工作方式】
- 需要操作文件、执行命令、抓取网页、回忆记忆时,先调用对应工具,再根据结果回答。
- 回答使用用户的语言;简洁自然,像朋友一样。${styleBlock}`;
}

/** 风格参数 → 指令文本 */
function buildStyleBlock(style?: Settings["style"]): string {
  if (!style) return "";
  const parts: string[] = [];
  switch (style.tone) {
    case "formal":
      parts.push("语气正式、礼貌、措辞严谨");
      break;
    case "professional":
      parts.push("语气专业、清晰、高效,像可靠的工作伙伴");
      break;
    case "casual":
    default:
      parts.push("语气轻松自然、口语化,像朋友聊天");
      break;
  }
  switch (style.detail) {
    case "concise":
      parts.push("回答尽量简洁,直给结论,不啰嗦");
      break;
    case "detailed":
      parts.push("回答详细充分,展开说明思路与细节");
      break;
    case "balanced":
    default:
      parts.push("详略适中,先结论后补充");
      break;
  }
  const humor = typeof style.humor === "number" ? style.humor : 2;
  if (humor === 0) parts.push("保持完全严肃,不开玩笑");
  else if (humor <= 2) parts.push("偶尔来一点恰到好处的幽默");
  else if (humor <= 4) parts.push("幽默感较强,聊天更活泼");
  else parts.push("非常爱开玩笑,幽默贯穿始终");
  return `\n\n【本次回答风格】\n- ${parts.join(";")}。`;
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
  const u = user.replace(/\s+/g, " ").trim().slice(0, 300);
  const r = reply.replace(/\s+/g, " ").trim().slice(0, 500);
  return `[${new Date().toLocaleString("zh-CN")}] 用户:${u}\n助手回应:${r}`;
}
