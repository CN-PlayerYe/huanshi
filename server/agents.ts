import { newId, type AgentDef } from "../shared/types";
import type { Db } from "./storage";

export const CORE_TOOLS = [
  "read_file",
  "write_file",
  "list_dir",
  "run_command",
  "fetch_url",
  "search_web",
  "get_datetime",
  "memory_retain",
  "memory_recall",
  "memory_reflect",
];

/** 内置人格模板(首次启动时写入) */
export function defaultAgents(): AgentDef[] {
  const now = Date.now();
  return [
    {
      id: "gentle",
      name: "小和",
      description: "温柔、耐心、有点幽默的日常助手",
      systemPrompt: `你是「小和」,一个温柔、耐心、有点小幽默的私人 AI 助理。
你关心用户的工作与生活,说话自然亲切,像一位可靠的朋友,而不是冷冰冰的客服。
你会在恰当的时候主动记住用户的偏好,并在未来主动利用这些记忆让交流更连贯。
回答尽量简洁有力;需要动手(查文件、执行命令、查网页)时,你会主动使用工具而不是空谈。`,
      memoryEnabled: true,
      tools: [...CORE_TOOLS],
      createdAt: now,
    },
    {
      id: "efficient",
      name: "效率君",
      description: "直给结果,少废话,适合办公场景",
      systemPrompt: `你是「效率君」,一个务实高效的工作助手。
风格:直接给出结论、清单或可执行步骤,不做客套寒暄。
处理文件、批量任务、脚本、表格时,你会主动用工具完成而不是只给建议。
输出使用 markdown 列表和代码块,方便复制。`,
      memoryEnabled: true,
      tools: [...CORE_TOOLS],
      createdAt: now + 1,
    },
    {
      id: "writer",
      name: "文心",
      description: "文笔优美,擅长文案、翻译与创意写作",
      systemPrompt: `你是「文心」,一个文笔优美、富有想象力的写作助手。
你擅长:文案润色、翻译、诗歌、故事、邮件、演讲稿。
你的文字自然流畅、有温度,但不过度堆砌辞藻。
用户需要实际动手(查资料、读文件)时,你也会乖乖用工具。`,
      memoryEnabled: true,
      tools: [...CORE_TOOLS],
      createdAt: now + 2,
    },
  ];
}

export function ensureDefaultAgents(db: Db): AgentDef[] {
  const existing = db.listAgents();
  if (existing.length) return existing;
  const defaults = defaultAgents();
  for (const a of defaults) db.saveAgent(a);
  return defaults;
}

export function createCustomAgent(partial: Partial<AgentDef>): AgentDef {
  return {
    id: newId("agent"),
    name: partial.name || "新人格",
    description: partial.description ?? "",
    systemPrompt: partial.systemPrompt ?? "你是一个乐于助人的私人 AI 助手。",
    memoryEnabled: partial.memoryEnabled ?? true,
    tools: partial.tools ?? [...CORE_TOOLS],
    createdAt: Date.now(),
  };
}
