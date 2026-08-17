"use client";

/**
 * Decide — the call, what argues with it, and what the heuristic would have said.
 *
 * ## What is on this screen and where each number comes from
 *
 * | panel | artifact | today |
 * |---|---|---|
 * | the call | `fpl/decision_public_gw{NN}_season.json` | absent — no gameweek has sealed |
 * | rejected plans | `fpl/sensitivity_gw{NN}_season.json` | published and unmeasurable |
 * | disagreement | `fpl/minutes_conflicts_gw01.json` | fifteen live conflicts |
 * | heuristic shortlist | `/api/fpl/state` | live |
 * | the fifteen | `/api/fpl/state` + `fpl/xp_public_gw{NN}.json` | live |
 *
 * Two of the five are absent for most of a gameweek cycle, by design, and the
 * screen is laid out for that rather than against it: the panels that *are*
 * populated — the conflicts, the fifteen, the badged heuristic — carry the top
 * of the page, and the absent call states its reason where the answer would be.
 * The reverse ordering is what put 1200px of empty boxes above the only content
 * on the page this one replaces.
 *
 * ## The one number this screen refuses to draw
 *
 * The design's headline carries a quantile strip — q10 through q99 with
 * `P(≥60) 47.9%` under it — for the whole XI. `PublicDecision` publishes
 * `mean_points` and no distribution, and a squad total's spread is not the sum
 * of its players' because clean sheets are drawn jointly. So the strip is not
 * drawn. Per-player glyphs are, everywhere the projection publishes quantiles,
 * because those are measured.
 */

import { useMemo, useState } from "react";
import { proven, type Artifact } from "@/lib/data/artifact";
import type { AgentStatus } from "@/lib/data/agent-status";
import { decisionDescriptor, type PublicDecision } from "@/lib/data/narrow";
import { sensitivityDescriptor, type Sensitivity } from "@/lib/data/sensitivity";
import {
  minutesConflictsDescriptor, type MinutesConflict, type MinutesConflicts,
} from "@/lib/data/minutes-conflicts";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import type { HeuristicView } from "@/lib/data/heuristics";
import { describeMode, modeOf } from "@/lib/margin/mode";
import {
  hasLineup, inReadingOrder, joinProjections, type SquadRow,
} from "@/lib/margin/squad";
import { INK, MONO, RAIL_BG, SANS } from "@/lib/margin/tokens";
import {
  Age, Distribution, Eyebrow, Hatch, MarginState, Nil, WhenProvenHere,
} from "@/components/margin/Marks";
import { SquadInterval } from "@/components/margin/SquadInterval";

const S = INK;

// ─────────────────────────────────────────────────────────────────────────────
// The call
// ─────────────────────────────────────────────────────────────────────────────

/** The move in one line, or "Hold". */
function moveLine(decision: PublicDecision): string {
  const plan = decision.plan;
  if (!plan) return "No plan was published with this decision.";
  const moved = plan.transfers_out.length > 0 || plan.transfers_in.length > 0;
  if (!moved) return "Hold — no transfer.";
  // Element ids, not names. `decision_public` publishes ids and the name lookup
  // lives in a different artifact; printing `Player 426` is ugly and printing a
  // guessed name is worse.
  return `Out ${plan.transfers_out.join(", ")} · in ${plan.transfers_in.join(", ")}`;
}

