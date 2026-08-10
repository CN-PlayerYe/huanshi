import { create } from "zustand";
import { newId, type AgentDef, type ChatMessage, type SessionMeta, type Settings, type StreamEvent, type SystemInfo } from "@shared/types";
import { api, initApi } from "./api";

// 保命线提示节流:同会话 5 分钟最多弹一次(工具循环时压缩会频繁触发)
const lastTrimmedToast: Record<string, number> = {};

interface AppState {
  backendUrl: string;
  ready: boolean;
  error: string | null;
  systemInfo: SystemInfo | null;
  settings: Settings | null;
  agents: AgentDef[];
  sessions: SessionMeta[];
  /** 归档会话(主列表隐藏,可恢复) */
  archivedSessions: SessionMeta[];
  /** 递增触发输入框重新聚焦(删除消息/弹窗关闭等) */
  focusTick: number;
  /** 未读计数:后台任务(心跳等)完成而用户没看该会话时 +1,选中会话后清零 */
  unreadBySession: Record<string, number>;
  /** 剧情选项:每个会话最近一次的 AI 选项 */
  sessionOptions: Record<string, string[]>;
  clearOptions(): void;
  /** 非模态提示(避免 window.alert 在 Electron 的焦点 bug) */
  toast: string | null;
  showToast(msg: string): void;
  clearToast(): void;
  activeSessionId: string | null;
  /** 上次使用的人格:新会话默认用它(而不是永远默认第一个) */
  lastAgentId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  sending: boolean;
  view: "chat" | "settings";
  sidebarCollapsed: boolean;

  init(): Promise<void>;
  refreshSystemInfo(): Promise<void>;
  refreshSettings(): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshSessions(): Promise<void>;
  selectSession(id: string): Promise<void>;
  newSession(): Promise<SessionMeta>;
  deleteSession(id: string): Promise<void>;
  archiveSession(id: string): Promise<void>;
  unarchiveSession(id: string): Promise<void>;
  /** 刷新归档列表(含恢复/删除后) */
  refreshArchived(): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  deleteMessage(sessionId: string, msgId: string): Promise<void>;
  /** 请求把焦点还给输入框(删除消息/弹窗关闭等场景) */
  focusInput(): void;
  setView(v: "chat" | "settings"): void;
  toggleSidebar(): void;
  toggleTheme(): void;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  changeDataDir(path: string): Promise<void>;
  saveAgent(a: Partial<AgentDef>): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  sendMessage(content: string, attachments?: { file: string; mime: string }[]): Promise<void>;
  stop(): void;
}

