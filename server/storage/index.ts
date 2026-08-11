import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type AgentDef, type ChatMessage, type SessionMeta, type TaskDef } from "../../shared/types";
import type { ResolvedPaths } from "../config";

/** 通用 JSON 文件读写(带内存缓存,原子替换) */
export class JsonFile<T> {
  private cache: T | undefined;
  private loaded = false;

  constructor(
    private file: string,
    private def: () => T,
  ) {}

  read(): T {
    if (this.loaded) return this.cache as T;
    if (existsSync(this.file)) {
      try {
        this.cache = JSON.parse(readFileSync(this.file, "utf-8")) as T;
      } catch (err) {
        console.error(`[storage] 读取 ${this.file} 失败,使用默认值:`, err);
        this.cache = this.def();
      }
    } else {
      this.cache = this.def();
    }
    this.loaded = true;
    return this.cache as T;
  }

  write(value: T): void {
    this.cache = value;
    this.loaded = true;
    mkdirSync(requireDir(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    try {
      renameSync(tmp, this.file);
    } catch {
      // Windows 上目标存在时 rename 可能失败,退回直接写
      writeFileSync(this.file, JSON.stringify(value, null, 2), "utf-8");
    }
  }
}

function requireDir(file: string): string {
  return file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
}

export class Db {
  private sessions: JsonFile<SessionMeta[]>;
  private agents: JsonFile<AgentDef[]>;
  private tasks: JsonFile<TaskDef[]>;
  private messageCache = new Map<string, JsonFile<ChatMessage[]>>();

  constructor(public readonly dataDir: string) {
    const dbDir = join(dataDir, "db");
    mkdirSync(dbDir, { recursive: true });
    this.sessions = new JsonFile<SessionMeta[]>(join(dbDir, "sessions.json"), () => []);
    this.agents = new JsonFile<AgentDef[]>(join(dbDir, "agents.json"), () => []);
    this.tasks = new JsonFile<TaskDef[]>(join(dbDir, "tasks.json"), () => []);
  }

  static fromPaths(paths: ResolvedPaths): Db {
    return new Db(paths.dataDir);
  }

  // ---- Sessions ----

  listSessions(includeArchived = false): SessionMeta[] {
    const all = this.sessions.read().filter((s) => !s.hidden); // 隐藏会话从所有列表消失(隐私保险)
    const list = includeArchived ? all : all.filter((s) => !s.archived);
    // 附上最后一条消息的文本预览:侧栏(及多任务心跳)新内容一眼可见
    for (const s of list) {
      try {
        const msgs = this.messagesFile(s.id).read();
        for (let i = msgs.length - 1; i >= 0; i--) {
          const text = (msgs[i].parts ?? [])
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(" ")
            .trim();
          if (text) {
            s.lastPreview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
            break;
          }
        }
      } catch {
        /* 消息文件缺失/损坏:预览留空 */
      }
    }
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSession(id: string): SessionMeta | undefined {
    return this.sessions.read().find((s) => s.id === id);
  }

  createSession(title: string, agentId: string): SessionMeta {
    const now = Date.now();
    const session: SessionMeta = {
      id: newId("sess"),
      title: title || "新会话",
      agentId,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    const all = this.sessions.read();
    all.push(session);
    this.sessions.write(all);
    return session;
  }

  /** 直接插入已构造的会话(迁移导入用,保留原始 id 与时间) */
  createSessionRaw(session: SessionMeta): void {
    const all = this.sessions.read();
    if (all.some((s) => s.id === session.id)) return;
    all.push(session);
    this.sessions.write(all);
  }

  updateSession(id: string, patch: Partial<SessionMeta>): SessionMeta | undefined {
    const all = this.sessions.read();
    const idx = all.findIndex((s) => s.id === id);
    if (idx < 0) return undefined;
    all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() };
    this.sessions.write(all);
    return all[idx];
  }

  deleteSession(id: string): void {
    const all = this.sessions.read().filter((s) => s.id !== id);
    this.sessions.write(all);
    const f = join(this.dataDir, "db", `messages-${id}.json`);
    try {
      if (existsSync(f)) renameSync(f, f + ".deleted");
    } catch {
      /* ignore */
    }
    this.messageCache.delete(id);
  }

  /** 隐藏会话(隐私保险):标记 hidden + 消息文件移出 db/ 到 .私藏/(翻数据目录也看不到内容) */
  hideSession(id: string): SessionMeta | undefined {
    const s = this.getSession(id);
    if (!s) return undefined;
    this.updateSession(id, { hidden: true });
    try {
      mkdirSync(join(this.dataDir, ".私藏"), { recursive: true });
      const from = join(this.dataDir, "db", `messages-${id}.json`);
      const to = join(this.dataDir, ".私藏", `messages-${id}.json`);
      if (existsSync(from)) renameSync(from, to);
    } catch {
      /* 移动失败不影响标记 */
    }
    this.messageCache.delete(id);
    return s;
  }

  /** 恢复隐藏会话:取消 hidden + 消息文件移回 db/ */
  unhideSession(id: string): SessionMeta | undefined {
    const s = this.getSession(id);
    if (!s) return undefined;
    this.updateSession(id, { hidden: false });
    try {
      const from = join(this.dataDir, ".私藏", `messages-${id}.json`);
      const to = join(this.dataDir, "db", `messages-${id}.json`);
      if (existsSync(from)) renameSync(from, to);
    } catch {
      /* ignore */
    }
    this.messageCache.delete(id);
    return s;
  }

  /** 列出隐藏会话(设置里低调入口,供恢复/真删) */
  listHiddenSessions(): SessionMeta[] {
    return this.sessions.read().filter((s) => s.hidden === true).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---- Messages ----

  getMessages(sessionId: string): ChatMessage[] {
    return this.messagesFile(sessionId).read();
  }

  appendMessage(msg: ChatMessage): void {
    const file = this.messagesFile(msg.sessionId);
    const all = file.read();
    all.push(msg);
    file.write(all);
  }

  updateMessage(msg: ChatMessage): void {
    const file = this.messagesFile(msg.sessionId);
    const all = file.read();
    const idx = all.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      all[idx] = msg;
      file.write(all);
    }
  }

  /** 删除单条消息(手动压缩上下文用) */
  deleteMessage(sessionId: string, msgId: string): boolean {
    const file = this.messagesFile(sessionId);
    const all = file.read();
    const kept = all.filter((m) => m.id !== msgId);
    if (kept.length === all.length) return false;
    file.write(kept);
    return true;
  }

  private messagesFile(sessionId: string): JsonFile<ChatMessage[]> {
    let f = this.messageCache.get(sessionId);
    if (!f) {
      f = new JsonFile<ChatMessage[]>(join(this.dataDir, "db", `messages-${sessionId}.json`), () => []);
      this.messageCache.set(sessionId, f);
    }
    return f;
  }

  // ---- Agents / Personas ----

  listAgents(): AgentDef[] {
    return this.agents.read();
  }

  getAgent(id: string): AgentDef | undefined {
    return this.agents.read().find((a) => a.id === id);
  }

  saveAgent(agent: AgentDef): void {
    const all = this.agents.read();
    const idx = all.findIndex((a) => a.id === agent.id);
    if (idx >= 0) all[idx] = agent;
    else all.push(agent);
    this.agents.write(all);
  }

  deleteAgent(id: string): void {
    this.agents.write(this.agents.read().filter((a) => a.id !== id));
  }

  // ---- Tasks(定时任务) ----

  listTasks(): TaskDef[] {
    return this.tasks.read();
  }

  getTask(id: string): TaskDef | undefined {
    return this.tasks.read().find((t) => t.id === id);
  }

  saveTask(task: TaskDef): void {
    const all = this.tasks.read();
    const idx = all.findIndex((t) => t.id === task.id);
    if (idx >= 0) all[idx] = task;
    else all.push(task);
    this.tasks.write(all);
  }

  deleteTask(id: string): void {
    this.tasks.write(this.tasks.read().filter((t) => t.id !== id));
  }

  /** 清理历史遗留的空消息(parts 无任何有效内容),返回清理条数 */
  cleanEmptyMessages(): number {
    let cleaned = 0;
    for (const s of this.listSessions(true)) {
      const all = this.messagesFile(s.id);
      const msgs = all.read();
      const kept = msgs.filter((m) => {
        const hasText = m.parts.some((p) => p.type === "text" && (p.text ?? "").trim());
        const hasTool = m.parts.some((p) => p.type === "tool" && p.tool);
        return hasText || hasTool;
      });
      if (kept.length !== msgs.length) {
        all.write(kept);
        cleaned += msgs.length - kept.length;
      }
    }
    return cleaned;
  }
}
