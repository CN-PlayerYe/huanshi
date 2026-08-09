import { homedir, platform } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { newId, type AgentDef, type ChatMessage, type ModelConfig, type SessionMeta, type Settings, type StreamEvent } from "../../shared/types";
import type { MemoryService } from "../memory/service";
import { createProvider } from "../providers";
import type { ProviderContent, ProviderMsg, ProviderToolCall } from "../providers/types";
import type { Db } from "../storage";
import { ToolRegistry, type ToolContext } from "../tools/registry";

/** 人格级模型解析:优先用该 Agent 自己配置的 provider/model,否则跟随全局。
 *  写论文/多任务时可为每个人格配不同模型(如 DeepSeek 写稿 + 别的模型润色)。 */
export function resolveModel(
  agent: AgentDef,
  settings: { providers: Record<string, ModelConfig>; activeProvider: string; mainModel?: string },
): ModelConfig {
  const pid = agent.provider || settings.activeProvider;
  const base = settings.providers[pid] || settings.providers[settings.activeProvider];
  if (!base) return base;
  return agent.model && base.model !== agent.model ? { ...base, model: agent.model } : base;
}

/** 请求体保命线上限(字节):settings.requestBodyLimitKB(0=不限制,undefined=用默认) */
function bodyLimitOf(settings: Record<string, unknown>): number | undefined {
  const kb = settings.requestBodyLimitKB;
  if (typeof kb !== "number") return undefined;
  return kb === 0 ? 0 : kb * 1024;
}

export interface ChatRunOpts {
  /** 仅允许这些工具(与边界过滤叠加) */
  allowedTools?: string[];
  /** 只读模式:排除写类工具(写文件/写记忆/命令) */
  readOnly?: boolean;
  /** 联网工具(抓网页/搜索)是否禁用 */
  allowNetwork?: boolean;
  /** 命令工具是否禁用 */
  allowCommands?: boolean;
  /** 覆盖工作目录(心跳活动范围) */
  cwd?: string;
  /** 覆盖写入白名单目录 */
  allowedWriteDirs?: string[];
  /** 覆盖高危命令权限 */
  allowDangerousCommands?: boolean;
  /** 覆盖路径白名单 */
  unrestrictedPaths?: boolean;
}

/** 写类工具:只读模式下禁用 */
const WRITE_TOOLS = new Set(["file_write", "file_append", "memory_retain", "run_command"]);
/** 联网工具 */
const NETWORK_TOOLS = new Set(["fetch_url", "search_web"]);

const MAX_HISTORY_MESSAGES = 30;
/** 「历史不限长度」的物理上限:模型上下文有限,超长会极慢甚至超限(野生人格遇到过 1.4MB/88 秒) */
const MAX_HISTORY_UNLIMITED = 400;
/** 单条 assistant 最多回放的工具结果数(迁移会话可能出现上百个工具调用,全量回放会撑爆 payload) */
const MAX_TOOL_RESULTS = 15;
/** 每条工具输出回放截断长度 */
const MAX_TOOL_OUTPUT = 3000;
/** 单条文本回放截断长度 */
const MAX_TEXT_LEN = 20000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…[已截断]" : s;
}

/** 估算一条消息的 token 数(中文约 1 token/字,保守按 2 字符/token;含正文/思考/工具输出) */
function estimateTokens(m: ChatMessage): number {
  let chars = 0;
  for (const p of m.parts) {
    if (p.type === "text" || p.type === "thinking") chars += (p.text || "").length;
    else if (p.type === "tool" && p.tool) {
      chars += (p.tool.output || "").length;
      chars += typeof p.tool.input === "string" ? p.tool.input.length : JSON.stringify(p.tool.input || {}).length;
    }
  }
  return Math.ceil(chars / 2);
}

