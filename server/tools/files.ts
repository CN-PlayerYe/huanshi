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
      // Agent 开启全文件权限时不受白名单限制
      const p = ctx.unrestrictedPaths
        ? (isAbsolute(String(input.path)) ? resolve(String(input.path)) : resolve(ctx.cwd, String(input.path)))
        : guardWritePath(String(input.path), ctx.cwd, ctx.allowedWriteDirs);
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
  {
    name: "search_files",
    description:
      "在指定目录内递归搜索文本文件中的关键词(内容或文件名),返回匹配文件、行号与片段。适合在笔记库/知识库(如 Obsidian)里快速定位内容,不用逐个文件翻。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的关键词" },
        directory: { type: "string", description: "搜索根目录(绝对路径或相对工作目录),默认工作目录" },
        extensions: { type: "array", items: { type: "string" }, description: "只搜这些扩展名,如 [\".md\", \".txt\"];默认 .md/.txt/.json/.csv/.log" },
        maxResults: { type: "number", description: "最多返回匹配条数,默认 20" },
        nameOnly: { type: "boolean", description: "只按文件名匹配,不读内容,更快", default: false },
      },
      required: ["query"],
    },
    async run(input, ctx) {
      const query = String(input.query ?? "").trim().toLowerCase();
      if (!query) throw new ToolError("缺少搜索关键词 query");
      const dir = input.directory ? resolvePath(String(input.directory), ctx.cwd) : ctx.cwd;
      const maxResults = Math.min(100, Math.max(1, Number(input.maxResults) || 20));
      const nameOnly = input.nameOnly === true;
      const exts = Array.isArray(input.extensions) ? input.extensions.map(String) : [".md", ".txt", ".json", ".csv", ".log"];
      const hits: string[] = [];
      const searchWalk = async (d: string, depth: number): Promise<void> => {
        if (hits.length >= maxResults || depth > 8) return;
        let entries: import("node:fs").Dirent[];
        try {
          entries = await readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= maxResults) return;
          const full = join(d, e.name);
          if (e.isDirectory()) {
            if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".git") continue;
            await searchWalk(full, depth + 1);
          } else if (e.isFile()) {
            const low = e.name.toLowerCase();
            if (!exts.some((x) => low.endsWith(x.toLowerCase()))) continue;
            if (nameOnly) {
              if (low.includes(query)) hits.push(`${full} (文件名匹配)`);
              continue;
            }
            try {
              const st = await stat(full);
              if (st.size > 512 * 1024) continue; // 跳过超大文件(多半是二进制/资料)
              const text = (await readFile(full, "utf8")).slice(0, 256 * 1024).toLowerCase();
              if (text.includes(query)) {
                const idx = text.indexOf(query);
                const lineStart = text.lastIndexOf("\n", idx) + 1;
                const lineEnd = text.indexOf("\n", idx);
                const snippet = text.slice(lineStart, lineEnd < 0 ? lineStart + 120 : lineEnd).trim().slice(0, 120);
                const lineNo = text.slice(0, idx).split("\n").length;
                hits.push(`${full}:${lineNo} ${snippet}`);
              }
            } catch {
              /* 读失败跳过(可能被占用/二进制) */
            }
          }
        }
      };
      await searchWalk(dir, 0);
      if (!hits.length) return `在 ${dir} 中没有找到包含「${String(input.query)}」的文本文件。`;
      return `${hits.slice(0, maxResults).map((h) => `- ${h}`).join("\n")}\n(共找到 ${hits.length} 条,显示前 ${maxResults} 条)`;
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
    "在用户电脑上执行 shell 命令(Windows 为 cmd;macOS/Linux 为 sh)。输出合并 stdout/stderr。注意:命令以当前用户权限运行,高危命令会被自动拦截。",
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
    // 危险命令分级拦截(Agent 若开启全权限则放行)
    if (!ctx.allowDangerousCommands) {
      const danger = detectDangerousCommand(command);
      if (danger) {
        return `⛔ 该命令被判定为高危操作,已自动拦截(${danger})。\n请告知用户,由用户手动确认后执行。`;
      }
    }
    const cwd = input.cwd ? resolvePath(String(input.cwd), ctx.cwd) : ctx.env.HOME || ctx.env.USERPROFILE || ctx.cwd;
    const timeoutMs = Number(input.timeoutMs) || 60_000;
    // Windows cmd 默认 GBK 输出,Node 按 UTF-8 解码会乱码:先切 UTF-8 代码页
    const win = process.platform === "win32";
    const fullCommand = win ? `chcp 65001 >nul & ${command}` : command;
    return new Promise((resolvePromise) => {
      const child = exec(
        fullCommand,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          encoding: "buffer",
          env: ctx.env,
        },
        (err, stdout, stderr) => {
          // 双解码:优先 UTF-8(chcp 65001 后);失败则按系统 GBK(中文 Windows 常见)
          const dec = (b: Buffer | string) => {
            const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
            try {
              return new TextDecoder("utf-8", { fatal: true }).decode(buf);
            } catch {
              try {
                return new TextDecoder("gbk").decode(buf);
              } catch {
                return buf.toString("utf-8");
              }
            }
          };
          const out = [dec(stdout), dec(stderr)].filter(Boolean).join("\n").trim() || "(无输出)";
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

/** 危险命令模式(命中即拒绝执行) */
const DANGEROUS_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+-(r|f|rf|fr)+[^\w]*\s+\//i, reason: "删除根目录(rm -rf /)" },
  { re: /\brm\s+-rf\b|\brm\s+-fr\b|\brm\s+-r\s+-f\b/i, reason: "递归强制删除(rm -rf)" },
  { re: /\bdel\s+\/s\b|\bdeltree\b|\brmdir\s+\/s\b/i, reason: "Windows 递归删除" },
  { re: /\bformat\s+[a-z]:/i, reason: "格式化磁盘" },
  { re: /\bshutdown\b|\breboot\b|\binit\s+0\b|\bpoweroff\b/i, reason: "关机/重启系统" },
  { re: /\bdd\s+if=.*\bof=\/dev\//i, reason: "覆写磁盘设备(dd)" },
  { re: /\bchmod\s+-R\s+777\s+\//i, reason: "根目录全权限" },
  { re: /\bdiskpart\b/i, reason: "磁盘分区操作" },
  { re: /\bcipher\s+\/w\b/i, reason: "擦除磁盘剩余空间" },
  { re: /\bformat\b.*\bquick\b/i, reason: "快速格式化" },
  { re: /\bdel\s+[a-z]:\\\s*$/i, reason: "删除整个盘符内容" },
  { re: /^\s*>\s*[a-z]:/i, reason: "重定向覆写盘符" },
];

function detectDangerousCommand(command: string): string | null {
  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(command)) return reason;
  }
  return null;
}

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
    // 中文 URL 等非 ASCII 必须先百分号编码,否则 fetch 直接报 ByteString 编码错误
    // 且需手动跟随重定向:undici 对含中文的 Location 头同样报 ByteString 错,每跳都要重新编码
    const maxBytes = Number(input.maxBytes) || 1024 * 1024;
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
    let u = encodeURI(url);
    let res: Response | undefined;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(u, { redirect: "manual", headers: { "User-Agent": UA } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        u = encodeURI(new URL(loc, res.url).toString());
        continue;
      }
      break;
    }
    if (!res || !res.ok) throw new ToolError(`HTTP ${res?.status ?? "?"}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // 超限不报错,截断保留前段(大页面常见,如搜索引擎结果页)
    const sliced = buf.length > maxBytes ? buf.slice(0, maxBytes) : buf;
    const html = sliced.toString("utf-8");
    const text = htmlToText(html);
    const tail = buf.length > maxBytes ? "\n…(页面过大,已截取前段)" : "";
    return (text.slice(0, 20000) + tail) || "(无可读文本)";
  },
};

/** 网页搜索(DuckDuckGo HTML 版,无需 API Key)。若网络不通可返回提示。 */
export const searchTool: Tool = {
  name: "search_web",
  description: "实时搜索互联网(无需 API Key)。返回标题、链接与摘要,适合查最新信息。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      maxResults: { type: "number", description: "最多返回条数,默认 5" },
    },
    required: ["query"],
  },
  async run(input) {
    const query = String(input.query).trim();
    if (!query) throw new ToolError("搜索关键词不能为空");
    const max = Math.min(8, Math.max(1, Number(input.maxResults) || 5));
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
    // 引擎按可达性排序:必应(国内直连)优先,DuckDuckGo(部分地区被墙)兜底
    const engines: { name: string; url: (q: string) => string; parse: (html: string) => SearchResult[] }[] = [
      { name: "必应", url: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBingHtml },
      { name: "DuckDuckGo", url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGoLite },
    ];
    for (const engine of engines) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res = await fetch(engine.url(query), { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA } });
        clearTimeout(timer);
        if (!res.ok) continue;
        const html = await res.text();
        const results = engine.parse(html).slice(0, max);
        if (!results.length) continue;
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      } catch {
        continue; // 该引擎不可达,试下一个
      }
    }
    return "搜索服务连接失败(网络不可达或引擎被限制)。可改用 fetch_url 直接抓取搜索引擎页面:\nhttps://www.baidu.com/s?wd=<关键词>";
  },
};

/** 解析 DuckDuckGo lite 结果页(表格布局) */
type SearchResult = { title: string; url: string; snippet: string };

function parseDuckDuckGoLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  // lite 版结果在 <a rel="nofollow" href="...">标题</a>,摘要紧随其后
  const linkRe = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    const url = m[1];
    if (!url.startsWith("http")) continue;
    links.push({ url, title: htmlToText(m[2]).slice(0, 200) });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html))) snippets.push(htmlToText(m[1]).slice(0, 300));
  for (let i = 0; i < links.length; i++) {
    out.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
  }
  return out;
}

/** 必应 HTML 结果解析:每个结果在 <li class="b_algo"> 内,<h2><a href>标题</a></h2> + <p>摘要</p> */
function parseBingHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html))) {
    const block = m[0];
    const a = block.match(/<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/);
    if (!a) continue;
    const url = a[1];
    if (!url.startsWith("http")) continue;
    const title = htmlToText(a[2]).slice(0, 200);
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = p ? htmlToText(p[1]).slice(0, 300) : "";
    out.push({ title, url, snippet });
    if (out.length >= 8) break;
  }
  return out;
}

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
