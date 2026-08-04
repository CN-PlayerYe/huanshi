import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolCallPart } from "@shared/types";

export function MessageItem({ msg, streaming }: { msg: ChatMessage; streaming?: boolean }) {
  const isUser = msg.role === "user";
  const text = msg.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
  const tools = msg.parts.filter((p) => p.type === "tool" && p.tool).map((p) => p.tool!) as ToolCallPart[];

  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      <div className="message-bubble">
        {tools.length > 0 && (
          <div className="tool-list">
            {tools.map((t) => (
              <ToolCallBlock key={t.id} tool={t} />
            ))}
          </div>
        )}
        {text ? (
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        ) : streaming ? (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolCallBlock({ tool }: { tool: ToolCallPart }) {
  let inputText = "";
  try {
    inputText = JSON.stringify(JSON.parse(tool.input), null, 2);
  } catch {
    inputText = tool.input;
  }
  const statusClass = tool.status === "running" ? "running" : tool.status === "error" ? "error" : "done";
  const statusText =
    tool.status === "running" ? "运行中…" : tool.status === "error" ? "出错" : tool.status === "done" ? "完成" : "等待中";

  return (
    <div className="tool-block">
      <div className="tool-head">
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{tool.name}</span>
        <span className={`tool-status ${statusClass}`}>{statusText}</span>
      </div>
      {inputText && <div className="tool-body input">{inputText.slice(0, 1200)}</div>}
      {tool.output && <div className="tool-body">{tool.output.slice(0, 2000)}</div>}
    </div>
  );
}

export function MessageList({ messages, streaming }: { messages: ChatMessage[]; streaming: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  if (!messages.length) {
    return (
      <div className="empty-chat">
        <div className="big">🌸</div>
        <div>你好,我是 HanaLite</div>
        <div style={{ fontSize: 13 }}>有记忆、有人格的私人 AI 助手。想聊点什么?</div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={ref}>
      {messages.map((m, i) => (
        <MessageItem key={m.id} msg={m} streaming={streaming && i === messages.length - 1 && m.role === "assistant"} />
      ))}
    </div>
  );
}