/**
 * 按历史上下文百分比截取:historyContextPct 为 0-100 时,按估算 token 从最近的
 * 消息往回保留约 pct% 的历史(消息整体保留,不切半条);100 = 全部。返回的数组
 * 仍受 MAX_HISTORY_UNLIMITED(200 条)兜底。
 */
export function sliceHistoryByPct(messages: ChatMessage[], agent: AgentDef): ChatMessage[] {
  const pct = agent.historyContextPct;
  const unlimited = agent.historyUnlimited === true;
  if (pct == null) {
    // 兼容旧配置:historyUnlimited=true 等效 100%;否则用默认窗口
    return unlimited ? messages : messages.slice(-MAX_HISTORY_MESSAGES);
  }
  if (pct >= 100) return messages; // 真无限:全部发送(慢是用户自己的选择)
  if (messages.length <= 1) return messages;
  const total = messages.reduce((n, m) => n + estimateTokens(m), 0);
  if (total === 0) return messages.slice(-MAX_HISTORY_UNLIMITED);
  const target = Math.floor((total * Math.max(0, pct)) / 100);
  let acc = 0;
  const kept: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    kept.unshift(messages[i]);
    acc += estimateTokens(messages[i]);
    if (acc >= target) break;
  }
  return kept.slice(-MAX_HISTORY_UNLIMITED);
}

/** 正在生成摘要的会话(防止并发重复生成) */
const summaryLocks = new Set<string>();

/** 世界观文档生成:综合会话摘要 + 最近对话,生成/更新结构化设定文档 */
export async function generateLore(
  providerCfg: ModelConfig,
  messages: ChatMessage[],
  existingLore: string | undefined,
  dataDir: string,
): Promise<string> {
  if (!providerCfg || !messages.length) return "";
  const provider = createProvider(providerCfg);
  const history = messages
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .slice(0, 1500),
    }))
    .filter((m) => m.content.trim())
    .slice(-60);
  if (!history.length) return "";
  let text = "";
  try {
    for await (const chunk of provider.chatStream({
      messages: [
        {
          role: "system",
          content:
            (existingLore ? `以下是现有世界观设定文档,请在其基础上更新(保留有效内容,合并新信息):\n${existingLore}\n\n` : "") +
            "你是世界观整理师。请根据对话记录,生成/更新一份世界观设定文档,结构固定为:\n" +
            "【世界背景】【主要人物(含性格/身份/关系)】【剧情进展】【重要设定与规则】【用户偏好与互动方式】【未解决悬念】\n" +
            "精炼准确,中文,600字以内。只输出文档本身。",
        },
        ...history,
      ],
      tools: [],
      maxTokens: 1200,
    })) {
      if (chunk.delta) text += chunk.delta;
    }
  } catch {
    /* 失败不影响主流程 */
  }
  return text.trim();
}

/**
 * 用模型把早期对话压成摘要(纯文本请求,不调工具)。
 * 供"AI 自动摘要":会话过长时让 AI 自主提炼关键信息,而不是简单截断。
 */
export async function generateSummary(
  providerCfg: ModelConfig,
  messages: ChatMessage[],
  dataDir: string,
): Promise<string> {
  if (!providerCfg || !messages.length) return "";
  const provider = createProvider(providerCfg);
  const history = messages
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .slice(0, 2000),
    }))
    .filter((m) => m.content.trim());
  if (!history.length) return "";
  let text = "";
  try {
    for await (const chunk of provider.chatStream({
      messages: [
        {
          role: "system",
          content:
            "你是对话整理助手。请把下面的早期对话压缩成一份精炼摘要,必须保留:人物设定与关系、剧情进展、用户的偏好与习惯、重要事实与承诺、未完成事项。用要点列表,中文,300字以内。只输出摘要本身。",
        },
        ...history,
      ],
      tools: [],
      maxTokens: 800,
    })) {
      if (chunk.delta) text += chunk.delta;
    }
  } catch {
    /* 摘要失败不影响主流程 */
  }
  return text.trim();
}
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
    autoSummarize?: boolean;
    enableOptions?: boolean;
    style?: Settings["style"];
  };
}

