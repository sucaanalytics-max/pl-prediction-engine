import { describe, expect, it } from "vitest";

import { utcStamp } from "@/lib/phone";

describe("utcStamp", () => {
  it("states the instant in UTC, labelled, whatever the reader's zone", () => {
    expect(utcStamp("2026-10-23T19:46:12.345678+00:00")).toBe("23 Oct, 19:46 UTC");
  });

  it("converts an offset stamp rather than reading its clock face", () => {
    expect(utcStamp("2026-10-23T21:46:00+02:00")).toBe("23 Oct, 19:46 UTC");
  });

  it("is null, not 'Invalid Date', when there is nothing usable", () => {
    expect(utcStamp(null)).toBeNull();
    expect(utcStamp(undefined)).toBeNull();
    expect(utcStamp("")).toBeNull();
    expect(utcStamp("not a date")).toBeNull();
  });
});
