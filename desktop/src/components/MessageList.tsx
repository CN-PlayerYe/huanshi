import { memo, useEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolCallPart } from "@shared/types";
import { api, apiBase } from "../api";
import { useApp } from "../store";
import logo from "../assets/icon.png";

export const MessageItem = memo(function MessageItem({ msg, streaming }: { msg: ChatMessage; streaming?: boolean }) {
  const isUser = msg.role === "user";
  const showThinking = useApp((s) => s.settings?.showThinking ?? true);
  const deleteMessage = useApp((s) => s.deleteMessage);
  // 朗读状态(全局单例:同一时间只读一条)
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const text = msg.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
  // 朗读引擎:API(OpenAI 兼容 TTS / 自建克隆)或系统语音
  const ttsMode = useApp((s) => s.settings?.tts?.mode ?? "system");
  const ttsVoice = useApp((s) => s.settings?.tts?.systemVoice);

  const toggleSpeak = async () => {
    if (speaking) {
      if (ttsMode === "api") {
        audioRef.current?.pause();
      } else {
        window.speechSynthesis?.cancel();
      }
      setSpeaking(false);
      return;
    }
    // API 模式:请求后端 TTS 并播放音频
    if (ttsMode === "api") {
      try {
        const blob = await api.tts(text);
        const url = URL.createObjectURL(blob);
        if (audioRef.current) audioRef.current.src = url;
        audioRef.current?.play().catch(() => undefined);
        setSpeaking(true);
      } catch (err) {
        window.dispatchEvent(new CustomEvent("hanalite-toast", { detail: `朗读失败:${(err as Error).message}` }));
      }
      return;
    }
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel(); // 先停掉其他消息的朗读
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 0.95;
    // 用户指定的系统语音
    if (ttsVoice) {
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find((x) => x.name === ttsVoice);
      if (v) u.voice = v;
    }
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
    setSpeaking(true);
  };
  const thinking = msg.parts
    .filter((p) => p.type === "thinking")
    .map((p) => p.text ?? "")
    .join("\n");
  const tools = msg.parts.filter((p) => p.type === "tool" && p.tool).map((p) => p.tool!) as ToolCallPart[];

  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      <div className="message-bubble">
        {/* API 朗读用隐藏音频元素 */}
        <audio ref={audioRef} onEnded={() => setSpeaking(false)} onPause={() => setSpeaking(false)} />
        {!isUser && thinking && showThinking && (
          <details className="thinking-block">
            <summary>🖊 思考过程</summary>
            <div className="thinking-content">{thinking}</div>
          </details>
        )}
        {tools.length > 0 && (
          <div className="tool-list">
            {tools.map((t) => (
              <ToolCallBlock key={t.id} tool={t} />
            ))}
          </div>
        )}
        {msg.parts.filter((p) => p.type === "image" && p.image).length > 0 && (
          <div className="msg-images">
            {msg.parts
              .filter((p) => p.type === "image" && p.image)
              .map((p, i) => (
                <img key={i} src={`${apiBase()}/files/${p.image!.file}`} alt="图片" className="msg-image" />
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
        <button
          className="msg-delete"
          title="删除这条消息(压缩上下文)"
          onClick={async () => {
            if (window.hanalite?.confirmDialog) {
              const ok = await window.hanalite.confirmDialog("删除这条消息?它将从本会话移除,用于压缩上下文。");
              if (ok) void deleteMessage(msg.sessionId, msg.id); // store 内部会触发输入框重新聚焦
            } else if (window.confirm("删除这条消息?它将从本会话移除,用于压缩上下文。")) {
              void deleteMessage(msg.sessionId, msg.id);
            }
          }}
        >
          🗑
        </button>
        {!isUser && text && (
          <button className={`msg-speak${speaking ? " active" : ""}`} title={speaking ? "停止朗读" : "朗读这条回复"} onClick={toggleSpeak}>
            {speaking ? "⏹" : "🔊"}
          </button>
        )}
      </div>
    </div>
  );
});

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

  const images = extractImages(tool.output ?? "");
  const textWithoutImages = images.length ? stripImages(tool.output ?? "") : tool.output ?? "";

  return (
    <div className="tool-block">
      <div className="tool-head">
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{tool.name}</span>
        <span className={`tool-status ${statusClass}`}>{statusText}</span>
      </div>
      {inputText && <div className="tool-body input">{inputText.slice(0, 1200)}</div>}
      {images.length > 0 && (
        <div className="tool-images">
          {images.map((src, i) => (
            <img key={i} src={src} alt="工具输出图片" className="tool-img" onClick={() => setLightbox(src)} />
          ))}
        </div>
      )}
      {textWithoutImages && <div className="tool-body">{textWithoutImages.slice(0, 2000)}</div>}
    </div>
  );
}

// ---- 全屏图片查看器 ----

let lightboxSrc: string | null = null;
const lightboxListeners = new Set<() => void>();

function setLightbox(src: string): void {
  lightboxSrc = src;
  for (const fn of lightboxListeners) fn();
}
function closeLightbox(): void {
  lightboxSrc = null;
  for (const fn of lightboxListeners) fn();
}

/** 图片查看器挂载点(由 MessageList 渲染,全局单例) */
export function Lightbox() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    lightboxListeners.add(force);
    return () => {
      lightboxListeners.delete(force);
    };
  }, []);
  if (!lightboxSrc) return null;
  return (
    <div className="lightbox" onClick={closeLightbox}>
      <img src={lightboxSrc} alt="预览" onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" onClick={closeLightbox}>
        ✕
      </button>
    </div>
  );
}

