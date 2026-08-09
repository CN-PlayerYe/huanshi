import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { MemoryConfig } from "../../shared/types";
import type { LocalMemory } from "./local";
import type { MemoryBackend, MemoryItem, MemoryKind } from "./service";

/**
 * Hindsight 记忆后端(Vectorize.io 语义记忆系统)。
 * 通过官方 @vectorize-io/hindsight-client 连接本地 daemon(http://localhost:8888)或 Cloud。
 * 连接失败时自动回退到本地记忆,保证离线可用。
 */
export class HindsightMemory implements MemoryBackend {
  readonly label = "hindsight";

  private client: HindsightClient;
  private bankReady = false;

  constructor(
    private cfg: MemoryConfig,
    private fallback: LocalMemory,
    private bankIdOverride?: string,
  ) {
    this.client = new HindsightClient({
      baseUrl: cfg.hindsightBaseUrl || "http://localhost:8888",
      ...(cfg.hindsightApiKey ? { apiKey: cfg.hindsightApiKey } : {}),
    });
  }

  private get bankId(): string {
    const base = this.cfg.hindsightBankId || "hanalite";
    return this.bankIdOverride ?? base;
  }

  private async ensureBank(): Promise<void> {
    if (this.bankReady) return;
    try {
      await this.client.createBank(this.bankId, {
        name: this.bankIdOverride ? `HanaLite-${this.bankIdOverride}` : "HanaLite",
        mission:
          "You are a personal AI assistant's long-term memory. Track the user's preferences, facts, and conversation history so future interactions feel continuous and personal.",
      });
    } catch {
      // bank 已存在或服务不可用,忽略
    }
    this.bankReady = true;
  }

  async recall(query: string, limit = 8): Promise<MemoryItem[]> {
    try {
      await this.ensureBank();
      const res = await this.client.recall(this.bankId, query, {
        maxTokens: Math.min(limit * 200, 1600),
      });
      const results = (res?.results ?? []).slice(0, limit);
      if (results.length) {
        return results.map((r, i) => ({
          id: `hs_${i}`,
          content: String(r.text ?? ""),
          kind: (r.type === "world" || r.type === "observation" ? "fact" : "experience") as MemoryKind,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }));
      }
    } catch (err) {
      console.warn("[memory] Hindsight recall 失败,回退本地:", (err as Error).message);
    }
    return this.fallback.recall(query, limit);
  }

  async retain(content: string, kind: MemoryKind): Promise<void> {
    try {
      await this.ensureBank();
      await this.client.retain(this.bankId, content, {
        context: kind === "fact" ? "user preference or fact" : "conversation experience",
        async: true,
      });
      return;
    } catch (err) {
      console.warn("[memory] Hindsight retain 失败,回退本地:", (err as Error).message);
    }
    await this.fallback.retain(content, kind);
  }

  async reflect(): Promise<string> {
    try {
      await this.ensureBank();
      const answer = await this.client.reflect(
        this.bankId,
        "Summarize the most important things I should remember about the user, and reflect on recent experiences.",
        { budget: "mid" },
      );
      return String(answer?.text ?? "");
    } catch (err) {
      console.warn("[memory] Hindsight reflect 失败,回退本地:", (err as Error).message);
    }
    return this.fallback.reflect();
  }

  async isHealthy(): Promise<boolean> {
    try {
      const version = await this.client.getVersion();
      return Boolean(version);
    } catch {
      return false;
    }
  }

  async stats(): Promise<{ facts: number; experiences: number }> {
    return this.fallback.stats();
  }

  async list(): Promise<MemoryItem[]> {
    return this.fallback.list();
  }

  async updateItem(id: string, patch: { content?: string; tag?: "fact" | "inference" | null }): Promise<void> {
    await this.fallback.updateItem(id, patch);
  }

  async deleteItem(id: string): Promise<void> {
    await this.fallback.deleteItem(id);
  }

  clear(): void {
    // 云端记忆不易批量清空,仅清本地回退;如需清云端可删除 bank 重建
    this.fallback.clear();
  }
}
