import type { ModelConfig } from "../../shared/types";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai";
import type { ChatProvider } from "./types";

const DEFAULT_URLS: Record<ModelConfig["kind"], string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  ollama: "http://localhost:11434/v1",
};

/** 根据配置创建 Provider。Ollama 走 OpenAI 兼容端点。 */
export function createProvider(cfg: ModelConfig): ChatProvider {
  const baseUrl = (cfg.baseUrl || DEFAULT_URLS[cfg.kind]).replace(/\/$/, "");
  switch (cfg.kind) {
    case "anthropic":
      return new AnthropicProvider(baseUrl, cfg.apiKey ?? "", cfg.model);
    case "ollama":
      return new OpenAICompatibleProvider(baseUrl, cfg.apiKey || undefined, cfg.model);
    case "openai":
    default:
      return new OpenAICompatibleProvider(baseUrl, cfg.apiKey, cfg.model, {}, cfg.disableThinking === true);
  }
}
