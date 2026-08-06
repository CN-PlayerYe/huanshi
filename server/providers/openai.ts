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
    private readonly disableThinking = false,
  ) {
    this.model = model;
    this._apiKey = apiKey ?? "";
  }
  private readonly _apiKey: string;

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamChunk> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const buildBody = () =>
      JSON.stringify({
        model: this.model,
        messages: req.messages.map(toOpenAIMessage),
        tools: req.tools.length ? req.tools.map(toOpenAITool) : undefined,
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature ?? 0.7,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        // 关闭思考模式(DeepSeek V3.2+/V4):模型不再“先想后答”,首字大幅提速
        ...(this.disableThinking ? { thinking: { type: "disabled" } } : {}),
      });

    // 400 偶发重试一次(模型端偶发解析失败/传输损坏时,重试往往成功)
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(this._apiKey ? { Authorization: `Bearer ${this._apiKey}` } : {}),
          ...this.extraHeaders,
        },
        body: buildBody(),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 400 && attempt === 0) {
          // 400 偶发解析失败:原样重试一次
          continue;
        }
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
      return;
    }
  }
}

/**
 * 加固"残缺的 \\u 字面序列":文本里字面 `\u` 后跟非 4 位 hex(如 Windows 路径 `G:\u123x`、
 * 迁移的报错残留)时,模型端若对 content 二次 JSON 解析会报 "unexpected end of hex escape"。
 * 把这类反斜杠翻倍(`\u` → `\\u`),经过 JSON 两次解析后仍显示为单个 `\`,但不再触发解析错误。
 */
function hardenEscape(text: string): string {
  return text.replace(/\\(?=u(?![\da-fA-F]{4}))/g, "\\\\");
}

function toOpenAIMessage(m: ProviderMsg) {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: hardenEscape(m.content) };
  }
  const base: any = { role: m.role };
  // 多模态:vision 块优先(图片 + 文本);否则纯文本
  if (m.vision?.length) {
    base.content = [
      ...(m.content ? [{ type: "text", text: hardenEscape(m.content) }] : []),
      ...m.vision.map((v) => (v.type === "image_url" ? { type: "image_url", image_url: { url: v.image_url.url } } : { type: "text", text: hardenEscape(v.text) })),
    ];
  } else {
    base.content = m.content ? hardenEscape(m.content) : null;
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    base.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: hardenEscape(tc.arguments) },
    }));
  }
  // DeepSeek thinking 模式:历史 assistant 的思考必须原样回传,否则 400
  if (m.role === "assistant" && m.reasoningContent) {
    base.reasoning_content = hardenEscape(m.reasoningContent);
  }
  return base;
}

function toOpenAITool(t: { name: string; description: string; parameters: Record<string, unknown> }) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}
