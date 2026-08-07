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
    const buildBody = (msgs: ProviderMsg[]) =>
      JSON.stringify({
        model: this.model,
        messages: msgs.map(toOpenAIMessage),
        tools: req.tools.length ? req.tools.map(toOpenAITool) : undefined,
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature ?? 0.7,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        // 关闭思考模式(DeepSeek V3.2+/V4):模型不再“先想后答”,首字大幅提速
        ...(this.disableThinking ? { thinking: { type: "disabled" } } : {}),
      });

    // 请求体过大(超长会话 + 思考全量回传)会传输截断/模型端解析失败:自动压缩
    let msgs = sanitizeToolMessages(req.messages);
    let body = buildBody(msgs);
    if (Buffer.byteLength(body) > 512 * 1024) {
      msgs = shrinkMessages(msgs);
      body = buildBody(msgs);
    }

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
        body,
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
export function hardenEscape(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)\\(?=u(?![\da-fA-F]{4}))/g, (_m, pre, pairs) => pre + pairs + "\\\\");
}

/**
 * 请求体压缩:超长会话(historyUnlimited 全量历史 + 思考全量回传)会生成 >100KB 的请求体,
 * 导致传输截断或模型端解析失败(HTTP 400 "unexpected end of hex escape")。
 * 策略:先压缩思考回传(500 字符足够),再截断正文,最后从最旧开始丢消息(保留最近 8 条)。
 */
/**
 * 兜底清理:删除"前面没有带 tool_calls 的 assistant"的孤立 tool 消息。
 * 无论历史结构多乱(迁移数据、压缩丢消息),都能保证 tool 消息永远有前置 assistant(tool_calls)。
 */
export function sanitizeToolMessages(msgs: ProviderMsg[]): ProviderMsg[] {
  const out: ProviderMsg[] = [];
  let lastHadToolCalls = false;
  for (const m of msgs) {
    if (m.role === "tool") {
      if (lastHadToolCalls) out.push(m);
      continue;
    }
    out.push(m);
    lastHadToolCalls = m.role === "assistant" && !!m.toolCalls?.length;
  }
  return out;
}

export function shrinkMessages(msgs: ProviderMsg[]): ProviderMsg[] {
  // 压缩策略:思考回传(纯开销、非记忆,通常占请求体大半)优先删除 → 正文保持完整(记忆本体)
  let m = msgs;
  let len = Buffer.byteLength(JSON.stringify(m));
  if (len > 512 * 1024) {
    // 思考回传是大头且非记忆:最近 3 条保留(截断 500 字符),更早全删;正文不动
    m = m.map((x, i) => {
      if (!x.reasoningContent) return x;
      const rankFromEnd = m.length - i;
      return rankFromEnd <= 3 ? { ...x, reasoningContent: x.reasoningContent.slice(0, 500) } : { ...x, reasoningContent: undefined };
    });
    len = Buffer.byteLength(JSON.stringify(m));
  }
  if (len > 512 * 1024) {
    // 工具输出同样非记忆:截断到 300 字符
    m = m.map((x) => (x.role === "tool" && x.content.length > 300 ? { ...x, content: `${x.content.slice(0, 300)}…` } : x));
    len = Buffer.byteLength(JSON.stringify(m));
  }
  let dropped = 0;
  while (len > 512 * 1024 && m.length > 30 && dropped < 400) {
    // 从最旧开始丢,以 user 消息为边界(user 及其之前全部丢掉),避免孤立 tool
    const firstUser = m.findIndex((x) => x.role === "user");
    if (firstUser < 0) break;
    m = m.slice(firstUser + 1);
    len = Buffer.byteLength(JSON.stringify(m));
    dropped += firstUser + 1;
  }
  return sanitizeToolMessages(m);
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
