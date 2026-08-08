/**
 * The Accuracy screen.
 *
 * The point of this page is that it says something true before it has measured
 * anything, so the tests are mostly about the empty state carrying real
 * content rather than a placeholder:
 *
 * * the ceiling renders while `measured` is null;
 * * "0 of 38 gameweeks sealed" is stated, not implied by a blank;
 * * beating the ceiling raises an alarm rather than being displayed as skill.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AccuracyPage from "@/app/accuracy/page";
import { ACCURACY } from "@/lib/data/accuracy";

const DAY_ONE = {
  schema_version: 1,
  generated_at: "2026-08-08T06:00:00Z",
  season: "2627",
  gameweeks_sealed: 0,
  observations: 0,
  perfect_model_rmse: 2.806,
  perfect_model_basis: "A perfect forecaster still incurs this, because the outcome is random.",
  measured: null,
  excess_over_ceiling: null,
  predicted_xi: { ours: null, benchmark: 0.84, benchmark_source: "SportMonks" },
  reason: "0 gameweek(s) sealed and 0 settled player-gameweeks recorded.",
};

const MEASURED = {
  ...DAY_ONE,
  gameweeks_sealed: 9,
  observations: 5400,
  measured: {
    overall: { n: 5400, rmse: 2.91, bias: -0.12, bias_radius: 0.04 },
    by_position: { MID: { n: 2100, rmse: 3.1, bias: -0.2, bias_radius: 0.06 } },
    by_band: {
      blank: { n: 3000, rmse: 1.4, bias: 0.1, bias_radius: 0.03 },
      haul: { n: 400, rmse: 7.2, bias: -3.1, bias_radius: 0.4 },
    },
    by_horizon: { "1": { n: 900, rmse: 2.7, bias: 0, bias_radius: 0.1 } },
  },
  excess_over_ceiling: 0.104,
  reason: null,
};

async function renderAccuracy(body?: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const path = String(url).replace(/^\/predictions\//, "");
    if (body === undefined || path !== ACCURACY.path) {
      return new Response("", { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(<AccuracyPage />);
  await screen.findByText("Accuracy");
  await new Promise((r) => setTimeout(r, 30));
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ""));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("before anything has been measured", () => {
  it("still shows the ceiling", async () => {
    await renderAccuracy(DAY_ONE);
    // The number that does not need a settled gameweek, and the reason this
    // page is worth shipping empty.
    expect(screen.getByText("2.806")).toBeInTheDocument();
  });

  it("explains why there is no measurement", async () => {
    await renderAccuracy(DAY_ONE);
    expect(screen.getByText("NOT YET MEASURED")).toBeInTheDocument();
    expect(screen.getByText(/0 of 38 gameweeks sealed/)).toBeInTheDocument();
  });

  it("states what the ceiling means rather than leaving a bare number", async () => {
    await renderAccuracy(DAY_ONE);
    // Said twice on purpose — once as the section's subtitle and once as the
    // artifact's own stated basis — so both are asserted rather than one being
    // matched by accident.
    expect(screen.getAllByText(/the outcome is random/).length).toBeGreaterThanOrEqual(2);
  });

  it("shows no breakdown table", async () => {
    await renderAccuracy(DAY_ONE);
    expect(screen.queryAllByTestId("slice")).toHaveLength(0);
  });

  it("names the predicted-XI bar without claiming it", async () => {
    await renderAccuracy(DAY_ONE);
    expect(screen.getByText("not measured")).toBeInTheDocument();
    expect(screen.getByText("84%")).toBeInTheDocument();
  });
});

describe("once measured", () => {
  it("shows ours beside the ceiling", async () => {
    await renderAccuracy(MEASURED);
    expect(screen.getByText("2.806")).toBeInTheDocument();
    expect(screen.getByText("2.910")).toBeInTheDocument();
  });

  it("leads with the avoidable part", async () => {
    await renderAccuracy(MEASURED);
    // 2.91 against a 2.806 ceiling: 0.104 is the only part that is ours.
    expect(screen.getByTestId("excess").textContent).toBe("0.104");
  });

  it("breaks the error out by band, position and horizon", async () => {
    await renderAccuracy(MEASURED);
    const rows = screen.getAllByTestId("slice");
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const haul = rows.find((r) => r.textContent?.includes("Hauls"));
    expect(within(haul!).getByText("7.200")).toBeInTheDocument();
  });

  it("says which band moves rank", async () => {
    await renderAccuracy(MEASURED);
    // In the section subtitle and again on the Hauls row, because an aggregate
    // RMSE hides exactly this and the reader has to be told twice.
    expect(screen.getAllByText(/band that moves rank/).length).toBeGreaterThanOrEqual(1);
    const hauls = screen.getAllByTestId("slice")
      .find((r) => r.textContent?.includes("Hauls"));
    expect(hauls?.textContent).toMatch(/10 or more/);
  });

  it("shows bias next to error", async () => {
    await renderAccuracy(MEASURED);
    const rows = screen.getAllByTestId("slice");
    const haul = rows.find((r) => r.textContent?.includes("Hauls"));
    // Pessimistic by 3.1 on hauls is a different problem from being noisy.
    expect(within(haul!).getByText("-3.100")).toBeInTheDocument();
  });

  it("renders a dash for a slice that was too thin to report", async () => {
    await renderAccuracy(MEASURED);
    const rows = screen.getAllByTestId("slice");
    const gkp = rows.find((r) => r.textContent?.startsWith("GKP"));
    expect(gkp?.textContent).toContain("—");
  });
});

describe("beating the ceiling", () => {
  it("raises an alarm instead of showing skill", async () => {
    await renderAccuracy({ ...MEASURED, excess_over_ceiling: -0.4 });
    const alert = screen.getByRole("alert");
    expect(alert.dataset.state).toBe("beats-ceiling");
    expect(alert.textContent).toMatch(/evidence of a defect/);
    expect(alert.textContent).toMatch(/already seen them/);
  });

  it("does not render the avoidable-error panel in that case", async () => {
    await renderAccuracy({ ...MEASURED, excess_over_ceiling: -0.4 });
    expect(screen.queryByTestId("excess")).not.toBeInTheDocument();
  });
});

describe("absence", () => {
  it("says nothing has been published rather than rendering zeros", async () => {
    await renderAccuracy(undefined);
    const cards = screen.getAllByRole("status");
    expect(cards.some((c) => /No accuracy rollup/.test(c.textContent ?? ""))).toBe(true);
    expect(screen.queryByText("0.000")).not.toBeInTheDocument();
  });
});
