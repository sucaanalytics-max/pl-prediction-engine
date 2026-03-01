"use client";

import { useState, useEffect, useCallback, useRef } from "react";

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
