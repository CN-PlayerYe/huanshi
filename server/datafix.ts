import type { ChatMessage } from "../shared/types";
import type { Db } from "./storage";

/**
 * 存量数据修复:早期迁移/旧版本把思考内容以内嵌 <thinking> 块塞进了正文文本。
 * 修复:把 <thinking>…</thinking> 从正文提取为独立的 thinking part,
 * 这样回放历史时能作为 reasoning_content 正确回传给 DeepSeek 等模型。
 * 幂等:已无 <thinking> 块的消息不会改动。
 */
export function fixEmbeddedThinking(db: Db): number {
  let changed = 0;
  for (const s of db.listSessions()) {
    const msgs = db.getMessages(s.id);
    for (const m of msgs) {
      const textParts = m.parts.filter((p) => p.type === "text");
      const hasThinkingPart = m.parts.some((p) => p.type === "thinking");
      if (!textParts.length || hasThinkingPart) continue;
      let dirty = false;
      const newParts: ChatMessage["parts"] = [];
      for (const p of textParts) {
        const text = p.text ?? "";
        const re = /<thinking>\s*([\s\S]*?)\s*<\/thinking>/g;
        let t = text;
        let hit: RegExpExecArray | null;
        while ((hit = re.exec(text))) {
          const thinking = hit[1].trim();
          if (thinking) {
            newParts.push({ type: "thinking", text: thinking });
            dirty = true;
          }
        }
        if (dirty) t = t.replace(re, "").replace(/\n{2,}/g, "\n").trim();
        if (t) newParts.push({ type: "text", text: t });
      }
      if (dirty) {
        const others = m.parts.filter((p) => p.type !== "text");
        db.updateMessage({ ...m, parts: [...others, ...newParts] });
        changed++;
      }
    }
  }
  return changed;
}

/**
 * 旧版心跳碎片会话归档:早期心跳每次新建「💓 心跳 <时间>」会话,
 * 新版改为固定「💓 <人格名> 心跳日记」。把旧的碎片心跳会话归档
 * (数据保留,侧栏清爽,可在归档区找回)。
 * 幂等:只处理标题以「💓」开头且不含「心跳日记」的会话。
 */
export function fixLegacyHeartbeatSessions(db: Db): number {
  let archived = 0;
  for (const s of db.listSessions(true)) {
    if (s.archived) continue;
    const t = s.title || "";
    if (t.startsWith("💓") && !t.includes("心跳日记")) {
      db.updateSession(s.id, { archived: true });
      archived++;
    }
  }
  return archived;
}

/**
 * 清理误入记忆库的心跳消息:心跳消息是系统代发的"自主活动邀请",
 * 以用户角色被沉淀进 experiences 会污染人格身份(如让一个人格误以为自己是另一个)。
 * 幂等:只删以「【心跳】」开头的条目。
 */
export async function cleanHeartbeatMemories(memory: { list: (agentId?: string) => Promise<{ id: string; content: string }[]>; deleteItem: (id: string, agentId?: string) => Promise<void> }, agentIds: string[]): Promise<number> {
  let n = 0;
  // 全局 + 各独立空间
  const scopes: (string | undefined)[] = [undefined, ...agentIds];
  for (const scope of scopes) {
    try {
      const items = await memory.list(scope);
      for (const it of items) {
        if (it.content.includes("【心跳】")) {
          await memory.deleteItem(it.id, scope);
          n++;
        }
      }
    } catch {
      /* 跳过 */
    }
  }
  return n;
}
