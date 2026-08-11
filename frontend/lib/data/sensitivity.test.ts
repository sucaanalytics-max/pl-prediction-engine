/**
 * The robustness report, and its refusal to show a number it does not have.
 *
 * The artifact this narrows is published on every agent run and today always
 * says `measurable: false`. So the tests that matter are about the unmeasurable
 * case being handled as a first-class state rather than as a degenerate one:
 *
 * * an unmeasurable report is **valid**, and narrows successfully;
 * * an unmeasurable report **with no reason** is rejected, because a page would
 *   then have nothing to show but a blank where an explanation belongs;
 * * `survival` stays null rather than becoming 0, even when measurable, because
 *   a run where every draw failed to solve has no survival rate and reporting
 *   0% would blame the recommendation for the solver's limits.
 *
 * `BandTests` pins the same four bands and cut points as
 * `pipeline/tests/test_sensitivity.py::BandTests`. The vocabulary is duplicated
 * across the two languages deliberately — it is a presentation decision — so it
 * needs a test on each side or the two drift apart silently.
 */
import { describe, expect, it } from "vitest";
import { classify, proven } from "@/lib/data/artifact";
import {
  band, narrowSensitivity, sensitivityDescriptor, sensitivityIsEmpty,
  type Sensitivity,
} from "@/lib/data/sensitivity";

const UNMEASURABLE = {
  measurable: false,
  reason:
    "No gameweek has been settled, so the projection error distribution has " +
    "never been measured.",
  baseline_move: null,
  survival: null,
  draws: 0,
  failed_draws: 0,
  alternatives: [],
  noise: null,
  gameweek: 7,
  entry_label: "season",
  generated_at: "2026-08-07T06:00:00Z",
  settled_gameweeks: 0,
};

const MEASURED = {
  measurable: true,
  reason: null,
  baseline_move: "521->9",
  survival: 0.86,
  draws: 100,
  failed_draws: 3,
  alternatives: [
    { move: "521->9", wins: 86, frequency: 0.86 },
    { move: "hold", wins: 14, frequency: 0.14 },
  ],
  noise: {
    sd_by_position: { DEF: 2.1, MID: 2.6 },
    intra_team_rho: 0.42,
    observations: { DEF: 300, MID: 380 },
    gameweeks: 9,
  },
  gameweek: 7,
  entry_label: "season",
  generated_at: "2026-08-07T06:00:00Z",
  settled_gameweeks: 9,
};

function ok(raw: unknown): Sensitivity {
  const result = narrowSensitivity(raw);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.value;
}

describe("the unmeasurable report is a first-class state", () => {
  it("narrows successfully", () => {
    const report = ok(UNMEASURABLE);
    expect(report.measurable).toBe(false);
    expect(report.reason).toContain("never been measured");
  });

  it("carries no fabricated survival rate", () => {
    expect(ok(UNMEASURABLE).survival).toBeNull();
  });

  it("is rejected when it gives no reason", () => {
    // Otherwise the page renders an amber badge over an empty paragraph.
    const { reason, ...noReason } = UNMEASURABLE;
    void reason;
    const result = narrowSensitivity(noReason);
    expect(result.ok).toBe(false);
  });

  it("counts as empty, not absent", () => {
    // The agent did publish it. "Working and waiting for data" is a different
    // message from "something failed to write".
    expect(sensitivityIsEmpty(ok(UNMEASURABLE))).toBe(true);
  });
});

describe("a measured report", () => {
  it("narrows every field the panel renders", () => {
    const report = ok(MEASURED);
    expect(report.survival).toBeCloseTo(0.86);
    expect(report.baselineMove).toBe("521->9");
    expect(report.draws).toBe(100);
    expect(report.failedDraws).toBe(3);
    expect(report.noise?.gameweeks).toBe(9);
  });

  it("keeps the alternatives so the runner-up is visible", () => {
    expect(ok(MEASURED).alternatives).toHaveLength(2);
  });

  it("drops an alternative with no move or no frequency", () => {
    const report = ok({
      ...MEASURED,
      alternatives: [{ move: "521->9", frequency: 0.9 }, { wins: 3 }, {}],
    });
    expect(report.alternatives).toHaveLength(1);
  });

  it("survival stays null when every draw failed", () => {
    // Measurable, zero completed draws. Coercing to 0% would report a solver
    // timeout as evidence that the recommendation is fragile.
    const report = ok({
      ...MEASURED, survival: null, draws: 0, failed_draws: 50,
    });
    expect(report.survival).toBeNull();
    expect(report.failedDraws).toBe(50);
  });

  it("with no completed draws it is empty despite being measurable", () => {
    expect(sensitivityIsEmpty(ok({ ...MEASURED, draws: 0 }))).toBe(true);
  });
});

describe("malformed input", () => {
  it("a missing measurable flag is fatal", () => {
    const { measurable, ...rest } = MEASURED;
    void measurable;
    expect(narrowSensitivity(rest).ok).toBe(false);
  });

  it("a non-boolean measurable is fatal", () => {
    expect(narrowSensitivity({ ...MEASURED, measurable: "yes" }).ok).toBe(false);
  });

  it("a non-object is refused", () => {
    expect(narrowSensitivity(null).ok).toBe(false);
    expect(narrowSensitivity([]).ok).toBe(false);
  });
});

describe("the descriptor", () => {
  it("pads the gameweek, matching what the agent writes", () => {
    expect(sensitivityDescriptor(7, "season").path)
      .toBe("fpl/sensitivity_gw07_season.json");
    expect(sensitivityDescriptor(12, "weekly").path)
      .toBe("fpl/sensitivity_gw12_weekly.json");
  });

  it("is owned by the agent, which is the writer that owns that directory", () => {
    expect(sensitivityDescriptor(7, "season").owner).toBe("agent");
  });

  it("classifies an unmeasurable report as empty through the envelope", () => {
    const d = sensitivityDescriptor(7, "season");
    const artifact = classify({
      path: d.path, source: "local", raw: UNMEASURABLE, narrow: d.narrow,
      isEmpty: d.isEmpty, now: new Date("2026-08-07T07:00:00Z"),
    });
    expect(artifact.state).toBe("empty");
    // Still readable, so the page can render the reason.
    expect(proven(artifact)).not.toBeNull();
  });
});

describe("the survival bands match the Python vocabulary", () => {
  it("says so when nothing was measured", () => {
    expect(band(null).label).toBe("not measured");
    expect(band(null).tone).toBe("unknown");
  });

  it("uses the same four cut points", () => {
    expect(band(0.85).tone).toBe("good");
    expect(band(0.80).tone).toBe("good");
    expect(band(0.79).tone).toBe("mixed");
    expect(band(0.60).tone).toBe("mixed");
    expect(band(0.40).tone).toBe("mixed");
    expect(band(0.39).tone).toBe("bad");
  });

  it("names fragility rather than colouring it alone", () => {
    // Colour is reinforcement, not the message — the same reason
    // `edgePrefix()` exists for the value-bet table.
    expect(band(0.2).label).toContain("fragile");
    expect(band(0.95).label).toContain("robust");
  });
});
