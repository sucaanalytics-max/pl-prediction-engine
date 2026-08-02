"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "suca-fpl-watchlist-v1";

export function usePlayerWatchlist() {
  const [watched, setWatched] = useState<number[]>([]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(stored)) {
        setWatched(stored.filter((value): value is number => Number.isInteger(value)));
      }
    } catch {
      setWatched([]);
    }
  }, []);

  const toggle = useCallback((elementId: number) => {
    setWatched((current) => {
      const next = current.includes(elementId)
        ? current.filter((value) => value !== elementId)
        : [...current, elementId];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { watched, toggle };
}
