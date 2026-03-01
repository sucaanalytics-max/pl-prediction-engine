"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTheme } from "next-themes";

// ─── useLocalStorage ──────────────────────────────────────────────────────────
// Persist state to localStorage with JSON serialization.
// Falls back gracefully if localStorage is unavailable (SSR, private browsing).

export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [stored, setStored] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStored((prev) => {
        const next = value instanceof Function ? value(prev) : value;
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Quota exceeded or private browsing — silently fail
        }
        return next;
      });
    },
    [key]
  );

  return [stored, setValue];
}

// ─── useSortable ──────────────────────────────────────────────────────────────
// Generic table sorting hook.

export type SortDir = "asc" | "desc";

export function useSortable<T>(
  data: T[],
  defaultKey: keyof T,
  defaultDir: SortDir = "desc"
) {
  const [sortKey, setSortKey] = useState<keyof T>(defaultKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);

  const sorted = [...data].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === "number" && typeof bv === "number") {
      return sortDir === "asc" ? av - bv : bv - av;
    }
    if (typeof av === "string" && typeof bv === "string") {
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return 0;
  });

  const toggleSort = useCallback(
    (key: keyof T) => {
      if (key === sortKey) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("desc");
      }
    },
    [sortKey]
  );

  return { sorted, sortKey, sortDir, toggleSort };
}

// ─── useFilter ────────────────────────────────────────────────────────────────
// Simple multi-filter hook for table rows.

export function useFilter<T>(
  data: T[],
  filterFn: (item: T, filters: Record<string, string>) => boolean
) {
  const [filters, setFilters] = useState<Record<string, string>>({});

  const filtered = data.filter((item) => filterFn(item, filters));

  const setFilter = useCallback((key: string, value: string) => {
    setFilters((prev) => {
      if (value === "" || value === "all") {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });
  }, []);

  const clearFilters = useCallback(() => setFilters({}), []);

  return { filtered, filters, setFilter, clearFilters };
}

// ─── useDebounce ──────────────────────────────────────────────────────────────

export function useDebounce<T>(value: T, delayMs: number = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

// ─── useChartTheme ────────────────────────────────────────────────────────────
// Returns chart colours keyed to the active theme.
// Guard with `mounted` to prevent SSR hydration mismatch.

export interface ChartTheme {
  grid: string;
  tick: string;
  tooltip: {
    background: string;
    border: string;
    color: string;
    shadow: string;
  };
}

export function useChartTheme(): ChartTheme {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Default to dark until mounted so SSR and first client render match
  const dark = !mounted || resolvedTheme === "dark";

  return {
    grid: dark ? "rgba(255,255,255,0.04)" : "rgba(15,23,42,0.06)",
    tick: dark ? "#475569" : "#94a3b8",
    tooltip: {
      background: dark ? "rgba(10,15,28,0.95)" : "#ffffff",
      border:     dark ? "rgba(255,255,255,0.1)" : "rgba(15,23,42,0.1)",
      color:      dark ? "#e2e8f0" : "#0f172a",
      shadow:     dark ? "0 4px 24px rgba(0,0,0,0.4)" : "0 4px 24px rgba(0,0,0,0.1)",
    },
  };
}
