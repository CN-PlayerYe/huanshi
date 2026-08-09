import type { MemoryService } from "../memory/service";
import type { Tool } from "./registry";

/** 记忆工具:让 Agent 自己具备记住/回忆/反思的能力 */
export function memoryTools(memory: MemoryService): Tool[] {
  return [
    {
      name: "memory_retain",
      description: "把一条重要信息(用户的偏好、事实、约定)保存到长期记忆,以后可以回忆起来。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要记住的内容,写成一句完整、自包含的话" },
          kind: { type: "string", enum: ["fact", "experience"], description: "fact=事实/偏好,experience=经历", default: "fact" },
        },
        required: ["content"],
      },
      async run(input, ctx) {
        if (!ctx.memory) return "记忆服务不可用";
        await ctx.memory.retain(String(input.content), input.kind === "experience" ? "experience" : "fact", ctx.agentId);
        return "已记住: " + String(input.content);
      },
    },
    {
      name: "memory_recall",
      description: "检索长期记忆,找出与某个问题/主题相关的过往事实与经历。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索关键词或问题" },
          limit: { type: "number", description: "最多返回条数,默认 5" },
        },
        required: ["query"],
      },
      async run(input, ctx) {
        if (!ctx.memory) return "记忆服务不可用";
        const items = await ctx.memory.recall(String(input.query), Number(input.limit) || 5, ctx.agentId);
        if (!items.length) return "(没有找到相关记忆)";
        return items.map((m) => `- ${m.content}`).join("\n");
      },
    },
    {
      name: "memory_reflect",
      description: "让记忆系统反思近期经历,生成一份关于用户的重要总结。",
      parameters: { type: "object", properties: {} },
      async run(_input, ctx) {
        if (!ctx.memory) return "记忆服务不可用";
        return await ctx.memory.reflect(ctx.agentId);
      },
    },
  ];
}