let abortController: AbortController | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useApp = create<AppState>((set, get) => ({
  backendUrl: "",
  ready: false,
  error: null,
  focusTick: 0,
  sessionOptions: {},
  toast: null,
  systemInfo: null,
  settings: null,
  agents: [],
  sessions: [],
  /** 归档会话(主列表隐藏,可恢复) */
  archivedSessions: [],
  activeSessionId: null,
  /** 后台任务未读计数 */
  unreadBySession: {},
  /** 上次使用的人格:新会话默认用它(而不是永远默认第一个),重启后回退默认 */
  lastAgentId: null as string | null,
  messagesBySession: {},
  sending: false,
  view: "chat",
  sidebarCollapsed: false,

  clearOptions() {
    const id = get().activeSessionId;
    if (!id) return;
    set((s) => {
      const next = { ...s.sessionOptions };
      delete next[id];
      return { sessionOptions: next };
    });
  },
  async init() {
    try {
      const url = await initApi();
      set({ backendUrl: url });
      await Promise.all([get().refreshSystemInfo(), get().refreshSettings(), get().refreshAgents(), get().refreshSessions(), get().refreshArchived()]);
      // 默认选中最新会话
      const { sessions } = get();
      if (sessions.length && !get().activeSessionId) {
        await get().selectSession(sessions[0].id);
      }
      set({ ready: true });
      // WebSocket:接收剧情选项 / 定时任务完成通知
      connectWs(url);
    } catch (err) {
      set({ error: String((err as Error).message), ready: true });
    }
  },

  async refreshSystemInfo() {
    set({ systemInfo: await api.systemInfo() });
  },
  async refreshSettings() {
    set({ settings: await api.getSettings() });
  },
  async refreshAgents() {
    set({ agents: (await api.listAgents()).agents });
  },
  async refreshSessions() {
    set({ sessions: (await api.listSessions()).sessions });
  },

  async refreshArchived() {
    set({ archivedSessions: (await api.listSessions(true)).sessions.filter((s) => s.archived) });
  },

  async selectSession(id) {
    // 无条件切回聊天视图(如从设置页「打开心跳日记」);即使会话已缓存也要切视图
    set((s) => {
      const unread = { ...s.unreadBySession };
      delete unread[id];
      return { activeSessionId: id, view: "chat", unreadBySession: unread };
    });
    if (!get().messagesBySession[id]) {
      const { messages } = await api.getMessages(id);
      set((s) => ({ messagesBySession: { ...s.messagesBySession, [id]: messages } }));
    }
  },

  async newSession() {
    // 新会话默认用“上次使用的人格”,而不是永远默认第一个(小盏)
    const agentId = get().lastAgentId ?? get().agents[0]?.id;
    const { session } = await api.createSession(undefined, agentId);
    await get().refreshSessions();
    set({ activeSessionId: session.id, messagesBySession: { ...get().messagesBySession, [session.id]: [] } });
    return session;
  },

  async deleteSession(id) {
    await api.deleteSession(id);
    const next = { ...get().messagesBySession };
    delete next[id];
    set({ messagesBySession: next });
    if (get().activeSessionId === id) set({ activeSessionId: null });
    await get().refreshSessions();
  },

  async archiveSession(id) {
    await api.archiveSession(id);
    if (get().activeSessionId === id) set({ activeSessionId: null });
    await Promise.all([get().refreshSessions(), get().refreshArchived()]);
  },

  async unarchiveSession(id) {
    await api.unarchiveSession(id);
    await Promise.all([get().refreshSessions(), get().refreshArchived()]);
  },

  async renameSession(id, title) {
    await api.renameSession(id, title);
    await get().refreshSessions();
  },

  async deleteMessage(sessionId, msgId) {
    await api.deleteMessage(sessionId, msgId);
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: (s.messagesBySession[sessionId] ?? []).filter((m) => m.id !== msgId),
      },
      // 弹窗(confirm)关闭后焦点丢失,主动请求输入框重新聚焦
      focusTick: Date.now(),
    }));
  },
  focusInput() {
    set({ focusTick: Date.now() });
  },
  showToast(msg) {
    set({ toast: msg });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 3200);
  },
  clearToast() {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: null });
  },

  setView(v) {
    set({ view: v });
  },

  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
  },

  toggleTheme() {
    const order = ["dark", "light", "ink"] as const;
    const cur = get().settings?.theme ?? "dark";
    const next = order[(order.indexOf(cur as any) + 1) % order.length];
    void get().updateSettings({ theme: next });
  },

  async updateSettings(patch) {
    const next = await api.putSettings(patch);
    set({ settings: next });
  },

  async changeDataDir(path) {
    const res = await api.setDataDir(path);
    set({ error: res.restartRequired ? `数据目录已切换到 ${path},重启后生效。` : null });
    return;
  },

  async saveAgent(a) {
    await api.saveAgent(a);
    await get().refreshAgents();
  },

  async deleteAgent(id) {
    await api.deleteAgent(id);
    await get().refreshAgents();
  },

  stop() {
    abortController?.abort();
    abortController = null;
    set({ sending: false });
  },

  async sendMessage(content, attachments?: { file: string; mime: string }[]) {
    const text = content.trim();
    if ((!text && !attachments?.length) || get().sending) return;

    let sessionId = get().activeSessionId ?? "";
    const agentId = get().agents[0]?.id;

    // 乐观插入 user 消息
    const userMsg: ChatMessage = {
      id: newId("msg"),
      sessionId,
      role: "user",
      parts: [
        { type: "text", text },
        ...(attachments ?? []).map((a) => ({ type: "image" as const, image: a })),
      ],
      createdAt: Date.now(),
    };
    const asstMsg: ChatMessage = {
      id: newId("msg"),
      sessionId,
      role: "assistant",
      parts: [{ type: "text", text: "" }],
      createdAt: Date.now(),
    };

    set((s) => {
      const list = s.messagesBySession[sessionId] ?? [];
      return {
        sending: true,
        messagesBySession: { ...s.messagesBySession, [sessionId]: [...list, userMsg, asstMsg] },
      };
    });

    abortController = new AbortController();
    const signal = abortController.signal;

    // 当前流式目标消息 id:message_start 认领前端占位消息或追加群聊人格消息后,delta/thinking/tool 都定位到它
    let curAsstId = asstMsg.id;

    try {
      await api.chatStream(
        { sessionId, content: text, agentId, attachments },
        (e: StreamEvent) => {
          if (e.type === "session_created") {
            sessionId = e.session.id;
            userMsg.sessionId = sessionId;
            asstMsg.sessionId = sessionId;
            set((s) => ({
              activeSessionId: sessionId,
              sessions: [e.session, ...s.sessions.filter((x) => x.id !== e.session.id)],
              messagesBySession: { ...s.messagesBySession, [sessionId]: s.messagesBySession[sessionId] ?? [userMsg, asstMsg] },
            }));
          } else if (e.type === "message_start") {
            const mid = e.message.id;
            curAsstId = mid;
            set((s) => {
              const list = s.messagesBySession[sessionId] ?? [];
              // 若最后一条 assistant 是刚插入的占位消息(前端预建),直接认领更新为后端真实 id
              const lastIdx = [...list].reverse().findIndex((m) => m.role === "assistant");
              if (lastIdx >= 0) {
                const i = list.length - 1 - lastIdx;
                if (list[i].id === asstMsg.id) {
                  const updated = [...list];
                  updated[i] = { ...list[i], id: mid, ...(e.message.agentId ? { agentId: e.message.agentId } : {}) };
                  return { messagesBySession: { ...s.messagesBySession, [sessionId]: updated } };
                }
              }
              // 群聊:追加新的人格消息
              return {
                messagesBySession: {
                  ...s.messagesBySession,
                  [sessionId]: [
                    ...list,
                    { id: mid, sessionId, role: "assistant" as const, parts: [{ type: "text", text: "" }], agentId: e.message.agentId, createdAt: Date.now() },
                  ],
                },
              };
            });
          } else if (e.type === "delta") {
            set((s) => updateMsg(s, sessionId, curAsstId, (m) => {
              // 找不到 text part(如群聊追加的新消息)时自建,避免文本丢失
              let textPart = m.parts.find((p) => p.type === "text");
              if (!textPart) {
                textPart = { type: "text", text: "" };
                m.parts.push(textPart);
              }
              textPart.text = (textPart.text ?? "") + e.content;
            }));
          } else if (e.type === "thinking") {
            set((s) => updateMsg(s, sessionId, curAsstId, (m) => {
              let tp = m.parts.find((p) => p.type === "thinking");
              if (!tp) {
                tp = { type: "thinking", text: "" };
                m.parts.push(tp);
              }
              tp.text = (tp.text ?? "") + e.content;
            }));
          } else if (e.type === "tool_start") {
            set((s) => updateMsg(s, sessionId, curAsstId, (m) => {
              m.parts.push({ type: "tool", tool: e.tool });
            }));
          } else if (e.type === "tool_end") {
            set((s) => updateMsg(s, sessionId, curAsstId, (m) => {
              const p = m.parts.find((p) => p.type === "tool" && p.tool?.id === e.tool.id);
              if (p?.tool) p.tool = e.tool;
            }));
          } else if (e.type === "done") {
            set((s) => updateMsg(s, sessionId, curAsstId, (m) => {
              m.parts = e.message.parts;
              m.model = e.message.model;
            }));
            set((s) => ({ sessions: s.sessions.map((x) => (x.id === e.session.id ? e.session : x)) }));
          } else if (e.type === "error") {
            set((s) => updateMsg(s, sessionId, curAsstId, (m) => {
              const textPart = m.parts.find((p) => p.type === "text");
              if (textPart) textPart.text = (textPart.text ?? "") + `\n\n⚠️ ${e.message}`;
            }));
          } else if (e.type === "context_trimmed") {
            // 保命线触发:明示用户(数据未删除,只是本次发送截断)。
            // 工具循环时每次请求都会触发压缩 → 节流:同会话 5 分钟最多提示一次,避免刷屏
            const now = Date.now();
            const last = lastTrimmedToast[sessionId] ?? 0;
            if (now - last > 5 * 60_000) {
              lastTrimmedToast[sessionId] = now;
              get().showToast(`⚠️ ${String(e.reason ?? "历史过长已自动压缩")}`);
            }
          }
        },
        signal,
      );
    } catch (err) {
      set((s) =>
        updateMsg(s, sessionId, asstMsg.id, (m) => {
          const textPart = m.parts.find((p) => p.type === "text");
          if (textPart) textPart.text = (textPart.text ?? "") + `\n\n⚠️ 请求中断:${(err as Error).message}`;
        }),
      );
    } finally {
      abortController = null;
      set({ sending: false });
      await get().refreshSessions();
    }
  },
}));

