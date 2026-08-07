import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../../shared/types";
import type { MemoryBackend, MemoryItem, MemoryKind } from "./service";

const FACTS_FILE = "facts.json";
const EXPERIENCES_FILE = "experiences.json";

/** 本地 JSON 记忆:关键词召回 + 去重保留。无外部依赖,离线可用。 */
export class LocalMemory implements MemoryBackend {
  readonly label = "local";

  private facts: MemoryItem[] = [];
  private experiences: MemoryItem[] = [];

  constructor(
    private dir: string,
    private caps?: { experienceCap?: number; factCap?: number },
  ) {
    mkdirSync(dir, { recursive: true });
    this.facts = this.load(FACTS_FILE);
    this.experiences = this.load(EXPERIENCES_FILE);
  }

  private load(file: string): MemoryItem[] {
    const p = join(this.dir, file);
    if (!existsSync(p)) return [];
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  private save(file: string, items: MemoryItem[]): void {
    writeFileSync(join(this.dir, file), JSON.stringify(items, null, 2), "utf-8");
  }

  private all(): MemoryItem[] {
    return [...this.facts, ...this.experiences];
  }

  async recall(query: string, limit = 8): Promise<MemoryItem[]> {
    // 空查询 = 返回最近的经历(按更新时间倒序)
    if (!query.trim()) {
      return this.all()
        .filter((i) => i.kind === "experience")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    }
    const tokens = query
      .toLowerCase()
      .split(/[\s,。，、;；:：!！?？"'()\[\]{}]+/)
      .filter((t) => t.length >= 2);
    const scored = this.all().map((item) => {
      const text = item.content.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (text.includes(t)) score += t.length;
      }
      if (query.length >= 4 && text.includes(query.toLowerCase())) score += 10;
      return { item, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, limit)
      .map((s) => s.item);
  }

  async retain(content: string, kind: MemoryKind): Promise<void> {
    const target = kind === "fact" ? this.facts : this.experiences;
    // 去重:与已有条目内容相同或高度相似则更新时间戳
    const existing = target.find((i) => i.content === content || (content.length > 40 && i.content.includes(content.slice(0, 40))));
    if (existing) {
      existing.updatedAt = Date.now();
    } else {
      target.push({ id: newId("mem"), content, kind, createdAt: Date.now(), updatedAt: Date.now() });
    }
    // 控制上限(0 = 无限)
    const cap = kind === "fact" ? (this.caps?.factCap ?? 500) : (this.caps?.experienceCap ?? 2000);
    if (cap > 0 && target.length > cap) target.splice(0, target.length - cap);
    this.save(kind === "fact" ? FACTS_FILE : EXPERIENCES_FILE, target);
  }

  async reflect(): Promise<string> {
    const recent = [...this.experiences].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
    if (!recent.length) return "还没有足够的经历可以反思。";
    return `最近经历概览:\n${recent.map((e) => `- ${e.content}`).join("\n")}`;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async stats(): Promise<{ facts: number; experiences: number }> {
    return { facts: this.facts.length, experiences: this.experiences.length };
  }

  async list(): Promise<MemoryItem[]> {
    return [...this.facts, ...this.experiences];
  }

  async updateItem(id: string, patch: { content?: string; tag?: "fact" | "inference" | null }): Promise<void> {
    const findAndUpdate = (items: MemoryItem[], file: string): boolean => {
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) return false;
      if (patch.content !== undefined) items[idx].content = patch.content;
      if (patch.tag !== undefined) items[idx].tag = patch.tag ?? undefined;
      items[idx].updatedAt = Date.now();
      this.save(file, items);
      return true;
    };
    if (findAndUpdate(this.facts, FACTS_FILE)) return;
    findAndUpdate(this.experiences, EXPERIENCES_FILE);
  }

  async deleteItem(id: string): Promise<void> {
    const drop = (items: MemoryItem[], file: string, assign: (next: MemoryItem[]) => void): boolean => {
      const next = items.filter((i) => i.id !== id);
      if (next.length === items.length) return false;
      assign(next); // 同步内存,否则 list() 仍读到旧数据
      this.save(file, next);
      return true;
    };
    if (drop(this.facts, FACTS_FILE, (n) => (this.facts = n))) return;
    drop(this.experiences, EXPERIENCES_FILE, (n) => (this.experiences = n));
  }

  clear(): void {
    this.facts = [];
    this.experiences = [];
    this.save(FACTS_FILE, []);
    this.save(EXPERIENCES_FILE, []);
  }
}
