import { memo, useEffect, useRef, useState } from "react";
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
  const sendMessage = useApp((s) => s.sendMessage);
  const stop = useApp((s) => s.stop);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const [summarizing, setSummarizing] = useState(false);

  const handleSend = (text: string, atts?: { file: string; mime: string }[]) => {
    if ((!text.trim() && !atts?.length) || sending) return;
    void sendMessage(text, atts);
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
        {activeSessionId && (
          <button
            className="btn secondary sm summarize-btn"
            title="手动压缩上下文:让 AI 把早期对话压成摘要(长会话提速、延续剧情)"
            disabled={summarizing}
            onClick={async () => {
              setSummarizing(true);
              try {
                const r = await api.summarizeSession(activeSessionId);
                useApp.getState().showToast(`已压缩 ${r.compressed} 条早期消息为摘要:${r.summary.slice(0, 60)}…`);
              } catch (err) {
                useApp.getState().showToast(`压缩失败:${(err as Error).message}`);
              } finally {
                setSummarizing(false);
              }
            }}
          >
            {summarizing ? "压缩中…" : "🧹 压缩上下文"}
          </button>
        )}
        {activeModel && <span className="model-tag">{activeModel}</span>}
      </div>

      <MessageList messages={messages} streaming={sending} />

      <ChatInput
        sending={sending}
        onSend={(text, atts) => handleSend(text, atts)}
        onStop={() => stop()}
      />
    </div>
  );
}

/** 独立输入框组件:本地 state,打字只重渲染自身,不拖累消息列表 */
const ChatInput = memo(function ChatInput({
  sending,
  onSend,
  onStop,
}: {
  sending: boolean;
  onSend: (t: string, atts?: { file: string; mime: string }[]) => void;
  onStop: () => void;
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<{ file: string; mime: string; preview: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [listening, setListening] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // store 请求聚焦(删除消息/弹窗关闭等)时,把光标放回输入框
  const focusTick = useApp((s) => s.focusTick);

  useEffect(() => {
    taRef.current?.focus();
  }, [focusTick]);

  // 窗口重新激活(如 confirm/其他窗口切回)时,自动把焦点还给输入框
  useEffect(() => {
    const onWinFocus = () => {
      // 焦点不在输入框/按钮上时才抢焦点,避免打断选中文本
      const el = document.activeElement;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT")) return;
      taRef.current?.focus();
    };
    window.addEventListener("focus", onWinFocus);
    return () => window.removeEventListener("focus", onWinFocus);
  }, []);

  const startVoice = async () => {
    if (listening) return;
    // 首选:Windows 本地语音识别(SAPI,离线可用,中文系统自带引擎)
    if (window.hanalite?.recognizeSpeech) {
      setListening(true);
      try {
        const r = await window.hanalite.recognizeSpeech();
        if (r.error) {
          useApp.getState().showToast(`语音识别失败:${r.error}`);
          return;
        }
        if (r.text) setInput((prev) => (prev ? prev + r.text : r.text));
        else useApp.getState().showToast("没有听清,请靠近麦克风再说一次。");
      } catch (err) {
        useApp.getState().showToast(`语音识别失败:${(err as Error).message}`);
      } finally {
        setListening(false);
        // 识别期间窗口焦点可能被系统抢走,完成后把光标还给输入框
        setTimeout(() => taRef.current?.focus(), 50);
      }
      return;
    }
    // 兜底:Web SpeechRecognition(Electron 下通常依赖 Google 服务,可能不可用)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      useApp.getState().showToast("当前环境不支持语音输入");
      return;
    }
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      const t = Array.from(e.results as ArrayLike<any>).map((r: any) => r[0].transcript).join("");
      setInput(t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e: any) => {
      setListening(false);
      useApp.getState().showToast(`语音识别不可用:${e?.error ?? "未知错误"}(需要网络语音服务)`);
    };
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && !attachments.length) || sending || uploading) return;
    const atts = attachments.map((a) => ({ file: a.file, mime: a.mime }));
    setInput("");
    setAttachments([]);
    onSend(text, atts);
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const up = await api.upload(f);
        setAttachments((prev) => [...prev, { ...up, preview: `${api.base}/files/${up.file}` }]);
      }
    } catch (err) {
      useApp.getState().showToast(`上传失败:${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="chat-input-wrap">
      {attachments.length > 0 && (
        <div className="chat-attachments">
          {attachments.map((a, i) => (
            <div key={i} className="chat-attachment">
              <img src={a.preview} alt="" />
              <button className="remove" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className="chat-input-box"
        onMouseDown={(e) => {
          // 可靠聚焦:阻止默认焦点转移,显式聚焦并放置光标(避免部分环境点击后 caret 不出现)
          const ta = taRef.current;
          if (ta && document.activeElement !== ta && !(e.target as HTMLElement).closest("button")) {
            e.preventDefault();
            ta.focus();
            const len = ta.value.length;
            ta.setSelectionRange(len, len);
          }
        }}
      >
        <button className="attach-btn" onClick={() => fileRef.current?.click()} title="发送图片" disabled={sending}>
          📎
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void pickFiles(e.target.files)} />
        <button className="attach-btn voice-btn" onClick={startVoice} title={listening ? "聆听中…" : "语音输入"} disabled={sending}>
          {listening ? "🎤…" : "🎤"}
        </button>
        <textarea
          ref={taRef}
          className="chat-input"
          rows={1}
          placeholder={uploading ? "上传中…" : sending ? "助手正在思考…" : "给幻世发消息(Enter 发送, Shift+Enter 换行)"}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <button
          className="send-btn"
          disabled={sending || (!input.trim() && !attachments.length) || uploading}
          onClick={sending ? onStop : () => void handleSend()}
          title={sending ? "停止" : "发送"}
        >
          {sending ? "■" : "➤"}
        </button>
      </div>
      <div className="chat-hint">
        {sending ? "正在生成,点击 ■ 停止" : "工具:文件 / 命令 / 网页 / 记忆 · 可发送图片 · 数据与记忆仅存本机"}
      </div>
    </div>
  );
});

