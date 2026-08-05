// ===== 前后端共享类型契约 =====

export type Role = "user" | "assistant" | "system";

export interface ToolCallPart {
  id: string;
  name: string;
  input: string; // 工具入参(JSON 字符串)
  output?: string; // 工具输出
  status: "pending" | "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
}

export interface MessagePart {
  type: "text" | "tool" | "thinking";
  text?: string;
  tool?: ToolCallPart;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: Role;
  parts: MessagePart[];
  createdAt: number;
  model?: string;
  error?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  memoryEnabled: boolean;
  tools: string[];
  createdAt: number;
  /** 是否跟随全局风格设置;关闭=原生态人格,不使用风格注入 */
  useGlobalStyle?: boolean;
  /** 允许执行高危命令(该 Agent 拥有完整命令权限) */
  allowDangerousCommands?: boolean;
  /** 文件写入不受白名单限制(该 Agent 拥有完整文件权限) */
  unrestrictedPaths?: boolean;
  /** 历史上下文不限长度(默认 60 条) */
  historyUnlimited?: boolean;
}

export type ProviderKind = "openai" | "anthropic" | "ollama";

export interface ModelConfig {
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  label?: string;
}

export interface MemoryConfig {
  mode: "local" | "hindsight";
  hindsightBaseUrl: string;
  hindsightApiKey?: string;
  hindsightBankId: string;
  hindsightLlmProvider?: string;
  hindsightLlmApiKey?: string;
  localEnabled: boolean;
  /** 本地经历保留上限(0 = 无限) */
  experienceCap?: number;
}

export interface Settings {
  providers: Record<string, ModelConfig>;
  activeProvider: string;
  mainModel: string;
  smallModel: string;
  dataDir: string;
  memory: MemoryConfig;
  theme: "dark" | "light" | "ink";
  language: "zh-CN" | "en" | "ja" | "ko" | "zh-TW";
  toolWhitelistDir: string;
  /** 对话中是否显示思考过程(思考内容始终存档在消息里) */
  showThinking: boolean;
  /** 人格风格参数(语气/详略/幽默度) */
  style?: {
    tone?: "formal" | "casual" | "professional";
    detail?: "concise" | "balanced" | "detailed";
    humor?: number; // 0-5
  };
  /** 外观自定义(皮肤):强调色 / 背景图 / 界面透明度 */
  appearance?: {
    accent?: string;
    bgImage?: string;
    chatOpacity?: number;
    sidebarOpacity?: number;
    /** 整个窗口的透明度(0.1-1,可看到桌面) */
    windowOpacity?: number;
    /** 聊天气泡不透明度(0.3-1) */
    bubbleOpacity?: number;
  };
}

export interface SystemInfo {
  version: string;
  dataDir: string;
  portable: boolean;
  hindsightConnected: boolean;
  platform: string;
}

/** 定时任务 */
export interface TaskDef {
  id: string;
  name: string;
  prompt: string;
  schedule: string; // cron 表达式(分 时 日 月 星期)
  agentId: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastResult?: string;
  lastStatus?: "ok" | "error" | "running";
}

// ---- 流式聊天事件(SSE) ----

export interface ChatRequest {
  sessionId: string;
  content: string;
  agentId?: string;
}

export type StreamEvent =
  | { type: "session_created"; session: SessionMeta }
  | { type: "delta"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_start"; tool: ToolCallPart }
  | { type: "tool_end"; tool: ToolCallPart }
  | { type: "done"; message: ChatMessage; session: SessionMeta }
  | { type: "error"; message: string };

// ---- 默认值 ----

export const DEFAULT_SETTINGS: Settings = {
  providers: {},
  activeProvider: "",
  mainModel: "",
  smallModel: "",
  dataDir: "",
  memory: {
    mode: "local",
    hindsightBaseUrl: "http://localhost:8888",
    hindsightApiKey: "",
    hindsightBankId: "hanalite",
    hindsightLlmProvider: "anthropic",
    hindsightLlmApiKey: "",
    localEnabled: true,
    experienceCap: 2000,
  },
  theme: "ink",
  language: "zh-CN",
  toolWhitelistDir: "",
  showThinking: true,
  appearance: {},
  style: { tone: "casual", detail: "balanced", humor: 2 },
};

export function newId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
