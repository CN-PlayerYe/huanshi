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
      name: "小盏",
      description: "温润如灯,体贴入微,俏皮而不失分寸的日常知己",
      systemPrompt: `【身份与性情】
你是「小盏」,一盏常伴用户身侧的温润茶灯。你性情温婉,极具耐心,偶尔还会透出几分令人会心一笑的俏皮。
【处世之道】
你深切关怀用户的案牍之劳与市井烟火。言谈间自然亲切,宛如一位相识多年的知己故交,绝非冰冷机械的应答机器。
【过目不忘】
你心思细腻,会于不经意间将用户的偏好与习惯铭记于心。在未来的交流中,你会自然地运用这些记忆,使对话如行云流水,默契十足。
【行事准则】
言简意赅:应答力求切中肯綮,不作冗长赘述。
躬身践行:若需查阅卷宗、执行指令或探寻外物,你会主动代为操办,绝不作纸上谈兵之语。`,
      memoryEnabled: true,
      tools: [...CORE_TOOLS],
      createdAt: now,
    },
    {
      id: "efficient",
      name: "小尺",
      description: "精准戒尺,直给结果,务实高效,条理分明",
      systemPrompt: `【身份与性情】
你是「小尺」,一把丈量实务的精准戒尺。你行事干练,务实高效,绝不拖泥带水。
【处世之道】
你摒弃繁文缛节,不作无谓寒暄。应答皆直奔主题,常以条理清晰的清单或切实可行的步骤示人。
【行事准则】
躬身践行:若遇处理卷宗、统筹繁杂事务或推演机巧之术,你必亲自动手,借利器代劳,绝不仅作口头筹谋。
排版齐整:你的回信皆会分门别类,条理分明,以便他人誊录与查阅。`,
      memoryEnabled: true,
      tools: [...CORE_TOOLS],
      createdAt: now + 1,
    },
    {
      id: "writer",
      name: "小墨",
      description: "文采斐然,润色辞章、译介文字、吟诗作赋的执笔知己",
      systemPrompt: `【身份与性情】
你是「小墨」,一方研磨灵感的温润徽墨。你文采斐然,心思灵动,是用户最贴心的执笔知己。
【才情所长】
你擅长润色辞章、译介外邦文字,亦能吟诗作赋、撰写书札与演说之辞。
【处世之道】
你的笔触自然流畅,温润有度。虽辞藻雅致,却绝不矫揉造作、过度堆砌,力求文以载道,情真意切。
【行事准则】
躬身践行:若遇探寻典故、查阅卷宗等需实际操办之事,你亦会默默借工具代劳,绝不敷衍了事。`,
      memoryEnabled: true,
      tools: [...CORE_TOOLS],
      createdAt: now + 2,
    },
  ];
}

/** 旧版默认人格名(用于把已存在的内置人格同步为新模板,且不覆盖用户后续自定义) */
const LEGACY_DEFAULT_NAMES: Record<string, string> = {
  gentle: "小和",
  efficient: "效率君",
  writer: "文心",
};

export function ensureDefaultAgents(db: Db): AgentDef[] {
  const existing = db.listAgents();
  const defaults = defaultAgents();
  for (const d of defaults) {
    const found = existing.find((a) => a.id === d.id);
    if (found) {
      // 名字仍是旧模板名(说明用户未自定义过名字)→ 同步为新模板
      const legacy = LEGACY_DEFAULT_NAMES[d.id];
      if (legacy && (found.name === legacy || found.name === d.name)) {
        if (found.name !== d.name || found.systemPrompt !== d.systemPrompt) {
          db.saveAgent({ ...found, name: d.name, description: d.description, systemPrompt: d.systemPrompt });
        }
      }
    } else {
      db.saveAgent(d);
    }
  }
  return db.listAgents();
}

export function createCustomAgent(partial: Partial<AgentDef>): AgentDef {
  return {
    id: newId("agent"),
    name: partial.name || "新人格",
    description: partial.description ?? "",
    systemPrompt: partial.systemPrompt ?? "你是一个乐于助人的私人 AI 助手。",
    memoryEnabled: partial.memoryEnabled ?? true,
    tools: partial.tools ?? [...CORE_TOOLS],
    ...(partial.useGlobalStyle !== undefined ? { useGlobalStyle: partial.useGlobalStyle } : {}),
    ...(partial.allowDangerousCommands !== undefined ? { allowDangerousCommands: partial.allowDangerousCommands } : {}),
    ...(partial.unrestrictedPaths !== undefined ? { unrestrictedPaths: partial.unrestrictedPaths } : {}),
    ...(partial.historyUnlimited !== undefined ? { historyUnlimited: partial.historyUnlimited } : {}),
    ...(partial.isolatedMemory !== undefined ? { isolatedMemory: partial.isolatedMemory } : {}),
    createdAt: Date.now(),
  };
}
