import { useEffect } from "react";
import { useApp } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";

export default function App() {
  const ready = useApp((s) => s.ready);
  const error = useApp((s) => s.error);
  const view = useApp((s) => s.view);
  const theme = useApp((s) => s.settings?.theme ?? "dark");
  const init = useApp((s) => s.init);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-logo">🌸</div>
        <div className="boot-text">HanaLite 正在启动…</div>
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
