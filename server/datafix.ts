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
