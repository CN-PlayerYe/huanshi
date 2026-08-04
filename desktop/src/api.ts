import type {
  AgentDef,
  ChatMessage,
  ChatRequest,
  SessionMeta,
  Settings,
  StreamEvent,
  SystemInfo,
} from "@shared/types";

let base = "http://127.0.0.1:5178";

/** 初始化后端地址:Electron 里通过 preload 桥获取;浏览器调试用固定端口 */
export async function initApi(): Promise<string> {
  const win = window.hanalite;
  if (win?.getBackendUrl) {
    base = await win.getBackendUrl();
  } else {
    base = `http://127.0.0.1:${import.meta.env.VITE_BACKEND_PORT ?? 5178}`;
  }
  return base;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  base: () => base,

  health: () => request<{ ok: boolean; version: string }>("/api/health"),
  systemInfo: () => request<SystemInfo>("/api/system/info"),
  tools: () => request<{ tools: { name: string; description: string }[] }>("/api/tools"),

  getSettings: () => request<Settings>("/api/settings"),
  putSettings: (s: Partial<Settings>) => request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  setDataDir: (path: string) =>
    request<{ ok: boolean; restartRequired: boolean; path: string }>("/api/settings/data-dir", { method: "POST", body: JSON.stringify({ path }) }),

  reflect: () => request<{ text: string }>("/api/memory/reflect", { method: "POST" }),

  probeCherryStudio: () => request<{ found: string[] }>("/api/import/cherrystudio/probe"),
  importCherryStudio: (body: { dataDir?: string; includeThinking?: boolean; skipExisting?: boolean }) =>
    request<{ ok: boolean; stats: { agents: number; sessions: number; messages: number; skippedSessions: number; skippedAgents: number; dataDir: string } }>(
      "/api/import/cherrystudio",
      { method: "POST", body: JSON.stringify(body) },
    ),

  listAgents: () => request<{ agents: AgentDef[] }>("/api/agents"),
  saveAgent: (a: Partial<AgentDef>) => request<{ agent: AgentDef }>("/api/agents", { method: "POST", body: JSON.stringify(a) }),
  deleteAgent: (id: string) => request<{ ok: boolean }>(`/api/agents/${id}`, { method: "DELETE" }),

  listSessions: () => request<{ sessions: SessionMeta[] }>("/api/sessions"),
  createSession: (title?: string, agentId?: string) =>
    request<{ session: SessionMeta }>("/api/sessions", { method: "POST", body: JSON.stringify({ title, agentId }) }),
  deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  archiveSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}/archive`, { method: "POST" }),
  renameSession: (id: string, title: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  setSessionAgent: (id: string, agentId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/agent`, { method: "POST", body: JSON.stringify({ agentId }) }),
  search: (q: string) =>
    request<{ sessions: { session: SessionMeta; matches: number }[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  getMessages: (id: string) => request<{ messages: ChatMessage[] }>(`/api/sessions/${id}/messages`),

  /** 流式聊天:逐事件回调,返回完整 assistant 消息 */
  async chatStream(req: ChatRequest, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`聊天请求失败:${res.status} ${text.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(data) as StreamEvent;
        } catch {
          continue;
        }
        onEvent(ev);
      }
    }
  },
};
