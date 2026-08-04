import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import type { AddressInfo } from "node:net";
import type { Settings, StreamEvent } from "../shared/types";
import { AgentEngine } from "./agent/engine";
import { ensureDefaultAgents } from "./agents";
import { createApp } from "./api/routes";
import { ensureDirs, loadSettings, resolveDataDir, type ResolvedPaths } from "./config";
import { MemoryService } from "./memory/service";
import { Db } from "./storage";
import { datetimeTool, fileTools, shellTool, webTool } from "./tools/files";
import { memoryTools } from "./tools/memory";
import { ToolRegistry } from "./tools/registry";

export interface ServerHandle {
  port: number;
  paths: ResolvedPaths;
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

  const memory = new MemoryService(settings.memory, paths.dataDir);

  const registry = new ToolRegistry();
  for (const t of [...fileTools, shellTool, webTool, datetimeTool, ...memoryTools(memory)]) {
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

  const server: ServerType = serve({ fetch: hanaApp.fetch, hostname: "127.0.0.1", port: Number(process.env.HANALITE_PORT) || 0 });
  // 等待监听就绪后再读取端口(端口 0 随机分配是异步的)
  await new Promise<void>((resolveListen) => server.once("listening", () => resolveListen()));
  injectWebSocket(server);
  const port = (server.address() as AddressInfo).port;

  console.log(`[hanalite] server listening on http://127.0.0.1:${port}`);
  console.log(`[hanalite] data dir: ${paths.dataDir}${paths.portable ? " (portable)" : ""}`);
  console.log(`[hanalite] memory: ${settings.memory.mode}`);

  return {
    port,
    paths,
    getSettings: () => settings,
    broadcast,
    close: () =>
      new Promise<void>((resolveClose) => {
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
