import { useEffect } from "react";
import { useApp } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";

// 模块级常量:避免 selector 每次返回新对象引用导致 React 无限重渲染
const EMPTY_APPEARANCE: Record<string, never> = {};

export default function App() {
  const ready = useApp((s) => s.ready);
  const error = useApp((s) => s.error);
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
    // color-mix 需要百分比单位(如 50%),不能传 0.5
    if (appearance.chatOpacity != null) root.setProperty("--chat-opacity", `${Math.round(appearance.chatOpacity * 100)}%`);
    else root.removeProperty("--chat-opacity");
    if (appearance.sidebarOpacity != null) root.setProperty("--side-opacity", `${Math.round(appearance.sidebarOpacity * 100)}%`);
    else root.removeProperty("--side-opacity");
    const body = document.body;
    if (appearance.bgImage) {
      const base = useApp.getState().backendUrl;
      // 加时间戳,防止浏览器复用同名旧缓存图
      body.style.backgroundImage = `url(${base}/files/${appearance.bgImage}?v=${Date.now()})`;
      body.style.backgroundSize = "cover";
      body.style.backgroundAttachment = "fixed";
    } else {
      body.style.backgroundImage = "";
    }
  }, [appearance]);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-logo">🏔</div>
        <div className="boot-text">幻世 正在启动…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">{view === "chat" ? <ChatView /> : <SettingsView />}</main>
      {error && (
        <div className="toast" onClick={() => useApp.setState({ error: null })}>
          {error}
        </div>
      )}
    </div>
  );
}
