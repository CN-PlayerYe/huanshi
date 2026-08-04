import { exec } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { guardWritePath, ToolError, type Tool, type ToolContext } from "./registry";

const MAX_READ_BYTES = 256 * 1024;

export const fileTools: Tool[] = [
  {
    name: "read_file",
    description: "读取文本文件内容。适合阅读源码、文档、配置文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径(绝对路径,或基于工作目录的相对路径)" },
        maxBytes: { type: "number", description: "最大读取字节数,默认 256KB" },
      },
      required: ["path"],
    },
    async run(input, ctx) {
      const p = resolvePath(String(input.path), ctx.cwd);
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) throw new ToolError(`文件不存在或不是文件:${p}`);
      const max = Number(input.maxBytes) || MAX_READ_BYTES;
      const buf = await readFile(p);
      if (buf.length > max) {
        return `文件过大(${buf.length} 字节),已截取前 ${max} 字节:\n\n${buf.subarray(0, max).toString("utf-8")}\n\n... (已截断)`;
      }
      return buf.toString("utf-8");
    },
  },
  {
    name: "write_file",
    description: "写入文本文件(自动创建父目录)。仅允许写入工作区或用户白名单目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径" },
        content: { type: "string", description: "文件内容" },
      },
      required: ["path", "content"],
    },
    async run(input, ctx) {
      const p = guardWritePath(String(input.path), ctx.cwd, ctx.allowedWriteDirs);
      await mkdir(resolve(p, ".."), { recursive: true });
      await writeFile(p, String(input.content ?? ""), "utf-8");
      return `已写入 ${p}(${String(input.content ?? "").length} 字符)`;
    },
  },
  {
    name: "list_dir",
    description: "列出目录内容(文件名、类型、大小)。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径,默认工作目录" },
        depth: { type: "number", description: "递归深度,0 表示只列一层,默认 1" },
      },
    },
    async run(input, ctx) {
      const p = input.path ? resolvePath(String(input.path), ctx.cwd) : ctx.cwd;
      const depth = Math.max(0, Number(input.depth) || 1);
      const lines: string[] = [];
      await walk(p, 0, depth, lines);
      return lines.join("\n") || "(空目录)";
    },
  },
];

async function walk(dir: string, level: number, maxDepth: number, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const indent = "  ".repeat(level);
    if (e.isDirectory()) {
      out.push(`${indent}📁 ${e.name}/`);
      if (level < maxDepth) await walk(join(dir, e.name), level + 1, maxDepth, out);
    } else {
      out.push(`${indent}📄 ${e.name}`);
    }
  }
}

function resolvePath(p: string, cwd: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export const shellTool: Tool = {
  name: "run_command",
  description:
    "在用户电脑上执行 shell 命令(Windows 为 cmd;macOS/Linux 为 sh)。输出合并 stdout/stderr。注意:命令以当前用户权限运行,请谨慎使用危险命令。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      cwd: { type: "string", description: "工作目录,默认用户主目录" },
      timeoutMs: { type: "number", description: "超时毫秒,默认 60000" },
    },
    required: ["command"],
  },
  run(input, ctx) {
    const command = String(input.command);
    const cwd = input.cwd ? resolvePath(String(input.cwd), ctx.cwd) : ctx.env.HOME || ctx.env.USERPROFILE || ctx.cwd;
    const timeoutMs = Number(input.timeoutMs) || 60_000;
    return new Promise((resolvePromise) => {
      const child = exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: ctx.env,
        },
        (err, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join("\n").trim() || "(无输出)";
          if (err) {
            resolvePromise(`退出码 ${(err as any).code ?? "?"}\n${out}\n${(err.message || "").slice(0, 500)}`);
          } else {
            resolvePromise(out);
          }
        },
      );
      // 让子进程随父进程退出
      child.on("error", (e) => resolvePromise(`启动命令失败:${e.message}`));
    });
  },
};

export const webTool: Tool = {
  name: "fetch_url",
  description: "抓取网页内容并转为纯文本(适合阅读文章、文档、API 页面)。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "完整的 http(s) URL" },
      maxBytes: { type: "number", description: "最大抓取字节数,默认 1MB" },
    },
    required: ["url"],
  },
  async run(input, _ctx) {
    const url = String(input.url);
    if (!/^https?:\/\//i.test(url)) throw new ToolError("URL 必须以 http:// 或 https:// 开头");
    const maxBytes = Number(input.maxBytes) || 1024 * 1024;
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "HanaLite/0.1" } });
    if (!res.ok) throw new ToolError(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ToolError(`内容超过 ${maxBytes} 字节限制`);
    const html = buf.toString("utf-8");
    const text = htmlToText(html);
    return text.slice(0, 20000) || "(无可读文本)";
  },
};

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export const datetimeTool: Tool = {
  name: "get_datetime",
  description: "获取当前日期时间、星期和时区。用于需要知道\"现在\"的场景。",
  parameters: { type: "object", properties: {} },
  run() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `当前时间:${now.toLocaleString("zh-CN")}(${now.toISOString()})\n星期:${["日", "一", "二", "三", "四", "五", "六"][now.getDay()]}\n时区:${tz}`;
  },
};