function TheCall(
  { decision, gameweek }: { decision: PublicDecision; gameweek: number },
) {
  const plan = decision.plan;
  return (
    <div>
      <Eyebrow surface={S} tone={S.agree} style={{ marginBottom: 11 }}>
        The call &middot; GW{gameweek} &middot; season team
      </Eyebrow>
      <h1
        style={{
          margin: 0, fontFamily: SANS, fontSize: 34, lineHeight: 1.08,
          letterSpacing: "-.035em", fontWeight: 600, color: S.ink, maxWidth: 800,
        }}
      >
        {moveLine(decision)}
        {plan?.captain !== null && plan?.captain !== undefined
          ? ` Captain ${plan.captain}.`
          : ""}
      </h1>
      {decision.objective ? (
        <p style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.55, color: S.ink2, maxWidth: 740 }}>
          {decision.objective}
        </p>
      ) : null}

      <div
        style={{
          display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))",
          gap: 24, alignItems: "start", margin: "16px 0 0",
          borderTop: `1px solid ${S.hair}`, borderBottom: `1px solid ${S.hair}`,
          padding: "16px 0",
        }}
      >
        <div>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".12em", marginBottom: 5 }}>
            Projected points
          </Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 34, fontWeight: 500, color: S.ink, letterSpacing: "-.03em", lineHeight: 1 }}>
            {decision.mean_points === null ? <Nil surface={S} size={30} /> : decision.mean_points.toFixed(1)}
          </div>
          {/* Prints that same sentence itself when the producer published no
              interval, so the honest state survives a producer that has not
              shipped the block yet. */}
          <SquadInterval decision={decision} />
        </div>
        <div>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".12em", marginBottom: 5 }}>
            Optimism gap
          </Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 34, fontWeight: 500, color: S.ink, letterSpacing: "-.03em", lineHeight: 1 }}>
            {decision.optimism_gap === null
              ? <Nil surface={S} size={30} />
              : decision.optimism_gap.toFixed(2)}
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 11.5, lineHeight: 1.45, color: S.ink3 }}>
            The winner&apos;s-curse correction, scored on an independent draw
            stream. A large gap means the shortlist was chosen by noise.
          </p>
        </div>
        <div>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".12em", marginBottom: 5 }}>
            Margin
          </Eyebrow>
          <div
            style={{
              fontFamily: MONO, fontSize: 20, fontWeight: 500, letterSpacing: "-.02em",
              color: decision.credible_margin ? S.agree : S.noise,
            }}
          >
            {decision.credible_margin ? "credible" : "within noise"}
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 11.5, lineHeight: 1.45, color: S.ink3 }}>
            {decision.credible_margin
              ? "The winner beat the runner-up by more than the draw noise."
              : "The top plans are indistinguishable at this draw count. Either is defensible."}
          </p>
        </div>
      </div>

      {decision.warnings.length > 0 ? (
        <ul style={{ margin: "12px 0 0", paddingLeft: 16, color: S.noise, fontSize: 12.5, lineHeight: 1.6 }}>
          {decision.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * No call, said at the size the answer would have been.
 *
 * The third tile is the point of the panel. "Would the call change" cannot be
 * answered without a solve, and `∅` is the honest mark — a reader who sees "no"
 * there will hold, and holding may be wrong. Not knowing and knowing-not are
 * different, and only one of them is true here.
 */
function NoCall(
  { gameweek, mode, status, decision, conflicts }: {
    gameweek: number;
    mode: ReturnType<typeof modeOf>;
    status: AgentStatus | null;
    decision: Artifact<PublicDecision>;
    conflicts: Artifact<MinutesConflicts>;
  },
) {
  const conflictCount = proven(conflicts)?.conflicts.length ?? null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <Hatch surface={S} width={96} height={14} />
        <Eyebrow surface={S}>
          {mode === "idle"
            ? "The engine has not run for this gameweek"
            : "No call has been published for this gameweek"}
        </Eyebrow>
      </div>
      <h1
        style={{
          margin: 0, fontFamily: SANS, fontSize: 32, lineHeight: 1.1,
          letterSpacing: "-.035em", fontWeight: 600, color: S.ink, maxWidth: 760,
        }}
      >
        There is no call for GW{gameweek} yet.
      </h1>
      <p style={{ margin: "12px 0 0", fontSize: 13.5, lineHeight: 1.6, color: S.ink2, maxWidth: 720 }}>
        {describeMode(mode, status)}
      </p>
      {/* The artifact's own sentence, on its own line. Run together with the
          resolver's, the two read as one malformed sentence — and the reason a
          state carries is the only thing separating an honest empty screen from
          a broken one, so it does not get to arrive as a fragment. */}
      <p style={{ margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.6, color: S.ink3, maxWidth: 720 }}>
        {decision.provenance.path} — {decision.reason}
      </p>

      <div
        style={{
          marginTop: 20, display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 1, background: S.hair, border: `1px solid ${S.hair}`,
        }}
      >
        <div style={{ background: S.bar, padding: "15px 17px" }}>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em" }}>Engine phase</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 500, color: S.ink, marginTop: 7, letterSpacing: "-.03em" }}>
            {status?.phase ?? <Nil surface={S} size={20} />}
          </div>
          <div style={{ fontSize: 12, color: S.ink3, marginTop: 5 }}>
            {status?.agentRan
              ? "The expensive job ran."
              : "The expensive job was skipped, so its artifacts are legitimately absent."}
          </div>
        </div>
        <div style={{ background: S.bar, padding: "15px 17px" }}>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em" }}>Open disagreements</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 500, color: S.ink, marginTop: 7, letterSpacing: "-.03em" }}>
            {conflictCount ?? <Nil surface={S} size={20} />}
          </div>
          <div style={{ fontSize: 12, color: S.ink3, marginTop: 5 }}>
            Scanned evidence against the fitted minutes. Reported, never applied.
          </div>
        </div>
        <div style={{ background: S.bar, padding: "15px 17px" }}>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em" }}>Would the call change</Eyebrow>
          <div style={{ marginTop: 7 }}><Nil surface={S} size={22} /></div>
          <div style={{ fontSize: 12, color: S.ink3, marginTop: 5 }}>
            Not knowable without a solve. Not &ldquo;no&rdquo;.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Disagreement
// ─────────────────────────────────────────────────────────────────────────────

function ConflictCell(
  { conflict, thresholds }: {
    conflict: MinutesConflict;
    thresholds: { fringe: number; nailed: number };
  },
) {
  // Which bar the disagreement is against. A bare "14′" is not a disagreement
  // with anything until the line it failed is on screen beside it.
  const bar = conflict.kind === "fringe-but-discussed"
    ? thresholds.fringe
    : thresholds.nailed;

  return (
    <div style={{ padding: "13px 17px", borderTop: `1px solid ${S.hair}` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 13, color: S.ink }}>{conflict.player}</span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3 }}>{conflict.club}</span>
        <span
          style={{
            fontFamily: MONO, fontSize: 15, color: S.ink,
            textDecoration: "line-through",
            textDecorationColor: S.conflict,
            textDecorationThickness: "1.5px",
          }}
        >
          {conflict.eMinutes.toFixed(0)}&prime;
        </span>
        <span style={{ fontFamily: MONO, fontSize: 14, color: S.conflict }}>
          &ne; {bar}&prime;
        </span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3 }}>
          {conflict.kind === "fringe-but-discussed"
            ? "discussed as a starter, fitted as a fringe player"
            : "fitted as nailed, doubted in the evidence"}
        </span>
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3, maxWidth: 720 }}>
        &ldquo;{conflict.quote}&rdquo;
      </p>
      <div style={{ marginTop: 5, fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
        {conflict.source}
        {" · "}
        <a
          href={conflict.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: S.agree, textDecoration: "none", borderBottom: `1px solid ${S.hair}` }}
        >
          check the claim
        </a>
      </div>
    </div>
  );
}