/** 从文本中提取图片 data URI(支持 data:image/ 前缀与 JSON {"type":"image","data":"裸base64"} 两种形态) */
function extractImages(text: string): string[] {
  const out: string[] = [];
  // 1) 标准 data URI
  const uriRe = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g;
  for (const m of text.match(uriRe) ?? []) out.push(m.replace(/\s/g, ""));
  // 2) JSON 形态:{"type":"image","data":"..."}(data 为裸 base64)
  const jsonRe = /\{"type"\s*:\s*"image"[\s\S]*?"data"\s*:\s*"([A-Za-z0-9+/=\s]{100,})"\s*\}/g;
  for (const m of text.matchAll(jsonRe)) {
    const raw = m[1].replace(/\s/g, "");
    const mime = sniffMime(raw);
    out.push(`data:${mime};base64,${raw}`);
  }
  return out.slice(0, 9);
}

function sniffMime(base64: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

function stripImages(text: string): string {
  return text
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, "[图片]")
    .replace(/\{"type"\s*:\s*"image"[\s\S]*?"data"\s*:\s*"[A-Za-z0-9+/=\s]{100,}"\s*\}/g, "[图片]");
}

export const MessageList = memo(function MessageList({ messages, streaming }: { messages: ChatMessage[]; streaming: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const options = activeSessionId ? useApp((s) => s.sessionOptions[activeSessionId] ?? []) : [];
  const clearOptions = useApp((s) => s.clearOptions);
  const sendMessage = useApp((s) => s.sendMessage);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  if (!messages.length) {
    return (
      <div className="empty-chat">
        <img src={logo} className="empty-chat-logo" alt="幻世" />
        <div>你好,这里是 幻世</div>
        <div style={{ fontSize: 13 }}>有记忆、有人格的私人 AI 助手。想聊点什么?</div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={ref}>
      {messages.map((m, i) => (
        <MessageItem key={m.id} msg={m} streaming={streaming && i === messages.length - 1 && m.role === "assistant"} />
      ))}
      {options.length > 0 && !streaming && (
        <div className="chat-options">
          <div className="chat-options-hint">✨ 下一步做什么?</div>
          {options.map((o, i) => (
            <button
              key={i}
              className="chat-option"
              onClick={() => {
                clearOptions();
                void sendMessage(o);
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <Lightbox />
    </div>
  );
});
