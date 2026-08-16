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
  const lastAgentId = useApp((s) => s.lastAgentId);
  const sendMessage = useApp((s) => s.sendMessage);
  const stop = useApp((s) => s.stop);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const [summarizing, setSummarizing] = useState(false);
  const [loreOpen, setLoreOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  // 语音通话模式(免按键连续对话)
  const callRef = useRef(false);
  const [callActive, setCallActive] = useState(false);

  const runCallLoop = async () => {
    while (callRef.current) {
      let text = "";
      try {
        const r = await window.hanalite?.recognizeSpeech();
        text = r?.text ?? "";
      } catch {
        text = "";
      }
      if (!callRef.current) break;
      if (!text.trim()) continue;
      useApp.getState().showToast(`🎙 听到:${text.slice(0, 40)}…`);
      await sendMessage(text);
      if (!callRef.current) break;
      // 朗读最后一条回复
      try {
        const last = useApp.getState().messagesBySession[activeSessionId ?? ""]?.filter((m) => m.role === "assistant").at(-1);
        const t = last?.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n") ?? "";
        if (t && "speechSynthesis" in window) {
          const u = new SpeechSynthesisUtterance(t.slice(0, 800));
          u.lang = "zh-CN";
          await new Promise<void>((res) => {
            u.onend = () => res();
            u.onerror = () => res();
            window.speechSynthesis.speak(u);
          });
        }
      } catch {
        /* ignore */
      }
    }
  };

  const toggleCall = () => {
    if (callActive) {
      callRef.current = false;
      setCallActive(false);
      window.speechSynthesis?.cancel();
      return;
    }
    callRef.current = true;
    setCallActive(true);
    void runCallLoop();
  };

  // 历史思考回传快捷切换:off → recent5 → all(与设置页 thinkingEcho 联动,全局生效)
  const thinkEcho = settings?.thinkingEcho ?? "all";
  const THINK_LABEL: Record<string, string> = { all: "🧠 思考·全部", recent5: "🧠 思考·近5条", off: "🧠 思考·关" };
  const cycleThinking = () => {
    const next = thinkEcho === "off" ? "recent5" : thinkEcho === "recent5" ? "all" : "off";
    void useApp.getState().updateSettings({ thinkingEcho: next }).then(() =>
      useApp.getState().showToast(`历史思考回传:${next === "all" ? "全部" : next === "recent5" ? "最近 5 条" : "关闭"}`),
    );
  };

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
          value={activeSession?.agentId ?? lastAgentId ?? ""}
          onChange={(e) => {
            const aid = e.target.value;
            // 记住上次使用的人格(持久化):下次新会话默认用它
            useApp.setState({ lastAgentId: aid });
            try {
              localStorage.setItem("huanshi.lastAgent", aid);
            } catch {
              /* ignore */
            }
            if (activeSessionId) {
              void api.setSessionAgent(activeSessionId, aid);
              void useApp.getState().refreshSessions();
            } else if (aid) {
              // 初始界面(还没打开任何会话):选人格 = 直接新建该人格的会话并进入
              void useApp.getState().newSession();
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
        {activeSessionId && (
          <button
            className="btn secondary sm"
            title={`历史思考回传:${thinkEcho === "all" ? "全部" : thinkEcho === "recent5" ? "最近 5 条" : "关闭"}(点击切换;超长会话建议关闭可提速)`}
            onClick={cycleThinking}
          >
            {THINK_LABEL[thinkEcho] ?? "🧠 思考"}
          </button>
        )}
        {activeSessionId && (
          <button
            className="btn secondary sm"
            title="导出本会话(对话全文+摘要)为文本文件"
            onClick={() => void api.exportSession(activeSessionId, activeSession?.title ?? "").catch((e) => useApp.getState().showToast(`导出失败:${(e as Error).message}`))}
          >
            📤 导出
          </button>
        )}
        {activeSessionId && (
          <button
            className={`btn secondary sm${callActive ? " call-active" : ""}`}
            title="语音通话:免按键连续对话(说话→AI 回应并朗读→再说话)"
            onClick={toggleCall}
          >
            {callActive ? "⏹ 挂断" : "🎙 通话"}
          </button>
        )}
        {activeSessionId && (
          <button
            className="btn secondary sm"
            title="群聊:一个会话里多个人格同场登场(点击选择成员)"
            onClick={() => setGroupOpen(true)}
          >
            👥 群聊
          </button>
        )}
        {activeSessionId && (
          <button
            className="btn secondary sm"
            title="世界观设定:预览/生成/编辑/撤销/清除"
            onClick={() => setLoreOpen(true)}
          >
            📖 世界观
          </button>
        )}
        {activeModel && <span className="model-tag">{activeModel}</span>}
        {loreOpen && activeSessionId && (
          <LorePanel
            sessionId={activeSessionId}
            initialLore={activeSession?.lore}
            hasHistory={Boolean(activeSession?.loreHistory?.length)}
            onClose={() => setLoreOpen(false)}
            onChanged={() => void useApp.getState().refreshSessions()}
          />
        )}
        {groupOpen && activeSessionId && <GroupPanel sessionId={activeSessionId} onClose={() => setGroupOpen(false)} onChanged={() => void useApp.getState().refreshSessions()} />}
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
/** 世界观管理面板:预览 / 生成 / 编辑 / 撤销 / 清除(误点可回退) */
function LorePanel({
  sessionId,
  initialLore,
  hasHistory,
  onClose,
  onChanged,
}: {
  sessionId: string;
  initialLore?: string;
  hasHistory: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lore, setLore] = useState(initialLore ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editText, setEditText] = useState(initialLore ?? "");

  const toast = (m: string) => useApp.getState().showToast(m);
  const act = async (fn: () => Promise<{ lore?: string }>, okMsg: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.lore !== undefined) setLore(r.lore);
      setEditText(r.lore ?? "");
      onChanged();
      toast(okMsg);
    } catch (err) {
      toast(`操作失败:${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal lore-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>📖 世界观设定</strong>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 8px" }}>
            AI 每次对话都会遵守这份设定(人设不崩、设定不冲突)。可以预览、生成、手动编辑,误操作可撤销。
          </p>
          {editing ? (
            <textarea
              className="lore-editor"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={14}
              placeholder="输入世界观设定内容…"
            />
          ) : (
            <pre className="lore-view">{lore || "(尚未生成世界观。点击「✨ 生成」让 AI 提炼当前剧情。)"}</pre>
          )}
        </div>
        <div className="modal-foot">
          {!editing ? (
            <>
              <button className="btn" disabled={busy} onClick={() => void act(() => api.loreSession(sessionId), "世界观已生成/更新")}>
                {busy ? "生成中…" : "✨ 生成/更新"}
              </button>
              <button className="btn secondary" disabled={busy || !lore} onClick={() => { setEditing(true); }}>
                ✏️ 编辑
              </button>
              <button className="btn secondary" disabled={busy || !hasHistory} onClick={() => void act(() => api.loreUndo(sessionId), "已回退到上一版本")}>
                ↩️ 撤销
              </button>
              <button className="btn danger" disabled={busy || !lore} onClick={() => void act(() => api.loreClear(sessionId).then(() => ({ lore: "" })), "世界观已清除")}>
                🗑 清除
              </button>
            </>
          ) : (
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => void act(() => api.loreSet(sessionId, editText).then((r) => ({ lore: r.lore })), "已保存")}
              >
                保存
              </button>
              <button className="btn secondary" disabled={busy} onClick={() => { setEditing(false); setEditText(lore); }}>
                取消
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 群聊成员设置面板:勾选 2+ 个人格同场登场 */
function GroupPanel({ sessionId, onClose, onChanged }: { sessionId: string; onClose: () => void; onChanged: () => void }) {
  const agents = useApp((s) => s.agents);
  const [selected, setSelected] = useState<string[]>(() => useApp.getState().sessions.find((s) => s.id === sessionId)?.groupAgents ?? []);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>👥 群聊成员</strong>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 10px" }}>
            选 2 个以上人格,它们会在一个会话里同场登场、轮流对你说的话回应。留空或只选 1 个 = 单人模式。
          </p>
          {agents.map((a) => (
            <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} />
              {a.name}
            </label>
          ))}
        </div>
        <div className="modal-foot">
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.setSessionGroup(sessionId, selected);
                onChanged();
                useApp.getState().showToast(selected.length >= 2 ? `群聊模式:${selected.length} 位人格同场` : "已恢复单人模式");
                onClose();
              } catch (err) {
                useApp.getState().showToast(`设置失败:${(err as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const [attachments, setAttachments] = useState<{ file: string; mime: string; preview: string; text?: string; name?: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [listening, setListening] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // store 请求聚焦(删除消息/弹窗关闭等)时,把光标放回输入框
  const focusTick = useApp((s) => s.focusTick);
  // 思考模式快捷切换:当前 activeProvider 的 disableThinking(模型先想后答 vs 直接答)
  const settings = useApp((s) => s.settings);
  const activePid = settings?.activeProvider ?? "";
  const thinkingOff = settings?.providers?.[activePid]?.disableThinking === true;
  const toggleThinkingMode = () => {
    if (!activePid || !settings?.providers?.[activePid]) {
      useApp.getState().showToast("未配置模型,无法切换思考模式");
      return;
    }
    const cfg = settings.providers[activePid];
    const next = !cfg.disableThinking;
    void useApp
      .getState()
      .updateSettings({ providers: { ...settings.providers, [activePid]: { ...cfg, disableThinking: next } } })
      .then(() => useApp.getState().showToast(`思考模式:${next ? "关闭(直接回答,更快)" : "开启(先思考再回答,更深入)"}`));
  };

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
    // 文本类附件(文献/笔记)直接拼进消息正文;图片附件走多模态
    const textParts = attachments.filter((a) => a.text);
    const content = textParts.length
      ? text + textParts.map((a) => `\n\n【文献 ${a.name ?? a.file}】\n${a.text}`).join("")
      : text;
    const atts = attachments.filter((a) => !a.text).map((a) => ({ file: a.file, mime: a.mime }));
    setInput("");
    setAttachments([]);
    // 输入框高度复位:长文发送后不残留撑高的 160px
    if (taRef.current) {
      taRef.current.style.height = "auto";
    }
    onSend(content, atts);
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const isImage = f.type.startsWith("image/");
        const isText = f.type.startsWith("text/") || /\.(txt|md|csv|json|log)$/i.test(f.name);
        if (isImage) {
          const up = await api.upload(f);
          setAttachments((prev) => [...prev, { ...up, preview: `${api.base}/files/${up.file}` }]);
        } else if (isText) {
          // 文本类:提取内容,发送时拼进对话(免去让 AI 读文件的门槛)
          const up = await api.upload(f);
          if (up.text) {
            setAttachments((prev) => [...prev, { file: up.file, mime: up.mime, preview: "", name: up.name ?? f.name, text: up.text }]);
          } else {
            useApp.getState().showToast(`⚠️ ${f.name}:文本为空或无法读取`);
          }
        } else {
          // PDF/docx 等:存到工作区「上传」文件夹,人格可用 read_file 阅读
          const up = await api.upload(f, "workspace");
          useApp.getState().showToast(`📚 ${f.name} 已存到工作区「上传」文件夹,可让 AI 阅读`);
        }
      }
    } catch (err) {
      useApp.getState().showToast(`上传失败:${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  // 拖拽上传:文件拖到输入区即触发上传(与 📎 选择同一套逻辑)
  const [dragOver, setDragOver] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void pickFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`chat-input-wrap${dragOver ? " drag-over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <div className="chat-attachments">
          {attachments.map((a, i) => (
            <div key={i} className="chat-attachment">
              {a.text ? (
                <span className="chat-attachment-file" title={`${a.name ?? a.file}(${(a.text.length / 1024).toFixed(0)}KB)`}>📄 {a.name ?? a.file}</span>
              ) : (
                <img src={a.preview} alt="" />
              )}
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
        <button
          className="attach-btn"
          onClick={toggleThinkingMode}
          title={`思考模式:${thinkingOff ? "关闭(直接回答,更快)" : "开启(先思考再回答,更深入)"} — 点击切换`}
          disabled={sending}
          style={{ opacity: thinkingOff ? 0.6 : 1 }}
        >
          💭
        </button>
        <input ref={fileRef} type="file" accept="image/*,.txt,.md,.csv,.json,.log,.pdf,.docx" multiple hidden onChange={(e) => void pickFiles(e.target.files)} />
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

