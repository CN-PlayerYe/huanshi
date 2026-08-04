import { useMemo, useState } from "react";
import { useApp } from "../store";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function Sidebar() {
  const sessions = useApp((s) => s.sessions);
  const agents = useApp((s) => s.agents);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const systemInfo = useApp((s) => s.systemInfo);
  const view = useApp((s) => s.view);
  const newSession = useApp((s) => s.newSession);
  const selectSession = useApp((s) => s.selectSession);
  const deleteSession = useApp((s) => s.deleteSession);
  const archiveSession = useApp((s) => s.archiveSession);
  const renameSession = useApp((s) => s.renameSession);
  const setView = useApp((s) => s.setView);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // 会话按 Agent 分组(保持 Agent 顺序:有会话的在前,按会话数降序)
  const sessionGroups = useMemo(() => {
    const map = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const list = map.get(s.agentId) ?? [];
      list.push(s);
      map.set(s.agentId, list);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [sessions]);

  const toggleGroup = (agentId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-logo">🌸</span>
        <span className="sidebar-title">HanaLite</span>
        <button className="new-session-btn" onClick={() => void newSession()} title="新建会话">
          ＋
        </button>
      </div>

      <div className="session-list">
        {sessions.length === 0 && <div style={{ color: "var(--text-dim)", fontSize: 13, padding: 16 }}>还没有会话,点击 ＋ 开始</div>}
        {sessionGroups.map(([agentId, list]) => (
          <div key={agentId} className="agent-group">
            <button
              className={`agent-group-title${collapsed.has(agentId) ? " collapsed" : ""}`}
              onClick={() => toggleGroup(agentId)}
              title="点击折叠/展开"
            >
              <span className="arrow">{collapsed.has(agentId) ? "▶" : "▼"}</span>
              <span className="gname">{agents.find((a) => a.id === agentId)?.name ?? "其他"}</span>
              <span className="gcount">{list.length}</span>
            </button>
            {!collapsed.has(agentId) &&
              list.map((s) => (
                <div key={s.id} className={`session-item${s.id === activeSessionId ? " active" : ""}`} onClick={() => void selectSession(s.id)}>
                  {renamingId === s.id ? (
                    <input
                      className="title"
                      autoFocus
                      defaultValue={s.title}
                      style={{ background: "var(--bg)", border: "1px solid var(--accent-dim)", borderRadius: 6, padding: "3px 6px", color: "var(--text)" }}
                      onBlur={(e) => {
                        void renameSession(s.id, e.target.value.trim() || s.title);
                        setRenamingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="title">{s.title}</span>
                  )}
                  <span className="time">{fmtTime(s.updatedAt)}</span>
                  <span className="session-menu" onClick={(e) => e.stopPropagation()}>
                    <button className="session-menu-btn" onClick={() => setMenuFor(menuFor === s.id ? null : s.id)}>
                      ⋯
                    </button>
                    {menuFor === s.id && (
                      <div className="session-pop" onMouseLeave={() => setMenuFor(null)}>
                        <button
                          onClick={() => {
                            setRenamingId(s.id);
                            setMenuFor(null);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          onClick={() => {
                            void archiveSession(s.id);
                            setMenuFor(null);
                          }}
                        >
                          归档
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            void deleteSession(s.id);
                            setMenuFor(null);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <div className="foot-status">
          <span className={`dot${systemInfo?.hindsightConnected ? "" : " off"}`} />
          记忆:{systemInfo?.hindsightConnected ? "Hindsight" : "本地"}
        </div>
        <button className="foot-btn" onClick={() => setView(view === "settings" ? "chat" : "settings")}>
          <span>⚙️</span> 设置
        </button>
      </div>
    </aside>
  );
}