function Disagreement(
  { artifact, decision, squadIds }: {
    artifact: Artifact<MinutesConflicts>;
    decision: Artifact<PublicDecision>;
    /** The fifteen, so the panel can say how many conflicts touch them. */
    squadIds: readonly number[];
  },
) {
  const [open, setOpen] = useState(false);
  const value = proven(artifact);
  const call = proven(decision);
  const shown = value ? (open ? value.conflicts : value.conflicts.slice(0, 3)) : [];

  // How many of this run's disagreements land on a player you own. The count
  // alone is a statistic; the intersection is the reason to read it.
  const mine = value && squadIds.length
    ? value.conflicts.filter((c) => squadIds.includes(c.elementId)).length
    : null;
  const widest = value?.conflicts[0] ?? null;

  return (
    <div style={{ border: `1px solid ${S.conflict}`, background: "rgba(0,0,0,.25)" }}>
      <div style={{ padding: "14px 17px 13px", borderBottom: `1px solid ${S.hair}` }}>
        <Eyebrow surface={S} tone={S.conflict} style={{ marginBottom: 7 }}>
          Disagreement
          {value ? ` · ${value.conflicts.length} open` : ""}
        </Eyebrow>
        <h2 style={{ margin: "0 0 4px", fontFamily: SANS, fontSize: 18, fontWeight: 600, letterSpacing: "-.02em", color: S.ink }}>
          Where the scanned evidence and the fitted minutes do not agree.
        </h2>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: S.ink2, maxWidth: 720 }}>
          {value?.note
            ?? "Reported, never applied: correcting a projection from a quote needs a "
              + "fitted model of pre-season minutes, not a regex."}
        </p>
      </div>

      {/* The design's three columns: what the solve says about its own margin,
          what the evidence disputes, and what the model flagged as
          uncalibrated. Only the first two have a producer. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div style={{ padding: "13px 17px", borderRight: `1px solid ${S.hair}` }}>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em", marginBottom: 6 }}>
            Margin over the runner-up
          </Eyebrow>
          {call ? (
            <>
              <div style={{ fontFamily: MONO, fontSize: 15, color: call.credible_margin ? S.agree : S.noise }}>
                {call.credible_margin ? "credible" : "within noise"}
              </div>
              <div style={{ marginTop: 7, fontFamily: MONO, fontSize: 11, color: S.ink3 }}>
                optimism gap{" "}
                {call.optimism_gap === null ? "∅" : call.optimism_gap.toFixed(2)}
                {" · scored on an independent draw stream"}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11.5, lineHeight: 1.45, color: S.ink3 }}>
              No call is published, so there is no margin to report. The
              runners-up are stripped from the public artifact by design.
            </div>
          )}
        </div>

        <div style={{ padding: "13px 17px", borderRight: `1px solid ${S.hair}` }}>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em", marginBottom: 6 }}>
            Evidence vs fitted minutes
          </Eyebrow>
          {widest && value ? (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: MONO, fontSize: 13, color: S.ink }}>{widest.player}</span>
                <span
                  style={{
                    fontFamily: MONO, fontSize: 15, color: S.ink,
                    textDecoration: "line-through",
                    textDecorationColor: S.conflict,
                    textDecorationThickness: "1.5px",
                  }}
                >
                  {widest.eMinutes.toFixed(0)}&prime;
                </span>
                <span style={{ fontFamily: MONO, fontSize: 14, color: S.conflict }}>
                  &ne;{" "}
                  {widest.kind === "fringe-but-discussed" ? value.fringeMinutes : value.nailedMinutes}&prime;
                </span>
              </div>
              <div style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.45, color: S.ink3 }}>
                {value.conflicts.length} disagreement
                {value.conflicts.length === 1 ? "" : "s"} this run
                {mine === null ? "" : `; ${mine} ${mine === 1 ? "touches" : "touch"} your fifteen`}. Not
                overridden — you decide.
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11.5, lineHeight: 1.45, color: S.ink3 }}>
              Nothing to report this run.
            </div>
          )}
        </div>

        <div style={{ padding: "13px 17px" }}>
          <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em", marginBottom: 6 }}>
            Sub-model flagged
          </Eyebrow>
          <div style={{ marginTop: 2 }}><Nil surface={S} size={16} /></div>
          <div style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.45, color: S.ink3 }}>
            No producer publishes a calibration flag per player, so nothing is
            drawn hollow. An uncalibrated rate rendered as a solid number is the
            one thing this panel exists to prevent.
          </div>
        </div>
      </div>

      <WhenProvenHere
        of={artifact}
        surface={S}
        showEmpty
        what={
          "No disagreement between the minutes model and the scanned evidence has "
          + "been published for this gameweek."
        }
        then={(value_) => (
          value_.conflicts.length === 0 ? (
            <p style={{ margin: 0, padding: "13px 17px", borderTop: `1px solid ${S.hair}`, fontSize: 12.5, color: S.ink2 }}>
              Checked, and nothing disagreed. Every projection the scan touched was
              consistent with the evidence — which is a result, not an absence.
            </p>
          ) : (
            <>
              {shown.map((conflict) => (
                <ConflictCell
                  key={`${conflict.elementId}-${conflict.url}`}
                  conflict={conflict}
                  thresholds={{ fringe: value_.fringeMinutes, nailed: value_.nailedMinutes }}
                />
              ))}
              {value_.conflicts.length > 3 ? (
                <button
                  type="button"
                  onClick={() => setOpen((was) => !was)}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "10px 17px", border: 0,
                    borderTop: `1px solid ${S.hair}`, background: "transparent",
                    fontFamily: MONO, fontSize: 10, letterSpacing: ".08em",
                    textTransform: "uppercase", color: S.ink3, cursor: "pointer",
                  }}
                >
                  {open
                    ? "show the widest three"
                    : `show the other ${value_.conflicts.length - 3}`}
                </button>
              ) : null}
              {value_.ambiguousSurnames.size > 0 ? (
                <p style={{ margin: 0, padding: "10px 17px", borderTop: `1px solid ${S.hair}`, fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
                  {value_.ambiguousSurnames.size} surname
                  {value_.ambiguousSurnames.size === 1 ? " was" : "s were"} left
                  unresolved rather than guessed, so any claim about them is absent
                  from this list rather than attached to the wrong player.
                </p>
              ) : null}
            </>
          )
        )}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rejected plans
// ─────────────────────────────────────────────────────────────────────────────

function Rejected(
  { artifact, gameweek }: { artifact: Artifact<Sensitivity>; gameweek: number },
) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 9 }}>
        <Eyebrow surface={S}>Rejected &middot; how often each plan won a re-solve</Eyebrow>
        <Eyebrow surface={S} style={{ fontSize: 10, letterSpacing: 0, textTransform: "none" }}>
          GW{gameweek} &middot; season team
        </Eyebrow>
      </div>
      <div style={{ border: `1px solid ${S.hair}`, padding: "0 15px" }}>
        <WhenProvenHere
          of={artifact}
          surface={S}
          compact
          what={
            "How often the call survives the projections being wrong has not been "
            + "measured for this gameweek."
          }
          then={(report) => (
            <div style={{ padding: "4px 0" }}>
              {report.alternatives.map((alt) => (
                <div
                  key={alt.move}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 80px 110px",
                    alignItems: "center", gap: 12, padding: "10px 0",
                    borderBottom: `1px solid ${S.hair}`,
                  }}
                >
                  <span style={{ fontSize: 13, color: alt.move === report.baselineMove ? S.ink : S.ink2 }}>
                    {alt.move === "hold" ? "Hold" : alt.move}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: S.ink, textAlign: "right" }}>
                    {(alt.frequency * 100).toFixed(0)}%
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", textAlign: "right", color: S.ink3 }}>
                    {alt.move === report.baselineMove ? "the call" : `${alt.wins} of ${report.draws}`}
                  </span>
                </div>
              ))}
              <p style={{ margin: "9px 0 12px", fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
                {report.draws} re-solve{report.draws === 1 ? "" : "s"} under perturbed
                projections
                {report.failedDraws > 0
                  ? `, ${report.failedDraws} of which could not be solved and are excluded from the denominator`
                  : ""}
                .
              </p>
            </div>
          )}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The heuristic, disclosed rather than dressed up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fallback shortlist, behind a fold and in italics.
 *
 * Not hidden and not styled like the model. Its projected minutes are
 * `minutes ÷ total points × 4.5`, which is dimensionally meaningless and rewards
 * low-scoring players with more minutes; its tests contain no accuracy
 * assertions. The rationale is the only part worth reading, so the rationale is
 * set in the reading face and the numbers are set dotted-underlined — a
 * typographic hedge, applied to every number this engine produces.
 */
function Heuristic({ artifact }: { artifact: Artifact<HeuristicView> }) {
  const [open, setOpen] = useState(false);
  const dotted = {
    fontFamily: MONO, fontSize: 12.5, color: S.ink2,
    borderBottom: `1.5px dotted ${S.ink3}`,
  } as const;

  return (
    <div style={{ border: `1px solid ${S.hair}`, background: "rgba(0,0,0,.2)" }}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        style={{
          display: "flex", width: "100%", alignItems: "center",
          justifyContent: "space-between", gap: 12, padding: "12px 15px",
          background: "transparent", border: 0, cursor: "pointer", textAlign: "left",
        }}
      >
        <span>
          <span style={{ display: "block", fontStyle: "italic", fontSize: 13, color: S.ink2 }}>
            Show the heuristic&apos;s shortlist — not the model
          </span>
          <span style={{ display: "block", fontFamily: MONO, fontSize: 10, color: S.ink3, marginTop: 3 }}>
            unvalidated &middot; minutes &divide; points &times; 4.5 &middot; no accuracy assertions
          </span>
        </span>
        <span style={{ fontFamily: MONO, fontSize: 16, color: S.ink3 }}>
          {open ? "−" : "+"}
        </span>
      </button>

      {open ? (
        <div style={{ padding: "12px 15px 14px", borderTop: `1px solid ${S.hair}` }}>
          <p style={{ margin: "0 0 11px", fontStyle: "italic", fontSize: 12.5, lineHeight: 1.5, color: S.ink3, maxWidth: 700 }}>
            Read the rationale, never the number. This engine ranks by an
            arithmetic score, not by a simulated distribution, and nothing in its
            test suite asserts that the score is right.
          </p>
          <WhenProvenHere
            of={artifact}
            surface={S}
            compact
            what="The heuristic engine produced no transfer shortlist."
            then={(view) => (
              view.transfers.length === 0 ? (
                <p style={{ margin: 0, fontStyle: "italic", fontSize: 12.5, color: S.ink2 }}>
                  No move scored better than holding.
                </p>
              ) : (
                <div>
                  {view.transfers.slice(0, 5).map((move) => (
                    <div
                      key={`${move.rank}-${move.playerOut.elementId}-${move.playerIn.elementId}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0,1fr) 66px 66px minmax(0,1fr)",
                        gap: 12, alignItems: "baseline", marginBottom: 7,
                        fontStyle: "italic", fontSize: 12.5, color: S.ink2,
                      }}
                    >
                      <span>{move.playerOut.name} &rarr; {move.playerIn.name}</span>
                      <span style={dotted}>+{move.delta4.toFixed(1)}</span>
                      <span style={dotted}>{move.confidence.toFixed(2)}</span>
                      <span style={{ fontStyle: "normal", fontSize: 11.5, color: S.ink3 }}>
                        {move.rationale.join(" · ") || "no rationale given"}
                      </span>
                    </div>
                  ))}
                  {view.droppedRows > 0 ? (
                    <p style={{ margin: "9px 0 0", fontSize: 11.5, color: S.noise }}>
                      {view.droppedRows} row{view.droppedRows === 1 ? "" : "s"} could
                      not be read and {view.droppedRows === 1 ? "is" : "are"} missing
                      from this list.
                    </p>
                  ) : null}
                </div>
              )
            )}
          />
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The rail
// ─────────────────────────────────────────────────────────────────────────────

function Rail(
  { gameweek, heuristics }: {
    gameweek: number; heuristics: Artifact<HeuristicView>;
  },
) {
  const { artifact: projections } = useArtifact(projectionsDescriptor(gameweek));
  const view = proven(heuristics);
  const squad = view?.squad ?? null;
  const file = proven(projections);

  // Both `?? []` fallbacks live inside the memo: a fresh empty array on the
  // outside would be a new dependency identity every render, which rebuilds the
  // join and re-sorts the fifteen on each keystroke elsewhere on the page.
  const join = useMemo(
    () => joinProjections(squad?.players ?? [], file?.players ?? []),
    [squad, file],
  );
  const rows = useMemo(() => inReadingOrder(join.rows), [join]);
  const lineup = hasLineup(rows);
  const starters = lineup ? rows.filter((r) => r.player.bench === false) : rows;
  const bench = lineup ? rows.filter((r) => r.player.bench === true) : [];

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 15, background: RAIL_BG }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <Eyebrow surface={S}>
          {lineup ? `Your XI · GW${gameweek}` : `Your fifteen · GW${gameweek}`}
        </Eyebrow>
        <Age of={projections} surface={S} />
      </div>

      {squad === null ? (
        <MarginState
          of={heuristics}
          surface={S}
          compact
          what="No squad could be read from FPL, so the fifteen are not shown."
        />
      ) : (
        <>
          <div>
            {starters.map((row) => (
              <RailRow key={`${row.player.name}-${row.player.team}`} row={row} />
            ))}
          </div>

          {bench.length > 0 ? (
            <div>
              <Eyebrow surface={S} style={{ marginBottom: 7 }}>Bench</Eyebrow>
              {bench.map((row) => (
                <RailRow key={`${row.player.name}-${row.player.team}`} row={row} dim />
              ))}
            </div>
          ) : null}

          {!lineup ? (
            <p style={{ margin: 0, fontFamily: MONO, fontSize: 10, lineHeight: 1.6, color: S.ink3 }}>
              No eleven has been solved for this gameweek, so these fifteen are not
              split into a starting XI and a bench. They are ordered by the
              model&apos;s own mean within each line.
            </p>
          ) : null}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", border: `1px solid ${S.hair}` }}>
            <div style={{ padding: "11px 13px", borderRight: `1px solid ${S.hair}` }}>
              <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em" }}>Bank</Eyebrow>
              <div style={{ fontFamily: MONO, fontSize: 18, color: S.ink, marginTop: 3 }}>
                {squad.bank === null ? <Nil surface={S} size={16} /> : `£${squad.bank.toFixed(1)}`}
              </div>
            </div>
            {/* Free transfers and hits, as the design has them — not squad value
                standing in for one of them. Both are unpublished, and `∅` in the
                slot the reader expects is a better answer than a different
                number in its place: a substituted metric reads as the one that
                was asked for. */}
            <div style={{ padding: "11px 13px", borderRight: `1px solid ${S.hair}` }}>
              <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em" }}>Free transfers</Eyebrow>
              <div style={{ marginTop: 3 }}><Nil surface={S} size={18} /></div>
            </div>
            <div style={{ padding: "11px 13px" }}>
              <Eyebrow surface={S} style={{ fontSize: 9, letterSpacing: ".1em" }}>Hits</Eyebrow>
              <div style={{ marginTop: 3 }}><Nil surface={S} size={18} /></div>
            </div>
          </div>

          <p style={{ margin: 0, fontFamily: MONO, fontSize: 10, lineHeight: 1.6, color: S.ink3 }}>
            Bank is read from FPL — measured, not projected. Free transfers and
            hits are not in the payload this app receives, so they are shown as
            unknown rather than as a plausible number. Squad value is
            £{squad.value === null ? "—" : squad.value.toFixed(1)}.
            {squad.bank === null
              ? " The bank is null until a deadline has passed, which is FPL saying "
                + "“no deadline yet” rather than “no money”."
              : ""}
            {" "}
            {join.unmatched > 0
              ? `${join.unmatched} of the fifteen are not in the published projection.`
              : ""}
            {" Propose-only: nothing is submitted on your behalf."}
          </p>
        </>
      )}
    </div>
  );
}

function RailRow({ row, dim = false }: { row: SquadRow; dim?: boolean }) {
  const { player, projection } = row;
  const xp = projection?.xp ?? null;

  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: "28px minmax(0,1fr) 88px 42px",
        alignItems: "center", gap: 8, padding: "7px 0",
        borderBottom: `1px solid ${S.hair}`,
        opacity: dim ? 0.62 : 1,
      }}
    >
      <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink3 }}>{player.position}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, color: S.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {player.name}
          </span>
          {player.role === "captain" ? (
            <span
              title="captain, from your own picks"
              style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, color: S.shell, background: S.agree, padding: "1px 4px" }}
            >
              C
            </span>
          ) : null}
          {player.role === "vice" ? (
            <span
              title="vice-captain, from your own picks"
              style={{ fontFamily: MONO, fontSize: 9, color: S.ink2, border: `1px solid ${S.hair}`, padding: "0 3px" }}
            >
              V
            </span>
          ) : null}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: S.ink3, marginTop: 2 }}>
          {player.fixture ?? "fixture unknown"}
        </div>
      </div>
      <div>
        {projection ? (
          <Distribution
            of={{
              q10: projection.q10, q25: projection.q25, q50: projection.q50,
              q75: projection.q75, q90: projection.q90,
              mean: projection.xp, mode: projection.mode,
            }}
            surface={S}
          />
        ) : null}
      </div>
      <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 14, color: S.ink }}>
        {xp === null ? <Nil surface={S} size={12} /> : xp.toFixed(1)}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function DecideView(
  { gameweek, status }: { gameweek: number; status: Artifact<AgentStatus> },
) {
  const { artifact: decision } = useArtifact(decisionDescriptor(gameweek, "season"));
  const { artifact: sensitivity } = useArtifact(sensitivityDescriptor(gameweek, "season"));
  const { artifact: conflicts } = useArtifact(minutesConflictsDescriptor(gameweek));
  const { artifact: heuristics } = useHeuristics();
  const mode = modeOf(proven(status));
  // The fifteen, so the disagreement panel can say how many of this run's
  // conflicts land on a player you actually own.
  const squadIds = (proven(heuristics)?.squad?.players ?? [])
    .map((p) => p.elementId)
    .filter((id): id is number => typeof id === "number");

  return (
    <div
      style={{
        flex: 1, display: "grid", alignItems: "start",
        gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 400px)",
        background: S.shell,
      }}
      data-testid="margin-decide"
    >
      <div
        style={{
          padding: "24px 24px 32px", display: "flex", flexDirection: "column",
          gap: 20, borderRight: `1px solid ${S.hair}`, minWidth: 0,
        }}
      >
        {/* One or the other, never both. `NoCall` renders `decision.reason`
            itself, so it IS the state card — at the size the answer would have
            been, which is the only place on this screen where absence is
            allowed to take the space substance would. */}
        {proven(decision) === null ? (
          <NoCall
            gameweek={gameweek}
            mode={mode}
            status={proven(status)}
            decision={decision}
            conflicts={conflicts}
          />
        ) : (
          <WhenProvenHere
            of={decision}
            surface={S}
            what={`No proposal has been published for GW${gameweek}.`}
            then={(value) => <TheCall decision={value} gameweek={gameweek} />}
          />
        )}

        <Disagreement
          artifact={conflicts}
          decision={decision}
          squadIds={squadIds}
        />
        <Rejected artifact={sensitivity} gameweek={gameweek} />
        <Heuristic artifact={heuristics} />
      </div>

      <Rail gameweek={gameweek} heuristics={heuristics} />
    </div>
  );
}
