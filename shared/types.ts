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
  type: "text" | "tool" | "thinking" | "image";
  text?: string;
  tool?: ToolCallPart;
  /** 图片附件:file 为相对数据目录的文件路径;desc 为辅助视觉模型生成的描述(缓存) */
  image?: { file: string; mime: string; desc?: string };
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: Role;
  parts: MessagePart[];
  createdAt: number;
  model?: string;
  /** 发言人格 id(assistant 消息;群聊时用于区分是谁说的) */
  agentId?: string;
  error?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** AI 自动摘要:早期对话的压缩,发送时注入给模型,兼顾速度与连续性 */
  summary?: string;
  /** 生成摘要时的消息总数(用于判断是否需要更新) */
  summaryCount?: number;
  /** 世界观设定文档:由 AI 维护的长篇设定(人物/世界观/关系),不随会话滚动丢失 */
  lore?: string;
  /** 世界观历史版本(回退用,最多 5 版) */
  loreHistory?: string[];
  /** 群聊成员(多个人格同场登场);空 = 单人模式(agentId) */
  groupAgents?: string[];
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
  /** 独立记忆空间:开启后记忆读写只走该人格自己的库,不与他人格共享 */
  isolatedMemory?: boolean;
}

export type ProviderKind = "openai" | "anthropic" | "ollama";

export interface ModelConfig {
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  label?: string;
  /** 关闭模型思考模式(DeepSeek V3.2+/V4 等支持;开启后首字更快,但无思考过程) */
  disableThinking?: boolean;
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
  /** 视觉辅助模型:纯文本主模型时,把图片交给这个多模态 provider 转成文字描述(空=直接传图给主模型) */
  visionProvider?: string;
  /** 朗读(TTS)配置:system=系统语音(可选手音),api=OpenAI 兼容 TTS 端点(含自己的克隆服务) */
  tts?: {
    mode: "system" | "api";
    systemVoice?: string;
    apiBaseUrl?: string;
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  /** 历史思考回传策略:DeepSeek thinking 要求回传 reasoning_content;all=全量,recent5=仅最近 5 条完整(更快,可能报错),off=不回传(最快,可能报错) */
  thinkingEcho?: "all" | "recent5" | "off";
  /** 自动摘要长上下文:会话过长时用 AI 把早期对话压成摘要,发送时注入(默认开启) */
  autoSummarize?: boolean;
  /** 局域网访问:开启后手机/其他设备可通过本机 IP 访问聊天(需重启生效) */
  lanAccess?: boolean;
  /** 剧情选项分支:回复完成后 AI 生成 2-3 个下一步选项(默认开启) */
  enableOptions?: boolean;
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
  /** 图片附件(相对数据目录的文件路径) */
  attachments?: { file: string; mime: string }[];
}

export type StreamEvent =
  | { type: "session_created"; session: SessionMeta }
  /** 一条 assistant 消息开始流式输出(带真实消息 id;群聊时每条人格消息各发一次) */
  | { type: "message_start"; message: { id: string; agentId?: string } }
  | { type: "delta"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_start"; tool: ToolCallPart }
  | { type: "tool_end"; tool: ToolCallPart }
  | { type: "done"; message: ChatMessage; session: SessionMeta }
  | { type: "error"; message: string }
  /** 剧情选项分支:回复完成后 AI 给出的下一步选项 */
  | { type: "options"; sessionId: string; options: string[] }
  /** 定时任务执行完成(桌面通知) */
  | { type: "task_done"; taskName: string; ok: boolean; result: string };

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
