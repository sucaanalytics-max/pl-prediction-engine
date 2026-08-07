/**
 * The Markets screen — the real-money path.
 *
 * Two properties matter more than anything visual, and both are asserted against
 * the shape of the REAL `latest.json`:
 *
 * 1. **A currency amount can never be rendered as a stake.** The artifact carries
 *    `half_kelly: 25.0` (currency, against a hardcoded £1,000) beside
 *    `half_kelly_pct: 0.025` (a fraction). Rendering the wrong one recommends
 *    staking 2500% of bankroll.
 * 2. **"No bets" is not one state.** Priced-and-nothing-cleared, no-prices-fetched
 *    and unrecognised-vocabulary are three different answers, and only the first
 *    means the engine worked.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MarketsPage from "@/app/markets/page";
import { pricingOf } from "@/lib/data/pricing";
import { REGISTRY } from "@/lib/data/narrow";

/** A prediction shaped exactly like the committed artifact. */
function prediction(bets: unknown[]) {
  return {
    match_id: "m1",
    fixture: { home_team: "Arsenal", away_team: "Chelsea", date: "2026-08-15" },
    probabilities: { "1x2": { home: 0.5, draw: 0.3, away: 0.2 } },
    shap_features: [],
    odds_comparison: null,
    value_bets: bets,
  };
}

/** The four Kelly fields as the real file carries them. Two units. */
const REAL_BET = {
  market: "Over 2.5 Goals",
  edge: 0.0562,
  model_prob: 0.61,
  implied_prob: 0.55,
  decimal_odds: 1.82,
  bookmaker: "bet365",
  full_kelly: 50.0,      // currency
  half_kelly: 25.0,      // currency
  full_kelly_pct: 0.05,  // fraction
  half_kelly_pct: 0.025, // fraction
};

function latest(predictions: unknown[]) {
  return {
    metadata: {
      gameweek: 1, season: "2026-27",
      generated_at: "2026-08-06T06:00:00Z", pipeline_version: "4.1.0",
    },
    predictions,
  };
}

function health(oddsSource: string | null) {
  return {
    last_updated: "2026-08-06T06:00:00Z", gameweek: 1, n_predictions: 10,
    status: "healthy", pipeline_version: "4.1.0",
    ...(oddsSource === null ? {} : { odds_source: oddsSource }),
  };
}

function mockFetch(bodies: Record<string, unknown>) {
  return vi.fn(async (url: unknown) => {
    const path = String(url).replace(/^\/predictions\//, "");
    if (!(path in bodies)) return new Response("", { status: 404 });
    return new Response(JSON.stringify(bodies[path]), { status: 200 });
  });
}

async function renderMarkets(bodies: Record<string, unknown>) {
  vi.stubGlobal("fetch", mockFetch(bodies));
  render(<MarketsPage />);
  await screen.findByText("Value bets");
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ""));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("stakes are fractions, never currency", () => {
  it("renders 2.50%, not 25.00% and not 2500%", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([REAL_BET])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    const row = screen.getByTestId("bet");
    expect(within(row).getByText("2.50%")).toBeInTheDocument();
    // The currency value, misrendered as a percentage.
    expect(within(row).queryByText("2500.00%")).toBeNull();
    // The full-Kelly fraction, which must never be the headline stake.
    expect(within(row).queryByText("5.00%")).toBeNull();
  });

  it("the illustrative cash figure uses the fraction", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([REAL_BET])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    // 0.025 x £100 = £2.50. If the currency field leaked it would be £2500.00.
    expect(within(screen.getByTestId("bet")).getByText("£2.50")).toBeInTheDocument();
  });

  it("shows 'no stake' when only the currency fields survive", async () => {
    // The drift case: a producer stops emitting the _pct fields. The correct
    // answer is no stake, NOT the currency number.
    const { half_kelly_pct, full_kelly_pct, ...currencyOnly } = REAL_BET;
    void half_kelly_pct; void full_kelly_pct;
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([currencyOnly])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    const row = screen.getByTestId("bet");
    expect(within(row).getByText("no stake")).toBeInTheDocument();
    expect(row.textContent).not.toContain("2500");
    expect(row.textContent).not.toContain("£25.00");
  });

  it("halves full_kelly_pct when only that survives", async () => {
    const { half_kelly_pct, ...noHalf } = REAL_BET;
    void half_kelly_pct;
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([noHalf])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    // Halved, because under-staking is recoverable and over-staking is not.
    expect(within(screen.getByTestId("bet")).getByText("2.50%")).toBeInTheDocument();
  });

  it("refuses a _pct field that itself holds a currency amount", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([
        prediction([{ ...REAL_BET, half_kelly_pct: 25.0, full_kelly_pct: 50.0 }]),
      ]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(within(screen.getByTestId("bet")).getByText("no stake")).toBeInTheDocument();
  });
});

describe("pricingOf", () => {
  it("recognises the two values the pipeline writes", () => {
    expect(pricingOf("the_odds_api")).toBe("priced");
    expect(pricingOf("unavailable")).toBe("unpriced");
  });

  it("refuses to guess at anything else", () => {
    // Measured on the committed artifact: `football_data`, which run_pipeline.py
    // never writes. Bucketing it would report a stale vocabulary as a market
    // judgement.
    expect(pricingOf("football_data")).toBe("unrecognised");
    expect(pricingOf(null)).toBe("unrecognised");
    expect(pricingOf("")).toBe("unrecognised");
  });
});

