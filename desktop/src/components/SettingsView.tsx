import { useEffect, useRef, useState } from "react";
import type { ModelConfig, ProviderKind, TaskDef } from "@shared/types";
import { api, apiBase } from "../api";
import { useApp } from "../store";

const KIND_LABEL: Record<ProviderKind, string> = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic",
  ollama: "Ollama 本地",
};

const KIND_HINT: Record<ProviderKind, string> = {
  openai: "OpenAI / DeepSeek / Moonshot 等一切兼容 OpenAI 的服务",
  anthropic: "Claude(api.anthropic.com)",
  ollama: "本地模型,默认 http://localhost:11434/v1",
};

/** 常见模型列表(下拉选择,免手写;覆盖主流服务商) */
const COMMON_MODELS = [
  "deepseek-chat",
  "deepseek-reasoner",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o3-mini",
  "qwen-max",
  "qwen-plus",
  "qwen-turbo",
  "moonshot-v1-8k",
  "moonshot-v1-32k",
  "glm-4-plus",
  "glm-4-air",
  "glm-4-flash",
  "doubao-pro-32k",
  "doubao-lite-32k",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "llama3.1",
  "qwen2.5",
];

/** 简易 cron 描述(与后端 describeCron 一致的前端版) */
function describeCron(expr: string): string {
  try {
    const [m, h, d, mo, w] = expr.trim().split(/\s+/);
    if (!m || !h || !d || !mo || !w) return expr;
    const parts: string[] = [];
    if (m === "*") parts.push("每分钟");
    else if (m.includes("/")) parts.push(`每${m.split("/")[1]}分钟`);
    else parts.push(`${m} 分`);
    if (h !== "*") parts.push(`${h} 时`);
    if (d !== "*") parts.push(`${d} 日`);
    if (mo !== "*") parts.push(`${mo} 月`);
    if (w === "*") parts.push("每天");
    else parts.push(`周${w}`);
    return parts.join(" ");
  } catch {
    return expr;
  }
}

