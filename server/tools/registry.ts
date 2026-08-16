import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MemoryService } from "../memory/service";

export interface ToolContext {
  cwd: string;
  allowedWriteDirs: string[];
  dataDir: string;
  env: NodeJS.ProcessEnv;
  memory: MemoryService | null;
  /** 允许执行高危命令(Agent 级全权限) */
  allowDangerousCommands?: boolean;
  /** 文件写入不受白名单限制(Agent 级全权限) */
  unrestrictedPaths?: boolean;
  /** 独立记忆空间作用域:该 Agent 开启 isolatedMemory 时为其 id,否则为空 */
  agentId?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema(parameters 部分) */
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** 路径守卫:写操作只允许在允许目录内,读操作允许系统任意路径 */
export function guardWritePath(rawPath: string, cwd: string, allowedWriteDirs: string[]): string {
  const home = require("node:os").homedir();
  const p = rawPath.startsWith("~") ? rawPath.replace(/^~/, home) : rawPath;
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const allowed = (allowedWriteDirs.length ? allowedWriteDirs : [cwd]).map((d) => resolve(d));
  for (const dir of allowed) {
    const rel = relative(dir, abs);
    if (rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsoluteWindowsDrive(rel))) {
      return abs;
    }
  }
  throw new ToolError(`路径不在允许写入的目录内:${abs}(允许:${allowed.join(", ")})`);
}

function isAbsoluteWindowsDrive(p: string): boolean {
  return /^[a-zA-Z]:/.test(p);
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  specs() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async run(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `错误:未知工具 ${name}`;
    try {
      const result = await tool.run(input, ctx);
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err: any) {
      return `工具执行出错:${err?.message ?? String(err)}`;
    }
  }
}
