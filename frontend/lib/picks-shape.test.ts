/**
 * What the app does on Friday when FPL starts serving picks.
 *
 * This path has never run: before a deadline FPL keeps an entry's picks private, so the
 * squad comes from a hand capture. At 17:30Z on the 21st it switches, once, under the
 * API's heaviest load of the week — and the switch was `picks ? picks.picks.map(…) :
 * CAPTURED_DRAFT`, which trusts any 200.
 *
 * The two shapes that matter are not exotic. `picks: []` is what an endpoint that is up
 * but has not yet materialised a team returns, and it produced an EMPTY squad labelled
 * `official_public`. A payload missing the key threw inside `.map` and took the route
 * down. Neither could be observed before the day it matters.
 */
import { describe, expect, it } from "vitest";

import { usableSquad, type PicksPayload } from "@/lib/fpl-live-server";

const pick = (element: number, position: number) => ({
  element, position, is_captain: false, is_vice_captain: false,
});

function squad(count: number): PicksPayload {
  return {
    picks: Array.from({ length: count }, (_, i) => pick(i + 1, i + 1)),
    entry_history: { value: 995, bank: 5 },
  };
}

describe("a picks payload is a squad, or it is not used", () => {
  it("accepts the real shape: fifteen picks and a history", () => {
    const payload = squad(15);
    expect(usableSquad(payload)).toBe(payload);
  });

  it("rejects an empty picks array, which is a 200 with no team in it", () => {
    // The shape that produced an empty squad labelled "official".
    expect(usableSquad(squad(0))).toBeNull();
  });

  it("rejects a squad of the wrong size in either direction", () => {
    expect(usableSquad(squad(14))).toBeNull();
    expect(usableSquad(squad(16))).toBeNull();
  });

  it("rejects a payload with no picks key rather than throwing on it", () => {
    // This used to throw inside `.map`, taking the whole route down with it.
    expect(usableSquad({ entry_history: { value: 995, bank: 5 } } as unknown as PicksPayload))
      .toBeNull();
    expect(usableSquad({ picks: null } as unknown as PicksPayload)).toBeNull();
  });

  it("rejects a missing or malformed entry_history, because bank and value read it", () => {
    const noHistory = { picks: squad(15).picks } as unknown as PicksPayload;
    expect(usableSquad(noHistory)).toBeNull();

    const nanBank = { ...squad(15), entry_history: { value: 995, bank: Number.NaN } };
    expect(usableSquad(nanBank)).toBeNull();

    const stringValue = {
      ...squad(15), entry_history: { value: "995", bank: 5 },
    } as unknown as PicksPayload;
    expect(usableSquad(stringValue)).toBeNull();
  });

  it("rejects a pick whose element or position is not a number", () => {
    const broken = squad(15);
    const withBadElement = {
      ...broken,
      picks: [{ ...broken.picks[0], element: null }, ...broken.picks.slice(1)],
    } as unknown as PicksPayload;
    expect(usableSquad(withBadElement)).toBeNull();
  });

  it("rejects null, which is the 404 the app already handled correctly", () => {
    expect(usableSquad(null)).toBeNull();
  });

  it("returns the payload itself, so the nine consumers read one answer", () => {
    /* The squad, the bank, the value, the source, the notices, the source label,
       capturedAt, isOfficial and freshness.squad all branch on this. A partial trust
       would label a captured squad "official", which is worse than either honest
       answer. */
    const payload = squad(15);
    expect(usableSquad(payload)).toBe(payload);
    expect(usableSquad(squad(3))).toBeNull();
  });
});
