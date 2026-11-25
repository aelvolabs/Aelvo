import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { WSConfig } from "../types";

const TOKEN_KEY = "aelvo_bridge_token";

function initialToken(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl) return fromUrl;
    return sessionStorage.getItem(TOKEN_KEY) ?? import.meta.env.VITE_BRIDGE_TOKEN ?? "";
  } catch {
    return import.meta.env.VITE_BRIDGE_TOKEN ?? "";
  }
}

const DEFAULT_CONFIG: WSConfig = {
  url: import.meta.env.VITE_WS_URL || "ws://127.0.0.1:4317",
  reconnectDelay: 3000,
  maxEvents: 500,
  token: initialToken(),
};

function loadConfig(): WSConfig {
  try {
    const stored = localStorage.getItem("aelvo_ws_config");
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        url: parsed.url || DEFAULT_CONFIG.url,
        reconnectDelay: parsed.reconnectDelay ?? DEFAULT_CONFIG.reconnectDelay,
        maxEvents: parsed.maxEvents ?? DEFAULT_CONFIG.maxEvents,
        token: initialToken(),
      };
    }
  } catch {
    // Corrupted storage, fall through to defaults
  }
  return { ...DEFAULT_CONFIG };
}

interface SettingsContextValue {
  config: WSConfig;
  updateConfig: (patch: Partial<WSConfig>) => void;
  resetConfig: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<WSConfig>(loadConfig);

  const updateConfig = useCallback((patch: Partial<WSConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      try {
        // The bridge token is a per-launch secret: keep it in session storage,
        // never in the long-lived UI preferences entry.
        if (patch.token !== undefined) sessionStorage.setItem(TOKEN_KEY, patch.token);
        const { token: _token, ...persisted } = next;
        localStorage.setItem("aelvo_ws_config", JSON.stringify(persisted));
      } catch {
        // Storage full or unavailable — ignore
      }
      return next;
    });
  }, []);

  const resetConfig = useCallback(() => {
    setConfig({ ...DEFAULT_CONFIG, token: "" });
    try {
      localStorage.removeItem("aelvo_ws_config");
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Ignore
    }
  }, []);

  return (
    <SettingsContext.Provider value={{ config, updateConfig, resetConfig }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
