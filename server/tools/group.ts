import type { Tool } from "./registry";

/**
 * 翻群聊记录:记忆库里只留"摘要片段"(谁说了什么要点),要看全貌时用这个。
 * - 不传 session → 列出最近的群聊(让它们知道去哪翻)
 * - 传 session(标题关键词或会话 id)→ 读那次的完整对话(带时间与说话人)
 */
export const groupTools: Tool[] = [
  {
    name: "read_group_chat",
    description:
      "翻看群聊的完整记录(原文,不靠记忆复述)。你的记忆里只有摘要片段,需要细节时用这个工具:不传 session 列出最近的群聊;传标题关键词或会话 id 读那次的完整对话;可用 who 只看某一个人的发言。",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "群聊标题关键词或会话 id;不传=列出最近的群聊" },
        who: { type: "string", description: "只看某个人的发言(名字关键词,如「小柒」「玄漪」)" },
        limit: { type: "number", description: "读最近多少条消息,默认 50,最多 500" },
      },
    },
    async run(input, ctx) {
      if (!ctx.listGroupChats || !ctx.readGroupChat) return "当前环境不支持翻阅群聊记录。";
      const raw = String(input.session ?? "").trim();
      const who = String(input.who ?? "").trim();
      const limit = Math.max(1, Math.min(500, Number(input.limit) || 50));
      const chats = ctx.listGroupChats();
      if (!chats.length) return "(还没有群聊记录)";
      if (!raw) {
        return `最近的群聊(${chats.length} 个):\n${chats
          .map((c) => {
            const when = new Date(c.updatedAt).toLocaleString("zh-CN", { hour12: false });
            const cnt = c.messageCount ? ` · ${c.messageCount} 条` : "";
            return `- 「${c.title}」 最后更新 ${when}${cnt} (id: ${c.id})`;
          })
          .join("\n")}\n想读哪次,把标题关键词或 id 传给我(可加 who 只看某人发言)。\n注意:同名群聊只传标题会读到最新那场,要翻更早那场请带上 id。`;
      }
      const hit = chats.find((c) => c.id === raw) ?? chats.find((c) => c.title.includes(raw)) ?? chats.find((c) => raw.includes(c.title));
      if (!hit) return `没找到匹配「${raw}」的群聊。现有:${chats.map((c) => c.title).join("、")}`;
      let msgs = ctx.readGroupChat(hit.id, limit);
      if (who) msgs = msgs.filter((m) => m.who.includes(who));
      if (!msgs.length) return who ? `「${hit.title}」最近 ${limit} 条里没有「${who}」的发言。` : `「${hit.title}」还没有消息。`;
      const lines = msgs
        .map((m) => `[${new Date(m.at).toLocaleString("zh-CN", { hour12: false })}] ${m.who}:${m.text || "(无文字)"}`)
        .join("\n");
      return `「${hit.title}」${who ? `中「${who}」的发言` : `最近 ${msgs.length} 条`}(原文):\n${lines}`;
    },
  },
];
