import type {
  AgentDef,
  ChatMessage,
  ChatRequest,
  ModelConfig,
  ProviderKind,
  SessionMeta,
  Settings,
  StreamEvent,
  SystemInfo,
  TaskDef,
} from "@shared/types";

let base = "http://127.0.0.1:5178";

/** 后端 base URL(供前端拼接静态资源地址) */
export const apiBase = (): string => base;

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
  uploadBackground: (dataUrl: string) =>
    request<{ ok: boolean; path: string }>("/api/appearance/background", { method: "POST", body: JSON.stringify({ dataUrl }) }),

  providerPresets: () => request<{ presets: { key: string; label: string; kind: ProviderKind; baseUrl: string; defaultModel: string; hint?: string }[] }>("/api/providers/presets"),
  testProvider: (cfg: ModelConfig) => request<{ ok: boolean; detail?: string; error?: string }>("/api/providers/test", { method: "POST", body: JSON.stringify(cfg) }),
  fetchModels: (cfg: ModelConfig) => request<{ ok: boolean; models?: string[]; error?: string }>("/api/providers/models", { method: "POST", body: JSON.stringify(cfg) }),

  reflect: () => request<{ text: string }>("/api/memory/reflect", { method: "POST" }),

  listTasks: () => request<{ tasks: TaskDef[] }>("/api/tasks"),
  createTask: (body: { name: string; prompt: string; schedule: string; agentId: string; kind?: "cron" | "heartbeat"; heartbeat?: import("../../shared/types").HeartbeatConfig }) =>
    request<{ task: TaskDef }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id: string, patch: Partial<TaskDef>) =>
    request<{ task: TaskDef }>(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
  runTask: (id: string) => request<{ ok: boolean; result: string }>(`/api/tasks/${id}/run`, { method: "POST" }),

  probeCherryStudio: () => request<{ found: string[] }>("/api/import/cherrystudio/probe"),
  importCherryStudio: (body: { dataDir?: string; includeThinking?: boolean; skipExisting?: boolean }) =>
    request<{ ok: boolean; stats: { agents: number; sessions: number; messages: number; skippedSessions: number; skippedAgents: number; dataDir: string } }>(
      "/api/import/cherrystudio",
      { method: "POST", body: JSON.stringify(body) },
    ),

  listAgents: () => request<{ agents: AgentDef[] }>("/api/agents"),
  saveAgent: (a: Partial<AgentDef>) => request<{ agent: AgentDef }>("/api/agents", { method: "POST", body: JSON.stringify(a) }),
  deleteAgent: (id: string) => request<{ ok: boolean }>(`/api/agents/${id}`, { method: "DELETE" }),

  listSessions: (includeArchived?: boolean) => request<{ sessions: SessionMeta[] }>(`/api/sessions${includeArchived ? "?includeArchived=1" : ""}`),
  createSession: (title?: string, agentId?: string) =>
    request<{ session: SessionMeta }>("/api/sessions", { method: "POST", body: JSON.stringify({ title, agentId }) }),
  deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  /** 删除一条消息里的全部工具调用信息(只留正文/思考) */
  stripTools: (sessionId: string, messageId: string) => request<{ ok: boolean }>(`/api/sessions/${sessionId}/messages/${messageId}/strip-tools`, { method: "POST" }),
  archiveSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}/archive`, { method: "POST" }),
  unarchiveSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}/unarchive`, { method: "POST" }),
  createBackup: () => request<{ ok: boolean; backupDir: string }>("/api/backup", { method: "POST" }),
  listBackups: () =>
    request<{ backups: { name: string; dir: string; size: number; mtime: number }[] }>("/api/backups"),
  restoreBackup: (backupDir: string) =>
    request<{ ok: boolean; snapshot?: string }>("/api/backup/restore", { method: "POST", body: JSON.stringify({ backupDir }) }),
  memoryList: (agentId?: string) =>
    request<{ items: { id: string; content: string; kind: string; tag?: string; createdAt: number; updatedAt: number }[] }>(
      `/api/memory/list${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
    ),
  memoryUpdate: (id: string, patch: { content?: string; tag?: string | null }, agentId?: string) =>
    request<{ ok: boolean }>(`/api/memory/${id}/update${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`, {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  memoryDelete: (id: string, agentId?: string) =>
    request<{ ok: boolean }>(`/api/memory/${id}/delete${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`, { method: "POST" }),
  renameSession: (id: string, title: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  /** 手动压缩上下文:AI 立即生成早期对话摘要(手动档) */
  summarizeSession: (id: string) =>
    request<{ ok: boolean; summary: string; compressed: number; kept: number }>(`/api/sessions/${id}/summarize`, { method: "POST" }),
  /** 群聊成员设置 */
  setSessionGroup: (id: string, agentIds: string[]) =>
    request<{ ok: boolean; groupAgents: string[] }>(`/api/sessions/${id}/group`, { method: "POST", body: JSON.stringify({ agentIds }) }),
  /** 世界观设定文档:生成/更新(AI 维护的长篇设定) */
  loreSession: (id: string) =>
    request<{ ok: boolean; lore: string }>(`/api/sessions/${id}/lore`, { method: "POST" }),
  loreUndo: (id: string) => request<{ ok: boolean; lore: string }>(`/api/sessions/${id}/lore/undo`, { method: "POST" }),
  loreClear: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}/lore/clear`, { method: "POST" }),
  loreSet: (id: string, text: string) =>
    request<{ ok: boolean; lore: string }>(`/api/sessions/${id}/lore/set`, { method: "POST", body: JSON.stringify({ text }) }),
  /** 局域网访问信息 */
  network: () => request<{ ips: string[]; lanAccess: boolean }>("/api/network"),
  /** 导出会话为文本(下载) */
  async exportSession(id: string, title: string): Promise<void> {
    const res = await fetch(base + `/api/sessions/${id}/export`);
    if (!res.ok) throw new Error("导出失败");
    const text = await res.text();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `幻世会话-${(title || id).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  },
  setSessionAgent: (id: string, agentId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/agent`, { method: "POST", body: JSON.stringify({ agentId }) }),
  /** 人格卡片导出:下载 JSON 文件 */
  async exportAgent(id: string, name: string): Promise<void> {
    const res = await fetch(base + `/api/agents/${id}/export`);
    if (!res.ok) throw new Error("导出失败");
    const card = await res.json();
    const blob = new Blob([JSON.stringify(card, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `幻世人格-${(name || "card").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
  /** 人格卡片导入 */
  importAgent: (card: unknown) =>
    request<{ agent: AgentDef }>(`/api/agents/import`, { method: "POST", body: JSON.stringify(card) }),
  search: (q: string) =>
    request<{ sessions: { session: SessionMeta; matches: number }[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  /** 图片附件上传,返回相对数据目录的文件路径 */
  async upload(file: File, dir?: "uploads" | "workspace"): Promise<{ file: string; mime: string; name?: string; text?: string }> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(base + `/api/upload${dir === "workspace" ? "?dir=workspace" : ""}`, { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.text().catch(() => "上传失败")) || "上传失败");
    return (await res.json()) as { file: string; mime: string; name?: string; text?: string };
  },
  /** API 朗读:文本 → 音频 Blob */
  async tts(text: string): Promise<Blob> {
    const res = await fetch(base + "/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `朗读失败(${res.status})`);
    }
    return await res.blob();
  },
  getMessages: (id: string) => request<{ messages: ChatMessage[] }>(`/api/sessions/${id}/messages`),
  deleteMessage: (sessionId: string, msgId: string) => request<{ ok: boolean }>(`/api/sessions/${sessionId}/messages/${msgId}`, { method: "DELETE" }),

  memoryStats: () => request<{ stats: { facts: number; experiences: number } }>("/api/memory/stats"),
  memoryAgents: () =>
    request<{ agents: { id: string; name: string; stats: { facts: number; experiences: number } }[] }>("/api/memory/agents"),
  clearAgentMemory: (id: string) =>
    request<{ ok: boolean }>(`/api/memory/agents/${id}/clear`, { method: "POST" }),
  memoryClear: () => request<{ ok: boolean }>("/api/memory/clear", { method: "POST" }),

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
