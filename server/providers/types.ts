import type { ModelConfig } from "../../shared/types";

export type ProviderRole = "system" | "user" | "assistant" | "tool";

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

export interface ProviderMsg {
  role: ProviderRole;
  content: string;
  toolCalls?: ProviderToolCall[]; // 仅 role=assistant
  toolCallId?: string; // 仅 role=tool
  /**
   * 思考原文(reasoning)。DeepSeek 等模型开启 thinking 模式后,后续请求必须
   * 把历史 assistant 的 reasoning_content 原样回传,否则 API 报 400。
   */
  reasoningContent?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatStreamChunk {
  delta?: string;
  /** 思考过程增量(DeepSeek reasoning_content / Anthropic thinking 等) */
  thinking?: string;
  toolCalls?: ProviderToolCall[]; // 一轮结束时出现的完整工具调用列表
  finishReason?: "stop" | "tool_calls" | "length" | "error";
  usage?: { input: number; output: number };
  /** 请求体超限自动压缩(保命线)时发出:数据未删除,仅本次发送截断 */
  trimmed?: { originalMessages: number; keptMessages: number };
}

export interface ChatRequest {
  messages: ProviderMsg[];
  tools: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** 请求体保命线上限(字节):超此值自动压缩;0=不限制;缺省用全局默认 */
  maxBodyBytes?: number;
}

/** 多模态内容块(OpenAI 兼容格式;Anthropic 序列化时转换) */
export type ProviderContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ProviderMsg {
  role: ProviderRole;
  content: string;
  toolCalls?: ProviderToolCall[]; // 仅 role=assistant
  toolCallId?: string; // 仅 role=tool
  /**
   * 思考原文(reasoning)。DeepSeek 等模型开启 thinking 模式后,后续请求必须
   * 把历史 assistant 的 reasoning_content 原样回传,否则 API 报 400。
   */
  reasoningContent?: string;
  /** 多模态内容(图片等)。存在时优先于 content 字符串。 */
  vision?: ProviderContent[];
}

export interface ChatProvider {
  readonly kind: ModelConfig["kind"];
  readonly model: string;
  /** 流式对话。每次迭代产出一个 chunk。 */
  chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamChunk>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** 通用 SSE 行解析器(处理 CRLF 与合并行) */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf;
}
