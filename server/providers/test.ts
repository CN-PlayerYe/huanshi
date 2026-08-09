import type { ModelConfig } from "../../shared/types";

/** 常用模型提供商预设(一键填入) */
export interface ProviderPreset {
  key: string;
  label: string;
  kind: ModelConfig["kind"];
  baseUrl: string;
  defaultModel: string;
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { key: "deepseek", label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", hint: "国内直连,性价比高" },
  { key: "moonshot", label: "Moonshot Kimi", kind: "openai", baseUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k2.5-turbo", hint: "国内直连" },
  { key: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", hint: "需可访问的代理" },
  { key: "anthropic", label: "Anthropic Claude", kind: "anthropic", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-5", hint: "Claude 系列" },
  { key: "zhipu", label: "智谱 GLM", kind: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash", hint: "国内直连" },
  { key: "siliconflow", label: "硅基流动", kind: "openai", baseUrl: "https://api.siliconflow.cn/v1", defaultModel: "Qwen/Qwen2.5-7B-Instruct", hint: "国内直连,模型多" },
  { key: "doubao", label: "火山方舟豆包", kind: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "", hint: "国内直连" },
  { key: "ollama", label: "Ollama 本地", kind: "ollama", baseUrl: "http://localhost:11434/v1", defaultModel: "", hint: "本地模型,无需 API Key" },
];

/** 测试连接:发最小请求验证 baseUrl/Key/模型可用 */
export async function testProvider(cfg: ModelConfig): Promise<string> {
  const base = (cfg.baseUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("请先填写 Base URL");

  if (cfg.kind === "anthropic") {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model || "claude-sonnet-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return "连接成功 ✓";
  }

  // OpenAI 兼容(含 Ollama):GET /models 验证鉴权与连通性
  const res = await fetch(`${base}/models`, {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null;
  const count = data?.data?.length ?? 0;
  return count > 0 ? `连接成功 ✓(可访问 ${count} 个模型)` : "连接成功 ✓";
}

/** 拉取可用模型列表 */
export async function fetchModelList(cfg: ModelConfig): Promise<string[]> {
  const base = (cfg.baseUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("请先填写 Base URL");
  if (cfg.kind === "anthropic") {
    throw new Error("Anthropic 不提供模型列表接口,请手动输入模型名(如 claude-sonnet-4-5)");
  }
  const res = await fetch(`${base}/models`, {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const data = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null;
  const list = (data?.data ?? []).map((m) => m.id).filter(Boolean);
  if (!list.length) throw new Error("接口未返回模型列表,请手动填写模型名");
  return list.sort();
}
