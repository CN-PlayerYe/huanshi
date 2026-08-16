import type { ChatMessage, SessionMeta } from "../shared/types";
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
  const taskSessionIds = new Set(db.listTasks().map((t) => t.sessionId).filter((x): x is string => Boolean(x)));
  // ① 定时任务碎片:「⏰」任务会话(自由活动等),每个 人格+任务名 只保留最新一份(任务指向的),其余归档
  const taskSessions = db.listSessions(true).filter((s) => !s.archived && (s.title || "").startsWith("⏰"));
  const byTask = new Map<string, SessionMeta[]>();
  for (const s of taskSessions) {
    const key = `${s.agentId}|${(s.title || "").trim()}`;
    const arr = byTask.get(key) ?? [];
    arr.push(s);
    byTask.set(key, arr);
  }
  for (const arr of byTask.values()) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => b.updatedAt - a.updatedAt);
    for (let i = 1; i < arr.length; i++) {
      if (taskSessionIds.has(arr[i].id)) continue;
      db.updateSession(arr[i].id, { archived: true });
      archived++;
    }
  }
  // ② 同名「💓 X 心跳日记」重复(旧版 sessionId 未持久化导致反复重建):
  //    每个标题只保留最新一份(+ 任务正在使用的),其余归档(数据保留)
  const all = db.listSessions(true).filter((s) => !s.archived && (s.title || "").includes("心跳日记"));
  const byTitle = new Map<string, SessionMeta[]>();
  for (const s of all) {
    const key = (s.title || "").trim();
    const arr = byTitle.get(key) ?? [];
    arr.push(s);
    byTitle.set(key, arr);
  }
  for (const arr of byTitle.values()) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => b.updatedAt - a.updatedAt);
    for (let i = 1; i < arr.length; i++) {
      if (taskSessionIds.has(arr[i].id)) continue;
      db.updateSession(arr[i].id, { archived: true });
      archived++;
    }
  }
  // ② 旧碎片:「💓 心跳 <时间>」等非"心跳日记"格式 → 归档
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
