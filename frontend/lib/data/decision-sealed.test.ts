/**
 * Whether a published decision is the committed one or a midweek re-solve.
 *
 * The agent now solves on every REFRESH, not only at the seal, so a decision
 * artifact exists all week instead of for the four hours before a deadline.
 * That is the point — the plan grid was empty six and a half days out of seven
 * — but it means most artifacts a screen reads are provisional, and a screen
 * cannot tell by looking.
 *
 * The absent case is the one worth being careful about. Every artifact written
 * before the producer carried this field came from `_seal`, because
 * `_decide_for_entries` had exactly one caller. So absence means sealed, and
 * that is a claim about history rather than a convenient default — which is why
 * it is asserted here rather than left to a `?? true` nobody would question.
 */
import { describe, expect, it } from "vitest";

import { narrowPublicDecision } from "@/lib/data/narrow";

function artifact(over: Record<string, unknown> = {}) {
  const result = narrowPublicDecision({
    gameweek: 4,
    entry_label: "owner",
    generated_at: "2026-09-05T09:00:00Z",
    decision: {
      mean_points: 55.2,
      plan: {
        squad: [1], xi: [1], captain: 1, vice: 1,
        transfers_in: [], transfers_out: [], hits: 0, bank_after: 25,
      },
    },
    ...over,
  });
  expect(result.ok, "fixture should narrow").toBe(true);
  return result.ok ? result.value : null;
}

describe("a decision says whether it was sealed", () => {
  it("reads a provisional decision as not sealed", () => {
    expect(artifact({ sealed: false })?.sealed).toBe(false);
  });

  it("reads a sealed decision as sealed", () => {
    expect(artifact({ sealed: true })?.sealed).toBe(true);
  });

  it("treats the field's absence as sealed, because it always was", () => {
    /**
     * Not a default chosen for convenience. Before the producer emitted this,
     * the seal was the only writer, so every artifact already in git — GW1
     * through GW3 — is a sealed one. Reading them as provisional would put a
     * "re-solved every few hours" caveat on three committed decisions.
     */
    expect(artifact()?.sealed).toBe(true);
  });

  it("does not read a non-boolean as provisional", () => {
    /**
     * A truthy string or a null from a malformed producer must not silently
     * become `false` and caveat a sealed plan, nor become `true` and strip the
     * caveat from a provisional one. Anything that is not a boolean is the
     * absent case, which is the documented one.
     */
    expect(artifact({ sealed: "yes" })?.sealed).toBe(true);
    expect(artifact({ sealed: null })?.sealed).toBe(true);
  });
});