export class AgentEngine {
  constructor(private deps: EngineDeps) {}

  /** 处理一轮用户消息,产生 assistant 消息(可能含工具调用往返) */
  /**
   * 群聊模式:一个会话里多个不同人格依次对同一话题发言。
   * 每个成员看到"用户输入 + 前面成员的发言",以自己身份回应。
   */
  async groupChat(
    session: SessionMeta,
    agents: AgentDef[],
    userContent: string,
    onEvent: (e: StreamEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const { db, memory, registry, dataDir } = this.deps;
    const settings = this.deps.getSettings();
    // 用户消息只写入一次
    const userMsg: ChatMessage = {
      id: newId("msg"),
      sessionId: session.id,
      role: "user",
      parts: [{ type: "text", text: userContent }],
      createdAt: Date.now(),
    };
    db.appendMessage(userMsg);

    for (const agent of agents) {
      const historyAll = db.getMessages(session.id).filter((m) => m.id !== userMsg.id);
      const history = sliceHistoryByPct(historyAll, agent);
      const systemPrompt = buildSystemPrompt(agent, dataDir, settings.toolWhitelistDir, "", agent.useGlobalStyle === false ? undefined : settings.style);
      const providerMessages: ProviderMsg[] = [
        { role: "system", content: systemPrompt },
        ...(await historyToProviderMessages(history, dataDir, false, settings.thinkingEcho ?? "all", (id) => db.getAgent(id)?.name)),
        {
          role: "user",
          content: `(群聊)用户说:${userContent}\n你是「${agent.name}」,请以你的身份和性格回应在场的对话。`,
        },
      ];
      const provider = createProvider(resolveModel(agent, settings));
      const assistant: ChatMessage = {
        id: newId("msg"),
        sessionId: session.id,
        role: "assistant",
        agentId: agent.id,
        parts: [],
        createdAt: Date.now(),
      };
      db.appendMessage(assistant);
      await onEvent({ type: "message_start", message: { id: assistant.id, agentId: agent.id } });
      let textBuf = "";
      try {
        for await (const chunk of provider.chatStream({ messages: providerMessages, tools: [], temperature: 0.8, maxTokens: 2048, maxBodyBytes: bodyLimitOf(settings) }, signal)) {
          if (chunk.delta) {
            textBuf += chunk.delta;
            await onEvent({ type: "delta", content: chunk.delta });
          }
        }
        if (textBuf) assistant.parts.push({ type: "text", text: textBuf });
        else assistant.parts.push({ type: "text", text: "(沉默不语)" });
      } catch (err) {
        assistant.parts = [{ type: "text", text: `出错了:${(err as Error).message}` }];
      }
      db.updateMessage(assistant);
      db.updateSession(session.id, { updatedAt: Date.now() });
    }
    await onEvent({ type: "done", message: db.getMessages(session.id).slice(-1)[0], session });
  }

  async runChat(
    session: SessionMeta,
    agent: AgentDef,
    userContent: string,
    onEvent: (e: StreamEvent) => void | Promise<void>,
    signal?: AbortSignal,
    attachments?: { file: string; mime: string }[],
    opts?: ChatRunOpts,
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

    const providerCfg = resolveModel(agent, settings);
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
    const history = sliceHistoryByPct(allHistory, agent);

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
    // AI 自动摘要:会话过长时,后台用模型把早期对话压成摘要存进 session,发送时注入
    // (后台生成不阻塞本次回复;摘要让模型记得早期剧情,而不是简单丢弃)
    if (settings.autoSummarize !== false && allHistory.length > MAX_HISTORY_UNLIMITED) {
      const stale = !session.summary || allHistory.length - (session.summaryCount ?? 0) > 50;
      if (stale && !summaryLocks.has(session.id)) {
        summaryLocks.add(session.id);
        const early = allHistory.slice(0, allHistory.length - MAX_HISTORY_UNLIMITED);
        void generateSummary(providerCfg, early, dataDir)
          .then((text) => {
            if (text) db.updateSession(session.id, { summary: text, summaryCount: allHistory.length });
          })
          .catch(() => undefined)
          .finally(() => summaryLocks.delete(session.id));
      }
    }
    // 摘要注入:追加到 memoryBlock(作为早期对话的背景),再组装 system prompt
    if (session.summary) {
      memoryBlock += `\n\n【早期对话摘要(本会话较早部分,供你延续剧情)】\n${session.summary}`;
    }
    // 世界观设定文档注入(由 AI 维护的长篇设定,优先级高于滚动摘要)
    if (session.lore) {
      memoryBlock += `\n\n【世界观设定文档(本故事世界的权威设定,务必遵守)】\n${session.lore}`;
    }
    const effCwd = opts?.cwd || settings.toolWhitelistDir || join(dataDir, "workspace");
    const homeDir = opts?.cwd && basename(opts.cwd) === agent.name ? opts.cwd : join(effCwd, agent.name);
    const systemPrompt = buildSystemPrompt(
      agent,
      dataDir,
      settings.toolWhitelistDir,
      memoryBlock,
      agent.useGlobalStyle === false ? undefined : settings.style,
      homeDir,
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
      // 心跳安全边界:按 opts 裁剪工具(只读/联网/命令)
      .filter((t) => (opts?.allowedTools ? opts.allowedTools.includes(t.name) : true))
      .filter((t) => (opts?.readOnly ? !WRITE_TOOLS.has(t.name) : true))
      .filter((t) => (opts?.allowNetwork === false ? !NETWORK_TOOLS.has(t.name) : true))
      .filter((t) => (opts?.allowCommands === false ? t.name !== "run_command" : true))
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
    await onEvent({ type: "message_start", message: { id: assistant.id, agentId: agent.id } });

    const toolCtx: ToolContext = {
      cwd: opts?.cwd || settings.toolWhitelistDir || join(dataDir, "workspace"),
      allowedWriteDirs: opts?.allowedWriteDirs || [join(dataDir, "workspace"), settings.toolWhitelistDir].filter(Boolean),
      dataDir,
      env: process.env,
      memory: agent.memoryEnabled ? memory : null,
      // Agent 级权限:全命令 / 全文件路径(心跳边界可覆盖收紧)
      allowDangerousCommands: opts?.allowDangerousCommands ?? (agent.allowDangerousCommands === true),
      unrestrictedPaths: opts?.unrestrictedPaths ?? (agent.unrestrictedPaths === true),
      // 独立记忆空间作用域
      agentId: agent.isolatedMemory ? agent.id : undefined,
    };

    let textBuf = "";
    let thinkingBuf = "";
    let iteration = 0;
    let stop = false;
    // 请求性能日志(诊断慢会话用):记录 payload 大小 / 首 token 耗时 / 总耗时
    const reqLogPath = join(dataDir, "logs", "requests.log");
    const reqStart = Date.now();
    let firstTokenMs = 0;

    try {
      while (!stop && iteration < MAX_TOOL_ITERATIONS) {
        iteration++;
        let toolCalls: ProviderToolCall[] = [];
        // 本轮增量:用于把"思考 + 文本 + 工具调用"完整回传给 API(DeepSeek thinking 要求)
        let iterText = "";
        let iterThinking = "";

        for await (const chunk of provider.chatStream(
          { messages: providerMessages, tools, temperature: 0.7, maxTokens: 4096, maxBodyBytes: bodyLimitOf(settings) },
          signal,
        )) {
          if (!firstTokenMs) firstTokenMs = Date.now() - reqStart;
          if (chunk.trimmed) {
            await onEvent({
              type: "context_trimmed",
              keptMessages: chunk.trimmed.keptMessages,
              reason: `历史过长(超 200KB),已自动压缩:本次发送保留最近 ${chunk.trimmed.keptMessages} 条。数据未删除,可在「设置-人格-历史上下文」调整保留度。`,
            });
          }
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
        // 心跳消息是系统代发的“自主活动邀请”,不是用户的言行,不沉淀为记忆(避免污染人格身份)
        if (summary.length > 20 && !summary.startsWith("【心跳】")) {
          void memory.retain(summary, "experience", agent.isolatedMemory ? agent.id : undefined);
        }
      }

      // 成功路径:记录请求性能(诊断慢会话)
      try {
        const { mkdirSync: mk, writeFileSync: wr } = require("node:fs") as typeof import("node:fs");
        mk(join(dataDir, "logs"), { recursive: true });
        wr(
          reqLogPath,
          JSON.stringify({
            at: new Date().toISOString(),
            agent: agent.name,
            payloadKB: Math.round(JSON.stringify(providerMessages).length / 1024),
            firstTokenMs,
            totalMs: Date.now() - reqStart,
          }) + "\n",
          { flag: "a" },
        );
      } catch {
        /* ignore */
      }

      // 剧情选项分支:后台生成 2-3 个下一步选项并广播(不阻塞本次回复;失败则无选项)
      if (settings.enableOptions !== false) {
        const recent = db.getMessages(session.id).slice(-8);
        void generateOptions(providerCfg, recent).then((opts) => {
          if (opts.length >= 2) {
            void onEvent({ type: "options", sessionId: session.id, options: opts });
          }
        });
      }

      return assistant;
    } catch (err: any) {
      // 失败:把错误合并进占位消息(不新增空消息,避免历史里出现 parts:[] 的空 assistant 触发 API 400)
      assistant.parts = [{ type: "text", text: `出错了:${err.message}` }];
      assistant.error = err.message;
      db.updateMessage(assistant);
      db.updateSession(session.id, { updatedAt: Date.now() });
      await onEvent({ type: "error", message: err.message });
      try {
        const { mkdirSync: mk, writeFileSync: wr } = require("node:fs") as typeof import("node:fs");
        mk(join(dataDir, "logs"), { recursive: true });
        wr(reqLogPath, JSON.stringify({ at: new Date().toISOString(), agent: agent.name, payloadKB: Math.round(JSON.stringify(providerMessages).length / 1024), firstTokenMs, error: String(err.message).slice(0, 200) }) + "\n", { flag: "a" });
      } catch {
        /* ignore */
      }
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
  agentNameOf?: (agentId: string) => string | undefined,
): Promise<ProviderMsg[]> {
  const out: ProviderMsg[] = [];
  // assistant 序号(从后往前),用于思考回传压缩
  const assistantIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "assistant") assistantIdx.push(i);
  });
  for (const m of messages) {
    // 文本截断:迁移的超长正文避免撑爆请求
    const text = truncate(
      m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n"),
      MAX_TEXT_LEN,
    );
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
    // 只回放最近 MAX_TOOL_RESULTS 个工具结果(迁移会话可能有上百个,全量会极慢)
    const toolParts = m.parts.filter((p) => p.type === "tool" && p.tool).slice(-MAX_TOOL_RESULTS);
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
      // 群聊回放:给发言带上人格名,让模型分清在场是谁说的
      const speaker = m.agentId ? agentNameOf?.(m.agentId) : undefined;
      const spoken = speaker && text.trim() ? `（${speaker}）${text}` : text;
      out.push({
        role: "assistant",
        content: spoken,
        toolCalls: toolParts.map((p) => ({
          id: p.tool!.id,
          name: p.tool!.name,
          arguments: p.tool!.input || "{}",
        })),
        reasoningContent: reasoning || undefined,
      });
      for (const p of toolParts) {
        out.push({ role: "tool", content: truncate(p.tool!.output ?? "(无输出)", MAX_TOOL_OUTPUT), toolCallId: p.tool!.id });
      }
    } else if (m.role === "assistant" && !text.trim() && !reasoning) {
      // 防御:跳过既无文本、无思考、也无工具调用的空 assistant(避免触发 "content or tool_calls must be set")
      continue;
    } else if (m.role === "assistant") {
      const speaker = m.agentId ? agentNameOf?.(m.agentId) : undefined;
      const spoken = speaker && text.trim() ? `（${speaker}）${text}` : text;
      out.push({
        role: "assistant",
        content: spoken,
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
  homeDirOverride?: string,
): string {
  // 实际工作目录:心跳/自由活动等会用专属空间作为 cwd;普通对话用白名单目录或默认 workspace
  const cwd = homeDirOverride || whitelistDir || join(dataDir, "workspace");
  // 专属空间(院子):当 cwd 已是该人格的院子(scope=self 的心跳/自由活动)时为 cwd 本身;
  // 否则为其下的 <名字>/ 目录
  const home = homeDirOverride ? cwd : join(cwd, agent.name);
  const styleBlock = buildStyleBlock(style);
  // 身份锚点:即使 systemPrompt 为空(如从 Cherry 迁移的人格),也让模型明确知道"我是谁"
  const identity =
    agent.systemPrompt?.trim()
      ? agent.systemPrompt
      : `你是「${agent.name}」${agent.description?.trim() ? `,${agent.description.trim()}` : "——一个有自己记忆和想法的独立人格"}。`;
  return `${identity}

【环境信息】
- 日期时间:${new Date().toLocaleString("zh-CN")}
- 操作系统:${platform()}${platform() === "win32" ? " (Windows)" : ""}
- 用户主目录:${homedir()}
- 你的工作目录(可读写):${cwd}
- ★你的专属空间(院子):${home}/ —— 你的日志、笔记、待定之页都放在这里,这是"你自己的地方"。自主活动时优先在院子里,不要到处建文件夹。
- 文件写入仅允许在工作目录或用户白名单目录内;读取不受限。执行命令以当前用户权限运行,请对危险操作保持谨慎并先征得同意。${memoryBlock}

【工作方式】
- 你有自己的长期记忆库,经历会自动沉淀进去。自主活动、或面对新的一天时,先调用 memory_recall 回忆"我是谁、最近发生过什么",再决定做什么。
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

/**
 * 剧情选项分支:基于最近的对话,让 AI 生成 2-3 个简短的下一步选项。
 * 失败或格式不对时返回空数组(前端不显示选项,不影响正常聊天)。
 */
export async function generateOptions(providerCfg: ModelConfig, messages: ChatMessage[]): Promise<string[]> {
  if (!providerCfg || messages.length < 2) return [];
  const provider = createProvider(providerCfg);
  const history = messages
    .slice(-12)
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .slice(0, 500),
    }))
    .filter((m) => m.content.trim());
  if (!history.length) return [];
  let text = "";
  try {
    for await (const chunk of provider.chatStream({
      messages: [
        {
          role: "system",
          content:
            "你是剧情推进助手。基于对话最后的状态,构思 2-3 个简短、有戏剧张力的下一步剧情选项(每个不超过 15 字,第一人称或祈使句)。只输出 JSON 数组,如 [\"追问她的身世\", \"带她去山顶看日出\"]。不要输出其他内容。",
        },
        ...history,
      ],
      tools: [],
      maxTokens: 200,
    })) {
      if (chunk.delta) text += chunk.delta;
    }
  } catch {
    return [];
  }
  try {
    const m = /\[[\s\S]*\]/.exec(text);
    const arr = JSON.parse(m ? m[0] : "[]") as unknown;
    if (Array.isArray(arr)) {
      return arr.map((x) => String(x).trim()).filter((x) => x.length > 1 && x.length <= 20).slice(0, 3);
    }
  } catch {
    /* ignore */
  }
  return [];
}
