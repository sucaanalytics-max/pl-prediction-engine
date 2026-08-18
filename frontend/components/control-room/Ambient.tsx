"use client";

/**
 * The ambient column — this gameweek's fixtures, the availability bar, and the
 * one thing that has never been computed at all.
 *
 * ## The fixtures are market-anchored now, and the strip says which
 *
 * §9 of the design document records that only Arsenal v Coventry carried fitted
 * goal rates and every other fixture rendered `∅`. That has changed:
 * `fixture_xg.json` carries `rate_source: "market_blend"` on all ten GW1 fixtures,
 * with eighteen bookmakers behind the anchor. So the rates are drawn and the anchor
 * is read from the artifact through {@link anchorFromRateSource} rather than
 * asserted — a fixture whose source the mapper does not recognise reports `∅`
 * rather than being quietly vouched for as a model figure.
 *
 * ## The availability bar, and the distinction it exists to keep
 *
 * Solid = players FPL has flagged. Hatched = players it has not. The second is
 * **not** "verified fit", and the caption says so: `player_stats.json` writes
 * `available` as `status in {"a", "d"}` — available *or doubtful* — so the hatched
 * segment holds everyone who has not been ruled out, including everyone nobody has
 * said anything about. Drawing absence of news as fitness is the failure this bar
 * is designed to prevent, so the hatch is the wider segment and the sentence under
 * it names the ambiguity instead of averaging it away.
 *
 * Both counts are counted from the artifact. The design's caption reads "39 of
 * 587", which was one capture's number; the file is 590 rows now, and a literal
 * would have gone on claiming 587 with nothing to catch it.
 */

import type { Projections } from "@/lib/data/projections";
import type { FixtureXg, MatchesFile, PlayerRow } from "@/lib/data/narrow";
import type { Read } from "@/lib/control-room/read";
import {
  REQUIRED_CALIBRATED_GAMEWEEKS, TAIL_THRESHOLD, availabilitySplit,
  gatedInSimulation,
} from "@/lib/control-room/model";
import { anchorFromRateSource, ProvenanceMarks } from "@/components/margin/Provenance";
import { Nil } from "@/components/margin/Marks";
import { predictionLabel } from "@/lib/formats";
import { Body, Figure, S, SectionLabel, Sub } from "@/components/control-room/parts";

/** How many fixtures the column shows. §4: four, and the rest are on /matches. */
const SHOWN = 4;

export interface AmbientProps {
  readonly gameweek: number | null;
  readonly matches: Read<MatchesFile>;
  readonly fixtureXg: Read<FixtureXg>;
  readonly playerStats: Read<readonly PlayerRow[]>;
  readonly projections: Read<Projections>;
  /** Sealed gameweeks, or null when the accuracy record could not be read. */
  readonly sealed: number | null;
}

