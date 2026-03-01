"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { PredictionData, HealthData } from "./predictions";

interface PredictionsContextValue {
  /** Main prediction data (latest.json) */
  predictions: PredictionData | null;
  /** Health/calibration data */
  health: HealthData | null;
  /** Loading state */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Manually trigger a refetch */
  refresh: () => void;
  /** Timestamp of last successful fetch */
  lastUpdated: number | null;
}

const PredictionsContext = createContext<PredictionsContextValue>({
  predictions: null,
  health: null,
  loading: true,
  error: null,
  refresh: () => {},
  lastUpdated: null,
});

const BASE_PATH = "/predictions";
const STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

export function PredictionsProvider({ children }: { children: ReactNode }) {
  const [predictions, setPredictions] = useState<PredictionData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [predRes, healthRes] = await Promise.allSettled([
        fetch(`${BASE_PATH}/latest.json`).then((r) => {
          if (!r.ok) throw new Error(`Predictions: ${r.status}`);
          return r.json() as Promise<PredictionData>;
        }),
        fetch(`${BASE_PATH}/health.json`).then((r) => {
          if (!r.ok) throw new Error(`Health: ${r.status}`);
          return r.json() as Promise<HealthData>;
        }),
      ]);

      if (predRes.status === "fulfilled") {
        setPredictions(predRes.value);
      } else {
        throw new Error(predRes.reason?.message ?? "Failed to load predictions");
      }

      if (healthRes.status === "fulfilled") {
        setHealth(healthRes.value);
      }
      // Health is optional — don't fail if it's missing

      setLastUpdated(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();

    // Auto-refresh every STALE_TIME_MS
    const interval = setInterval(() => {
      fetchData();
    }, STALE_TIME_MS);

    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <PredictionsContext.Provider
      value={{ predictions, health, loading, error, refresh: fetchData, lastUpdated }}
    >
      {children}
    </PredictionsContext.Provider>
  );
}

/** Hook to consume predictions context. Throws if used outside provider. */
export function usePredictions() {
  const ctx = useContext(PredictionsContext);
  if (ctx === undefined) {
    throw new Error("usePredictions must be used within a PredictionsProvider");
  }
  return ctx;
}
