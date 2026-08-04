/// <reference types="vite/client" />

interface Window {
  hanalite?: {
    getBackendUrl: () => Promise<string>;
    getAppVersion: () => Promise<string>;
  };
}
