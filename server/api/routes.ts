import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { newId, type AgentDef, type ChatRequest, type SessionMeta, type Settings, type StreamEvent, type TaskDef } from "../../shared/types";
import { AgentEngine } from "../agent/engine";
import { createCustomAgent } from "../agents";
import { saveSettings, writeDataDirRedirect, type ResolvedPaths } from "../config";
import { nextRunTime, parseCron } from "../cron";
import { importCherryStudio, isCherryStudioDataDir, probeCherryStudioDirs, type ImportStats } from "../import/cherrystudio";
import type { MemoryService } from "../memory/service";
import type { Db } from "../storage";
import { ToolRegistry } from "../tools/registry";

export interface AppDeps {
  db: Db;
  paths: ResolvedPaths;
  memory: MemoryService;
  engine: AgentEngine;
  registry: ToolRegistry;
  version: string;
  getSettings: () => Settings;
  setSettings: (s: Settings) => void;
  isPortable: () => boolean;
  /** 事件广播(WebSocket 推送),可选 */
  broadcast?: (e: StreamEvent) => void;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // ---- 健康与系统信息 ----

  app.get("/api/health", async (c) => {
    const mem = await deps.memory.status();
    return c.json({ ok: true, version: deps.version, memory: mem });
  });

  app.get("/api/system/info", async (c) => {
    const mem = await deps.memory.status();
    return c.json({
      version: deps.version,
      dataDir: deps.paths.dataDir,
      portable: deps.isPortable(),
      hindsightConnected: mem.mode === "hindsight" && mem.healthy,
      platform: process.platform,
    });
  });

  app.get("/api/tools", (c) => {
    return c.json({ tools: deps.registry.list().map((t) => ({ name: t.name, description: t.description })) });
  });

  // ---- 设置 ----

  app.get("/api/settings", (c) => c.json(deps.getSettings()));

  app.put("/api/settings", async (c) => {
    const patch = (await c.req.json()) as Partial<Settings>;
    const current = deps.getSettings();
    const next: Settings = {
      ...current,
      ...patch,
      memory: { ...current.memory, ...(patch.memory ?? {}) },
      providers: patch.providers ?? current.providers,
    };
    saveSettings(deps.paths.dataDir, next);
    deps.setSettings(next);
    return c.json(next);
  });

  /** 修改数据目录(写重定向,重启生效) */
  app.post("/api/settings/data-dir", async (c) => {
    const { path } = (await c.req.json()) as { path: string };
    if (!path?.trim()) return c.json({ error: "路径不能为空" }, 400);
    if (deps.isPortable()) return c.json({ error: "便携模式下数据目录固定,请移动整个应用目录" }, 400);
    writeDataDirRedirect(deps.paths.redirectFile, path);
    const settings = deps.getSettings();
    settings.dataDir = path;
    saveSettings(deps.paths.dataDir, settings);
    return c.json({ ok: true, restartRequired: true, path });
  });

  // ---- 记忆 ----

  app.post("/api/memory/reflect", async (c) => {
    const text = await deps.memory.reflect();
    return c.json({ text });
  });

  // ---- 人格 / Agents ----

  app.get("/api/agents", (c) => c.json({ agents: deps.db.listAgents() }));

  app.post("/api/agents", async (c) => {
    const body = (await c.req.json()) as Partial<AgentDef>;
    const agent: AgentDef = body.id
      ? { ...deps.db.getAgent(body.id)!, ...body }
      : createCustomAgent(body);
    deps.db.saveAgent(agent);
    return c.json({ agent });
  });

