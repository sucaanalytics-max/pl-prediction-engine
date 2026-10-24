import { describe, expect, it } from "vitest";
import { countdownLabel } from "@/components/DeadlineClock";

const T = Date.parse("2026-10-24T12:00:00Z");
const after = (ms: number) => T + ms;
const H = 3_600_000;

describe("countdownLabel", () => {
  it("counts days and hours, as the strip reads", () => {
    expect(countdownLabel(after(7 * 24 * H + 3 * H + 5 * 60_000), T)).toBe("7d 3h left");
  });
  it("counts hours and minutes inside a day", () => {
    expect(countdownLabel(after(3 * H + 12 * 60_000), T)).toBe("3h 12m left");
  });
  it("counts minutes inside an hour, never below one", () => {
    expect(countdownLabel(after(42 * 60_000), T)).toBe("42m left");
    expect(countdownLabel(after(5_000), T)).toBe("1m left");
  });
  it("says so once the deadline has gone", () => {
    expect(countdownLabel(T, T)).toBe("Deadline passed");
    expect(countdownLabel(after(-H), T)).toBe("Deadline passed");
  });
});
