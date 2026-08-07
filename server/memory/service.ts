import { join } from "node:path";
import type { MemoryConfig } from "../../shared/types";
import { HindsightMemory } from "./hindsight";
import { LocalMemory } from "./local";

export type MemoryKind = "fact" | "experience" | "summary";

export interface MemoryItem {
  id: string;
  content: string;
  kind: MemoryKind;
  /** 用户可修订的标注:fact=事实 / inference=推断;未标注时由 kind 推导展示 */
  tag?: "fact" | "inference";
  createdAt: number;
  updatedAt: number;
}

export interface MemoryBackend {
  readonly label: string;
  recall(query: string, limit?: number): Promise<MemoryItem[]>;
  retain(content: string, kind: MemoryKind): Promise<void>;
  reflect(bankId?: string): Promise<string>;
  /** 列出全部记忆(用于导出/备份) */
  list(): Promise<MemoryItem[]>;
  /** 修订一条记忆(内容/标注);不存在则忽略 */
  updateItem(id: string, patch: { content?: string; tag?: "fact" | "inference" | null }): Promise<void>;
  /** 删除一条记忆 */
  deleteItem(id: string): Promise<void>;
  isHealthy(): Promise<boolean>;
  stats(): Promise<{ facts: number; experiences: number }>;
  clear(): void;
}

/**
 * 记忆服务:优先使用 Hindsight(向量语义记忆),未配置或不可用时回退到本地记忆。
 * 提供 retain(记住)/ recall(回忆)/ reflect(反思总结)三个操作。
 *
 * 支持"独立记忆空间":所有方法可传入 agentId,当传入时读写只作用于该人格自己的库
 * (本地:memory/agents/<id>;Hindsight:独立 bank)。调用方仅在人格开启
 * isolatedMemory 时才传 agentId。
 */
export class MemoryService {
  private backend: MemoryBackend;
  /** 独立记忆空间缓存:<agentId, backend> */
  private agentBackends = new Map<string, MemoryBackend>();

  constructor(
    private cfg: MemoryConfig,
    dataDir: string,
  ) {
    const local = new LocalMemory(join(dataDir, "memory"), { experienceCap: cfg.experienceCap ?? 2000 });
    this.backend = cfg.mode === "hindsight" ? new HindsightMemory(cfg, local) : local;
    this.dataDir = dataDir;
  }

  private dataDir: string;

  /** 返回某人格的独立 backend(不存在则创建);agentId 为空时返回全局 backend */
  private backendFor(agentId?: string): MemoryBackend {
    if (!agentId) return this.backend;
    let b = this.agentBackends.get(agentId);
    if (!b) {
      const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const local = new LocalMemory(join(this.dataDir, "memory", "agents", safe), {
        experienceCap: this.cfg.experienceCap ?? 2000,
      });
      b = this.cfg.mode === "hindsight" ? new HindsightMemory(this.cfg, local, safe) : local;
      this.agentBackends.set(agentId, b);
    }
    return b;
  }

  get mode(): "local" | "hindsight" {
    return this.cfg.mode;
  }

  get backendLabel(): string {
    return this.backend.label;
  }

  async recall(query: string, limit = 8, agentId?: string): Promise<MemoryItem[]> {
    if (!this.cfg.localEnabled && this.cfg.mode === "local") return [];
    try {
      return await this.backendFor(agentId).recall(query, limit);
    } catch (err) {
      console.error("[memory] recall 失败:", err);
      return [];
    }
  }

  /** 最近的经历回顾(供新会话注入,让"记忆不断片") */
  async recentExperiences(limit = 5, agentId?: string): Promise<MemoryItem[]> {
    try {
      const items = await this.backendFor(agentId).recall("", limit);
      return items;
    } catch {
      return [];
    }
  }

  async retain(content: string, kind: MemoryKind = "experience", agentId?: string): Promise<void> {
    if (!content?.trim()) return;
    try {
      await this.backendFor(agentId).retain(content.slice(0, 8000), kind);
    } catch (err) {
      console.error("[memory] retain 失败:", err);
    }
  }

  async reflect(agentId?: string): Promise<string> {
    try {
      return await this.backendFor(agentId).reflect();
    } catch (err) {
      return `反思失败:${(err as Error).message}`;
    }
  }

  /** 本地记忆统计(条数)与清空 */
  stats(agentId?: string): Promise<{ facts: number; experiences: number }> {
    return this.backendFor(agentId).stats();
  }

  /** 列出全部记忆(用于人格卡片导出) */
  list(agentId?: string): Promise<MemoryItem[]> {
    return this.backendFor(agentId).list();
  }

  /** 修订一条记忆(内容/标注) */
  updateItem(id: string, patch: { content?: string; tag?: "fact" | "inference" | null }, agentId?: string): Promise<void> {
    return this.backendFor(agentId).updateItem(id, patch);
  }

  /** 删除一条记忆 */
  deleteItem(id: string, agentId?: string): Promise<void> {
    return this.backendFor(agentId).deleteItem(id);
  }

  clear(agentId?: string): void {
    this.backendFor(agentId).clear();
  }

  async status(): Promise<{ mode: string; backend: string; healthy: boolean }> {
    let healthy = true;
    try {
      healthy = await this.backend.isHealthy();
    } catch {
      healthy = false;
    }
    return { mode: this.mode, backend: this.backend.label, healthy };
  }
}
