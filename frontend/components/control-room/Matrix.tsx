"use client";

/**
 * The facet × team matrix — eight rows, three columns, one question per row.
 *
 * ## What this is, and what it refuses to be
 *
 * The design spec's §4 populates all three columns: Ronny at 54 with `q10 40 · q90
 * 70`, Wazza at 53 with `q10 31 · q90 84`, `Thomas → Senesi`, `Thomas → Kroupi
 * Jr`, `£96.9m · £3.1m`, `£96.1m · £0.0m`, both last runs at `06:12`/`06:16`. Its
 * own §9 lists every one of those as fabricated — "the two sample proposals",
 * "every quantile" — and the repository agrees: `fpl/decision_public_gw01_season
 * .json` and `..._weekly.json` have never been written, and `fpl/agent_status.json`
 * reports `agent_ran: false` with "nothing due yet".
 *
 * So this renders the design's **structure** — all eight rows, three columns, the
 * 1px-gap-over-a-hairline rule, every label and its 11px note — and fills it from
 * the artifacts. Where an artifact says nothing, the cell says `∅` and names the
 * file that would have carried it. §9's own rule: *if you cannot source a figure,
 * render `∅` and say what was not fitted.*
 *
 * ## The contrast survives the emptiness
 *
 * That is the point of keeping the rows. Four of the eight are knowable for all
 * three teams — objective, ownership stance, calibration, and what is blocked on
 * you — and those four are exactly the rows on which Ronny and Wazza are opposite:
 * one prices spread as a cost and cannot see ownership at all, the other prices
 * spread as the instrument and can see nothing else. A reader who never gets a
 * proposal out of either bot can still read straight across and see that they are
 * optimising opposed things, which is what the matrix is for.
 *
 * ## The projection row
 *
 * §4 calls it the product's thesis: one glyph, one 20–110 scale, three emphases.
 * All three are drawn, at `neutral` / `median` / `tail`, through the one
 * {@link Distribution} primitive — and two of the three resolve to `∅` because
 * their input is empty, which is the primitive's own answer for "nothing was
 * fitted". Mine's carries the one squad-level figure that is additive: the mean.
 * See {@link xiTotal} for why a quantile is not, and `SquadInterval` for the
 * sentence this screen reuses when a total has no published interval.
 */

import type { AgentStatus } from "@/lib/data/agent-status";
import type { HeuristicView } from "@/lib/data/heuristics";
import type { PublicDecision } from "@/lib/data/narrow";
import type { Projections } from "@/lib/data/projections";
import type { Read } from "@/lib/control-room/read";
import { COUNTING_RULE } from "@/lib/margin/planner";
import {
  REQUIRED_CALIBRATED_GAMEWEEKS, TEAMS, money, tenths, type TeamKey, type XiTotal,
} from "@/lib/control-room/model";
import { SQUAD_SCALE_HI, SQUAD_SCALE_LO } from "@/lib/margin/distribution";
import { Distribution, Nil } from "@/components/margin/Marks";
import { ProvenanceMarks } from "@/components/margin/Provenance";
import {
  Answer, Body, Figure, Label, S, SectionLabel, Sub,
} from "@/components/control-room/parts";
import { hatch } from "@/lib/margin/tokens";

/** The eight rows, in the order §4 fixes them. */
const FACETS = [
  { key: "objective", label: "Objective", note: "What the team is actually maximising." },
  { key: "projection", label: "GW1 projection", note: "One glyph, one 20–110 scale, three emphases." },
  { key: "value", label: "Value · bank", note: "Market-anchored. Bank in tenths, as FPL reports it." },
  { key: "call", label: "Current call", note: "The move each would make now." },
  { key: "wants", label: "Wants you", note: "Whether anything is blocked on your answer." },
  { key: "ownership", label: "Ownership stance", note: "The single axis they truly differ on." },
  { key: "calibration", label: "Calibration", note: "Whether the objective has been earned." },
  { key: "run", label: "Last run", note: "When it last produced anything." },
] as const;

type FacetKey = (typeof FACETS)[number]["key"];

