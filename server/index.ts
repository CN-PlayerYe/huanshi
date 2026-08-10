import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Settings, StreamEvent } from "../shared/types";
import { AgentEngine } from "./agent/engine";
import { ensureDefaultAgents } from "./agents";
import { fixEmbeddedThinking, fixLegacyHeartbeatSessions, cleanHeartbeatMemories } from "./datafix";
import { createApp } from "./api/routes";
import { ensureDirs, loadSettings, resolveDataDir, type ResolvedPaths } from "./config";
import { MemoryService } from "./memory/service";
import { Db } from "./storage";
import { Scheduler } from "./tasks";
import { datetimeTool, fileTools, searchTool, shellTool, webTool } from "./tools/files";
import { memoryTools } from "./tools/memory";
import { ToolRegistry } from "./tools/registry";

export interface ServerHandle {
  port: number;
  paths: ResolvedPaths;
  dataFix?: { cleanedEmpty: number; fixedThinking: number };
  getSettings: () => Settings;
  broadcast: (e: StreamEvent) => void;
  close: () => Promise<void>;
}

export async function createServer(opts: { version?: string; isPackaged?: boolean; appPath?: string } = {}): Promise<ServerHandle> {
  const paths = resolveDataDir({ isPackaged: opts.isPackaged, appPath: opts.appPath });
  ensureDirs(paths);

  let settings = loadSettings(paths.dataDir);
  const db = Db.fromPaths(paths);
  ensureDefaultAgents(db);

  // 清理历史遗留的空消息(旧版本失败路径可能产生 parts:[] 的 assistant,会触发 API 400)
  const cleaned = db.cleanEmptyMessages();
  if (cleaned > 0) console.log(`[hanalite] 清理了 ${cleaned} 条空消息`);

  // 存量数据修复:把内嵌 <thinking> 从正文提取为独立 part(DeepSeek reasoning_content 回传需要)
  let fixedThinking = 0;
  try {
    fixedThinking = fixEmbeddedThinking(db);
    if (fixedThinking > 0) console.log(`[hanalite] 修复了 ${fixedThinking} 条消息的思考内容`);
  } catch (err) {
    console.error("[hanalite] 数据修复失败(不影响启动):", (err as Error).message);
  }

  // 旧版心跳碎片会话归档:标题「💓 心跳 <时间>」→ 归档(数据保留)
  try {
    const hbArchived = fixLegacyHeartbeatSessions(db);
    if (hbArchived > 0) console.log(`[hanalite] 已归档 ${hbArchived} 个旧心跳碎片会话`);
  } catch {
    /* 不影响启动 */
  }

  const memory = new MemoryService(settings.memory, paths.dataDir);

  // 清理误入记忆库的心跳消息(避免污染人格身份,如人格身份污染)
  try {
    void cleanHeartbeatMemories(memory, db.listAgents().filter((a) => a.isolatedMemory).map((a) => a.id)).then((n) => {
      if (n > 0) console.log(`[hanalite] 已清理 ${n} 条误入记忆的心跳消息`);
    });
  } catch {
    /* 不影响启动 */
  }

  const registry = new ToolRegistry();
  for (const t of [...fileTools, shellTool, webTool, searchTool, datetimeTool, ...memoryTools(memory)]) {
    registry.register(t);
  }

  const engine = new AgentEngine({
    db,
    memory,
    registry,
    dataDir: paths.dataDir,
    getSettings: () => settings,
  });

  // ---- WebSocket 广播(会话更新通知,供多窗口/远程前端同步) ----
  const clients = new Set<import("ws").WebSocket>();
  const broadcast = (e: StreamEvent) => {
    const payload = JSON.stringify({ event: e });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  const hanaApp = createApp({
    db,
    paths,
    memory,
    engine,
    registry,
    version: opts.version ?? "0.1.0",
    getSettings: () => settings,
    setSettings: (s) => {
      settings = s;
    },
    isPortable: () => paths.portable,
    broadcast,
    // 主人发消息:记录时间,心跳执行时据此打断
    onUserMessage: () => {
      lastUserAt = Date.now();
    },
    // 手动立即运行:走调度器(心跳任务走心跳分支:固定日记会话/边界/打断)
    onRunTask: async (taskId) => scheduler.runNow(taskId),
  });

  // CORS:渲染进程(file:// 或 dev localhost)请求本机后端;仅监听 127.0.0.1,允许所有来源无安全风险
  hanaApp.use("*", cors({ origin: "*" }));

  // ---- WebSocket(需在 app 创建后注入) ----
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: hanaApp });
  hanaApp.get(
    "/api/ws",
    upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        if (ws.raw) clients.add(ws.raw);
      },
      onClose(_evt, ws) {
        if (ws.raw) clients.delete(ws.raw);
      },
    })),
  );

  const server: ServerType = serve({
    fetch: hanaApp.fetch,
    // 局域网访问:开启后监听所有网卡,手机/其他设备可通过局域网 IP 访问
    hostname: settings.lanAccess ? "0.0.0.0" : "127.0.0.1",
    port: Number(process.env.HANALITE_PORT) || 0,
  });
  // 等待监听就绪后再读取端口(端口 0 随机分配是异步的)
  await new Promise<void>((resolveListen) => server.once("listening", () => resolveListen()));
  injectWebSocket(server);
  const port = (server.address() as AddressInfo).port;

  // ---- 定时任务调度器 ----
  let lastUserAt: number | undefined;
  // 重启后恢复"主人最后说话时间":取所有会话最后一条非心跳 user 消息(心跳是系统代发,不算)
  try {
    for (const s of db.listSessions(true)) {
      const msgs = db.getMessages(s.id);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "user") continue;
        const partsStr = JSON.stringify(m.parts ?? []);
        if (partsStr.includes("【心跳")) continue; // 系统代发的心跳邀请,不是主人说话
        lastUserAt = Math.max(lastUserAt ?? 0, m.createdAt);
        break; // 该会话里最新的一条 user 消息(从尾往前第一条)
      }
    }
  } catch {
    /* 恢复失败不阻塞启动 */
  }
  const workspaceDir = settings.toolWhitelistDir || join(paths.dataDir, "workspace");
  const scheduler = new Scheduler(
    db,
    engine,
    (id) => db.getAgent(id),
    (e) => {
      // 任务完成:广播给前端做桌面通知(人格主动找你)+ 会话 id(心跳日记实时刷新用)
      broadcast({ type: "task_done", taskName: e.taskName, ok: e.ok, result: e.result.slice(0, 200), sessionId: e.sessionId });
    },
    workspaceDir,
    () => lastUserAt,
    () => settings.heartbeatPaused === true,
  );
  scheduler.start();

  console.log(`[hanalite] server listening on http://127.0.0.1:${port}`);
  console.log(`[hanalite] data dir: ${paths.dataDir}${paths.portable ? " (portable)" : ""}`);
  console.log(`[hanalite] memory: ${settings.memory.mode}`);

  return {
    port,
    paths,
    /** 本次启动的数据修复计数(空消息清理 / 思考内容归位) */
    dataFix: { cleanedEmpty: cleaned, fixedThinking },
    getSettings: () => settings,
    broadcast,
    close: () =>
      new Promise<void>((resolveClose) => {
        scheduler.stop();
        server.close(() => resolveClose());
      }),
  };
}

// 支持 `node dist-electron/server/index.js` 独立启动(server-first CLI/调试)
if (require.main === module) {
  createServer({ version: "0.1.0" }).then((handle) => {
    console.log(`[hanalite] 独立模式运行中:http://127.0.0.1:${handle.port}(Ctrl+C 退出)`);
    process.on("SIGINT", () => {
      void handle.close().then(() => process.exit(0));
    });
  });
}
