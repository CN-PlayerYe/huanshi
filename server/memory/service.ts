import { join } from "node:path";
import type { MemoryConfig } from "../../shared/types";
import { HindsightMemory } from "./hindsight";
import { LocalMemory } from "./local";

export type MemoryKind = "fact" | "experience" | "summary";

export interface MemoryItem {
  id: string;
  content: string;
  kind: MemoryKind;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryBackend {
  readonly label: string;
  recall(query: string, limit?: number): Promise<MemoryItem[]>;
  retain(content: string, kind: MemoryKind): Promise<void>;
  reflect(bankId: string): Promise<string>;
  isHealthy(): Promise<boolean>;
}

/**
 * 记忆服务:优先使用 Hindsight(向量语义记忆),未配置或不可用时回退到本地记忆。
 * 提供 retain(记住)/ recall(回忆)/ reflect(反思总结)三个操作。
 */
export class MemoryService {
  private backend: MemoryBackend;

  constructor(
    private cfg: MemoryConfig,
    dataDir: string,
  ) {
    const local = new LocalMemory(join(dataDir, "memory"));
    this.backend = cfg.mode === "hindsight" ? new HindsightMemory(cfg, local) : local;
  }

  get mode(): "local" | "hindsight" {
    return this.cfg.mode;
  }

  get backendLabel(): string {
    return this.backend.label;
  }

  async recall(query: string, limit = 8): Promise<MemoryItem[]> {
    if (!this.cfg.localEnabled && this.cfg.mode === "local") return [];
    try {
      return await this.backend.recall(query, limit);
    } catch (err) {
      console.error("[memory] recall 失败:", err);
      return [];
    }
  }

  async retain(content: string, kind: MemoryKind = "experience"): Promise<void> {
    if (!content?.trim()) return;
    try {
      await this.backend.retain(content.slice(0, 8000), kind);
    } catch (err) {
      console.error("[memory] retain 失败:", err);
    }
  }

  async reflect(): Promise<string> {
    try {
      return await this.backend.reflect(this.cfg.hindsightBankId);
    } catch (err) {
      return `反思失败:${(err as Error).message}`;
    }
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