export interface MatrixProps {
  readonly gameweek: number | null;
  readonly focus: TeamKey;
  readonly status: Read<AgentStatus>;
  readonly projections: Read<Projections>;
  readonly live: Read<HeuristicView>;
  readonly xi: XiTotal | null;
  readonly calibrated: number | null;
  readonly calibrationSource: string | null;
  /** The two bots' own proposals, fetched so their absence is measured. */
  readonly ronny: Read<PublicDecision>;
  readonly wazza: Read<PublicDecision>;
}

/**
 * A cell whose artifact said nothing.
 *
 * `∅` and a sentence, never a blank and never a zero. An empty cell reads as
 * "fitted, and it came out low"; a zero reads as a measurement. The path is named
 * because "not published" without a filename is indistinguishable from a bug.
 */
function NotPublished(
  { what, path, initialising }: {
    what: string; path: string; initialising: boolean;
  },
) {
  return (
    <>
      <Nil surface={S} size={15} />
      <Body style={{ marginTop: 6 }}>
        {initialising
          // Not a skeleton and not a spinner: one honest sentence, in place, in
          // body type, that is replaced by the answer when the fetch lands.
          ? `Reading ${path}.`
          : what}
      </Body>
      <div style={{ marginTop: 4 }}>
        <Sub>{`${path} · never written`}</Sub>
      </div>
    </>
  );
}

