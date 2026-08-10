/// <reference types="vite/client" />

interface Window {
  hanalite?: {
    getBackendUrl: () => Promise<string>;
    getAppVersion: () => Promise<string>;
    onMenuEvent: (cb: (action: string) => void) => void;
    setThemeBg: (theme: string) => void;
    setWindowOpacity: (opacity: number) => void;
    windowMinimize: () => void;
    windowMaximize: () => void;
    windowClose: () => void;
    recognizeSpeech: () => Promise<{ text: string; error?: string }>;
    confirmDialog: (message: string) => Promise<boolean>;
  };
}
