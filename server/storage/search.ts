import type { SessionMeta } from "../../shared/types";
import type { Db } from "./index";

export interface SearchHit {
  session: SessionMeta;
  /** -1 = 标题命中;否则为消息命中数 */
  matches: number;
}

/** 跨会话全文搜索:标题优先,其次消息正文/工具输出。返回按命中排序的结果。 */
export function searchSessions(db: Db, rawQuery: string, limit = 50): SearchHit[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const s of db.listSessions()) {
    if (s.title.toLowerCase().includes(q)) {
      hits.push({ session: s, matches: -1 }); // -1 = 标题命中
      continue;
    }
    const messages = db.getMessages(s.id);
    let matches = 0;
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.type === "text" && (p.text ?? "").toLowerCase().includes(q)) {
          matches++;
          break;
        }
        if (p.type === "tool" && (p.tool?.output ?? "").toLowerCase().includes(q)) matches++;
      }
    }
    if (matches > 0) hits.push({ session: s, matches });
  }
  return hits.slice(0, limit);
}