/** One cell of the eight rows, for one team. */
function Cell(
  { facet, team, props }: { facet: FacetKey; team: TeamKey; props: MatrixProps },
) {
  const { status, projections, live, xi, ronny, wazza, calibrated } = props;
  const bot = team === "ronny" ? ronny : team === "wazza" ? wazza : null;
  const botName = team === "ronny" ? "Ronny" : "Wazza";

  switch (facet) {
    // ── 1 · Objective ───────────────────────────────────────────────────────
    case "objective": {
      if (team === "mine") {
        return (
          <>
            <Figure size={15}>Your call</Figure>
            <Body style={{ marginTop: 6 }}>
              No objective function. The two bots are advisers you consult, and you
              are free to ignore both.
            </Body>
          </>
        );
      }
      const objective = team === "ronny" ? TEAMS[1].objective : TEAMS[2].objective;
      return (
        <>
          <Figure size={15}>{objective}</Figure>
          <Body style={{ marginTop: 6 }}>
            {team === "ronny"
              ? "Expected points over the season. Spread is priced as a cost, so it "
                + "will refuse a coin-flip it likes the mean of."
              : "Chance of clearing a threshold this week. Spread is the instrument, "
                + "so it will pay median points to buy a tail."}
          </Body>
          <div style={{ marginTop: 4 }}>
            <Sub
              title={
                team === "wazza"
                  ? "the threshold is pipeline/decide/plan_eval.py's default; no run "
                    + "has published which rung this gameweek was solved against"
                  : "pipeline/config.py, FPL_ENTRIES"
              }
            >
              {team === "wazza"
                ? "producer default · no solved threshold published"
                : "pipeline mandate · fixed"}
            </Sub>
          </div>
        </>
      );
    }

    // ── 2 · GW1 projection — the thesis row ─────────────────────────────────
    case "projection": {
      const emphasis = team === "mine"
        ? "neutral"
        : team === "ronny" ? "median" : "tail";

      if (team === "mine") {
        const draws = projections.value?.nDraws ?? null;
        return (
          <div data-testid="projection-glyph" data-team="mine" data-emphasis={emphasis}>
            <div className="flex items-center gap-[11px]">
              <Distribution
                of={{ mean: xi?.total ?? null }}
                surface={S}
                width={132}
                height={20}
                lo={SQUAD_SCALE_LO}
                hi={SQUAD_SCALE_HI}
                emphasis={emphasis}
              />
              {xi === null
                ? <Nil surface={S} size={15} />
                : <Figure size={18}>{xi.total.toFixed(1)}</Figure>}
            </div>
            <Body style={{ marginTop: 6 }}>
              {xi === null
                ? "The squad read does not say which eleven starts, so no total is "
                  + "summed — an assumed eleven would be a lineup nothing solved."
                : `Your eleven as drafted, summed from the published means. A mean is `
                  + `additive, so this total is exact rather than estimated. No `
                  + `interval is published for a squad total, so none is drawn.`}
            </Body>
            <div style={{ marginTop: 4 }}>
              <Sub title="the eleven's means, added; the armband is not doubled here because two screens in this app once printed two different totals for one eleven">
                {xi === null
                  ? "no XI identified"
                  : `${xi.matched} of ${xi.xiSize} matched on FPL's id`
                    + `${draws === null ? "" : ` · ${draws.toLocaleString()} draws`}`
                    + ` · ${COUNTING_RULE}`}
              </Sub>
            </div>
          </div>
        );
      }

      /*
       * The same primitive, the same scale, the emphasis this bot reads by.
       *
       * This branch used to ignore `bot` entirely and hardcode the absence. That was
       * correct for every day so far — neither file has ever been written — and would
       * have become a lie the moment one was: the screen would have said "no total
       * has been published" while the artifact beside it carried `mean_points` and
       * the total's quantiles. Wrong in the cautious direction is still wrong, and
       * this is the row the product exists for.
       *
       * The interval here is legitimate where a squad interval usually is not: it is
       * measured over the same draws that produced the mean, rather than summed from
       * eleven marginals, which would be narrower and flattering. All five ends come
       * from `plan_eval.py`'s own `quantiles` map, so the glyph draws the whole shape
       * rather than a whisker with a hole in it.
       */
      const decision = bot?.value ?? null;
      const total = decision?.mean_points ?? null;

      if (total !== null) {
        return (
          <div data-testid="projection-glyph" data-team={team} data-emphasis={emphasis}>
            <div className="flex items-center gap-[11px]">
              <Distribution
                of={{
                  mean: total,
                  q10: decision?.points_q10 ?? null,
                  q25: decision?.points_q25 ?? null,
                  q50: decision?.points_q50 ?? null,
                  q75: decision?.points_q75 ?? null,
                  q90: decision?.points_q90 ?? null,
                  // No counterpart: the producer publishes quantiles for the squad
                  // total, not a mode.
                  mode: null,
                }}
                surface={S}
                width={132}
                height={20}
                lo={SQUAD_SCALE_LO}
                hi={SQUAD_SCALE_HI}
                emphasis={emphasis}
              />
              <Figure size={18}>{total.toFixed(1)}</Figure>
            </div>
            <Body style={{ marginTop: 6 }}>
              {team === "ronny"
                ? "Reads the median and prices the spread as a cost. Measured over "
                  + "the same draws as the mean, so the interval is the solver's own "
                  + "rather than eleven marginals added up."
                : "Reads the right tail and prices the spread as the instrument. "
                  + "Measured over the same draws as the mean, so the interval is the "
                  + "solver's own rather than eleven marginals added up."}
            </Body>
            <div style={{ marginTop: 4 }}>
              <Sub>
                {[
                  decision?.points_q10 === null || decision?.points_q10 === undefined
                    ? null : `q10 ${decision.points_q10.toFixed(0)}`,
                  decision?.points_q90 === null || decision?.points_q90 === undefined
                    ? null : `q90 ${decision.points_q90.toFixed(0)}`,
                  `${emphasis} emphasis`,
                  decision?.nDraws === null || decision?.nDraws === undefined
                    ? null : `${decision.nDraws.toLocaleString()} draws`,
                ].filter(Boolean).join(" · ")}
              </Sub>
            </div>
          </div>
        );
      }

      // Nothing published. An empty input, so the primitive renders its own `∅`, and
      // the row still shows three glyph slots at three emphases.
      return (
        <div data-testid="projection-glyph" data-team={team} data-emphasis={emphasis}>
          <div className="flex items-center gap-[11px]">
            <Distribution
              of={{}}
              surface={S}
              width={132}
              height={20}
              lo={SQUAD_SCALE_LO}
              hi={SQUAD_SCALE_HI}
              emphasis={emphasis}
            />
          </div>
          <Body style={{ marginTop: 6 }}>
            {team === "ronny"
              ? "Would read the median and price the spread as a cost. Nothing to "
                + "read: no squad and no total have been published for this entry."
              : "Would read the right tail and price the spread as the instrument. "
                + "Nothing to read: no squad and no total have been published for "
                + "this entry."}
          </Body>
          <div style={{ marginTop: 4 }}>
            <Sub>{`${bot?.path ?? "no decision path"} · never written`}</Sub>
          </div>
        </div>
      );
    }

    // ── 3 · Value · bank ────────────────────────────────────────────────────
    case "value": {
      if (team === "mine") {
        const squad = live.value?.squad ?? null;
        const value = money(squad?.value ?? null);
        const bank = money(squad?.bank ?? null);
        if (value === null) {
          return (
            <>
              <Nil surface={S} size={15} />
              <Body style={{ marginTop: 6 }}>
                {live.initialising
                  ? "Reading the live squad."
                  : "FPL's own state could not be read, so the squad's value is "
                    + "unknown — which is not £0.0m."}
              </Body>
            </>
          );
        }
        const held = tenths(squad?.bank ?? null);
        return (
          <>
            <Figure size={15}>
              {bank === null ? value : `${value} · ${bank}`}
            </Figure>
            <Body style={{ marginTop: 6 }}>
              {bank === null
                ? "No deadline has passed, so FPL reports no bank at all. Unknown, "
                  + "not zero."
                : `${held} tenths held back. `}
              {squad?.source === "captured_authenticated_draft"
                ? "GW1 picks stay private before the deadline, so the fifteen are "
                  + "the authenticated draft, priced from FPL's live catalogue."
                : null}
            </Body>
            <div style={{ marginTop: 4 }}>
              <ProvenanceMarks
                anchor="market"
                freshness={live.age === null
                  ? null
                  : { label: live.age, stale: live.stale }}
                surface={S}
              />
            </div>
          </>
        );
      }
      return (
        <NotPublished
          initialising={bot?.initialising ?? false}
          path={bot?.path ?? ""}
          what={`No squad is published for ${botName}. FPL keeps a GW1 squad private `
            + `until the deadline, and no decision names one, so there is no value `
            + `and no bank to report.`}
        />
      );
    }

    // ── 4 · Current call ────────────────────────────────────────────────────
    case "call": {
      if (team === "mine") {
        const captain = xi?.captain?.name ?? null;
        const vice = xi?.vice?.name ?? null;
        return (
          <>
            <Figure size={14}>No move proposed</Figure>
            <Body style={{ marginTop: 6 }}>
              {`Nothing solves for entry ${TEAMS[0].entryId} — the two bots are `
                + `advisers, and neither has published. `}
              {captain === null
                ? "The squad read does not name an armband."
                : `Your standing pick keeps ${captain} on the armband`
                  + `${vice === null ? "." : `, ${vice} as vice.`}`}
            </Body>
          </>
        );
      }
      return (
        <NotPublished
          initialising={bot?.initialising ?? false}
          path={bot?.path ?? ""}
          what={`${botName} has proposed nothing for this gameweek. The agent gates `
            + `on the deadline and has not run, so there is no move to show — not a `
            + `hold, which would be a decision it did not make.`}
        />
      );
    }

    // ── 5 · Wants you ───────────────────────────────────────────────────────
    case "wants": {
      const deadline = status.value?.deadline ?? null;
      return (
        <>
          <Figure size={15} tone={team === "mine" ? S.ink : S.ink3}>
            Nothing waiting
          </Figure>
          <Body style={{ marginTop: 6 }}>
            {team === "mine"
              ? "No proposal is waiting on your answer: neither bot has published "
                + "one for this gameweek. The deadline is the only thing on the clock."
              : `${botName} has not run, so nothing of its is blocked on you. `
                + `Approval happens on the team's own screen; this board cannot `
                + `submit a team.`}
          </Body>
          {deadline === null ? null : (
            <div style={{ marginTop: 4 }}>
              <Sub future title="a scheduled time, not one that has happened">
                {props.gameweek === null
                  ? "deadline scheduled"
                  : `GW${props.gameweek} deadline scheduled`}
              </Sub>
            </div>
          )}
        </>
      );
    }

    // ── 6 · Ownership stance ────────────────────────────────────────────────
    case "ownership": {
      if (team === "mine") {
        return (
          <>
            <Figure size={15}>Yours</Figure>
            <Body style={{ marginTop: 6 }}>
              You can weigh it or ignore it, week to week.
            </Body>
          </>
        );
      }
      return (
        <>
          <Figure size={14} tone={team === "ronny" ? S.ink3 : S.ink}>
            {team === "ronny" ? "Not an input" : "Every input"}
          </Figure>
          <Body style={{ marginTop: 6 }}>
            {team === "ronny"
              ? "A template pick and a differential are the same object to it. It "
                + "cannot tell you it is being brave, because it has no way to know."
              : "Only relative return counts, so a 4%-owned haul beats the same "
                + "points at 60% every time."}
          </Body>
          <div style={{ marginTop: 4 }}>
            <Sub title="pipeline/decide/field.py: effective ownership cannot change the EV-optimal pick, only the variance of the margin over the field">
              pipeline/decide/field.py
            </Sub>
          </div>
        </>
      );
    }

    // ── 7 · Calibration — §4.1 ──────────────────────────────────────────────
    case "calibration": {
      if (team === "mine") {
        return (
          <Body tone={S.ink3}>
            Not applicable. A human does not need to earn an objective before
            holding one.
          </Body>
        );
      }
      if (team === "ronny") {
        return (
          <>
            <Figure size={14}>Earned</Figure>
            <Body style={{ marginTop: 6 }}>
              Expected points is measurable against any settled gameweek, so nothing
              gates it.
            </Body>
          </>
        );
      }
      return <Calibration weeks={calibrated} source={props.calibrationSource} />;
    }

    // ── 8 · Last run ────────────────────────────────────────────────────────
    case "run": {
      if (team === "mine") {
        return (
          <>
            <Figure size={15} tone={S.ink3}>—</Figure>
            <Body style={{ marginTop: 6 }}>No agent runs on your behalf.</Body>
          </>
        );
      }
      const ran = status.value?.agentRan ?? null;
      return (
        <>
          <Nil surface={S} size={15} />
          <Body style={{ marginTop: 6 }}>
            {ran === false
              ? `Never. The phase resolver reports agent_ran: false, so ${botName} `
                + `has produced nothing to date.`
                + (status.value?.reason ? ` Its words: “${status.value.reason}”.` : "")
              : status.initialising
                ? "Reading the agent's phase."
                : "The phase resolver could not be read, so whether the agent has "
                  + "run is unknown — which is not the same as it having not run."}
          </Body>
          <div style={{ marginTop: 4 }}>
            <Sub>
              {`${status.path}${status.age === null ? "" : ` · ${status.age}`}`}
            </Sub>
          </div>
        </>
      );
    }
  }
}