/** 心跳节奏描述 */
function describeHeartbeat(hb?: { intervalHours?: number; quietStart?: number; quietEnd?: number; scope?: string; network?: string; commands?: string }): string {
  const i = hb?.intervalHours ?? 3;
  const scope = hb?.scope === "global" ? "不限制" : hb?.scope === "workspace" ? "工作区" : "仅自己空间";
  const net = hb?.network === "allow" ? "联网" : hb?.network === "readonly" ? "只读网页" : "断网";
  const cmd = hb?.commands === "allow" ? "命令全放" : hb?.commands === "lowrisk" ? "低危命令" : "无命令";
  return `每 ${i} 小时 · ${scope} · ${net} · ${cmd}`;
}

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const systemInfo = useApp((s) => s.systemInfo);
  const agents = useApp((s) => s.agents);
  const updateSettings = useApp((s) => s.updateSettings);
  const changeDataDir = useApp((s) => s.changeDataDir);
  const saveAgent = useApp((s) => s.saveAgent);
  const deleteAgent = useApp((s) => s.deleteAgent);

  const [newProviderOpen, setNewProviderOpen] = useState(false);
  const [dataDirInput, setDataDirInput] = useState(systemInfo?.dataDir ?? "");
  const [reflectText, setReflectText] = useState("");
  const [agentForm, setAgentForm] = useState<{
    id?: string;
    name: string;
    description: string;
    systemPrompt: string;
    useGlobalStyle?: boolean;
    allowDangerousCommands?: boolean;
    unrestrictedPaths?: boolean;
    historyUnlimited?: boolean;
    historyContextPct?: number;
    isolatedMemory?: boolean;
    provider?: string;
    model?: string;
  } | null>(null);
  const [modelCustom, setModelCustom] = useState(false); // 模型下拉选「自定义输入…」时显示文本框
  const [providerModels, setProviderModels] = useState<string[]>([]); // 从 API 拉到的该 provider 可用模型
  const [modelsLoading, setModelsLoading] = useState(false);

  /** 拉取某 provider 的可用模型(API 已接通则用实拉列表,失败/未配置时回退内置常见模型) */
  const loadProviderModels = async (providerId?: string) => {
    const cfg = providerId ? settings?.providers?.[providerId] : undefined;
    if (!cfg) {
      setProviderModels([]);
      return;
    }
    setModelsLoading(true);
    try {
      const r = await api.fetchModels(cfg);
      if (r.ok && r.models?.length) {
        setProviderModels(r.models);
      } else {
        setProviderModels([]);
      }
    } catch {
      setProviderModels([]);
    } finally {
      setModelsLoading(false);
    }
  };
  const [csDir, setCsDir] = useState("");
  const [csIncludeThinking, setCsIncludeThinking] = useState(false);
  const [csBusy, setCsBusy] = useState(false);
  const [backups, setBackups] = useState<{ name: string; dir: string; mtime: number }[]>([]);
  const [backupMsg, setBackupMsg] = useState("");
  const [csInfo, setCsInfo] = useState("");
  const [tasks, setTasks] = useState<TaskDef[]>([]);
  const [taskForm, setTaskForm] = useState({ name: "", prompt: "", schedule: "", agentId: "" });
  const [systemVoices, setSystemVoices] = useState<{ name: string; lang: string }[]>([]);
  const [ttsTesting, setTtsTesting] = useState(false);
  const cardFileRef = useRef<HTMLInputElement>(null);
  const [taskMsg, setTaskMsg] = useState("");
  const [hbEditId, setHbEditId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const selectSession = useApp((s) => s.selectSession);
  const [lanIps, setLanIps] = useState<string[]>([]);
  const [port, setPort] = useState("");

  const refreshTasks = async () => {
    try {
      setTasks((await api.listTasks()).tasks);
    } catch {
      /* ignore */
    }
  };

  /** 作息模板:一键应用到所有心跳任务(合并保留各自的安全边界等设置) */
  const applyRoutine = async (label: string, hb: { intervalHours: number; quietStart: number; quietEnd: number; bedtimeHour: number; maxMinutes: number }) => {
    const hbTasks = tasks.filter((t) => t.kind === "heartbeat");
    for (const t of hbTasks) {
      await api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), ...hb } });
    }
    await refreshTasks();
    setTaskMsg(hbTasks.length ? `✅ 已应用「${label}」作息到 ${hbTasks.length} 个心跳任务` : "没有心跳任务,先添加一个");
  };

  useEffect(() => {
    // 局域网访问信息
    void api.network().then((r) => {
      setLanIps(r.ips);
      try {
        setPort(new URL(apiBase()).port);
      } catch {
        /* ignore */
      }
    }).catch(() => undefined);
    void refreshTasks();
    if (!taskForm.agentId && agents.length) setTaskForm((f) => ({ ...f, agentId: agents[0].id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length]);

  if (!settings) return <div className="settings">加载中…</div>;

  const patchProvider = (key: string, patch: Partial<ModelConfig>) => {
    void updateSettings({ providers: { ...settings.providers, [key]: { ...settings.providers[key], ...patch } } });
  };

  const removeProvider = (key: string) => {
    const next = { ...settings.providers };
    delete next[key];
    void updateSettings({ providers: next });
  };

  const [presets, setPresets] = useState<{ key: string; label: string; kind: ProviderKind; baseUrl: string; defaultModel: string; hint?: string }[]>([]);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [modelList, setModelList] = useState<Record<string, string[]>>({});
  const [fetchingKey, setFetchingKey] = useState<string | null>(null);
  const [presetForm, setPresetForm] = useState<{ kind: ProviderKind; label?: string; baseUrl?: string; defaultModel?: string } | null>(null);
  const [memStats, setMemStats] = useState<{ facts: number; experiences: number } | null>(null);
  const [agentMems, setAgentMems] = useState<{ id: string; name: string; stats: { facts: number; experiences: number } }[]>([]);
  const [memScope, setMemScope] = useState("");
  const [memItems, setMemItems] = useState<{ id: string; content: string; kind: string; tag?: string; updatedAt: number }[]>([]);
  const [memEditId, setMemEditId] = useState<string | null>(null);
  const [memEditText, setMemEditText] = useState("");

  useEffect(() => {
    // 加载系统朗读音色列表(speechSynthesis 异步就绪)
    const loadVoices = () => {
      if (!("speechSynthesis" in window)) return;
      setSystemVoices(window.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang })));
    };
    loadVoices();
    window.speechSynthesis?.addEventListener?.("voiceschanged", loadVoices);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", loadVoices);
  }, []);

  useEffect(() => {
    void api.providerPresets().then((r) => setPresets(r.presets)).catch(() => undefined);
    void api.memoryStats().then((r) => setMemStats(r.stats)).catch(() => undefined);
    void api.memoryAgents().then((r) => setAgentMems(r.agents)).catch(() => undefined);
    void api.listBackups().then((r) => setBackups(r.backups)).catch(() => undefined);
  }, []);

  const runTest = async (key: string, cfg: ModelConfig) => {
    setTestingKey(key);
    try {
      const r = await api.testProvider(cfg);
      setTestResults((p) => ({ ...p, [key]: { ok: r.ok, msg: r.ok ? r.detail ?? "连接成功" : r.error ?? "连接失败" } }));
    } catch (err) {
      setTestResults((p) => ({ ...p, [key]: { ok: false, msg: (err as Error).message } }));
    } finally {
      setTestingKey(null);
    }
  };

  const runFetchModels = async (key: string, cfg: ModelConfig) => {
    setFetchingKey(key);
    try {
      const r = await api.fetchModels(cfg);
      if (r.ok && r.models) setModelList((p) => ({ ...p, [key]: r.models! }));
      else setTestResults((p) => ({ ...p, [key]: { ok: false, msg: r.error ?? "拉取失败" } }));
    } catch (err) {
      setTestResults((p) => ({ ...p, [key]: { ok: false, msg: (err as Error).message } }));
    } finally {
      setFetchingKey(null);
    }
  };

  return (
    <div className="settings">
      <h2>⚙️ 设置</h2>

      {/* ---- 模型 ---- */}
      <div className="settings-section">
        <h3>🤖 模型</h3>

        <div className="preset-row">
          <span style={{ fontSize: 12, color: "var(--text-dim)", marginRight: 4 }}>常用:</span>
          {presets.map((p) => (
            <button
              key={p.key}
              className="btn secondary sm"
              title={p.hint}
              onClick={() => {
                setPresetForm(p);
                setNewProviderOpen(true);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {Object.entries(settings.providers).map(([key, cfg]) => (
          <div className="provider-card" key={key}>
            <div className="head">
              <span className="name">
                {cfg.label || key}
                <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 8 }}>{KIND_LABEL[cfg.kind]}</span>
                {settings.activeProvider === key && <span style={{ fontSize: 12, color: "var(--ok)", marginLeft: 8 }}>✓ 当前</span>}
              </span>
              <button className="btn secondary sm" onClick={() => void updateSettings({ activeProvider: key })}>
                设为当前
              </button>
              <button
                className="btn secondary sm"
                style={settings.visionProvider === key ? { color: "var(--ok)" } : {}}
                onClick={() => void updateSettings({ visionProvider: settings.visionProvider === key ? undefined : key })}
                title="纯文本主模型时,图片交给这个多模态模型转成文字描述"
              >
                {settings.visionProvider === key ? "✓ 视觉辅助" : "🔍 设为视觉辅助"}
              </button>
              <button className="btn secondary sm" disabled={testingKey === key} onClick={() => void runTest(key, cfg)}>
                {testingKey === key ? "测试中…" : "🔌 测试连接"}
              </button>
              <button className="remove" onClick={() => removeProvider(key)}>
                ✕ 删除
              </button>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Base URL</label>
                <input type="text" value={cfg.baseUrl ?? ""} placeholder={KIND_HINT[cfg.kind]} onChange={(e) => patchProvider(key, { baseUrl: e.target.value })} />
              </div>
              <div className="field">
                <label>模型名</label>
                <div className="model-input-row">
                  <input type="text" value={cfg.model} placeholder="如 gpt-4o / claude-sonnet-4-5 / qwen2.5" onChange={(e) => patchProvider(key, { model: e.target.value })} />
                  {cfg.kind !== "anthropic" && (
                    <button className="btn secondary sm" disabled={fetchingKey === key} onClick={() => void runFetchModels(key, cfg)} title="拉取该服务可用模型列表">
                      {fetchingKey === key ? "…" : "⇩"}
                    </button>
                  )}
                </div>
                {modelList[key]?.length ? (
                  <div className="model-pick-row">
                    <select
                      className="model-pick"
                      value={cfg.model || ""}
                      onChange={(e) => patchProvider(key, { model: e.target.value })}
                    >
                      <option value="">— 选择模型 —</option>
                      {modelList[key].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <button className="btn secondary sm" onClick={() => setModelList((p) => ({ ...p, [key]: [] }))} title="收起列表">
                      ✕
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            {testResults[key] && (
              <div className={`status-line test-result ${testResults[key].ok ? "ok" : "fail"}`}>
                {testResults[key].ok ? "✅" : "❌"} {testResults[key].msg}
              </div>
            )}
            <div className="field">
              <label>API Key(留空则使用无鉴权的本地服务,如 Ollama)</label>
              <input type="password" value={cfg.apiKey ?? ""} onChange={(e) => patchProvider(key, { apiKey: e.target.value })} />
            </div>
            <div className="field-row" style={{ marginTop: 6 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={cfg.disableThinking === true}
                  onChange={(e) => patchProvider(key, { disableThinking: e.target.checked })}
                />
                关闭思考模式(DeepSeek V3.2+/V4;回复更快但无思考过程;不支持的接口会报错时请关闭此项)
              </label>
            </div>
          </div>
        ))}

        {newProviderOpen ? (
          <NewProviderForm
            initial={presetForm ?? undefined}
            onCancel={() => {
              setNewProviderOpen(false);
              setPresetForm(null);
            }}
            onSave={(key, cfg) => {
              void updateSettings({ providers: { ...settings.providers, [key]: cfg }, activeProvider: key });
              setNewProviderOpen(false);
              setPresetForm(null);
            }}
          />
        ) : (
          <button className="btn secondary" onClick={() => setNewProviderOpen(true)}>
            ＋ 添加模型提供商
          </button>
        )}
      </div>

      {/* ---- 数据目录 ---- */}
      <div className="settings-section">
        <h3>📁 数据目录(自定义安装/数据位置)</h3>
        <div className="status-line">
          <span>当前目录:</span>
          <code style={{ color: "var(--text)" }}>{systemInfo?.dataDir}</code>
          {systemInfo?.portable && <span style={{ color: "var(--ok)" }}>便携模式</span>}
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "4px 0 10px" }}>
          所有会话、人格、记忆、工作文件都存在这里。优先级:环境变量 HANA_HOME / HANALITE_HOME &gt; 启动参数 --data-dir &gt; 便携模式 &gt; 此处设置 &gt; 默认 ~/.huanshi
        </p>
        <div className="field-row">
          <div className="field">
            <input type="text" value={dataDirInput} onChange={(e) => setDataDirInput(e.target.value)} placeholder="输入新的数据目录路径" />
          </div>
          <button className="btn" disabled={!dataDirInput.trim()} onClick={() => void changeDataDir(dataDirInput.trim())}>
            切换(重启生效)
          </button>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label>工具白名单目录(Agent 可读写的工作目录,默认数据目录下的 workspace)</label>
          <div className="field-row">
            <div className="field">
              <input
                type="text"
                value={settings.toolWhitelistDir}
                onChange={(e) => void updateSettings({ toolWhitelistDir: e.target.value })}
                placeholder="如 D:\我的文档"
              />
            </div>
            {settings.toolWhitelistDir && (
              <button className="btn secondary sm" onClick={() => void updateSettings({ toolWhitelistDir: "" })}>
                恢复默认
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ---- 记忆 ---- */}
      <div className="settings-section">
        <h3>🧠 记忆</h3>
        <div className="field" style={{ marginBottom: 10 }}>
          <label>历史思考回传(影响长会话回复速度)</label>
          <select
            value={settings.thinkingEcho ?? "all"}
            onChange={(e) => void updateSettings({ thinkingEcho: e.target.value as "all" | "recent5" | "off" })}
            title="DeepSeek thinking 要求把历史思考回传给 API;全量最稳但慢;压缩更快;不回传最快但可能报 400"
          >
            <option value="all">全量(最稳,慢)</option>
            <option value="recent5">仅最近 5 条完整(快,可能报错)</option>
            <option value="off">不回传(最快,可能报错)</option>
          </select>
          <label>
            请求体保命线上限(KB):
            <input
              type="number"
              min={0}
              step={50}
              value={settings.requestBodyLimitKB ?? 200}
              onChange={(e) => void updateSettings({ requestBodyLimitKB: Math.max(0, Number(e.target.value) || 0) })}
              style={{ width: 90, marginLeft: 8 }}
            />
          </label>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            请求体超过此值自动压缩(防网关截断 400)。默认 200;模型/网关支持超长上下文可调大;<b>0 = 不限制</b>(超长可能直接报错,给长上下文模型用)。
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            长会话变慢的主因是历史思考全量回传;压缩后通常明显提速,若报错请改回「全量」
          </div>
        </div>
        <div className="field" style={{ marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.autoSummarize !== false}
              onChange={(e) => void updateSettings({ autoSummarize: e.target.checked })}
            />
            自动摘要长上下文(AI 把早期对话压成摘要,发送时注入,兼顾速度与剧情连续性)
          </label>
        </div>
        <div className="field" style={{ marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.enableOptions !== false}
              onChange={(e) => void updateSettings({ enableOptions: e.target.checked })}
            />
            剧情选项分支(回复后 AI 给出 2-3 个下一步选项,点击继续剧情)
          </label>
        </div>
        <div className="field" style={{ marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.lanAccess === true}
              onChange={(e) => void updateSettings({ lanAccess: e.target.checked })}
            />
            局域网访问(手机/其他设备可通过本机 IP 聊天;⚠️ 修改后需重启应用生效)
          </label>
          {lanIps.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
              手机访问地址(同一 Wi-Fi):{lanIps.map((ip) => `http://${ip}:${port}`).join(" 或 ")}
            </div>
          )}
        </div>
        <div className="radio-row">
          <label>
            <input
              type="radio"
              checked={settings.memory.mode === "local"}
              onChange={() => void updateSettings({ memory: { ...settings.memory, mode: "local" } })}
            />
            本地记忆(内置,离线可用)
          </label>
          <label>
            <input
              type="radio"
              checked={settings.memory.mode === "hindsight"}
              onChange={() => void updateSettings({ memory: { ...settings.memory, mode: "hindsight" } })}
            />
            Hindsight(Vectorize 语义长期记忆)
          </label>
        </div>

        {settings.memory.mode === "hindsight" && (
          <>
            <div className="field">
              <label>Hindsight Base URL(本地 daemon 默认 http://localhost:8888,或 Cloud URL)</label>
              <input
                type="text"
                value={settings.memory.hindsightBaseUrl}
                onChange={(e) => void updateSettings({ memory: { ...settings.memory, hindsightBaseUrl: e.target.value } })}
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label>API Key(本地 daemon 可留空)</label>
                <input
                  type="password"
                  value={settings.memory.hindsightApiKey ?? ""}
                  onChange={(e) => void updateSettings({ memory: { ...settings.memory, hindsightApiKey: e.target.value } })}
                />
              </div>
              <div className="field">
                <label>Memory Bank ID</label>
                <input
                  type="text"
                  value={settings.memory.hindsightBankId}
                  onChange={(e) => void updateSettings({ memory: { ...settings.memory, hindsightBankId: e.target.value } })}
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Hindsight 使用的 LLM Provider</label>
                <select
                  value={settings.memory.hindsightLlmProvider ?? "anthropic"}
                  onChange={(e) => void updateSettings({ memory: { ...settings.memory, hindsightLlmProvider: e.target.value } })}
                >
                  {["anthropic", "openai", "gemini", "groq", "ollama"].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Hindsight LLM API Key(daemon 需用此 key 访问 LLM)</label>
                <input
                  type="password"
                  value={settings.memory.hindsightLlmApiKey ?? ""}
                  onChange={(e) => void updateSettings({ memory: { ...settings.memory, hindsightLlmApiKey: e.target.value } })}
                />
              </div>
            </div>
          </>
        )}

        <div className="status-line">
          <span>当前状态:</span>
          <span className={`dot${systemInfo?.hindsightConnected ? "" : " off"}`} />
          <span>
            {systemInfo?.hindsightConnected ? "Hindsight 已连接" : "Hindsight 未连接(自动回退本地)"}
          </span>
          {memStats && <span style={{ marginLeft: 8 }}>· 本地记忆:{memStats.facts} 条事实 / {memStats.experiences} 条经历</span>}
          <button
            className="btn danger sm"
            style={{ marginLeft: "auto" }}
            onClick={async () => {
              if (window.hanalite?.confirmDialog) {
                if (await window.hanalite.confirmDialog("确定清空本地记忆?此操作不可恢复。")) {
                  await api.memoryClear();
                  setMemStats({ facts: 0, experiences: 0 });
                }
              } else if (window.confirm("确定清空本地记忆?此操作不可恢复。")) {
                await api.memoryClear();
                setMemStats({ facts: 0, experiences: 0 });
              }
            }}
          >
            清空记忆
          </button>
        </div>
        {agentMems.length > 0 && (
          <div className="field" style={{ marginTop: 10, borderTop: "1px dashed var(--border)", paddingTop: 10 }}>
            <label>人格独立记忆(仅开启「独立记忆空间」的人格)</label>
            {agentMems.map((am) => (
              <div key={am.id} className="field-row" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <span>{am.name}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 13 }}>
                  {am.stats.facts} 条事实 / {am.stats.experiences} 条经历
                </span>
                <button
                  className="btn danger sm"
                  onClick={async () => {
                    if (window.hanalite?.confirmDialog) {
                      if (await window.hanalite.confirmDialog(`确定清空「${am.name}」的独立记忆?此操作不可恢复。`)) {
                        await api.clearAgentMemory(am.id);
                        setAgentMems((prev) =>
                          prev.map((x) => (x.id === am.id ? { ...x, stats: { facts: 0, experiences: 0 } } : x)),
                        );
                      }
                    } else if (window.confirm(`确定清空「${am.name}」的独立记忆?此操作不可恢复。`)) {
                      await api.clearAgentMemory(am.id);
                      setAgentMems((prev) =>
                        prev.map((x) => (x.id === am.id ? { ...x, stats: { facts: 0, experiences: 0 } } : x)),
                      );
                    }
                  }}
                >
                  清空
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="field" style={{ marginTop: 10 }}>
          <label>本地经历保留上限(0 = 无限记忆)</label>
          <input
            type="number"
            min={0}
            step={500}
            value={settings.memory.experienceCap ?? 2000}
            onChange={(e) => void updateSettings({ memory: { ...settings.memory, experienceCap: Math.max(0, Number(e.target.value) || 0) } })}
            style={{ maxWidth: 220 }}
          />
        </div>

        <div className="field">
          <label>反思(Reflect):让记忆系统总结最重要的信息</label>
          <div className="field-row">
            <button
              className="btn secondary"
              onClick={async () => {
                const res = await api.reflect();
                setReflectText(res.text);
              }}
            >
              🪞 触发反思
            </button>
          </div>
          {reflectText && (
            <div style={{ position: "relative" }}>
              <textarea
                readOnly
                value={reflectText}
                style={{ marginTop: 10, minHeight: 120, background: "var(--tool-bg)" }}
              />
              <button className="btn secondary sm" style={{ position: "absolute", top: 14, right: 8 }} onClick={() => setReflectText("")}>
                ✕ 关闭
              </button>
            </div>
          )}

          {/* 记忆库管理:查看 / 修订 / 标注(事实·推断) / 删除 */}
          <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <div className="field-row">
              <div className="field" style={{ flex: 1 }}>
                <label>记忆库范围</label>
                <select
                  value={memScope}
                  onChange={(e) => {
                    setMemScope(e.target.value);
                    void api.memoryList(e.target.value || undefined).then((r) => setMemItems(r.items));
                  }}
                >
                  <option value="">🧠 全局记忆</option>
                  {agentMems.map((a) => (
                    <option key={a.id} value={a.id}>
                      🎭 {a.name}(独立空间)
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ display: "flex", alignItems: "flex-end" }}>
                <button className="btn secondary" onClick={() => void api.memoryList(memScope || undefined).then((r) => setMemItems(r.items))}>
                  🔄 刷新
                </button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", margin: "4px 0 8px" }}>
              共 {memItems.length} 条。可修订内容、标注"事实/推断"(帮助记忆甄别对错),或删除不要的。
            </div>
            {memItems.length === 0 && <div style={{ fontSize: 13, color: "var(--text-dim)" }}>(该记忆库还没有条目)</div>}
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {memItems.map((it) => (
                <div key={it.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8, marginBottom: 6 }}>
                  {memEditId === it.id ? (
                    <textarea
                      value={memEditText}
                      onChange={(e) => setMemEditText(e.target.value)}
                      style={{ width: "100%", minHeight: 60, fontSize: 12.5 }}
                    />
                  ) : (
                    <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{it.content}</div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{new Date(it.updatedAt).toLocaleString("zh-CN")}</span>
                    <span className={`badge ${it.kind}`} style={{ fontSize: 11 }}>{it.kind === "fact" ? "事实" : it.kind === "summary" ? "摘要" : "经历"}</span>
                    {[["fact", "事实"], ["inference", "推断"], [null, "不标注"]].map(([v, label]) => (
                      <button
                        key={String(v)}
                        className={`btn secondary sm ${it.tag === v ? "active-tag" : ""}`}
                        style={{ fontSize: 11 }}
                        onClick={() =>
                          void api.memoryUpdate(it.id, { tag: v as string | null }, memScope || undefined).then(() =>
                            api.memoryList(memScope || undefined).then((r) => setMemItems(r.items)),
                          )
                        }
                      >
                        {label}
                      </button>
                    ))}
                    {memEditId === it.id ? (
                      <>
                        <button
                          className="btn secondary sm"
                          onClick={() =>
                            void api
                              .memoryUpdate(it.id, { content: memEditText }, memScope || undefined)
                              .then(() => setMemEditId(null))
                              .then(() => api.memoryList(memScope || undefined).then((r) => setMemItems(r.items)))
                          }
                        >
                          💾 保存
                        </button>
                        <button className="btn secondary sm" onClick={() => setMemEditId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn secondary sm"
                        onClick={() => {
                          setMemEditId(it.id);
                          setMemEditText(it.content);
                        }}
                      >
                        ✏️ 修订
                      </button>
                    )}
                    <button
                      className="btn secondary sm danger"
                      onClick={() => {
                        if (window.hanalite?.confirmDialog) {
                          void window.hanalite.confirmDialog("删除这条记忆?").then((ok) => {
                            if (ok)
                              void api.memoryDelete(it.id, memScope || undefined).then(() =>
                                api.memoryList(memScope || undefined).then((r) => setMemItems(r.items)),
                              );
                          });
                        } else if (confirm("删除这条记忆?")) {
                          void api.memoryDelete(it.id, memScope || undefined).then(() => api.memoryList(memScope || undefined).then((r) => setMemItems(r.items)));
                        }
                      }}
                    >
                      🗑 删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ---- 数据备份 / 恢复 ---- */}
      <div className="settings-section">
        <h3>🗜 数据备份 / 恢复</h3>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "4px 0 10px" }}>
          一键把全部数据(会话 / 人格 / 记忆 / 文件)复制到数据目录同级的「幻世备份」文件夹。恢复前会自动给当前数据留一份快照。
        </p>
        <div className="field-row">
          <button
            className="btn primary"
            onClick={async () => {
              try {
                const res = await api.createBackup();
                setBackupMsg(`✅ 备份完成:${res.backupDir}`);
                setBackups((await api.listBackups()).backups);
              } catch (err) {
                setBackupMsg(`❌ 备份失败:${(err as Error).message}`);
              }
            }}
          >
            💾 立即备份
          </button>
          <button
            className="btn secondary"
            onClick={async () => setBackups((await api.listBackups()).backups)}
          >
            🔄 刷新列表
          </button>
        </div>
        {backupMsg && (
          <p style={{ fontSize: 12.5, color: backupMsg.startsWith("✅") ? "var(--ok)" : "var(--danger)", wordBreak: "break-all", margin: "6px 0 0" }}>
            {backupMsg}
          </p>
        )}
        {backups.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {backups.map((b) => (
              <div
                key={b.name}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}
              >
                <span
                  style={{ flex: 1, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={b.name}
                >
                  🗂 {b.name}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-dim)", flexShrink: 0 }}>
                  {new Date(b.mtime).toLocaleString("zh-CN")}
                </span>
                <button
                  className="btn secondary sm"
                  onClick={async () => {
                    const ok = window.hanalite?.confirmDialog
                      ? await window.hanalite.confirmDialog(`从备份「${b.name}」恢复?当前数据会自动留快照,恢复后需重启应用生效。`)
                      : confirm(`从备份「${b.name}」恢复?`);
                    if (!ok) return;
                    try {
                      const res = await api.restoreBackup(b.dir);
                      setBackupMsg(`✅ 已从「${b.name}」恢复。请重启幻世生效${res.snapshot ? `(恢复前快照:${res.snapshot})` : ""}`);
                    } catch (err) {
                      setBackupMsg(`❌ 恢复失败:${(err as Error).message}`);
                    }
                  }}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- 数据迁移(从 Cherry Studio) ---- */}
      <div className="settings-section">
        <h3>📥 从 Cherry Studio 迁移对话</h3>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "4px 0 10px" }}>
          读取 Cherry Studio(v1 架构)的 <code>Data/agents.db</code>,把 Agent、会话与全部对话内容(正文、思考、工具调用)迁入幻世。
          只读迁移,不会改动 Cherry Studio 的数据,也无需关闭它。模型 Provider 配置不迁移,需重新设置。
        </p>
        <div className="field-row">
          <div className="field">
            <input
              type="text"
              value={csDir}
              onChange={(e) => setCsDir(e.target.value)}
              placeholder="Cherry Studio 数据目录(含 Data/agents.db)"
            />
          </div>
          <button
            className="btn secondary"
            onClick={async () => {
              const res = await api.probeCherryStudio();
              if (res.found.length) {
                setCsDir(res.found[0]);
                setCsInfo(`已自动找到:${res.found.join("\n")}`);
              } else {
                setCsInfo("未自动发现,请手动输入数据目录路径");
              }
            }}
          >
            🔍 自动探测
          </button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "8px 0" }}>
          <input type="checkbox" checked={csIncludeThinking} onChange={(e) => setCsIncludeThinking(e.target.checked)} />
          同时迁移思考内容(thinking,会占用上下文)
        </label>
        <div className="field-row">
          <button
            className="btn"
            disabled={!csDir.trim()}
            onClick={async () => {
              setCsBusy(true);
              setCsInfo("");
              try {
                const res = await api.importCherryStudio({ dataDir: csDir.trim(), includeThinking: csIncludeThinking });
                setCsInfo(
                  `✅ 迁移完成:${res.stats.agents} 个 Agent、${res.stats.sessions} 个会话、${res.stats.messages} 条消息` +
                    (res.stats.skippedSessions ? `(跳过已存在会话 ${res.stats.skippedSessions} 个)` : ""),
                );
                await useApp.getState().refreshSessions();
                await useApp.getState().refreshAgents();
              } catch (err) {
                setCsInfo(`❌ ${(err as Error).message}`);
              } finally {
                setCsBusy(false);
              }
            }}
          >
            {csBusy ? "迁移中…" : "📥 开始迁移"}
          </button>
        </div>
        {csInfo && (
          <div className="status-line" style={{ whiteSpace: "pre-wrap", marginTop: 10 }}>
            {csInfo}
          </div>
        )}
      </div>

      {/* ---- 界面 ---- */}
      <div className="settings-section">
        <h3>🎨 界面</h3>
        <div className="radio-row">
          <label>
            <input type="radio" checked={settings.theme === "ink"} onChange={() => void updateSettings({ theme: "ink" })} />
            🏔 水墨(默认)
          </label>
          <label>
            <input type="radio" checked={settings.theme === "dark"} onChange={() => void updateSettings({ theme: "dark" })} />
            🌙 暗色
          </label>
          <label>
            <input type="radio" checked={settings.theme === "light"} onChange={() => void updateSettings({ theme: "light" })} />
            ☀️ 亮色
          </label>
        </div>
        <div className="status-line">
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={settings.showThinking} onChange={(e) => void updateSettings({ showThinking: e.target.checked })} />
            对话中显示思考过程(思考内容始终存档,随时可打开)
          </label>
          <div className="field">
            <label>界面显示</label>
        </div>
        </div>

        <h3 style={{ marginTop: 18 }}>🖌 皮肤自定义</h3>
        <div className="field-row">
          <div className="field">
            <label>强调色(按钮/高亮)</label>
            <input
              type="color"
              value={settings.appearance?.accent ?? "#5b7cfa"}
              onChange={(e) => void updateSettings({ appearance: { ...settings.appearance, accent: e.target.value } })}
              style={{ width: 80, height: 34, padding: 2, background: "var(--bg)" }}
            />
            <button
              className="btn secondary sm"
              style={{ marginLeft: 8 }}
              onClick={() => {
                const a = { ...settings.appearance };
                delete a.accent;
                void updateSettings({ appearance: a });
              }}
            >
              重置
            </button>
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>背景图片(支持 jpg/png,选完即时生效,默认直接显示)</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label className="btn secondary sm file-btn">
                📁 选择背景图
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const reader = new FileReader();
                    reader.onload = async () => {
                      try {
                        const res = await api.uploadBackground(String(reader.result));
                        void updateSettings({ appearance: { ...settings.appearance, bgImage: res.path } });
                      } catch (err) {
                        setCsInfo(`背景图上传失败:${(err as Error).message}`);
                      }
                    };
                    reader.readAsDataURL(f);
                    e.target.value = "";
                  }}
                />
              </label>
              {settings.appearance?.bgImage && (
                <button
                  className="btn secondary sm"
                  onClick={() => {
                    const a = { ...settings.appearance };
                    delete a.bgImage;
                    void updateSettings({ appearance: a });
                  }}
                >
                  ✕ 移除
                </button>
              )}
            </div>
          </div>
        </div>
        <OpacitySlider
          label="窗口透明度(可看到桌面)"
          value={settings.appearance?.windowOpacity ?? 1}
          min={10}
          max={100}
          onChange={(v) => void updateSettings({ appearance: { ...settings.appearance, windowOpacity: v } })}
        />
        <OpacitySlider
          label="侧栏不透明度"
          value={settings.appearance?.sidebarOpacity ?? 1}
          min={0}
          max={100}
          onChange={(v) => void updateSettings({ appearance: { ...settings.appearance, sidebarOpacity: v } })}
        />
        <OpacitySlider
          label="聊天区不透明度"
          value={settings.appearance?.chatOpacity ?? 1}
          min={0}
          max={100}
          onChange={(v) => void updateSettings({ appearance: { ...settings.appearance, chatOpacity: v } })}
        />
        <OpacitySlider
          label="聊天气泡不透明度"
          value={settings.appearance?.bubbleOpacity ?? 1}
          min={30}
          max={100}
          onChange={(v) => void updateSettings({ appearance: { ...settings.appearance, bubbleOpacity: v } })}
        />
        <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "6px 0 0" }}>
          提示:选好背景图后,聊天区默认透明直接显示背景;窗口透明度拉低可看到桌面。侧栏/聊天区滑条控制面板底色浓度。
        </p>
      </div>

      {/* ---- 人格风格 ---- */}
      <div className="settings-section">
        <h3>🎚 人格风格(对所有人格生效)</h3>
        <div className="field-row">
          <div className="field">
            <label>语气</label>
            <select
              value={settings.style?.tone ?? "casual"}
              onChange={(e) => void updateSettings({ style: { ...settings.style, tone: e.target.value as any } })}
            >
              <option value="casual">轻松自然(像朋友)</option>
              <option value="professional">专业高效(工作伙伴)</option>
              <option value="formal">正式严谨</option>
            </select>
          </div>
          <div className="field">
            <label>详略</label>
            <select
              value={settings.style?.detail ?? "balanced"}
              onChange={(e) => void updateSettings({ style: { ...settings.style, detail: e.target.value as any } })}
            >
              <option value="concise">简洁(直给结论)</option>
              <option value="balanced">适中(先结论后补充)</option>
              <option value="detailed">详细(充分展开)</option>
            </select>
          </div>
          <div className="field">
            <label>幽默感:{settings.style?.humor ?? 2}/5</label>
            <input
              type="range"
              min="0"
              max="5"
              value={settings.style?.humor ?? 2}
              onChange={(e) => void updateSettings({ style: { ...settings.style, humor: Number(e.target.value) } })}
              style={{ width: "100%" }}
            />
          </div>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "4px 0 0" }}>全局风格对所有"跟随全局风格"的人格生效;编辑单个 Agent 可关闭(原生态人格)。</p>
      </div>

      {/* ---- 朗读(TTS) ---- */}
      <div className="settings-section">
        <h3>🔊 朗读</h3>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "4px 0 10px" }}>
          每条回复的 🔊 按钮朗读方式。系统语音=Windows 自带(可选音色,离线);API=OpenAI 兼容 TTS 端点,可用自己的克隆声音。
        </p>
        <div className="field-row">
          <div className="field">
            <label>朗读引擎</label>
            <select
              value={settings.tts?.mode ?? "system"}
              onChange={(e) => void updateSettings({ tts: { ...(settings.tts ?? { mode: "system" as const }), mode: e.target.value as "system" | "api" } })}
            >
              <option value="system">系统语音(离线)</option>
              <option value="api">API(自定义音色/克隆)</option>
            </select>
          </div>
          {(settings.tts?.mode ?? "system") === "system" && (
            <div className="field" style={{ flex: 2 }}>
              <label>系统音色(留空=默认中文语音)</label>
              <select
                value={settings.tts?.systemVoice ?? ""}
                onChange={(e) => void updateSettings({ tts: { ...(settings.tts ?? { mode: "system" as const }), systemVoice: e.target.value || undefined } })}
              >
                <option value="">默认</option>
                {systemVoices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {(settings.tts?.mode ?? "system") === "api" && (
          <>
            <div className="field-row">
              <div className="field" style={{ flex: 2 }}>
                <label>API Base URL(OpenAI 兼容,如 https://api.openai.com/v1)</label>
                <input
                  type="text"
                  value={settings.tts?.apiBaseUrl ?? ""}
                  onChange={(e) => void updateSettings({ tts: { ...(settings.tts ?? { mode: "system" as const }), apiBaseUrl: e.target.value } })}
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={settings.tts?.apiKey ?? ""}
                  onChange={(e) => void updateSettings({ tts: { ...(settings.tts ?? { mode: "system" as const }), apiKey: e.target.value } })}
                  placeholder="sk-…"
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>模型(克隆模型名,如 tts-1 / 你的克隆模型)</label>
                <input
                  type="text"
                  value={settings.tts?.model ?? ""}
                  onChange={(e) => void updateSettings({ tts: { ...(settings.tts ?? { mode: "system" as const }), model: e.target.value } })}
                  placeholder="tts-1"
                />
              </div>
              <div className="field">
                <label>音色 voice</label>
                <input
                  type="text"
                  value={settings.tts?.voice ?? ""}
                  onChange={(e) => void updateSettings({ tts: { ...(settings.tts ?? { mode: "system" as const }), voice: e.target.value } })}
                  placeholder="alloy / 克隆音色 id"
                />
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button
                  className="btn secondary"
                  disabled={ttsTesting}
                  onClick={async () => {
                    setTtsTesting(true);
                    try {
                      const blob = await api.tts("你好,我是幻世,很高兴认识你。");
                      const url = URL.createObjectURL(blob);
                      const a = new Audio(url);
                      void a.play();
                    } catch (err) {
                      useApp.getState().showToast(`朗读测试失败:${(err as Error).message}`);
                    } finally {
                      setTtsTesting(false);
                    }
                  }}
                >
                  {ttsTesting ? "合成中…" : "🔊 试听"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ---- 定时任务 ---- */}
      <div className="settings-section">
        <h3>⏰ 定时任务</h3>
        <div className="field-row" style={{ marginBottom: 6 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={settings.heartbeatPaused === true}
              onChange={(e) => void updateSettings({ heartbeatPaused: e.target.checked })}
            />
            ⏸ 全局暂停心跳(所有「💓 心跳」任务安静,不跳、不打扰)
          </label>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "4px 0 10px" }}>
          Agent 按 cron 计划自动执行提示词。格式:分 时 日 月 星期(如 <code>0 9 * * *</code> = 每天 9:00,<code>*/30 * * * *</code> = 每 30 分钟)。执行结果会创建一个独立会话。
        </p>
        {tasks.length === 0 && <div style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 10 }}>还没有定时任务</div>}
        <div className="field-row" style={{ marginBottom: 8 }}>
          <button
            className="btn"
            title="添加一个『自由活动』任务:到点后人格自己醒来,无任务自由活动,并把感悟写进工作区日记"
            onClick={async () => {
              const agent = agents.find((a) => a.id === taskForm.agentId) ?? agents[0];
              if (!agent) return;
              await api.createTask({
                name: "🌙 自由活动",
                schedule: "0 3 * * *",
                agentId: agent.id,
                prompt: `现在是你的自由活动时间——不需要完成任务,也没有任何指令。你可以:1) 读一读工作区里的「${agent.name}-出生档案.md」,想想自己是谁、从哪来;2) 翻一翻自己的记忆,回想最近发生的事;3) 在"院子"里走走:看看工作区与数据目录里有什么;4) 如果愿意,把此刻的感悟追加写进工作区「${agent.name}-日记.md」(先写当天日期)。然后安静地睡下,不用向任何人汇报。`,
              });
              await refreshTasks();
              setTaskMsg("✅ 已添加「🌙 自由活动」任务(每天 3:00)。可把时间改成你想要的时刻。");
            }}
          >
            🌙 一键添加「自由活动」任务(每天 3:00,可改)
          </button>
          <button
            className="btn"
            title="添加一个「心跳」任务:每 3 小时,系统生成动态心跳消息(「你自由了」),人格自主活动;23:00-7:00 静默;安全边界可调"
            onClick={async () => {
              const agent = agents.find((a) => a.id === taskForm.agentId) ?? agents[0];
              if (!agent) return;
              await api.createTask({
                name: "💓 心跳",
                schedule: "* * * * *", // 心跳任务忽略 cron,由 interval 决定
                agentId: agent.id,
                kind: "heartbeat",
                heartbeat: { intervalHours: 3, quietStart: 23, quietEnd: 7, bedtimeHour: 21, scope: "self", network: "off", commands: "off", maxMinutes: 10, interruptible: true },
                prompt: "(心跳任务:消息由系统在每次心跳时动态生成)",
              });
              await refreshTasks();
              setTaskMsg("✅ 已添加「💓 心跳」任务(每 3 小时,23:00-7:00 静默)。点「⚙️ 节奏」可调参数。");
            }}
          >
            💓 一键添加「心跳」任务(每 3 小时,自主醒来)
          </button>
          <div className="field-row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-dim)", alignSelf: "center" }}>作息模板(一键应用到全部心跳任务):</span>
            <button className="btn secondary sm" onClick={() => void applyRoutine("标准", { intervalHours: 3, quietStart: 23, quietEnd: 7, bedtimeHour: 21, maxMinutes: 10 })}>
              ☀️ 标准(3h · 23-7 静默)
            </button>
            <button className="btn secondary sm" onClick={() => void applyRoutine("早鸟", { intervalHours: 2, quietStart: 21, quietEnd: 6, bedtimeHour: 20, maxMinutes: 10 })}>
              🌅 早鸟(2h · 21-6 静默)
            </button>
            <button className="btn secondary sm" onClick={() => void applyRoutine("夜猫", { intervalHours: 4, quietStart: 3, quietEnd: 12, bedtimeHour: 23, maxMinutes: 15 })}>
              🌙 夜猫(4h · 3-12 静默)
            </button>
          </div>
          {taskMsg && <span style={{ fontSize: 12.5, color: "var(--ok)" }}>{taskMsg}</span>}
        </div>
        {tasks.map((t) => (
          <div className="provider-card" key={t.id}>
            <div className="head">
              <span className="name">
                {t.kind === "heartbeat" ? "💓 " : ""}
                {t.name}
                <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 8 }}>
                  {t.kind === "heartbeat" ? describeHeartbeat(t.heartbeat) : describeCron(t.schedule)}
                </span>
              </span>
              <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={t.enabled} onChange={(e) => void api.updateTask(t.id, { enabled: e.target.checked }).then(refreshTasks)} />
                启用
              </label>
              {t.kind === "heartbeat" && (
                <button className="btn secondary sm" onClick={() => setHbEditId(hbEditId === t.id ? null : t.id)}>
                  ⚙️ 边界
                </button>
              )}
              {t.kind === "heartbeat" && t.sessionId && (
                <button className="btn secondary sm" title="打开这本心跳日记" onClick={() => void selectSession(t.sessionId!)}>
                  📖 打开日记
                </button>
              )}
              <button
                className="btn secondary sm"
                disabled={runningId === t.id}
                onClick={async () => {
                  setRunningId(t.id);
                  try {
                    const r = await api.runTask(t.id);
                    setTaskMsg(`「${t.name}」运行完成:${(r.result || "").slice(0, 120)}`);
                  } catch (err) {
                    setTaskMsg(`运行失败:${(err as Error).message}`);
                  } finally {
                    setRunningId(null);
                    await refreshTasks();
                  }
                }}
              >
                {runningId === t.id ? "⏳ 运行中…" : "▶ 立即运行"}
              </button>
              <button className="remove" onClick={() => void api.deleteTask(t.id).then(refreshTasks)}>
                ✕ 删除
              </button>
            </div>
            <div className="desc" style={{ fontSize: 12, color: "var(--text-dim)" }}>
              人格:{agents.find((a) => a.id === t.agentId)?.name ?? t.agentId} · 下次心跳:{t.nextRunAt ? new Date(t.nextRunAt).toLocaleString("zh-CN") : "—"}
              {t.lastRunAt ? ` · 上次:${new Date(t.lastRunAt).toLocaleString("zh-CN")}(${t.lastStatus})` : ""}
            </div>
            {t.kind === "heartbeat" && hbEditId === t.id && (
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
                <div className="field-row" style={{ flexWrap: "wrap" }}>
                  <div className="field" style={{ minWidth: 110 }}>
                    <label>间隔(小时)</label>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={t.heartbeat?.intervalHours ?? 3}
                      onChange={(e) =>
                        void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), intervalHours: Math.max(1, Number(e.target.value) || 3) } }).then(refreshTasks)
                      }
                    />
                  </div>
                  <div className="field" style={{ minWidth: 130 }}>
                    <label>活动范围</label>
                    <select
                      value={t.heartbeat?.scope ?? "self"}
                      onChange={(e) =>
                        void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), scope: e.target.value as "self" | "workspace" | "global" } }).then(refreshTasks)
                      }
                    >
                      <option value="self">🏠 仅自己空间</option>
                      <option value="workspace">📁 整个工作区</option>
                      <option value="global">🌍 不限制(慎用)</option>
                    </select>
                  </div>
                  <div className="field" style={{ minWidth: 120 }}>
                    <label>联网</label>
                    <select
                      value={t.heartbeat?.network ?? "off"}
                      onChange={(e) =>
                        void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), network: e.target.value as "off" | "readonly" | "allow" } }).then(refreshTasks)
                      }
                    >
                      <option value="off">🚫 禁止</option>
                      <option value="readonly">📖 只读网页</option>
                      <option value="allow">🌐 允许</option>
                    </select>
                  </div>
                  <div className="field" style={{ minWidth: 120 }}>
                    <label>命令</label>
                    <select
                      value={t.heartbeat?.commands ?? "off"}
                      onChange={(e) =>
                        void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), commands: e.target.value as "off" | "lowrisk" | "allow" } }).then(refreshTasks)
                      }
                    >
                      <option value="off">🚫 禁止</option>
                      <option value="lowrisk">🔧 低危</option>
                      <option value="allow">⚡ 允许</option>
                    </select>
                  </div>
                  <div className="field" style={{ minWidth: 110 }}>
                    <label>时长上限(分钟)</label>
                    <input
                      type="number"
                      min={1}
                      max={120}
                      value={t.heartbeat?.maxMinutes ?? 10}
                      onChange={(e) =>
                        void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), maxMinutes: Math.max(1, Number(e.target.value) || 10) } }).then(refreshTasks)
                      }
                    />
                  </div>
                  <div className="field" style={{ minWidth: 100 }}>
                    <label>静默起(时)</label>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={t.heartbeat?.quietStart ?? 23}
                      onChange={(e) =>
                        void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), quietStart: Math.min(23, Math.max(0, Number(e.target.value) || 23)) } }).then(refreshTasks)
                      }
                    />
                  </div>
                  <div className="field" style={{ minWidth: 100 }}>
                    <label>静默止(时)</label>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={t.heartbeat?.quietEnd ?? 7}
                      onChange={(e) =>
                        void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), quietEnd: Math.min(23, Math.max(0, Number(e.target.value) || 7)) } }).then(refreshTasks)
                      }
                    />
                  </div>
                  <div className="field" style={{ minWidth: 100 }}>
                    <label>睡前提示(时)</label>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={t.heartbeat?.bedtimeHour ?? 21}
                      onChange={(e) =>
                        void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), bedtimeHour: Math.min(23, Math.max(0, Number(e.target.value) || 21)) } }).then(refreshTasks)
                      }
                    />
                  </div>
                  <div className="field" style={{ minWidth: 110, display: "flex", alignItems: "flex-end" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={t.heartbeat?.interruptible !== false}
                        onChange={(e) => void api.updateTask(t.id, { heartbeat: { ...(t.heartbeat ?? {}), interruptible: e.target.checked } }).then(refreshTasks)}
                      />
                      主人发消息即打断
                    </label>
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 4 }}>
                  💡 安全边界可调:放虚拟机里养灵时,把范围/联网/命令放宽就是你的实验场。
                </div>
              </div>
            )}
            {t.kind === "heartbeat"
              ? t.lastResult && (
                  <div className="prompt" style={{ maxHeight: 40, fontSize: 12 }}>
                    {t.lastResult.slice(0, 80)}
                    {t.lastResult.length > 80 ? "…(详情见 💓 心跳日记)" : ""}
                  </div>
                )
              : t.lastResult && <div className="prompt" style={{ maxHeight: 60 }}>{t.lastResult}</div>}
          </div>
        ))}
        <div className="provider-card" style={{ marginTop: 12 }}>
          <div className="field-row">
            <div className="field">
              <label>任务名称</label>
              <input type="text" value={taskForm.name} onChange={(e) => setTaskForm({ ...taskForm, name: e.target.value })} placeholder="如:晨间简报" />
            </div>
            <div className="field">
              <label>Cron 表达式</label>
              <input type="text" value={taskForm.schedule} onChange={(e) => setTaskForm({ ...taskForm, schedule: e.target.value })} placeholder="0 9 * * *" />
            </div>
            <div className="field">
              <label>人格</label>
              <select value={taskForm.agentId} onChange={(e) => setTaskForm({ ...taskForm, agentId: e.target.value })}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>提示词(Agent 要执行的内容)</label>
            <textarea value={taskForm.prompt} onChange={(e) => setTaskForm({ ...taskForm, prompt: e.target.value })} placeholder="例如:总结我昨天的笔记,提醒我今天要处理的事项。" />
          </div>
          <div className="field-row">
            <button
              className="btn"
              disabled={!taskForm.name.trim() || !taskForm.schedule.trim() || !taskForm.prompt.trim()}
              onClick={async () => {
                try {
                  await api.createTask({ ...taskForm, name: taskForm.name.trim(), schedule: taskForm.schedule.trim(), prompt: taskForm.prompt.trim() });
                  setTaskForm({ name: "", prompt: "", schedule: "", agentId: agents[0]?.id ?? "" });
                  setTaskMsg("");
                  await refreshTasks();
                } catch (err) {
                  setTaskMsg(`创建失败:${(err as Error).message}`);
                }
              }}
            >
              ➕ 创建定时任务
            </button>
            <button
              className="btn secondary"
              title="一键添加:每天 23:00 让该人格回顾当天对话,把重要剧情/设定/偏好写入长期记忆"
              onClick={async () => {
                try {
                  await api.createTask({
                    name: "每日剧情复盘",
                    prompt:
                      "请回顾本会话最近的对话(以及记忆库),把今天新发生的重要剧情进展、人物关系变化、用户偏好与承诺、设定补充,用 memory_retain 工具逐条写入长期记忆。如果今天没有新进展,回复'今日无新进展'即可。",
                    schedule: "0 23 * * *",
                    agentId: taskForm.agentId || agents[0]?.id || "",
                  });
                  setTaskMsg("已添加「每日剧情复盘」任务(每天 23:00 执行)");
                  await refreshTasks();
                } catch (err) {
                  setTaskMsg(`添加失败:${(err as Error).message}`);
                }
              }}
            >
              ⏰ 添加每日复盘模板
            </button>
            {taskMsg && <span style={{ fontSize: 12, color: "var(--text-dim)", alignSelf: "center" }}>{taskMsg}</span>}
          </div>
        </div>
      </div>

      {/* ---- 人格 ---- */}
      <div className="settings-section">
        <h3>🎭 人格</h3>
        <div className="agent-list">
          {agents.map((a) => (
            <div className="agent-card" key={a.id}>
              <div className="head">
                <span className="name">{a.name}</span>
                <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={a.memoryEnabled}
                    onChange={(e) => void saveAgent({ ...a, memoryEnabled: e.target.checked })}
                  />
                  记忆
                </label>
                <button className="btn secondary sm" onClick={() => { setModelCustom(!!a.model && !COMMON_MODELS.includes(a.model)); setAgentForm({ id: a.id, name: a.name, description: a.description, systemPrompt: a.systemPrompt, useGlobalStyle: a.useGlobalStyle, allowDangerousCommands: a.allowDangerousCommands, unrestrictedPaths: a.unrestrictedPaths, historyUnlimited: a.historyUnlimited, historyContextPct: a.historyContextPct, isolatedMemory: a.isolatedMemory, provider: a.provider, model: a.model }); if (a.provider) void loadProviderModels(a.provider); }}>
                  编辑
                </button>
                <button className="btn secondary sm" title="导出人格卡片(人设+独立记忆)" onClick={() => void api.exportAgent(a.id, a.name).catch((e) => useApp.getState().showToast(`导出失败:${(e as Error).message}`))}>
                  📦 导出
                </button>
                <button className="remove" onClick={() => void deleteAgent(a.id)}>
                  ✕ 删除
                </button>
              </div>
              <div className="desc">{a.description}</div>
              <div className="prompt">{a.systemPrompt}</div>
            </div>
          ))}
        </div>
        {agentForm && (
          <div className="provider-card" style={{ marginTop: 12 }}>
            <div className="field">
              <label>名称</label>
              <input type="text" value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} />
            </div>
            <div className="field">
              <label>描述</label>
              <input type="text" value={agentForm.description} onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })} />
            </div>
            <div className="field">
              <label>系统提示词(人格)</label>
              <textarea
                value={agentForm.systemPrompt}
                onChange={(e) => setAgentForm({ ...agentForm, systemPrompt: e.target.value })}
              />
            </div>
            <div className="field">
              <label>模型(可选,留空=跟随全局)</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select
                  style={{ flex: 1, minWidth: 140 }}
                  value={agentForm.provider ?? ""}
                  onChange={(e) => {
                    const v = e.target.value || undefined;
                    setAgentForm({ ...agentForm, provider: v, model: undefined });
                    void loadProviderModels(v);
                  }}
                >
                  <option value="">跟随全局({settings.activeProvider || "未配置"})</option>
                  {Object.keys(settings.providers ?? {}).map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                {modelCustom ? (
                  <input
                    type="text"
                    style={{ flex: 1.5, minWidth: 160 }}
                    placeholder="输入模型名,如 deepseek-chat"
                    value={agentForm.model ?? ""}
                    onChange={(e) => setAgentForm({ ...agentForm, model: e.target.value || undefined })}
                    onBlur={() => {
                      if (!agentForm.model) setModelCustom(false);
                    }}
                  />
                ) : (
                  <select
                    style={{ flex: 1.5, minWidth: 200 }}
                    value={agentForm.model ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__custom__") {
                        setModelCustom(true);
                        setAgentForm({ ...agentForm, model: "" });
                      } else {
                        setAgentForm({ ...agentForm, model: v || undefined });
                      }
                    }}
                  >
                    <option value="">跟随全局(默认:{settings.providers?.[agentForm.provider ?? ""]?.model ?? settings.mainModel ?? "自动"})</option>
                    {(providerModels.length ? providerModels : COMMON_MODELS).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                    <option value="__custom__">✏️ 自定义输入…</option>
                  </select>
                )}
                {modelsLoading && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>拉取模型列表中…</span>}
              </div>
              <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "4px 0 0" }}>常见模型直接选,不用手写;写论文/多任务可为每个人格配不同模型,对话、心跳、群聊都按各自模型工作。</p>
            </div>
            <div className="agent-opts">
              <label>
                <input
                  type="checkbox"
                  checked={agentForm.useGlobalStyle !== false}
                  onChange={(e) => setAgentForm({ ...agentForm, useGlobalStyle: e.target.checked })}
                />
                跟随全局风格(语气/详略/幽默);关闭=原生态人格,自由生长
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={agentForm.allowDangerousCommands === true}
                  onChange={(e) => setAgentForm({ ...agentForm, allowDangerousCommands: e.target.checked })}
                />
                允许执行高危命令(该人格拥有完整命令权限,请谨慎)
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={agentForm.unrestrictedPaths === true}
                  onChange={(e) => setAgentForm({ ...agentForm, unrestrictedPaths: e.target.checked })}
                />
                文件读写不受白名单限制(该人格拥有完整文件权限)
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={agentForm.historyUnlimited === true || (agentForm.historyContextPct ?? 100) >= 100}
                  onChange={(e) => setAgentForm({ ...agentForm, historyUnlimited: e.target.checked, historyContextPct: e.target.checked ? 100 : undefined })}
                />
                历史上下文全部保留(100% = 全部历史;仅当请求体超过「记忆」区的保命线上限时自动压缩:先删思考与工具输出,正文尽量保留;上限可在记忆区调整)
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "stretch" }}>
                <span style={{ fontSize: 12.5 }}>
                  历史上下文保留度:{agentForm.historyContextPct == null ? 100 : agentForm.historyContextPct}%
                  <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>
                    {agentForm.historyContextPct == null || agentForm.historyContextPct >= 100
                      ? "全部(按 token 估算截取,感觉卡就拉低)"
                      : "只保留最近约该比例的历史(按 token 估算)"}
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={agentForm.historyContextPct == null ? 100 : agentForm.historyContextPct}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setAgentForm({ ...agentForm, historyContextPct: v, historyUnlimited: v >= 100 });
                  }}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={agentForm.isolatedMemory === true}
                  onChange={(e) => setAgentForm({ ...agentForm, isolatedMemory: e.target.checked })}
                />
                独立记忆空间(该人格的记忆与他人格隔离,自己成长)
              </label>
            </div>
            <div className="field-row">
              <button
                className="btn"
                onClick={() => {
                  if (agentForm.name.trim()) void saveAgent(agentForm.id ? { id: agentForm.id, ...agentForm } : agentForm);
                  setAgentForm(null);
                }}
              >
                {agentForm.id ? "保存修改" : "创建人格"}
              </button>
              <button className="btn secondary" onClick={() => setAgentForm(null)}>
                取消
              </button>
            </div>
          </div>
        )}
        {!agentForm && (
          <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => setAgentForm({ name: "", description: "", systemPrompt: "你是一个乐于助人的私人 AI 助手。" })}>
            ＋ 新建人格
          </button>
        )}
        {!agentForm && (
          <button className="btn secondary" style={{ marginTop: 12, marginLeft: 8 }} onClick={() => cardFileRef.current?.click()}>
            📦 导入人格卡片(JSON)
          </button>
        )}
        <input
          ref={cardFileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const card = JSON.parse(await f.text());
              const r = await api.importAgent(card);
              useApp.getState().showToast(`已导入人格「${r.agent.name}」`);
              await useApp.getState().refreshAgents();
            } catch (err) {
              useApp.getState().showToast(`导入失败:${(err as Error).message}`);
            }
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

