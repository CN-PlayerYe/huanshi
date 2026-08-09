import {
  ProviderError,
  sseLines,
  type ChatProvider,
  type ChatRequest,
  type ChatStreamChunk,
  type ProviderMsg,
  type ProviderToolCall,
} from "./types";

const ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic Messages API Provider(支持 tool use) */
export class AnthropicProvider implements ChatProvider {
  readonly kind = "anthropic";
  readonly model: string;

  constructor(
    public readonly baseUrl: string,
    private readonly apiKey: string,
    model: string,
  ) {
    this.model = model;
  }

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamChunk> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/messages`;
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        system,
        messages: toAnthropicMessages(req.messages),
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
        stream: true,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.7,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(`模型请求失败(HTTP ${res.status}): ${body.slice(0, 500)}`, res.status, body);
    }
    if (!res.body) throw new ProviderError("响应无 body");

    // tool_use 累计:index -> { id, name, inputJson }
    const toolAcc = new Map<number, { id: string; name: string; inputJson: string }>();
    let finishReason: ChatStreamChunk["finishReason"];
    let usage: { input: number; output: number } | undefined;

    for await (const line of sseLines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "content_block_start": {
          const cb = ev.content_block;
          if (cb?.type === "text" && cb.text) {
            yield { delta: cb.text };
          } else if (cb?.type === "tool_use") {
            toolAcc.set(ev.index, { id: cb.id, name: cb.name, inputJson: cb.input ? JSON.stringify(cb.input) : "" });
          } else if (cb?.type === "thinking" && cb.thinking) {
            yield { thinking: cb.thinking };
          }
          break;
        }
        case "content_block_delta": {
          const d = ev.delta;
          if (d?.type === "text_delta" && d.text) {
            yield { delta: d.text };
          } else if (d?.type === "input_json_delta" && d.partial_json) {
            const cur = toolAcc.get(ev.index);
            if (cur) cur.inputJson += d.partial_json;
          } else if (d?.type === "thinking_delta" && d.thinking) {
            yield { thinking: d.thinking };
          }
          break;
        }
        case "message_delta": {
          if (ev.delta?.stop_reason) {
            finishReason = ev.delta.stop_reason === "tool_use" ? "tool_calls" : ev.delta.stop_reason === "max_tokens" ? "length" : "stop";
          }
          if (ev.usage) {
            usage = { input: ev.usage.input_tokens ?? 0, output: ev.usage.output_tokens ?? 0 };
          }
          break;
        }
        default:
          break;
      }
    }

    if (toolAcc.size > 0) {
      const calls: ProviderToolCall[] = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => {
          let args = v.inputJson;
          if (!args) args = "{}";
          try {
            JSON.parse(args);
          } catch {
            args = "{}";
          }
          return { id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: v.name, arguments: args };
        });
      yield { toolCalls: calls };
    }
    if (finishReason) yield { finishReason };
    if (usage) yield { usage };
  }
}

/** 内部消息 → Anthropic 消息(把连续的 tool 消息聚合成 user 消息的 tool_result 块) */
export function toAnthropicMessages(msgs: ProviderMsg[]): any[] {
  const out: any[] = [];
  let pendingTools: { toolCallId: string; output: string }[] = [];

  const flushTools = () => {
    if (!pendingTools.length) return;
    out.push({
      role: "user",
      content: pendingTools.map((t) => ({
        type: "tool_result",
        tool_use_id: t.toolCallId,
        content: t.output,
      })),
    });
    pendingTools = [];
  };

  for (const m of msgs) {
    if (m.role === "system") {
      // system 由调用方放入 system 字段
      continue;
    } else if (m.role === "user") {
      flushTools();
      const images = (m.vision ?? []).filter((v) => v.type === "image_url");
      if (images.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        // 多模态:dataURL → base64 + media_type(Anthropic 图片格式)
        for (const v of images) {
          const m2 = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(v.image_url.url);
          if (m2) content.push({ type: "image", source: { type: "base64", media_type: m2[1], data: m2[2] } });
        }
        out.push({ role: "user", content });
      } else {
        out.push({ role: "user", content: m.content || "" });
      }
    } else if (m.role === "tool") {
      pendingTools.push({ toolCallId: m.toolCallId ?? "", output: m.content });
    } else if (m.role === "assistant") {
      flushTools();
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParse(tc.arguments) });
      }
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
    }
  }
  flushTools();
  return out;
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
