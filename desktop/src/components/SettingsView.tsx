import { useState } from "react";
import type { ModelConfig, ProviderKind } from "@shared/types";
import { api } from "../api";
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
  const [agentForm, setAgentForm] = useState<{ name: string; description: string; systemPrompt: string } | null>(null);
  const [csDir, setCsDir] = useState("");
  const [csIncludeThinking, setCsIncludeThinking] = useState(false);
  const [csBusy, setCsBusy] = useState(false);
  const [csInfo, setCsInfo] = useState("");

  if (!settings) return <div className="settings">加载中…</div>;

  const patchProvider = (key: string, patch: Partial<ModelConfig>) => {
    void updateSettings({ providers: { ...settings.providers, [key]: { ...settings.providers[key], ...patch } } });
  };

  const removeProvider = (key: string) => {
    const next = { ...settings.providers };
    delete next[key];
    void updateSettings({ providers: next });
  };

  return (
    <div className="settings">
      <h2>⚙️ 设置</h2>

      {/* ---- 模型 ---- */}
      <div className="settings-section">
        <h3>🤖 模型</h3>
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
                <input type="text" value={cfg.model} placeholder="如 gpt-4o / claude-sonnet-4-5 / qwen2.5" onChange={(e) => patchProvider(key, { model: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>API Key(留空则使用无鉴权的本地服务,如 Ollama)</label>
              <input type="password" value={cfg.apiKey ?? ""} onChange={(e) => patchProvider(key, { apiKey: e.target.value })} />
            </div>
          </div>
        ))}

        {newProviderOpen ? (
          <NewProviderForm
            onCancel={() => setNewProviderOpen(false)}
            onSave={(key, cfg) => {
              void updateSettings({ providers: { ...settings.providers, [key]: cfg }, activeProvider: key });
              setNewProviderOpen(false);
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
          所有会话、人格、记忆、工作文件都存在这里。优先级:环境变量 HANA_HOME / HANALITE_HOME &gt; 启动参数 --data-dir &gt; 便携模式 &gt; 此处设置 &gt; 默认 ~/.hanalite
        </p>
        <div className="field-row">
          <div className="field">
            <input type="text" value={dataDirInput} onChange={(e) => setDataDirInput(e.target.value)} placeholder="输入新的数据目录路径" />
          </div>
          <button className="btn" disabled={!dataDirInput.trim()} onClick={() => void changeDataDir(dataDirInput.trim())}>
            切换(重启生效)
          </button>
        </div>
      </div>

      {/* ---- 记忆 ---- */}
      <div className="settings-section">
        <h3>🧠 记忆</h3>
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
            <textarea
              readOnly
              value={reflectText}
              style={{ marginTop: 10, minHeight: 120, background: "var(--tool-bg)" }}
            />
          )}
        </div>
      </div>

      {/* ---- 数据迁移(从 Cherry Studio) ---- */}
      <div className="settings-section">
        <h3>📥 从 Cherry Studio 迁移对话</h3>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "4px 0 10px" }}>
          读取 Cherry Studio(v1 架构)的 <code>Data/agents.db</code>,把 Agent、会话与全部对话内容(正文、思考、工具调用)迁入 HanaLite。
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
                <button className="btn secondary sm" onClick={() => setAgentForm({ name: a.name, description: a.description, systemPrompt: a.systemPrompt })}>
                  编辑
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
            <div className="field-row">
              <button
                className="btn"
                onClick={() => {
                  if (agentForm.name.trim()) void saveAgent({ ...agentForm });
                  setAgentForm(null);
                }}
              >
                保存人格
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
      </div>
    </div>
  );
}

function NewProviderForm(props: { onCancel: () => void; onSave: (key: string, cfg: ModelConfig) => void }) {
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
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