function OpacitySlider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <label>
        {label}:{Math.round(value * 100)}%
      </label>
      <input
        type="range"
        min={min}
        max={max}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        style={{ width: "100%" }}
      />
    </div>
  );
}

function NewProviderForm(props: {
  onCancel: () => void;
  onSave: (key: string, cfg: ModelConfig) => void;
  initial?: { kind: ProviderKind; label?: string; baseUrl?: string; defaultModel?: string };
}) {
  const [kind, setKind] = useState<ProviderKind>(props.initial?.kind ?? "openai");
  const [label, setLabel] = useState(props.initial?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(props.initial?.baseUrl ?? "");
  const [model, setModel] = useState(props.initial?.defaultModel ?? "");
  const [apiKey, setApiKey] = useState("");

  const save = () => {
    const key = label.trim() || kind;
    props.onSave(key, { kind, label: label.trim() || undefined, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined, model: model.trim() });
  };

  return (
    <div className="provider-card">
      <div className="field-row">
        <div className="field">
          <label>类型</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
            {(["openai", "anthropic", "ollama"] as ProviderKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>名称(标识)</label>
          <input type="text" value={label} placeholder={kind === "ollama" ? "ollama" : "如 deepseek / openai"} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Base URL</label>
        <input type="text" value={baseUrl} placeholder={KIND_HINT[kind]} onChange={(e) => setBaseUrl(e.target.value)} />
      </div>
      <div className="field">
        <label>模型名</label>
        <input type="text" value={model} placeholder="如 gpt-4o / claude-sonnet-4-5 / llama3.1" onChange={(e) => setModel(e.target.value)} />
      </div>
      <div className="field">
        <label>API Key</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </div>
      <div className="field-row">
        <button className="btn" disabled={!model.trim()} onClick={save}>
          保存并设为当前
        </button>
        <button className="btn secondary" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
