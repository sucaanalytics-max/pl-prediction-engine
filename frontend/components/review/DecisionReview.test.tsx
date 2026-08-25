/**
 * The review's copy, which is the part that can mislead.
 *
 * A number here is either right or wrong and the type checker helps. The wording is
 * where the damage lives: calling a tie a mistake, or a rescued error free, would
 * teach the manager the wrong lesson every week while every figure on the page
 * stayed correct.
 *
 * Fixtures go through the REAL narrower, so a producer field rename breaks these
 * tests rather than silently rendering blanks — the same reason
 * `MinutesConflicts.test.tsx` builds its value that way.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

import { narrowDecisionReview } from "@/lib/data/decision-review";

const GW1 = {
  schema_version: 1,
  generated_at: "2026-08-25T14:00:00Z",
  season: "2627",
  team_name: "A Team",
  observations: 1,
  minimum_observations: 6,
  aggregate: null,
  aggregate_reason:
    "1 settled gameweek(s) reviewed; 6 are needed before a rate is reported.",
  names: {
    "173": "Thomas",
    "152": "Palestra",
    "124": "Gross",
    "418": "Thiago",
    "426": "Bruno",
  },
  gameweeks: [
    {
      gameweek: 1,
      sealed_at: "2026-08-21T13:38:35Z",
      seconds_before_deadline: 13884,
      points: 44,
      fpl_points_on_bench: 2,
      transfers: 0,
      hit_cost: 0,
      submitted_eleven: [152, 426, 418],
      submitted_bench: [173, 124],
      selection: {
        worst_starter: 152,
        best_bench: 124,
        bench_rated_higher: [173, 124],
        gap: 3.6158,
        misordered: true,
      },
      bench: [
        {
          bench_element: 173,
          starter_element: 152,
          kind: "rescued",
          points_forgone: 0,
          verdict: "foreseeable",
          is_lesson: true,
        },
        {
          bench_element: 124,
          starter_element: 418,
          kind: "cost",
          points_forgone: 2,
          verdict: "indistinguishable",
          is_lesson: false,
        },
      ],
      captain: { chosen: 426, sealed_best: 426, agreed: true, points_delta: 0 },
    },
  ],
};

/** Run the real narrower, then hand the result straight to the component. */
async function mount(raw: Record<string, unknown>) {
  const result = narrowDecisionReview(raw);
  if (!result.ok) throw new Error(`fixture did not narrow: ${result.problems}`);
  const value = result.value;

  vi.resetModules();
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: () => ({
      artifact: {
        state: "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: null,
        value,
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const mod = await import("@/components/review/DecisionReview");
  render(<mod.default />);
}

function week(overrides: Record<string, unknown>) {
  return { ...GW1, gameweeks: [{ ...GW1.gameweeks[0], ...overrides }] };
}

afterEach(() => {
  vi.resetModules();
});

describe("the aggregate is withheld until it is earned", () => {
  it("shows the producer's own reason, not one of its own", async () => {
    await mount(GW1);
    expect(
      screen.getByText(/6 are needed before a rate is reported/),
    ).toBeInTheDocument();
  });

  it("prints no rate at all rather than a zero", async () => {
    await mount(GW1);
    // A withheld rate rendered as 0% is indistinguishable from a measured 0%.
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("shows figures once the sample clears", async () => {
    await mount({
      ...GW1,
      observations: 6,
      aggregate_reason: null,
      aggregate: {
        gameweeks: 6,
        points_forgone_on_bench: 11,
        foreseeable_bench_errors: 2,
        captain_agreement_rate: 0.5,
        captain_points_vs_engine: -4,
      },
    });
    expect(screen.getByText("11")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });
});

describe("a tie is never rendered as a mistake", () => {
  it("labels an indistinguishable call as too close to call", async () => {
    await mount(GW1);
    expect(screen.getByText("too close to call")).toBeInTheDocument();
  });

  it("uses the reproach exactly once — on the foreseeable call, not the tie", async () => {
    await mount(GW1);
    expect(screen.getAllByText("could have known")).toHaveLength(1);
  });
});

describe("a rescued error is shown as a lesson that cost nothing", () => {
  it("says the cost was nothing this time", async () => {
    await mount(GW1);
    expect(screen.getByText(/cost nothing this time/)).toBeInTheDocument();
  });

  it("still marks it as something that could have been known", async () => {
    await mount(GW1);
    expect(screen.getByText("could have known")).toBeInTheDocument();
  });
});

describe("the selection headline", () => {
  it("names the starter and counts the bench players rated above him", async () => {
    await mount(GW1);
    expect(screen.getByText("Palestra")).toBeInTheDocument();
    expect(
      screen.getByText(/2 of your 2 bench players were rated above him/),
    ).toBeInTheDocument();
  });

  it("says so plainly when the eleven was correctly ordered", async () => {
    await mount(
      week({
        selection: {
          worst_starter: 152,
          best_bench: 124,
          bench_rated_higher: [],
          gap: null,
          misordered: false,
        },
      }),
    );
    expect(
      screen.getByText(
        /Every player you started was rated above every player you benched/,
      ),
    ).toBeInTheDocument();
  });
});

describe("the captain line", () => {
  it("says the engine agreed when it did", async () => {
    await mount(GW1);
    expect(screen.getByText(/was the engine/)).toBeInTheDocument();
  });

  it("names the engine's preference and the doubled cost when it disagreed", async () => {
    await mount(
      week({
        captain: {
          chosen: 418,
          sealed_best: 426,
          agreed: false,
          points_delta: 12,
        },
      }),
    );
    expect(screen.getByText(/the engine preferred/)).toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
  });
});

describe("the two kinds of silence are not the same", () => {
  it("says nothing to judge for a bench player who never came on", async () => {
    // Caught in the browser: Dubravka is in the sealed universe, so labelling him
    // "not covered" blamed the forecast for a comparison that never existed.
    await mount(
      week({
        bench: [
          {
            bench_element: 999,
            starter_element: null,
            kind: "no_claim",
            points_forgone: 0,
            verdict: null,
            is_lesson: false,
          },
        ],
      }),
    );
    expect(screen.getByText(/nothing to judge/)).toBeInTheDocument();
    expect(screen.queryByText(/not covered/)).not.toBeInTheDocument();
    expect(screen.queryByText("right call")).not.toBeInTheDocument();
  });

  it("says not covered only when a comparison existed and the forecast lacked it", async () => {
    await mount(
      week({
        bench: [
          {
            bench_element: 999,
            starter_element: 152,
            kind: "cost",
            points_forgone: 3,
            verdict: null,
            is_lesson: false,
          },
        ],
      }),
    );
    expect(screen.getByText(/not covered/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing to judge/)).not.toBeInTheDocument();
  });
});
