import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newId, type AgentDef, type ChatMessage, type SessionMeta } from "../../shared/types";
import type { Db } from "../storage";
import { createCustomAgent } from "../agents";
import * as iconv from "iconv-lite";

/** 修复 mojibake:UTF-8 文本被误按 GB18030 解码的乱码(如 鐜茬彂=玲珑)。
 *  方向:乱码 Unicode → 按 GB18030 编码回字节(= 原始 UTF-8 字节)→ 再按 UTF-8 解码。
 *  自检测:修复后不再含乱码特征字且无替换符才采用,否则原样(防止误修正常文本)。 */
const MOJIBAKE_CHARS = /[杩鐜鍙鏂鎴缁閭鎯浠杩樼敤鏄鍝綆]/u;
export function repairMojibake(text: string): string {
  if (!text || !/[\u4e00-\u9fff]/.test(text)) return text;
  // 乱码特征:GBK 误读 UTF-8 的高频字(杩=这 鐜=玲 鍙=可 鏂=文 鎴=我 缁=给 閭=那 鎯=情 杩樻槸=还是 鐢=用 鏄=是)
  if (!MOJIBAKE_CHARS.test(text)) return text;
  try {
    const bytes = iconv.encode(text, "gb18030"); // 乱码 → 原始 UTF-8 字节
    const decoded = iconv.decode(bytes, "utf-8");
    // 修复干净(无乱码特征字、无替换符)才采用
    if (decoded && !MOJIBAKE_CHARS.test(decoded) && !decoded.includes("\uFFFD")) return decoded;
  } catch {
    /* ignore */
  }
  return text;
}

/** 只读打开 SQLite,WAL 模式下直开可能失败(Cherry 正在运行占用 -wal/-shm):失败自动复制副本再开 */
function openSqliteReadonly(dbFile: string): DatabaseSync {
  try {
    return new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    const tmp = mkdtempSync(join(tmpdir(), "cherry-import-"));
    const base = basename(dbFile);
    for (const ext of ["", "-wal", "-shm"]) {
      const f = dbFile + ext;
      if (existsSync(f)) copyFileSync(f, join(tmp, base + ext));
    }
    return new DatabaseSync(join(tmp, base), { readOnly: true });
  }
}

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

  const sqlite = openSqliteReadonly(dbFile);

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

    // ---- 主库补迁:cherrystudio.sqlite 里的 agent 会话消息(agents.db 之外的数据,如用户人格主库时代) ----
    const mainDb = join(opts.cherryDataDir, "Data", "cherrystudio.sqlite");
    if (existsSync(mainDb)) {
      const n = importMainSessions(db, mainDb, stats);
      if (n > 0) console.log(`[cherry] 主库补迁:${n} 条消息`);
    }

    return stats;
  } finally {
    sqlite.close();
  }
}

/** Cherry 的 agent id 可能带前缀/非法字符,规范化并避免与 HanaLite 内置冲突 */
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

/** 主库(cherrystudio.sqlite)补迁:agents.db 之外的 agent 会话消息(如用户人格主库时代)。
 *  会话 → 幻世新会话;消息 data(parts JSON)→ 幻世消息;文本过乱码修复。返回导入消息数。 */
function importMainSessions(db: Db, mainDbFile: string, stats: ImportStats): number {
  let imported = 0;
  const sqlite = openSqliteReadonly(mainDbFile);
  try {
    const mainAgents = sqlite.prepare("SELECT id,name,description FROM agent").all() as { id: string; name: string; description?: string }[];
    const agentIdMap = new Map<string, string>();
    for (const ma of mainAgents) {
      let target = db.listAgents().find((a) => a.name === ma.name);
      if (!target) {
        target = createCustomAgent({ name: ma.name, description: ma.description || `从 Cherry 主库迁入的「${ma.name}」` });
        db.saveAgent(target);
        stats.agents++;
      }
      agentIdMap.set(ma.id, target.id);
    }
    const sessions = sqlite.prepare("SELECT id,name,agent_id FROM agent_session").all() as { id: string; name: string; agent_id: string }[];
    const sessionMap = new Map<string, string>();
    const existingTitles = new Set(db.listSessions().map((s) => s.title));
    for (const s of sessions) {
      const aid = agentIdMap.get(s.agent_id);
      if (!aid) continue;
      const name = s.name?.trim();
      if (!name) continue; // 无标题的空会话不迁
      const title = `${name}(主库)`;
      if (existingTitles.has(title)) continue; // 已迁过,不重复建
      existingTitles.add(title);
      sessionMap.set(s.id, db.createSession(title, aid).id);
      stats.sessions++;
    }
    for (const s of sessions) {
      const sid = sessionMap.get(s.id);
      if (!sid) continue;
      const rows = sqlite
        .prepare("SELECT id,role,data,created_at FROM agent_session_message WHERE session_id=? ORDER BY created_at")
        .all(s.id) as { id: string; role: string; data: string; created_at?: number }[];
      for (const r of rows) {
        let parts: ChatMessage["parts"] = [];
        try {
          const parsed = JSON.parse(r.data || "{}");
          const rawParts = Array.isArray(parsed?.parts) ? parsed.parts : [];
          parts = rawParts.map((p: { type?: string; text?: string; tool?: { name?: string; input?: unknown; output?: string }; name?: string }) => {
            if (p?.type === "text") return { type: "text" as const, text: repairMojibake(String(p.text ?? "")) };
            if (p?.type === "thinking" || p?.type === "reasoning") return { type: "thinking" as const, text: repairMojibake(String(p.text ?? "")) };
            if (p?.type === "tool") {
              return {
                type: "tool" as const,
                tool: {
                  id: `m_${r.id}_${Math.random().toString(36).slice(2, 6)}`,
                  name: p.tool?.name ?? "tool",
                  input: JSON.stringify(p.tool?.input ?? {}),
                  output: repairMojibake(String(p.tool?.output ?? "")),
                  status: "done" as const,
                  startedAt: Date.now(),
                  finishedAt: Date.now(),
                },
              };
            }
            if (p?.type === "data-error") return { type: "text" as const, text: `[调用出错:${p.name ?? "未知"}]` };
            return { type: "text" as const, text: repairMojibake(String(JSON.stringify(p) ?? "")) };
          });
        } catch {
          parts = [{ type: "text", text: repairMojibake(r.data || "") }];
        }
        if (!parts.length) parts = [{ type: "text", text: "" }];
        db.appendMessage({
          id: newId("msg"),
          sessionId: sid,
          role: r.role === "user" ? "user" : "assistant",
          parts,
          createdAt: r.created_at || Date.now(),
        });
        imported++;
        stats.messages++;
      }
    }
  } finally {
    sqlite.close();
  }
  return imported;
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
      if (b.content?.trim()) textBuf.push(repairMojibake(b.content.trim()));
    } else if (b.type === "thinking") {
      if (includeThinking && b.content?.trim()) {
        // 思考存为独立 part(回放时作为 reasoning_content 原样回传,DeepSeek 要求)
        parts.push({ type: "thinking", text: repairMojibake(b.content.trim()) });
      }
    } else if (b.type === "tool") {
      const meta = b.metadata?.rawMcpToolResponse;
      const toolName = meta?.tool?.name ?? b.metadata?.toolName ?? "tool";
      const args = meta?.arguments ?? {};
      const response = repairMojibake(extractToolResponse(meta?.response));
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
