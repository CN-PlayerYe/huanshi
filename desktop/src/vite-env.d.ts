/// <reference types="vite/client" />

interface Window {
  hanalite?: {
    getBackendUrl: () => Promise<string>;
    getAppVersion: () => Promise<string>;
    onMenuEvent: (cb: (action: string) => void) => void;
    setThemeBg: (theme: string) => void;
  };
}
