import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { newId, type AgentDef, type ChatRequest, type ModelConfig, type SessionMeta, type Settings, type StreamEvent, type TaskDef } from "../../shared/types";
import { AgentEngine, generateLore, generateSummary } from "../agent/engine";
import { createCustomAgent } from "../agents";
import { saveSettings, writeDataDirRedirect, type ResolvedPaths } from "../config";
import { nextRunTime, parseCron } from "../cron";
import { searchSessions } from "../storage/search";
import { importCherryStudio, isCherryStudioDataDir, probeCherryStudioDirs, type ImportStats } from "../import/cherrystudio";
import { fetchModelList, PROVIDER_PRESETS, testProvider } from "../providers/test";
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

  /** 常用模型提供商预设 */
  app.get("/api/providers/presets", (c) => c.json({ presets: PROVIDER_PRESETS }));

  /** 测试模型连接 */
  app.post("/api/providers/test", async (c) => {
    const cfg = (await c.req.json()) as ModelConfig;
    try {
      const detail = await testProvider(cfg);
      return c.json({ ok: true, detail });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

  /** 拉取模型列表 */
  app.post("/api/providers/models", async (c) => {
    const cfg = (await c.req.json()) as ModelConfig;
    try {
      const models = await fetchModelList(cfg);
      return c.json({ ok: true, models });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

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

  /** 上传自定义背景图(存数据目录,返回相对路径) */
  app.post("/api/appearance/background", async (c) => {
    const { dataUrl } = (await c.req.json().catch(() => ({}))) as { dataUrl?: string };
    if (!dataUrl?.startsWith("data:image/")) return c.json({ error: "仅支持图片(base64 data URL)" }, 400);
    const m = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return c.json({ error: "图片格式无法识别" }, 400);
    const [, ext, b64] = m;
    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) || "png";
    const dir = join(deps.paths.dataDir, "appearance");
    mkdirSync(dir, { recursive: true });
    // 文件名带时间戳,保证 URL 变化、浏览器不会复用旧缓存图
    const name = `bg_${Date.now()}.${safeExt}`;
    writeFileSync(join(dir, name), Buffer.from(b64, "base64"));
    // 清理旧背景图,避免堆积
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith("bg_") && f !== name) unlinkSync(join(dir, f));
      }
    } catch {
      /* ignore */
    }
    return c.json({ ok: true, path: `appearance/${name}` });
  });

  /** 图片附件上传:存入数据目录 uploads/,返回相对路径(最大 15MB) */
  app.post("/api/upload", bodyLimit({ maxSize: 15 * 1024 * 1024 }), async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || typeof file === "string") return c.json({ error: "缺少文件" }, 400);
    const f = file as File;
    const ext = (f.type.match(/image\/(\w+)/)?.[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    const dir = join(deps.paths.dataDir, "uploads");
    mkdirSync(dir, { recursive: true });
    const name = `${newId("up")}.${ext}`;
    writeFileSync(join(dir, name), Buffer.from(await f.arrayBuffer()));
    return c.json({ file: `uploads/${name}`, mime: f.type || "image/png" });
  });

  /** API 朗读(TTS):把文本交给 OpenAI 兼容 TTS 端点(或自建克隆服务),返回音频 */
  app.post("/api/tts", async (c) => {
    const { text } = (await c.req.json().catch(() => ({}))) as { text?: string };
    const tts = deps.getSettings().tts;
    if (!text?.trim() || tts?.mode !== "api" || !tts.apiBaseUrl) {
      return c.json({ error: "未配置 API 朗读" }, 400);
    }
    const base = tts.apiBaseUrl.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(tts.apiKey ? { Authorization: `Bearer ${tts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: tts.model || "tts-1",
          input: text.slice(0, 4000),
          voice: tts.voice || "alloy",
          response_format: "mp3",
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return c.json({ error: `TTS 服务返回 ${res.status}:${errText.slice(0, 200)}` }, 502);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return c.newResponse(buf, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    } catch (err) {
      return c.json({ error: `TTS 请求失败:${(err as Error).message}` }, 502);
    }
  });

  /** 静态文件服务(自定义背景图等) */
  app.get("/files/*", (c) => {
    const rel = c.req.path.replace(/^\/files\//, "");
    const file = join(deps.paths.dataDir, rel);
    if (!file.startsWith(deps.paths.dataDir) || !existsSync(file)) {
      return c.text("not found", 404);
    }
    const mime: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".txt": "text/plain; charset=utf-8",
    };
    return c.body(readFileSync(file), 200, { "Content-Type": mime[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  });

  // ---- 记忆 ----

  app.post("/api/memory/reflect", async (c) => {
    const text = await deps.memory.reflect();
    return c.json({ text });
  });

  /** 本地记忆统计(条数)与清空 */
  app.get("/api/memory/stats", async (c) => {
    return c.json({ stats: await deps.memory.stats() });
  });

  /** 独立记忆空间的人格及其记忆统计 */
  app.get("/api/memory/agents", async (c) => {
    const agents = deps.db.listAgents().filter((a) => a.isolatedMemory);
    const rows = await Promise.all(
      agents.map(async (a) => ({ id: a.id, name: a.name, stats: await deps.memory.stats(a.id) })),
    );
    return c.json({ agents: rows });
  });

  /** 清空某人格的独立记忆 */
  app.post("/api/memory/agents/:id/clear", (c) => {
    deps.memory.clear(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/memory/clear", async (c) => {
    deps.memory.clear();
    return c.json({ ok: true });
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

  /** 人格卡片导出:人格定义 + 独立记忆 → JSON 文件 */
  app.get("/api/agents/:id/export", async (c) => {
    const a = deps.db.getAgent(c.req.param("id"));
    if (!a) return c.json({ error: "人格不存在" }, 404);
    const memory = a.isolatedMemory ? await deps.memory.list(a.id) : [];
    const card = {
      format: "huanshi-agent",
      version: 1,
      exportedAt: new Date().toISOString(),
      agent: {
        name: a.name,
        description: a.description,
        systemPrompt: a.systemPrompt,
        memoryEnabled: a.memoryEnabled,
        tools: a.tools,
        useGlobalStyle: a.useGlobalStyle,
        allowDangerousCommands: a.allowDangerousCommands,
        unrestrictedPaths: a.unrestrictedPaths,
        historyUnlimited: a.historyUnlimited,
        isolatedMemory: a.isolatedMemory,
      },
      memory,
    };
    const fname = `agent-${a.id.slice(0, 16)}.json`;
    return c.json(card, 200, {
      // 文件名含中文会导致 Hono Header 报错;实际下载名由前端 a.download 指定(中文)
      "Content-Disposition": `attachment; filename="${fname}"`,
    });
  });

  /** 人格卡片导入:JSON 文件 → 新人格(+独立记忆) */
  app.post("/api/agents/import", async (c) => {
    const card = (await c.req.json().catch(() => null)) as {
      format?: string;
      agent?: Record<string, unknown>;
      memory?: { id?: string; content?: string; kind?: string; createdAt?: number }[];
    } | null;
    if (!card || card.format !== "huanshi-agent" || !card.agent?.name || !card.agent?.systemPrompt) {
      return c.json({ error: "不是有效的幻世人格卡片文件" }, 400);
    }
    const agent = createCustomAgent({
      name: String(card.agent.name),
      description: String(card.agent.description ?? ""),
      systemPrompt: String(card.agent.systemPrompt),
      memoryEnabled: card.agent.memoryEnabled !== false,
      tools: Array.isArray(card.agent.tools) ? (card.agent.tools as string[]) : undefined,
      useGlobalStyle: card.agent.useGlobalStyle as boolean | undefined,
      allowDangerousCommands: card.agent.allowDangerousCommands as boolean | undefined,
      unrestrictedPaths: card.agent.unrestrictedPaths as boolean | undefined,
      historyUnlimited: card.agent.historyUnlimited as boolean | undefined,
      isolatedMemory: card.agent.isolatedMemory as boolean | undefined,
    });
    deps.db.saveAgent(agent);
    // 导入独立记忆
    if (agent.isolatedMemory && Array.isArray(card.memory) && card.memory.length) {
      for (const item of card.memory.slice(0, 500)) {
        if (item?.content) {
          void deps.memory.retain(String(item.content), item.kind === "experience" ? "experience" : "fact", agent.id);
        }
      }
    }
    return c.json({ agent });
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

  /** 删除单条消息(手动压缩上下文) */
  app.delete("/api/sessions/:id/messages/:msgId", (c) => {
    const ok = deps.db.deleteMessage(c.req.param("id"), c.req.param("msgId"));
    return c.json({ ok });
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

      await deps.engine.runChat(session!, agent, body.content, onEvent, c.req.raw.signal, body.attachments);
    });
  });

  // ---- 会话标题重命名 ----

  app.post("/api/sessions/:id/rename", async (c) => {
    const { title } = (await c.req.json()) as { title: string };
    deps.db.updateSession(c.req.param("id"), { title: title || "新会话" });
    return c.json({ ok: true });
  });

  /** 手动压缩上下文:立即用 AI 把早期对话压成摘要存进会话(手动档) */
  app.post("/api/sessions/:id/summarize", async (c) => {
    const id = c.req.param("id");
    const session = deps.db.getSession(id);
    if (!session) return c.json({ error: "会话不存在" }, 404);
    const msgs = deps.db.getMessages(id);
    if (msgs.length <= 10) return c.json({ error: "会话太短,暂不需要压缩" }, 400);
    const early = msgs.slice(0, Math.max(msgs.length - 30, 10)); // 最近 30 条保留完整,更早的压成摘要
    const cfg = deps.getSettings().providers[deps.getSettings().activeProvider];
    const summary = await generateSummary(cfg, early, deps.paths.dataDir);
    if (!summary) return c.json({ error: "摘要生成失败,请稍后重试" }, 500);
    deps.db.updateSession(id, { summary, summaryCount: msgs.length });
    return c.json({ ok: true, summary, compressed: early.length, kept: msgs.length - early.length });
  });

  /** 世界观设定文档:生成/更新(AI 综合摘要+最近对话维护设定)。更新前保存历史版本供回退 */
  app.post("/api/sessions/:id/lore", async (c) => {
    const id = c.req.param("id");
    const session = deps.db.getSession(id);
    if (!session) return c.json({ error: "会话不存在" }, 404);
    const msgs = deps.db.getMessages(id);
    if (msgs.length < 5) return c.json({ error: "对话太少,暂无法提炼世界观" }, 400);
    const cfg = deps.getSettings().providers[deps.getSettings().activeProvider];
    const lore = await generateLore(cfg, msgs.slice(-200), session.lore, deps.paths.dataDir);
    if (!lore) return c.json({ error: "世界观生成失败,请稍后重试" }, 500);
    const history = session.lore ? [session.lore, ...(session.loreHistory ?? [])].slice(0, 5) : session.loreHistory;
    deps.db.updateSession(id, { lore, loreHistory: history });
    return c.json({ ok: true, lore });
  });

  /** 世界观:回退到上一版本 */
  app.post("/api/sessions/:id/lore/undo", (c) => {
    const id = c.req.param("id");
    const session = deps.db.getSession(id);
    if (!session || !session.loreHistory?.length) return c.json({ error: "没有可回退的历史版本" }, 400);
    const [prev, ...rest] = session.loreHistory;
    deps.db.updateSession(id, { lore: prev, loreHistory: rest });
    return c.json({ ok: true, lore: prev });
  });

  /** 世界观:清除(误点或不需要时) */
  app.post("/api/sessions/:id/lore/clear", (c) => {
    const id = c.req.param("id");
    const session = deps.db.getSession(id);
    if (!session) return c.json({ error: "会话不存在" }, 404);
    deps.db.updateSession(id, { lore: undefined, loreHistory: undefined });
    return c.json({ ok: true });
  });

  /** 世界观:手动编辑(直接设置内容) */
  app.post("/api/sessions/:id/lore/set", async (c) => {
    const id = c.req.param("id");
    const { text } = (await c.req.json().catch(() => ({}))) as { text?: string };
    const session = deps.db.getSession(id);
    if (!session) return c.json({ error: "会话不存在" }, 404);
    const newLore = (text ?? "").trim();
    const history = session.lore ? [session.lore, ...(session.loreHistory ?? [])].slice(0, 5) : session.loreHistory;
    deps.db.updateSession(id, { lore: newLore || undefined, loreHistory: history });
    return c.json({ ok: true, lore: newLore });
  });

  /** 会话导出:对话全文 + 摘要 → 纯文本(下载) */
  app.get("/api/sessions/:id/export", (c) => {
    const s = deps.db.getSession(c.req.param("id"));
    if (!s) return c.json({ error: "会话不存在" }, 404);
    const agent = deps.db.getAgent(s.agentId);
    const msgs = deps.db.getMessages(s.id);
    const lines: string[] = [];
    lines.push(`# ${s.title}`);
    lines.push(`人格:${agent?.name ?? s.agentId}`);
    lines.push(`导出时间:${new Date().toLocaleString("zh-CN")}`);
    if (s.summary) lines.push(`\n## 早期对话摘要(AI)\n${s.summary}`);
    if (s.lore) lines.push(`\n## 世界观设定文档(AI)\n${s.lore}`);
    lines.push(`\n## 对话记录(共 ${msgs.length} 条)\n`);
    for (const m of msgs) {
      const role = m.role === "user" ? "👤 用户" : "🤖 助手";
      const text = m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      const thinking = m.parts.filter((p) => p.type === "thinking").map((p) => p.text ?? "").join("\n");
      const tools = m.parts.filter((p) => p.type === "tool" && p.tool);
      lines.push(`### ${role} · ${new Date(m.createdAt).toLocaleString("zh-CN")}`);
      if (thinking) lines.push(`> 🖊 思考:${thinking}`);
      if (text) lines.push(text);
      for (const t of tools) lines.push(`[🔧 ${t.tool!.name}] ${(t.tool!.output ?? "").slice(0, 300)}`);
      lines.push("");
    }
    const fname = `session-${s.id.slice(0, 20)}.txt`;
    return c.text(lines.join("\n"), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      // 文件名含中文会导致 Hono Header 报错;实际下载名由前端 a.download 指定(中文)
      "Content-Disposition": `attachment; filename="${fname}"`,
    });
  });

  // ---- 搜索(会话标题 + 消息正文) ----

  app.get("/api/search", (c) => {
    return c.json({ sessions: searchSessions(deps.db, c.req.query("q") ?? "") });
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
