import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";
import { MessageList } from "./MessageList";

// 模块级常量:避免 selector 每次返回新数组引用导致 React 无限重渲染
const EMPTY_MESSAGES: never[] = [];

export function ChatView() {
  const activeSessionId = useApp((s) => s.activeSessionId);
  const messages = useApp((s) => (s.activeSessionId ? (s.messagesBySession[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES));
  const sessions = useApp((s) => s.sessions);
  const agents = useApp((s) => s.agents);
  const sending = useApp((s) => s.sending);
  const settings = useApp((s) => s.settings);
  const selectSession = useApp((s) => s.selectSession);
  const newSession = useApp((s) => s.newSession);
  const sendMessage = useApp((s) => s.sendMessage);
  const stop = useApp((s) => s.stop);

  const [input, setInput] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // 切换会话时清空输入焦点状态
  useEffect(() => {
    taRef.current?.focus();
  }, [activeSessionId]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    void sendMessage(text);
  };

  const activeModel = settings?.activeProvider ? settings.providers[settings.activeProvider]?.model : undefined;

  return (
    <div className="chat-view">
      <div className="chat-head">
        <span className="session-title">{activeSession?.title ?? "新会话"}</span>
        <select
          value={activeSession?.agentId ?? ""}
          onChange={(e) => {
            if (activeSessionId) {
              void api.setSessionAgent(activeSessionId, e.target.value);
              void useApp.getState().refreshSessions();
            }
          }}
          title="切换人格"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {activeModel && <span className="model-tag">{activeModel}</span>}
      </div>

      <MessageList messages={messages} streaming={sending} />

      <div className="chat-input-wrap">
        <div className="chat-input-box">
          <textarea
            ref={taRef}
            className="chat-input"
            rows={1}
            placeholder={sending ? "助手正在思考…" : "给 HanaLite 发消息(Enter 发送, Shift+Enter 换行)"}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <button className="send-btn" disabled={sending || !input.trim()} onClick={sending ? stop : handleSend} title={sending ? "停止" : "发送"}>
            {sending ? "■" : "➤"}
          </button>
        </div>
        <div className="chat-hint">
          {sending ? "正在生成,点击 ■ 停止" : "工具:文件 / 命令 / 网页 / 记忆 · 数据与记忆仅存本机"}
        </div>
      </div>
    </div>
  );
}

