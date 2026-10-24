import { describe, expect, it } from "vitest";
import { formatUtc, freshnessOf } from "@/lib/freshness";

const base = { readable: true, stale: false, producedAt: "2026-10-24T06:23:00Z", ageMs: 1000, budgetMs: 10_000 };

describe("formatUtc", () => {
  it("prints day, month and hh:mm in UTC", () => {
    expect(formatUtc("2026-10-24T06:23:00Z")).toBe("24 Oct, 06:23");
    expect(formatUtc("2026-10-23T19:50:59+00:00")).toBe("23 Oct, 19:50");
  });
  it("answers null for nothing and for junk", () => {
    expect(formatUtc(null)).toBeNull();
    expect(formatUtc("yesterday")).toBeNull();
  });
});

describe("freshnessOf", () => {
  it("is fresh inside half the budget and ageing beyond it", () => {
    expect(freshnessOf(base)).toBe("fresh");
    expect(freshnessOf({ ...base, ageMs: 6000 })).toBe("ageing");
  });
  it("stale wins over age, and an unreadable file is missing", () => {
    expect(freshnessOf({ ...base, stale: true })).toBe("stale");
    expect(freshnessOf({ ...base, readable: false })).toBe("missing");
  });
  it("does not call an unstamped artifact fresh", () => {
    expect(freshnessOf({ ...base, producedAt: null, ageMs: null })).toBe("unstamped");
  });
  it("has no ageing band without a budget", () => {
    expect(freshnessOf({ ...base, budgetMs: null, ageMs: 9e9 })).toBe("fresh");
  });
});
