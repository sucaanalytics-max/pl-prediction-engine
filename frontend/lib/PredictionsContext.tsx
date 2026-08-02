"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  loadPredictions,
  loadHealth,
  type PredictionData,
  type HealthData,
} from "./predictions";

interface PredictionsContextValue {
  /** Main prediction data (latest.json) */
  predictions: PredictionData | null;
  /** Health/calibration data */
  health: HealthData | null;
  /** Loading state */
  loading: boolean;
  /** Per-resource loading states */
  loadingPredictions: boolean;
  loadingHealth: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Manually trigger a refetch */
  refresh: () => void;
  /** Timestamp of last successful fetch */
  lastUpdated: number | null;
  /** Whether data is older than STALE_TIME_MS */
  isStale: boolean;
}

const PredictionsContext = createContext<PredictionsContextValue>({
  predictions: null,
  health: null,
  loading: true,
  loadingPredictions: true,
  loadingHealth: true,
  error: null,
  refresh: () => {},
  lastUpdated: null,
  isStale: false,
});

const STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

export function PredictionsProvider({ children }: { children: ReactNode }) {
  const [predictions, setPredictions] = useState<PredictionData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingPredictions, setLoadingPredictions] = useState(true);
  const [loadingHealth, setLoadingHealth] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // Request dedup: prevent concurrent fetches
  const inflightRef = useRef<Promise<void> | null>(null);

  const fetchData = useCallback(async () => {
    // If a fetch is already in-flight, return that promise
    if (inflightRef.current) return inflightRef.current;

    const doFetch = async () => {
      setLoading(true);
      setLoadingPredictions(true);
      setLoadingHealth(true);
      setError(null);

      try {
        const [predRes, healthRes] = await Promise.allSettled([
          loadPredictions(),
          loadHealth(),
        ]);

        if (predRes.status === "fulfilled") {
          setPredictions(predRes.value);
        } else {
          throw new Error(predRes.reason?.message ?? "Failed to load predictions");
        }
        setLoadingPredictions(false);

        if (healthRes.status === "fulfilled") {
          setHealth(healthRes.value);
        }
        setLoadingHealth(false);

        setLastUpdated(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
        setLoadingPredictions(false);
        setLoadingHealth(false);
        inflightRef.current = null;
      }
    };

    inflightRef.current = doFetch();
    return inflightRef.current;
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, STALE_TIME_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Compute stale flag
  const isStale = lastUpdated !== null && Date.now() - lastUpdated > STALE_TIME_MS;

  // Memoize context value to prevent unnecessary re-renders
  const value = useMemo<PredictionsContextValue>(
    () => ({
      predictions,
      health,
      loading,
      loadingPredictions,
      loadingHealth,
      error,
      refresh: fetchData,
      lastUpdated,
      isStale,
    }),
    [predictions, health, loading, loadingPredictions, loadingHealth, error, fetchData, lastUpdated, isStale]
  );

  return (
    <PredictionsContext.Provider value={value}>
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
