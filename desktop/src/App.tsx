import { useEffect } from "react";
import { useApp } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import logo from "./assets/icon.png";

// 模块级常量:避免 selector 每次返回新对象引用导致 React 无限重渲染
const EMPTY_APPEARANCE: Record<string, never> = {};

// 主题背景色表(与 base.css 主题变量保持一致,用于 JS 直接计算 rgba 背景)
const THEME_BG: Record<string, { bg: string; side: string; user: string; assistant: string }> = {
  ink: { bg: "#f2eddf", side: "#eae3d0", user: "#e3d9bf", assistant: "#faf7ee" },
  light: { bg: "#f3f5fa", side: "#ffffff", user: "#e7edff", assistant: "#ffffff" },
  dark: { bg: "#17181c", side: "#1d1e24", user: "#2c3450", assistant: "#23242c" },
};

/** 十六进制色 + 透明度 → rgba 字符串 */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export default function App() {
  const ready = useApp((s) => s.ready);
  const error = useApp((s) => s.error);
  const toast = useApp((s) => s.toast);
  const view = useApp((s) => s.view);
  const theme = useApp((s) => s.settings?.theme ?? "ink");
  // 注意:必须用模块级常量,避免 ?? 每次返回新引用导致 React 无限重渲染
  const appearance = useApp((s) => s.settings?.appearance ?? EMPTY_APPEARANCE);
  const setView = useApp((s) => s.setView);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const newSession = useApp((s) => s.newSession);
  const init = useApp((s) => s.init);

  // 应用主题
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 主题同步窗口背景色(暗色下顶部边框不再是白色)
  useEffect(() => {
    window.hanalite?.setThemeBg(theme);
  }, [theme]);

  // 非模态 toast:组件内(如朗读失败)通过自定义事件触发
  useEffect(() => {
    const showToast = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) useApp.getState().showToast(detail);
    };
    window.addEventListener("hanalite-toast", showToast);
    return () => window.removeEventListener("hanalite-toast", showToast);
  }, []);

  // 应用菜单动作(文件/编辑/视图/帮助)
  useEffect(() => {
    window.hanalite?.onMenuEvent((action: string) => {
      if (action === "new-session") void newSession();
      else if (action === "open-settings") setView("settings");
      else if (action === "toggle-theme") toggleTheme();
      else if (action === "toggle-sidebar") toggleSidebar();
    });
  }, [newSession, setView, toggleTheme, toggleSidebar]);

  // 外观自定义:强调色 / 透明度 / 背景图
  useEffect(() => {
    const root = document.documentElement.style;
    if (appearance.accent) root.setProperty("--accent", appearance.accent);
    else root.removeProperty("--accent");
    // 直接用 JS 算 rgba 背景,绕开 color-mix(其在部分渲染环境下会失效导致界面全透明)
    const t = THEME_BG[theme] ?? THEME_BG.dark;
    root.setProperty("--chat-bg", hexToRgba(t.bg, appearance.chatOpacity ?? 1));
    root.setProperty("--side-bg", hexToRgba(t.side, appearance.sidebarOpacity ?? 1));
    root.setProperty("--bubble-user", hexToRgba(t.user, appearance.bubbleOpacity ?? 1));
    root.setProperty("--bubble-assistant", hexToRgba(t.assistant, appearance.bubbleOpacity ?? 1));
    // 标题栏(左侧 drag 区 + 右上按钮区)跟随聊天区遮罩:透明度滑块 0-100% 实时联动
    const titlebarBg = hexToRgba(t.bg, appearance.chatOpacity ?? 1);
    root.setProperty("--titlebar-bg", titlebarBg);
    window.hanalite?.setTitleBarOverlay(titlebarBg);
    const body = document.body;
    if (appearance.bgImage) {
      // 背景图作为底层装饰:界面保持默认不透明,想沉浸可在外观里手动调聊天区透明度
      const base = useApp.getState().backendUrl;
      // 加时间戳,防止浏览器复用同名旧缓存图
      body.style.backgroundImage = `url(${base}/files/${appearance.bgImage}?v=${Date.now()})`;
      body.style.backgroundSize = "cover";
      body.style.backgroundAttachment = "fixed";
    } else {
      body.style.backgroundImage = "";
    }
  }, [appearance, theme]);

  // 窗口整体透明度(看到桌面)
  const windowOpacity = useApp((s) => s.settings?.appearance?.windowOpacity ?? 1);
  useEffect(() => {
    window.hanalite?.setWindowOpacity(windowOpacity);
  }, [windowOpacity]);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) {
    return (
      <div className="boot">
        <img src={logo} className="boot-logo" alt="幻世" />
        <div className="boot-text">幻世 正在启动…</div>
      </div>
    );
  }

  return (
    <div className="app">
      {/* 自绘标题栏:透明拖拽区,背景透出主题/背景图;窗口按钮由 titleBarOverlay 提供 */}
      <div className="titlebar">
        <span className="titlebar-title">幻世</span>
      </div>
      <Sidebar />
      <main className="main">{view === "chat" ? <ChatView /> : <SettingsView />}</main>
      {error && (
        <div className="toast" onClick={() => useApp.setState({ error: null })}>
          {error}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
