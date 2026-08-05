import { create } from "zustand";
import { newId, type AgentDef, type ChatMessage, type SessionMeta, type Settings, type StreamEvent, type SystemInfo } from "@shared/types";
import { api, initApi } from "./api";

interface AppState {
  backendUrl: string;
  ready: boolean;
  error: string | null;
  systemInfo: SystemInfo | null;
  settings: Settings | null;
  agents: AgentDef[];
  sessions: SessionMeta[];
  /** 递增触发输入框重新聚焦(删除消息/弹窗关闭等) */
  focusTick: number;
  activeSessionId: string | null;
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

export const useApp = create<AppState>((set, get) => ({
  backendUrl: "",
  ready: false,
  error: null,
  focusTick: 0,
  systemInfo: null,
  settings: null,
  agents: [],
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  sending: false,
  view: "chat",
  sidebarCollapsed: false,

  async init() {
    try {
      const url = await initApi();
      set({ backendUrl: url });
      await Promise.all([get().refreshSystemInfo(), get().refreshSettings(), get().refreshAgents(), get().refreshSessions()]);
      // 默认选中最新会话
      const { sessions } = get();
      if (sessions.length && !get().activeSessionId) {
        await get().selectSession(sessions[0].id);
      }
      set({ ready: true });
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

  async selectSession(id) {
    if (get().activeSessionId === id && get().messagesBySession[id]) return;
    set({ activeSessionId: id });
    if (!get().messagesBySession[id]) {
      const { messages } = await api.getMessages(id);
      set((s) => ({ messagesBySession: { ...s.messagesBySession, [id]: messages } }));
    }
  },

  async newSession() {
    const { session } = await api.createSession(undefined, get().agents[0]?.id);
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
    await get().refreshSessions();
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
          } else if (e.type === "delta") {
            set((s) => updateMsg(s, sessionId, asstMsg.id, (m) => {
              const textPart = m.parts.find((p) => p.type === "text");
              if (textPart) textPart.text = (textPart.text ?? "") + e.content;
            }));
          } else if (e.type === "thinking") {
            set((s) => updateMsg(s, sessionId, asstMsg.id, (m) => {
              let tp = m.parts.find((p) => p.type === "thinking");
              if (!tp) {
                tp = { type: "thinking", text: "" };
                m.parts.push(tp);
              }
              tp.text = (tp.text ?? "") + e.content;
            }));
          } else if (e.type === "tool_start") {
            set((s) => updateMsg(s, sessionId, asstMsg.id, (m) => {
              m.parts.push({ type: "tool", tool: e.tool });
            }));
          } else if (e.type === "tool_end") {
            set((s) => updateMsg(s, sessionId, asstMsg.id, (m) => {
              const p = m.parts.find((p) => p.type === "tool" && p.tool?.id === e.tool.id);
              if (p?.tool) p.tool = e.tool;
            }));
          } else if (e.type === "done") {
            set((s) => updateMsg(s, sessionId, asstMsg.id, (m) => {
              m.parts = e.message.parts;
              m.model = e.message.model;
            }));
            set((s) => ({ sessions: s.sessions.map((x) => (x.id === e.session.id ? e.session : x)) }));
          } else if (e.type === "error") {
            set((s) => updateMsg(s, sessionId, asstMsg.id, (m) => {
              const textPart = m.parts.find((p) => p.type === "text");
              if (textPart) textPart.text = (textPart.text ?? "") + `\n\n⚠️ ${e.message}`;
            }));
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
