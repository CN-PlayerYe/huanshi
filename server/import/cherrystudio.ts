import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newId, type AgentDef, type ChatMessage, type SessionMeta } from "../../shared/types";
import type { Db } from "../storage";

/**
 * Cherry Studio(v1 架构)Agent 对话迁移器。
 * 数据源:Data/agents.db(SQLite),Agent 会话的消息正文以 JSON 内联在 content 中(顶层 blocks 数组)。
 * 无需关闭 Cherry Studio(SQLite 只读),无需 IndexedDB(那是普通聊天的块存储)。
 */

export interface ImportStats {
  agents: number;
  sessions: number;
  messages: number;
  skippedSessions: number;
  skippedAgents: number;
  dataDir: string;
}

export interface ImportOptions {
  cherryDataDir: string;
  includeThinking: boolean;
  /** 已存在的同名 session/agent 是否跳过(默认 true,防止覆盖) */
  skipExisting?: boolean;
}

export function isCherryStudioDataDir(dir: string): boolean {
  return existsSync(join(dir, "Data", "agents.db"));
}

/** 探测 Cherry Studio 数据目录候选(返回已确认有效的) */
export function probeCherryStudioDirs(): string[] {
  const candidates: string[] = [];
  const env = process.env;
  // 1. Windows 默认
  if (env.APPDATA) candidates.push(join(env.APPDATA, "CherryStudio"));
  // 2. ~/.cherrystudio(config.json 里的 appDataPath)
  const homeConfig = join(homedir(), ".cherrystudio", "config", "config.json");
  if (existsSync(homeConfig)) {
    try {
      const cfg = JSON.parse(readFileSync(homeConfig, "utf-8"));
      for (const entry of cfg.appDataPath ?? []) {
        if (entry?.dataPath) candidates.push(entry.dataPath);
      }
    } catch {
      /* ignore */
    }
  }
  // 3. 去掉去重,只保留有效目录
  return [...new Set(candidates)].filter((d) => d && isCherryStudioDataDir(d));
}

interface RawAgent {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  model: string;
}

interface RawSession {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  created_at: string;
  updated_at: string;
}

interface RawMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

const CHERRY_AGENT_PREFIX = "cherry-";

export function importCherryStudio(db: Db, opts: ImportOptions): ImportStats {
  const dbFile = join(opts.cherryDataDir, "Data", "agents.db");
  if (!existsSync(dbFile)) {
    throw new Error(`未找到 Cherry Studio 数据库:${dbFile}`);
  }

  const stats: ImportStats = {
    agents: 0,
    sessions: 0,
    messages: 0,
    skippedSessions: 0,
    skippedAgents: 0,
    dataDir: opts.cherryDataDir,
  };
  const skipExisting = opts.skipExisting ?? true;

  const sqlite = new DatabaseSync(dbFile, { readOnly: true });

  try {
    // ---- Agents / 人格 ----
    const rawAgents = sqlite
      .prepare("SELECT id, name, description, instructions, model FROM agents WHERE deleted_at IS NULL")
      .all() as unknown as RawAgent[];

    for (const ra of rawAgents) {
      const id = normalizeAgentId(ra.id);
      if (skipExisting && db.getAgent(id)) {
        stats.skippedAgents++;
        continue;
      }
      const agent: AgentDef = {
        id,
        name: ra.name || ra.id,
        description: ra.description || `从 Cherry Studio 迁入的 Agent「${ra.name || ra.id}」`,
        systemPrompt: ra.instructions?.trim() || "你是一个乐于助人的私人 AI 助手。",
        memoryEnabled: true,
        tools: DEFAULT_TOOLS,
        createdAt: Date.now(),
      };
      db.saveAgent(agent);
      stats.agents++;
    }

    // ---- Sessions ----
    const rawSessions = sqlite.prepare("SELECT id, agent_id, name, description, instructions, created_at, updated_at FROM sessions").all() as unknown as RawSession[];

    for (const rs of rawSessions) {
      if (skipExisting && db.getSession(rs.id)) {
        stats.skippedSessions++;
        continue;
      }
      const now = Date.now();
      const session: SessionMeta = {
        id: rs.id,
        title: rs.name || "Cherry 会话",
        agentId: normalizeAgentId(rs.agent_id),
        createdAt: parseTs(rs.created_at) ?? now,
        updatedAt: parseTs(rs.updated_at) ?? now,
        archived: false,
      };
      // 会话级 instructions 优先于 Agent 级(若 Agent 是新迁入的,用会话的)
      const agent = db.getAgent(session.agentId);
      if (agent && rs.instructions?.trim() && rs.instructions.trim() !== agent.systemPrompt) {
        db.saveAgent({ ...agent, systemPrompt: rs.instructions.trim() });
      }
      db.createSessionRaw(session);
      stats.sessions++;

      // ---- Messages ----
      const rawMessages = sqlite
        .prepare("SELECT id, session_id, role, content, created_at FROM session_messages WHERE session_id = ? ORDER BY id")
        .all(rs.id) as unknown as RawMessage[];

      for (const rm of rawMessages) {
        const msg = convertMessage(rm, session.id, opts.includeThinking);
        if (msg) {
          db.appendMessage(msg);
          stats.messages++;
        }
      }
    }

    return stats;
  } finally {
    sqlite.close();
  }
}

