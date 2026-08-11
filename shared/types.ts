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
  /** 隐藏(隐私保险):从所有列表消失,消息文件移出 db/ 到 .私藏/;设置里可恢复 */
  hidden?: boolean;
  /** AI 自动摘要:早期对话的压缩,发送时注入给模型,兼顾速度与连续性 */
  summary?: string;
  /** 最后一条消息的文本预览(侧栏显示用,心跳/后台任务新内容一眼可见) */
  lastPreview?: string;  /** 生成摘要时的消息总数(用于判断是否需要更新) */
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
  /** 人格级模型:provider id(如 "DeepSeek"),留空=跟随全局 activeProvider */
  provider?: string;
  /** 人格级模型名(如 "deepseek-v4-flash"),留空=跟随全局 mainModel */
  model?: string;
  /** 允许执行高危命令(该 Agent 拥有完整命令权限) */
  allowDangerousCommands?: boolean;
  /** 文件写入不受白名单限制(该 Agent 拥有完整文件权限) */
  unrestrictedPaths?: boolean;
  /** 历史上下文不限长度(默认 60 条,已并入 historyContextPct=100) */
  historyUnlimited?: boolean;
  /**
   * 历史上下文保留百分比(0-100):按估算 token 从最近的消息往回截取。
   * 100 = 全部历史(由 200 条 + 80KB 请求体兜底);null/undefined = 用 historyUnlimited 兼容旧配置。
   */
  historyContextPct?: number;
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
  /** 全局暂停心跳:主人可随时让所有心跳任务安静(默认开启心跳) */
  heartbeatPaused?: boolean;
  /** 请求体保命线上限(KB):请求体超过此值自动压缩,防止网关截断 400;
   *  默认 200;模型/网关支持超长上下文时可调大,0=不限制(超长可能 400,给长上下文模型用) */
  requestBodyLimitKB?: number;
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
  schedule: string; // cron 表达式(分 时 日 月 星期);kind=heartbeat 时忽略
  agentId: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastResult?: string;
  lastStatus?: "ok" | "error" | "running";
  /** 连续空跳次数(无自发产出),用于动态间隔翻倍 */
  blankBeats?: number;
  /** 心跳任务的固定会话(「💓 心跳日记」):每次心跳追加到同一会话,不产生碎片 */
  sessionId?: string;
  /** cron=定时任务(默认);heartbeat=心跳(自主醒来,消息由系统动态生成) */
  kind?: "cron" | "heartbeat";
  /** kind=heartbeat 时的节奏与安全边界配置 */
  heartbeat?: HeartbeatConfig;
}

/** 心跳配置:节奏 + 安全边界(自主活动的前提,均可调) */
export interface HeartbeatConfig {
  /** 心跳间隔小时,默认 3 */
  intervalHours?: number;
  /** 静默时段开始小时(0-23),默认 23 */
  quietStart?: number;
  /** 静默时段结束小时(0-23),默认 7 */
  quietEnd?: number;
  /** 睡前跳小时:该小时后的第一次心跳强制写日志,默认 21 */
  bedtimeHour?: number;
  /** 活动范围:仅自己空间 / 整个工作区 / 不限 */
  scope?: "self" | "workspace" | "global";
  /** 联网:禁止 / 只读(网页) / 允许 */
  network?: "off" | "readonly" | "allow";
  /** 命令:禁止 / 低危 / 允许 */
  commands?: "off" | "lowrisk" | "allow";
  /** 单次活动时长上限(分钟),默认 10,到点自动收工 */
  maxMinutes?: number;
  /** 主人发消息时是否立即打断(默认 true) */
  interruptible?: boolean;
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
  /** 请求体超限自动压缩(保命线):数据未删除,仅本次发送截断;提示用户可调整历史保留度 */
  | { type: "context_trimmed"; keptMessages: number; reason: string }
  /** 剧情选项分支:回复完成后 AI 给出的下一步选项 */
  | { type: "options"; sessionId: string; options: string[] }
  /** 定时任务执行完成(桌面通知);sessionId 用于心跳日记会话实时刷新 */
  | { type: "task_done"; taskName: string; ok: boolean; result: string; sessionId?: string };

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