describe("the vig flag — whether an edge is honest", () => {
  /**
   * `edge = model_prob - implied_prob`, so the edge is only honest if
   * `implied_prob` was de-vigged. Measured on the live artifact this varies BY
   * MARKET: the 1X2 bets are de-vigged, both Over 2.5 Goals bets are not.
   * A raw edge overstates value and therefore oversizes the stake.
   */
  it("flags an edge that still contains the bookmaker's margin", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([
        { ...REAL_BET, implied_prob: 0.4603, raw_implied_prob: 0.4603 },
      ])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(document.querySelector('[data-vig="inflated"]')).not.toBeNull();
    expect(screen.getByText(/still include the book's margin/)).toBeInTheDocument();
  });

  it("marks a de-vigged edge as net of vig", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([
        { ...REAL_BET, implied_prob: 0.2942, raw_implied_prob: 0.3040 },
      ])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(document.querySelector('[data-vig="clean"]')).not.toBeNull();
    expect(document.querySelector('[data-vig="inflated"]')).toBeNull();
  });

  it("says unknown rather than assuming clean when raw_implied_prob is absent", async () => {
    // The dangerous default. Assuming de-vigged would present an inflated edge as
    // an honest one, on the screen that sizes real stakes.
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([REAL_BET])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(document.querySelector('[data-vig="unknown"]')).not.toBeNull();
    expect(document.querySelector('[data-vig="clean"]')).toBeNull();
  });

  it("tolerates float noise rather than reporting it as a de-vig", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([
        { ...REAL_BET, implied_prob: 0.46, raw_implied_prob: 0.46 + 1e-12 },
      ])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(document.querySelector('[data-vig="inflated"]')).not.toBeNull();
  });

  it("can filter down to de-vigged bets only", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([
        prediction([{ ...REAL_BET, implied_prob: 0.29, raw_implied_prob: 0.30 }]),
        { ...prediction([{ ...REAL_BET, market: "Over 2.5 Goals", implied_prob: 0.46, raw_implied_prob: 0.46 }]), match_id: "m2" },
      ]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(screen.getAllByTestId("bet")).toHaveLength(2);
    screen.getByLabelText, screen.getByRole("checkbox").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getAllByTestId("bet")).toHaveLength(1);
  });
});

describe("the three kinds of no-bets", () => {
  it("priced and nothing cleared is stated as a real answer", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    const card = screen.getByRole("status");
    expect(card.dataset.pricing).toBe("priced");
    expect(card.textContent).toMatch(/nothing cleared the edge threshold/);
    expect(card.textContent).toMatch(/real answer, not a missing one/);
  });

  it("no prices fetched names the quota", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([])]),
      [REGISTRY.health.path]: health("unavailable"),
    });
    const card = screen.getByRole("status");
    expect(card.dataset.pricing).toBe("unpriced");
    expect(card.textContent).toMatch(/500 requests a month/);
  });

  it("an unrecognised source says it cannot tell", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([])]),
      [REGISTRY.health.path]: health("football_data"),
    });
    const card = screen.getByRole("status");
    expect(card.dataset.pricing).toBe("unrecognised");
    expect(card.textContent).toMatch(/Cannot tell whether markets were priced/);
    expect(card.textContent).toContain("football_data");
  });

  it("an absent health artifact is unrecognised, not priced", async () => {
    // Guessing "priced" here would claim the market had been assessed when the
    // file saying so could not even be read.
    await renderMarkets({ [REGISTRY.latest.path]: latest([prediction([])]) });
    expect(screen.getByRole("status").dataset.pricing).toBe("unrecognised");
  });
});

describe("Rule 2 and degenerate data", () => {
  it("an absent latest.json does not blank the page", async () => {
    await renderMarkets({ [REGISTRY.health.path]: health("the_odds_api") });
    expect(screen.getByText("Value bets")).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toMatch(/No predictions/);
  });

  it("renders bets even when the explainability stage never ran", async () => {
    // `latest` is `empty` on the committed data because shap_features is [] and
    // odds_comparison is null on 10/10 — but the value bets are real and must
    // still show. This is why the section passes showEmpty.
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([REAL_BET])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(screen.getByTestId("bet")).toBeInTheDocument();
  });

  it("collects bets from every fixture, not just the first", async () => {
    await renderMarkets({
      [REGISTRY.latest.path]: latest([
        prediction([REAL_BET]),
        { ...prediction([{ ...REAL_BET, market: "Home Win" }]), match_id: "m2" },
      ]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(screen.getAllByTestId("bet")).toHaveLength(2);
  });

  it("tolerates a bet with no decimal odds", async () => {
    const { decimal_odds, ...noOdds } = REAL_BET;
    void decimal_odds;
    await renderMarkets({
      [REGISTRY.latest.path]: latest([prediction([noOdds])]),
      [REGISTRY.health.path]: health("the_odds_api"),
    });
    expect(screen.getByTestId("bet")).toBeInTheDocument();
  });
});
