import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTools } from "../server/tools/files";
import type { ToolContext } from "../server/tools/registry";

/** search_files:本地全文搜索(Obsidian 库/笔记库定位用) */
describe("search_files 本地全文搜索", () => {
  let dir: string;
  const ctx: ToolContext = {
    cwd: "",
    allowedWriteDirs: [],
    dataDir: "",
    env: {},
    memory: null,
  };
  const tool = fileTools.find((t) => t.name === "search_files")!;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hana-search-files-"));
    mkdirSync(join(dir, "日记"), { recursive: true });
    writeFileSync(join(dir, "日记", "2026-08-11.md"), "# 今天的日记\n\n今天和璇玑聊了 Obsidian 的搭配,\n晚上吃了饺子。\n", "utf8");
    writeFileSync(join(dir, "日记", "2026-08-10.md"), "# 昨天的日记\n\n下雨,没出门。\n", "utf8");
    writeFileSync(join(dir, "读书笔记.md"), "《小王子》——重要的东西用眼睛是看不见的。\n", "utf8");
    ctx.cwd = dir;
  });

  afterAll(() => {
    // rmSync(dir, { recursive: true, force: true });
  });

  it("按内容命中并给出文件+行号", async () => {
    const r = await tool.run({ query: "饺子" }, ctx);
    expect(r).toContain("2026-08-11.md");
    expect(r).toContain(":4"); // 第 4 行命中
    expect(r).toContain("晚上吃了饺子");
  });

  it("跨子目录搜索(日记文件夹)", async () => {
    const r = await tool.run({ query: "下雨" }, ctx);
    expect(r).toContain("2026-08-10.md");
  });

  it("多关键词无关时返回未找到", async () => {
    const r = await tool.run({ query: "不存在的词xyz" }, ctx);
    expect(r).toContain("没有找到");
  });

  it("nameOnly 只匹配文件名", async () => {
    const r = await tool.run({ query: "读书", nameOnly: true }, ctx);
    // 文件名命中(读书笔记.md),内容里没有"读书"二字
    expect(r).toContain("读书笔记.md");
  });

  it("缺关键词报错", async () => {
    await expect(tool.run({}, ctx)).rejects.toThrow();
  });
});
