// 一次性脚本:把 server/electron/tests 里的 `@shared/types` 别名导入改写为相对路径,
// 使 tsc 编译产物(CJS)可以直接运行,无需运行时别名解析。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const targets = ["server", "electron", "tests"];
const files = [];
for (const t of targets) {
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(root, t));
}

let changed = 0;
for (const f of files) {
  const src = readFileSync(f, "utf-8");
  if (!src.includes('@shared/types')) continue;
  const dir = dirname(f);
  let rel = relative(dir, root);
  if (!rel) rel = ".";
  const relPath = rel.split(sep).join("/") + "/shared/types";
  const next = src.replaceAll('from "@shared/types"', `from "${relPath}"`);
  writeFileSync(f, next);
  changed++;
  console.log(`rewrote ${f.replace(root + sep, "")} -> ${relPath}`);
}
console.log(`done, ${changed} files rewritten`);
