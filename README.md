# HanaLite 🌸

一个**有记忆、有人格**的私人 AI 助手桌面应用 —— 灵感来自 [openhanako / HanaAgent](https://github.com/liliMozi/openhanako),主打:

- **自定义数据目录 / 安装路径**:环境变量、启动参数、便携模式、设置页四种方式随意指定数据存放位置
- **Hindsight 长期记忆**:接入 [Vectorize.io Hindsight](https://hindsight.vectorize.io) 语义记忆系统(World facts / Experiences / Mental Models),未配置时自动回退内置本地记忆,离线可用
- **多模型接入**:OpenAI 兼容(OpenAI / DeepSeek / Moonshot…)、Anthropic(Claude)、Ollama 本地
- **Agent 能力**:文件读写、执行命令、抓取网页、检索/保存记忆,带 PathGuard 路径守卫

> 这是一个从零实现的独立项目,不是 HanaAgent 的 fork。HanaAgent 是一个数千 commits 的庞大项目,这里提供同理念的、更轻量、完全本地方优先的实现。

---

## ✨ 功能特性

| 模块 | 说明 |
|------|------|
| 💬 聊天 | 流式回复、Markdown 渲染、会话管理(新建/重命名/归档/删除) |
| 🧠 记忆 | Hindsight 语义记忆(retain / recall / reflect)+ 本地记忆双后端,自动回退 |
| 🎭 人格 | 内置 3 个人格模板(温柔助手/效率君/文心),支持自建人格,可随时切换 |
| 🔧 工具 | 读写文件、列目录、执行 shell 命令、抓取网页、日期时间、记忆工具 |
| 🛡 安全 | PathGuard:写操作仅限工作区/白名单目录;命令以当前用户权限运行并提示谨慎 |
| 📁 数据目录 | `HANA_HOME` / `--data-dir` / 便携模式 / 设置页,任意位置,全部数据随目录走 |
| 📦 本地优先 | 会话、人格、记忆、设置全部存本机 JSON 文件,无云依赖,可整目录备份迁移 |

## 🚀 快速开始

### 开发模式运行

```bash
npm install
npm run dev          # 启动 Vite + Electron(首次较慢)
```

或仅启动后端 + 浏览器调试:

```bash
HANALITE_PORT=5178 npm run build:main
node dist-electron/server/index.js   # 后端监听 127.0.0.1:5178
# 另开终端: VITE_BACKEND_PORT=5178 npm run dev:renderer  → 浏览器打开 http://localhost:5173
```

### 首次配置

1. 打开应用,进入 **设置 → 模型**,添加模型提供商:
   - **OpenAI 兼容**:如 DeepSeek(`https://api.deepseek.com/v1`)、Moonshot(`https://api.moonshot.cn/v1`),填 API Key 与模型名
   - **Anthropic**:`api.anthropic.com`,填 key 与模型名(如 `claude-sonnet-4-5`)
   - **Ollama**:Base URL 留空默认 `http://localhost:11434/v1`,填本地模型名(如 `qwen2.5`)
2. 设为当前,回到聊天页即可对话。

## 📁 自定义数据目录(重点)

数据目录保存所有会话、人格、记忆、工作文件与设置。解析优先级:

1. **环境变量** `HANA_HOME` 或 `HANALITE_HOME`
2. **启动参数** `--data-dir <路径>`
3. **便携模式**:可执行文件旁有 `data/` 目录或 `portable.txt` 时,数据自动放在 exe 旁(绿色版)
4. **设置页**:设置 → 数据目录,输入新路径点"切换"(写入重定向文件,重启生效)
5. **默认**:`~/.hanalite`(Windows 为 `%USERPROFILE%\.hanalite`)

```bash
# 示例:把数据放在 D 盘
set HANA_HOME=D:\hanalite-data   # PowerShell: $env:HANA_HOME="D:\hanalite-data"
npm start
```

## 🧠 Hindsight 记忆

### 1. 启动 Hindsight 服务(二选一)

**本地 Docker(推荐,数据不出本机):**

```bash
docker run -d --name hindsight -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_PROVIDER=anthropic \
  -e HINDSIGHT_API_LLM_API_KEY=sk-ant-xxxx \
  ghcr.io/vectorize-io/hindsight:latest
```

**Hindsight Cloud:** 在 <https://ui.hindsight.vectorize.io> 注册,拿到 Cloud URL 与 API Key。

### 2. 在 HanaLite 中启用

设置 → 记忆 → 选择 **Hindsight**,填写:

- **Base URL**:本地 `http://localhost:8888` 或 Cloud URL
- **API Key**:Cloud 必填,本地 daemon 可留空
- **Memory Bank ID**:默认 `hanalite`
- **LLM Provider / API Key**:Hindsight 处理记忆所用的 LLM(与 daemon 启动参数一致)

> 未配置 Hindsight 或服务不可用时,应用**自动回退本地记忆**(关键词召回 + 去重),一切照常工作。

### 记忆怎么用

- 每次对话前,自动**召回**与当前话题相关的记忆注入上下文
- 对话后,自动把本次交流**沉淀**为经历
- Agent 也能通过 `memory_retain` / `memory_recall` / `memory_reflect` 三个工具主动管理记忆
- 设置页可手动触发 **反思(Reflect)**

## 🏗 架构

```
electron/         Electron 主进程 + preload(窗口、生命周期、IPC)
server/           后端(Hono HTTP + WebSocket,随 Electron 同进程运行)
  config.ts       配置与数据目录解析
  storage/        JSON 文件存储(接口化,可替换 SQLite)
  providers/      模型 Provider:OpenAI 兼容 / Anthropic / Ollama
  agent/          Agent 引擎:工具调用循环、系统提示组装
  tools/          工具集 + PathGuard 路径守卫
  memory/         记忆服务:Hindsight 后端 + 本地后端
  api/            REST + SSE 路由
desktop/          React 19 + Vite 渲染进程(聊天界面、设置页)
shared/           前后端共享类型
tests/            Vitest 单元测试
```

- 后端监听 `127.0.0.1` 随机端口,渲染进程通过 preload 桥获取地址
- 聊天走 **SSE 流式**(`POST /api/chat`),WebSocket(`/api/ws`)用于多窗口事件广播
- 渲染进程沙盒隔离(`contextIsolation: true`),无 `nodeIntegration`

## 📦 打包发布

```bash
npm run dist            # NSIS 安装器(安装时可自定义安装路径)+ portable 绿色版
npm run dist:portable   # 仅 portable 绿色版
```

- **NSIS 安装器**:安装向导中可选择安装目录(`allowToChangeInstallationDirectory`),非一键安装
- **portable 绿色版**:解压即用;exe 旁放 `data/` 目录或 `portable.txt` 即进入便携模式,数据跟随应用目录走
- 未配置代码签名,首次运行 Windows SmartScreen 可能拦截,点击"更多信息 → 仍要运行"

## 🧪 测试与类型检查

```bash
npm test          # Vitest 单元测试
npm run typecheck # TypeScript 类型检查
```

## 🗺 路线图

- [x] 聊天 + 会话管理 + 人格 + 工具 + Hindsight 记忆 + 自定义数据目录
- [x] electron-builder 打包(NSIS 安装器,可选安装路径;portable 绿色版)
- [ ] 多 Agent 并行与频道协作
- [ ] 定时任务(Cron)与心跳巡检
- [ ] 插件系统(拖拽安装、路由、Provider 扩展)
- [ ] Bridge(Telegram / 飞书 / QQ)
- [ ] 移动端 PWA / LAN 前端
- [ ] 国际化(zh / en / ja / ko / zh-TW)
- [ ] SQLite(WAL)存储升级

## 📄 许可证

Apache License 2.0
