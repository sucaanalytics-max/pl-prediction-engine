"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { FplLiveResponse, FplLiveState } from "./fpl-live";

interface FplLiveContextValue {
  state: FplLiveState | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  isStale: boolean;
  refresh: () => Promise<void>;
}

const FplLiveContext = createContext<FplLiveContextValue | undefined>(undefined);
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 1000;

export function FplLiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FplLiveState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const request = (async () => {
      setError(null);
      try {
        const response = await fetch("/api/fpl/state", {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const payload = (await response.json()) as
          | FplLiveResponse
          | { error?: string };
        if (!response.ok || !("data" in payload)) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : `FPL sync returned ${response.status}`
          );
        }
        setState(payload.data);
        setLastUpdated(new Date(payload.data.generatedAt).getTime());
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Unable to load live FPL data"
        );
      } finally {
        setLoading(false);
        inflight.current = null;
      }
    })();
    inflight.current = request;
    return request;
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const isStale =
    lastUpdated !== null && Date.now() - lastUpdated > STALE_AFTER_MS;
  const value = useMemo(
    () => ({ state, loading, error, lastUpdated, isStale, refresh }),
    [state, loading, error, lastUpdated, isStale, refresh]
  );

  return (
    <FplLiveContext.Provider value={value}>{children}</FplLiveContext.Provider>
  );
}

export function useFplLive() {
  const context = useContext(FplLiveContext);
  if (!context) {
    throw new Error("useFplLive must be used within FplLiveProvider");
  }
  return context;
}