  app.delete("/api/agents/:id", (c) => {
    deps.db.deleteAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- 会话 ----

  app.get("/api/sessions", (c) => c.json({ sessions: deps.db.listSessions() }));

  app.post("/api/sessions", async (c) => {
    const { title, agentId } = (await c.req.json().catch(() => ({}))) as { title?: string; agentId?: string };
    const session = deps.db.createSession(title ?? "", agentId ?? firstAgentId(deps.db));
    return c.json({ session });
  });

  app.delete("/api/sessions/:id", (c) => {
    deps.db.deleteSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/archive", (c) => {
    const s = deps.db.updateSession(c.req.param("id"), { archived: true });
    return c.json({ ok: Boolean(s) });
  });

  app.get("/api/sessions/:id/messages", (c) => {
    return c.json({ messages: deps.db.getMessages(c.req.param("id")) });
  });

  // ---- 聊天(SSE 流式) ----

  app.post("/api/chat", (c) => {
    return streamSSE(c, async (stream) => {
      const body = (await c.req.json().catch(() => ({}))) as ChatRequest & { title?: string };
      if (!body.content?.trim()) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: "消息内容为空" }) });
        return;
      }

      let session = deps.db.getSession(body.sessionId);
      if (!session) {
        session = deps.db.createSession(body.title ?? "", body.agentId ?? firstAgentId(deps.db));
        await stream.writeSSE({ event: "session_created", data: JSON.stringify({ type: "session_created", session }) });
      }

      const agent = deps.db.getAgent(session.agentId) ?? deps.db.listAgents()[0];
      if (!agent) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: "未找到可用人格" }) });
        return;
      }

      const onEvent = async (e: StreamEvent) => {
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        deps.broadcast?.(e);
      };

      await deps.engine.runChat(session!, agent, body.content, onEvent, c.req.raw.signal);
    });
  });

  // ---- 会话标题重命名 ----

  app.post("/api/sessions/:id/rename", async (c) => {
    const { title } = (await c.req.json()) as { title: string };
    deps.db.updateSession(c.req.param("id"), { title: title || "新会话" });
    return c.json({ ok: true });
  });

  // ---- 搜索(会话标题 + 消息正文) ----

  app.get("/api/search", (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    if (!q) return c.json({ sessions: [] });
    const hits: { session: SessionMeta; matches: number }[] = [];
    for (const s of deps.db.listSessions()) {
      if (s.title.toLowerCase().includes(q)) {
        hits.push({ session: s, matches: -1 }); // -1 = 标题命中
        continue;
      }
      const messages = deps.db.getMessages(s.id);
      let matches = 0;
      for (const m of messages) {
        for (const p of m.parts) {
          if (p.type === "text" && (p.text ?? "").toLowerCase().includes(q)) {
            matches++;
            break;
          }
          if (p.type === "tool" && (p.tool?.output ?? "").toLowerCase().includes(q)) matches++;
        }
      }
      if (matches > 0) hits.push({ session: s, matches });
    }
    return c.json({ sessions: hits.slice(0, 50) });
  });

  // ---- Cherry Studio 迁移导入 ----

  app.get("/api/import/cherrystudio/probe", (c) => {
    const found = probeCherryStudioDirs();
    return c.json({ found });
  });

  app.post("/api/import/cherrystudio", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { dataDir?: string; includeThinking?: boolean; skipExisting?: boolean };
    let dataDir = body.dataDir?.trim();
    if (!dataDir) {
      const found = probeCherryStudioDirs();
      dataDir = found[0];
    }
    if (!dataDir || !isCherryStudioDataDir(dataDir)) {
      return c.json({ error: `不是有效的 Cherry Studio 数据目录:${dataDir ?? "(空)"}(需包含 Data/agents.db)` }, 400);
    }
    try {
      const stats: ImportStats = importCherryStudio(deps.db, {
        cherryDataDir: dataDir,
        includeThinking: body.includeThinking ?? false,
        skipExisting: body.skipExisting ?? true,
      });
      return c.json({ ok: true, stats });
    } catch (err) {
      return c.json({ error: `导入失败:${(err as Error).message}` }, 500);
    }
  });

  /** 切换会话使用的人格 */
  app.post("/api/sessions/:id/agent", async (c) => {
    const { agentId } = (await c.req.json()) as { agentId: string };
    const s = deps.db.updateSession(c.req.param("id"), { agentId });
    return c.json({ ok: Boolean(s) });
  });

  // ---- 定时任务 ----

  app.get("/api/tasks", (c) => c.json({ tasks: deps.db.listTasks() }));

  app.post("/api/tasks", async (c) => {
    const body = (await c.req.json()) as { name?: string; prompt?: string; schedule?: string; agentId?: string };
    if (!body.name?.trim() || !body.prompt?.trim() || !body.schedule?.trim()) {
      return c.json({ error: "名称、提示词、cron 表达式均不能为空" }, 400);
    }
    let nextRunAt: number;
    try {
      const d = nextRunTime(parseCron(body.schedule.trim()), new Date(Date.now() + 60_000));
      if (!d) return c.json({ error: "无法计算下次执行时间" }, 400);
      nextRunAt = d.getTime();
    } catch (err) {
      return c.json({ error: `cron 表达式无效:${(err as Error).message}` }, 400);
    }
    const task: TaskDef = {
      id: newId("task"),
      name: body.name.trim(),
      prompt: body.prompt.trim(),
      schedule: body.schedule.trim(),
      agentId: body.agentId || firstAgentId(deps.db),
      enabled: true,
      createdAt: Date.now(),
      nextRunAt,
    };
    deps.db.saveTask(task);
    return c.json({ task });
  });

  app.put("/api/tasks/:id", async (c) => {
    const body = (await c.req.json()) as Partial<TaskDef>;
    const cur = deps.db.getTask(c.req.param("id"));
    if (!cur) return c.json({ error: "任务不存在" }, 404);
    const next: TaskDef = { ...cur, ...body, id: cur.id };
    if (body.schedule && body.schedule !== cur.schedule) {
      try {
        const d = nextRunTime(parseCron(body.schedule), new Date(Date.now() + 60_000));
        next.nextRunAt = d?.getTime() ?? cur.nextRunAt;
      } catch (err) {
        return c.json({ error: `cron 表达式无效:${(err as Error).message}` }, 400);
      }
    }
    deps.db.saveTask(next);
    return c.json({ task: next });
  });

  app.delete("/api/tasks/:id", (c) => {
    deps.db.deleteTask(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** 立即手动触发一次任务(测试用) */
  app.post("/api/tasks/:id/run", async (c) => {
    const task = deps.db.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "任务不存在" }, 404);
    const agent = deps.db.getAgent(task.agentId);
    if (!agent) return c.json({ error: "人格不存在" }, 404);
    const session = deps.db.createSession(`⏰ ${task.name}`, task.agentId);
    let finalText = "";
    await deps.engine.runChat(session, agent, task.prompt, (e) => {
      if (e.type === "done") {
        finalText = e.message.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").slice(0, 600);
      }
    });
    deps.db.saveTask({ ...task, lastRunAt: Date.now(), lastStatus: "ok", lastResult: finalText || "(无文本输出)" });
    return c.json({ ok: true, result: finalText });
  });

  // ---- WebSocket:事件推送(会话更新通知) ----
  // 由 @hono/node-ws 注入,见 server/index.ts

  return app;
}

function firstAgentId(db: Db): string {
  return db.listAgents()[0]?.id ?? "";
}