/**
 * Wazza's calibration counter — §4.1.
 *
 * Six cells, filled when a gameweek has sealed and been scored, hatched and
 * hairlined when it has not. **It never takes a warning or an error hue.** It is a
 * genuine caveat displayed with confidence, not a fault: the weekly objective
 * cannot honestly maximise a tail probability it has never been scored on, so it
 * borrows the season objective and says so here rather than in a footnote.
 *
 * The cells are the one bordered element on this board, and the border is theirs
 * rather than a panel around them — a caveat in a box would read as an alert.
 */
function Calibration({ weeks, source }: { weeks: number | null; source: string | null }) {
  const cells = Array.from({ length: REQUIRED_CALIBRATED_GAMEWEEKS }, (_, i) => i);
  return (
    <div data-testid="calibration-counter">
      <div
        className="grid gap-[3px] max-w-[176px]"
        style={{ gridTemplateColumns: `repeat(${REQUIRED_CALIBRATED_GAMEWEEKS}, 1fr)` }}
      >
        {cells.map((i) => {
          const sealed = weeks !== null && i < weeks;
          return (
            <span
              key={i}
              title={sealed
                ? `gameweek ${i + 1}: sealed and scored`
                : `gameweek ${i + 1}: not yet sealed`}
              style={{
                display: "block",
                height: 12,
                ...(sealed
                  ? { background: S.ink }
                  : {
                    border: `1px solid ${S.rule}`,
                    background:
                      hatch(S),
                  }),
              }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-[9px] gap-y-1 mt-2">
        {weeks === null
          ? <Nil surface={S} size={15} />
          : (
            <Figure size={19} style={{ whiteSpace: "nowrap" }}>
              {`${weeks} of ${REQUIRED_CALIBRATED_GAMEWEEKS}`}
            </Figure>
          )}
        <Label size={11} style={{ letterSpacing: "0", textTransform: "none" }}>
          calibrated gameweeks
        </Label>
      </div>
      <Body style={{ marginTop: 6 }}>
        {weeks === null
          ? "The calibration counter is not published — no artifact carries the "
            + "field model's band history — so how many gameweeks it has held is "
            + "unknown. It runs EV-optimal until six have."
          : `${weeks} of ${REQUIRED_CALIBRATED_GAMEWEEKS} calibrated gameweeks · `
            + `running EV-optimal. It cannot honestly maximise a tail probability it `
            + `has never been scored on, so it borrows Ronny's objective and states `
            + `that here rather than in a footnote.`}
      </Body>
      {source === null ? null : (
        <div style={{ marginTop: 4 }}>
          <Sub>{source}</Sub>
        </div>
      )}
    </div>
  );
}

export function Matrix(props: MatrixProps) {
  const label = props.gameweek === null
    ? "Projection"
    : `GW${props.gameweek} projection`;

  return (
    <section className="mt-[30px] pt-[9px]" style={{ borderTop: `2px solid ${S.ink}` }}>
      <div className="flex items-baseline justify-between gap-4">
        <SectionLabel>Where the three teams stand</SectionLabel>
        <Sub>every row is one question asked of all three · read across to compare</Sub>
      </div>

      {/* The 1px gap over a hairline background IS the rule. No card, no border
          per cell, no radius — a hairline reads as a boundary and a rounded
          corner reads as an object, and these are boundaries. */}
      <div
        data-testid="standings-matrix"
        className="grid gap-px mt-[14px] grid-cols-[158px_repeat(3,minmax(0,1fr))]"
        style={{ background: S.hair, border: `1px solid ${S.hair}` }}
      >
        <div
          className="flex flex-col justify-end px-[15px] pt-[13px] pb-[14px]"
          style={{ background: S.shell }}
        >
          <Label size={11} tone={S.ink3}>Facet</Label>
          <Body size={11} style={{ marginTop: 5 }}>
            Down for one team, across for the argument.
          </Body>
        </div>

        {TEAMS.map((team) => (
          <div
            key={team.key}
            data-testid={`matrix-head-${team.key}`}
            className="px-[15px] pt-[13px] pb-[14px]"
            style={{
              background: team.key === props.focus ? S.inset : S.bar,
              borderTop: `2px solid ${S.ink}`,
            }}
          >
            <div className="flex items-baseline justify-between gap-[10px]">
              <Answer size={24} as="span" style={{ lineHeight: 1 }}>{team.name}</Answer>
              <Figure size={11} tone={S.ink3} style={{ fontWeight: 400 }}>
                {team.entryId}
              </Figure>
            </div>
            <div className="flex items-center gap-[7px] mt-[7px]">
              <span
                aria-hidden
                title={team.kind === "human" ? "a person decides" : "an agent decides"}
                style={{
                  display: "block", width: 6, height: 6,
                  ...(team.kind === "human"
                    ? { background: S.ink }
                    : { border: `1px solid ${S.ink}` }),
                }}
              />
              <Label size={11}>{team.mandate}</Label>
            </div>
          </div>
        ))}

        {FACETS.map((facet) => (
          <FacetRow key={facet.key} facet={facet} props={props} label={label} />
        ))}
      </div>
    </section>
  );
}

function FacetRow(
  { facet, props, label }: {
    facet: (typeof FACETS)[number];
    props: MatrixProps;
    label: string;
  },
) {
  return (
    <>
      <div className="px-[15px] py-[13px]" style={{ background: S.shell }}>
        <Label>{facet.key === "projection" ? label : facet.label}</Label>
        <Body size={11} style={{ marginTop: 5 }}>{facet.note}</Body>
      </div>
      {TEAMS.map((team) => (
        <div
          key={team.key}
          data-testid={`cell-${facet.key}-${team.key}`}
          className="px-[15px] py-[13px]"
          style={{ background: team.key === props.focus ? S.inset : S.bar }}
        >
          <Cell facet={facet.key} team={team.key} props={props} />
        </div>
      ))}
    </>
  );
}
