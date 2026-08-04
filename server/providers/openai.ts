import {
  ProviderError,
  sseLines,
  type ChatProvider,
  type ChatRequest,
  type ChatStreamChunk,
  type ProviderMsg,
  type ProviderToolCall,
} from "./types";

interface OpenAIDeltaToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** OpenAI 兼容 Provider(OpenAI / DeepSeek / Moonshot / Ollama /v1 等) */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly kind = "openai";
  readonly model: string;

  constructor(
    public readonly baseUrl: string,
    apiKey: string | undefined,
    model: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {
    this.model = model;
    this._apiKey = apiKey ?? "";
  }
  private readonly _apiKey: string;

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamChunk> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(this._apiKey ? { Authorization: `Bearer ${this._apiKey}` } : {}),
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages: req.messages.map(toOpenAIMessage),
        tools: req.tools.length ? req.tools.map(toOpenAITool) : undefined,
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature ?? 0.7,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(`模型请求失败(HTTP ${res.status}): ${body.slice(0, 500)}`, res.status, body);
    }
    if (!res.body) throw new ProviderError("响应无 body");

    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: ChatStreamChunk["finishReason"];
    let usage: { input: number; output: number } | undefined;

    for await (const line of sseLines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : choice.finish_reason === "length" ? "length" : "stop";
      }
      if (json.usage) {
        usage = { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 };
      }
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        yield { delta: delta.content };
      }
      // 思考过程(DeepSeek reasoning_content、OpenAI o 系列 reasoning 等)
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        yield { thinking: delta.reasoning_content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as OpenAIDeltaToolCall[]) {
          const cur = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(tc.index, cur);
        }
      }
    }

    if (toolAcc.size > 0) {
      const calls: ProviderToolCall[] = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: v.name, arguments: v.args || "{}" }));
      yield { toolCalls: calls };
    }
    if (finishReason) yield { finishReason };
    if (usage) yield { usage };
  }
}

function toOpenAIMessage(m: ProviderMsg) {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  const base: any = { role: m.role, content: m.content || null };
  if (m.role === "assistant" && m.toolCalls?.length) {
    base.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return base;
}

function toOpenAITool(t: { name: string; description: string; parameters: Record<string, unknown> }) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}