/** Cherry 的 agent id 可能带前缀/非法字符,规范化并避免与幻世内置冲突 */
function normalizeAgentId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!clean) return newId("agent");
  if (clean.startsWith("cherry-")) return clean;
  return "cherry-" + clean;
}

function parseTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

interface Block {
  id?: string;
  type: string;
  content?: string;
  status?: string;
  metadata?: {
    rawMcpToolResponse?: {
      tool?: { name?: string; id?: string };
      arguments?: unknown;
      response?: unknown;
      status?: string;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export function convertMessage(rm: RawMessage, sessionId: string, includeThinking: boolean): ChatMessage | null {
  let parsed: { message?: { model?: { name?: string } | string }; blocks?: Block[] };
  try {
    parsed = JSON.parse(rm.content);
  } catch {
    return null;
  }
  const blocks = parsed.blocks ?? [];
  const parts: ChatMessage["parts"] = [];
  const now = parseTs(rm.created_at) ?? Date.now();

  const textBuf: string[] = [];
  for (const b of blocks) {
    if (b.type === "main_text") {
      if (b.content?.trim()) textBuf.push(b.content.trim());
    } else if (b.type === "thinking") {
      if (includeThinking && b.content?.trim()) {
        // 思考存为独立 part(回放时作为 reasoning_content 原样回传,DeepSeek 要求)
        parts.push({ type: "thinking", text: b.content.trim() });
      }
    } else if (b.type === "tool") {
      const meta = b.metadata?.rawMcpToolResponse;
      const toolName = meta?.tool?.name ?? b.metadata?.toolName ?? "tool";
      const args = meta?.arguments ?? {};
      const response = extractToolResponse(meta?.response);
      const startedAt = now;
      parts.push({
        type: "tool",
        tool: {
          id: `ct_${rm.id}_${b.id ?? parts.length}`,
          name: String(toolName),
          input: JSON.stringify(args ?? {}),
          output: response,
          status: meta?.status === "error" || b.status === "error" ? "error" : "done",
          startedAt,
          finishedAt: now,
        },
      });
    } else if (b.type === "image") {
      textBuf.push("[图片]");
    }
    // unknown / error 块忽略
  }

  const text = textBuf.join("\n\n");
  if (rm.role === "user") {
    if (!text.trim()) return null;
    return {
      id: newId("msg"),
      sessionId,
      role: "user",
      parts: [{ type: "text", text }],
      createdAt: now,
    };
  }

  if (!parts.length && !text.trim()) return null;
  if (text.trim()) parts.unshift({ type: "text", text });

  const modelName =
    typeof parsed.message?.model === "string" ? parsed.message.model : (parsed.message?.model as any)?.name;

  return {
    id: newId("msg"),
    sessionId,
    role: "assistant",
    parts,
    createdAt: now,
    model: modelName,
  };
}

function extractToolResponse(response: unknown): string {
  if (response == null) return "";
  if (typeof response === "string") return response.slice(0, 8000);
  if (Array.isArray(response)) {
    return response
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as any).text) : JSON.stringify(c)))
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000);
  }
  if (typeof response === "object") {
    const content = (response as any).content;
    if (content) return extractToolResponse(content);
  }
  return JSON.stringify(response).slice(0, 8000);
}

const DEFAULT_TOOLS = [
  "read_file",
  "write_file",
  "list_dir",
  "run_command",
  "fetch_url",
  "get_datetime",
  "memory_retain",
  "memory_recall",
  "memory_reflect",
];

export function defaultImportTools(): string[] {
  return [...DEFAULT_TOOLS];
}