export function Ambient(props: AmbientProps) {
  const { gameweek, matches, fixtureXg, playerStats, projections, sealed } = props;

  const fixtures = (matches.value?.matches ?? []).slice(0, SHOWN);
  // An index rather than a `find` per row: `fixture_xg.json` carries eighty
  // fixtures across the horizon, and the two files agree on club names but not on
  // order, so the join needs a key rather than a position.
  const rates = new Map(
    (fixtureXg.value?.fixtures ?? []).map(
      (row) => [`${row.home_team}|${row.away_team}`, row],
    ),
  );
  const split = availabilitySplit(playerStats.value);
  const gated = projections.value === null
    ? null
    : gatedInSimulation(projections.value.players);

  return (
    <div>
      <SectionLabel>
        {gameweek === null ? "Ambient" : `Ambient · GW${gameweek}`}
      </SectionLabel>

      {fixtures.length === 0 ? (
        <Body size={12} style={{ marginTop: 10 }}>
          {matches.initialising
            ? "Reading this gameweek's fixtures."
            : `No fixtures are published for this gameweek — ${matches.path} carries `
              + `none, so nothing is listed rather than a grid of blanks.`}
        </Body>
      ) : (
        fixtures.map((match) => {
          const rate = rates.get(`${match.home_team}|${match.away_team}`) ?? null;
          const anchor = anchorFromRateSource(rate?.rate_source);
          return (
            <div
              key={match.match_id}
              data-testid="ambient-fixture"
              className="grid items-baseline gap-3 py-2 grid-cols-[minmax(0,1fr)_62px_104px]"
              style={{ borderBottom: `1px solid ${S.hair}` }}
            >
              <Body size={12.5} tone={S.ink}>
                {`${match.home_team} v ${match.away_team}`}
              </Body>
              <Figure
                size={11.5}
                style={{ textAlign: "right", fontWeight: 400 }}
                title="the model's own call and how much of the probability mass it carries"
              >
                {`${match.confidence_pct.toFixed(0)}% ${predictionLabel(match.model_prediction)}`}
              </Figure>
              <div className="text-right">
                {rate === null ? (
                  <Nil surface={S} size={11} />
                ) : (
                  <Figure
                    size={11}
                    tone={S.ink2}
                    style={{ fontWeight: 400 }}
                    title={`goal rates the consumer uses, home / away — ${
                      rate.rate_source ?? "source unstated"
                    }`}
                  >
                    {`${rate.home_rate.toFixed(2)} / ${rate.away_rate.toFixed(2)}`}
                  </Figure>
                )}
                <div style={{ marginTop: 2 }}>
                  <ProvenanceMarks anchor={anchor} surface={S} />
                </div>
              </div>
            </div>
          );
        })
      )}

      {/* ── The availability bar ─────────────────────────────────────────── */}
      <div className="mt-4" data-testid="availability">
        {split === null ? (
          <Body size={12}>
            {playerStats.initialising
              ? "Reading the player catalogue."
              : `No availability is published — ${playerStats.path} could not be `
                + `read, so no split is drawn. An empty bar would read as "nobody is `
                + `flagged", which is a measurement.`}
          </Body>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <Figure size={21} style={{ fontWeight: 400 }}>{split.flagged}</Figure>
              <Body size={11.5}>
                {`of ${split.total} carry an availability flag`}
              </Body>
            </div>
            <div
              className="grid gap-[2px] mt-2"
              style={{
                height: 10,
                gridTemplateColumns: `${split.flagged}fr ${split.unflagged}fr`,
              }}
            >
              <span
                data-testid="availability-flagged"
                title={`${split.flagged} players: FPL has published a flag`}
                style={{ background: S.ink }}
              />
              <span
                data-testid="availability-no-news"
                title={`${split.unflagged} players: no flag, which is not the same as fit`}
                style={{
                  background:
                    "repeating-linear-gradient(45deg, rgba(27,26,22,.12) 0 3px, "
                    + "transparent 3px 6px)",
                  border: `1px solid ${S.hair}`,
                }}
              />
            </div>
            <Body size={11.5} tone={S.ink3} style={{ marginTop: 8 }}>
              {"Hatch is "}
              <em style={{ fontStyle: "normal", color: S.ink }}>no flag</em>
              {`. ${split.unflagged} carry none, and FPL writes that field as `}
              <em style={{ fontStyle: "normal", color: S.ink }}>available or doubtful</em>
              {`, so it cannot separate a player who is fit from one nobody has `
                + `mentioned.`}
              {gated === null
                ? null
                : ` ${gated} are gated to no appearance in the simulation.`}
            </Body>
          </>
        )}
      </div>

      {/* ── Rule 1's one genuine exception: never computed at all ───────── */}
      <Body size={12} style={{ marginTop: 16, lineHeight: 1.55 }}>
        {`P(GW ≥ ${TAIL_THRESHOLD}) has never been scored for this squad — `
          + `${REQUIRED_CALIBRATED_GAMEWEEKS} sealed gameweeks are needed and `
          + `${sealed === null ? "the sealed count is not published" : `${sealed} have sealed`}`
          + `, so Wazza runs EV-optimal and says so above.`}
      </Body>
      {fixtureXg.age === null ? null : (
        <div style={{ marginTop: 8 }}>
          <Sub>{`goal rates: ${fixtureXg.age}`}</Sub>
        </div>
      )}
    </div>
  );
}