function updateMsg(s: AppState, sessionId: string, msgId: string, fn: (m: ChatMessage) => void): Partial<AppState> {
  const list = s.messagesBySession[sessionId] ?? [];
  return {
    messagesBySession: {
      ...s.messagesBySession,
      [sessionId]: list.map((m) => (m.id === msgId ? apply(fn, m) : m)),
    },
  };
}

function apply(fn: (m: ChatMessage) => void, m: ChatMessage): ChatMessage {
  const copy: ChatMessage = { ...m, parts: m.parts.map((p) => ({ ...p, tool: p.tool ? { ...p.tool } : undefined })) };
  fn(copy);
  return copy;
}

/** WebSocket:接收剧情选项(options)与定时任务完成通知(task_done),断线自动重连 */
function connectWs(backendUrl: string): void {
  let ws: WebSocket | null = null;
  let retry = 0;
  const open = () => {
    try {
      ws = new WebSocket(backendUrl.replace(/^http/, "ws") + "/api/ws");
    } catch {
      return;
    }
    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(String(ev.data)) as { event?: Record<string, unknown> } | Record<string, unknown>;
        // 后端广播包了一层 { event: e },兼容两种形态(否则 task_done 永远收不到,心跳消息不实时刷新)
        const e = (raw && typeof raw === "object" && "event" in raw && raw.event ? raw.event : raw) as { type?: string; [k: string]: unknown };
        if (e.type === "options") {
          const sid = String(e.sessionId ?? "");
          const opts = Array.isArray(e.options) ? (e.options as string[]) : [];
          if (sid && opts.length) useApp.setState((s) => ({ sessionOptions: { ...s.sessionOptions, [sid]: opts } }));
        } else if (e.type === "task_done") {
          const name = String(e.taskName ?? "定时任务");
          const ok = e.ok !== false;
          useApp.getState().showToast(`${ok ? "✅" : "⚠️"} 任务「${name}」${ok ? "已完成" : "执行失败"}`);
          // 任务执行可能新建了会话(心跳日记)/更新了会话 → 刷新侧栏,避免"重启才显示"
          void useApp.getState().refreshSessions();
          // 若正在看该任务对应的会话(心跳日记),实时重拉消息,不用等重启
          const sid = String(e.sessionId ?? "");
          if (sid && useApp.getState().activeSessionId === sid) {
            void api.getMessages(sid).then(({ messages }) => {
              useApp.setState((s) => ({ messagesBySession: { ...s.messagesBySession, [sid]: messages } }));
            });
          } else if (sid) {
            // 没在看该会话 → 未读 +1,侧栏红点提示(多个心跳同时完成也能逐个标出)
            useApp.setState((s) => ({
              unreadBySession: { ...s.unreadBySession, [sid]: (s.unreadBySession[sid] ?? 0) + 1 },
            }));
          }
          // 桌面通知(人格主动找你)
          try {
            if ("Notification" in window && Notification.permission === "granted") {
              new Notification(`幻世 · ${name}`, { body: ok ? String(e.result ?? "").slice(0, 120) : String(e.result ?? "") });
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      // 断线重连(指数退避)
      setTimeout(open, Math.min(30000, 2000 * 2 ** retry++));
    };
    ws.onopen = () => {
      retry = 0;
      if ("Notification" in window && Notification.permission === "default") {
        void Notification.requestPermission().catch(() => undefined);
      }
    };
  };
  open();
}
