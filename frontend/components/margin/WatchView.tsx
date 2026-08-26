"use client";

/**
 * Watch — what is rotting, what changed, and whether we were right.
 *
 * ## The idle surface, and why it is content rather than a holding page
 *
 * The engine is gated on the deadline, so for roughly ten days of every cycle
 * there is no call to read. That is a large fraction of the product's life, and
 * every competitor fills it with the same stale plan re-rendered daily. Three
 * things are genuinely true in that window and none of them needs a solve:
 *
 * 1. **Decay** — every artifact has an age, and an age is only decision-relevant
 *    next to the number it qualifies. A market anchor pulled before two team-news
 *    windows is not merely old; everything downstream inherits it.
 * 2. **Change** — `fpl/deltas.jsonl` records each resolution the news poller made
 *    and, separately, whether the agent found it moved a decision. The two halves
 *    arrive at different cadences because the poller has no scipy and the MILP
 *    needs it, so an unassessed change says "impact not yet assessed" rather than
 *    waiting until it is complete.
 * 3. **Calibration** — `fpl/accuracy.json` carries the perfect-model ceiling
 *    whether or not a single gameweek has sealed, and the ceiling is the number
 *    that stops a future RMSE of 2.9 reading as a failure.
 *
 * ## The panel that refuses to grade one week
 *
 * Calibration reports the ceiling and the sealed-gameweek count and declines to
 * turn either into a verdict on a single week. One gameweek inside the
 * interquartile band is not evidence of a good model, and printing it as one is
 * how a product teaches its reader to over-trust it.
 */

import { proven, isStale, type Artifact } from "@/lib/data/artifact";
import { ageLine } from "@/lib/formats";
import { AGENT_STATUS, type AgentStatus } from "@/lib/data/agent-status";
import { ACCURACY, beatsTheCeiling, type Accuracy } from "@/lib/data/accuracy";
import {
  minutesConflictsDescriptor, type MinutesConflicts,
} from "@/lib/data/minutes-conflicts";
import { REGISTRY, type DeltaFeed, type DeltaRecord } from "@/lib/data/narrow";
import { projectionsDescriptor, type Projections } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";
import { FLOODLIT, MONO, SANS } from "@/lib/margin/tokens";
import {
  Eyebrow, Nil, WhenProvenHere, compactAge,
} from "@/components/margin/Marks";

const S = FLOODLIT;

function Panel(
  { eyebrow, title, children }: {
    eyebrow: string; title: string; children: React.ReactNode;
  },
) {
  return (
    <div style={{ background: S.bar, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 13, minWidth: 0 }}>
      <div>
        <Eyebrow surface={S} style={{ fontSize: 10, letterSpacing: ".12em" }}>{eyebrow}</Eyebrow>
        <h2 style={{ margin: "5px 0 0", fontFamily: SANS, fontSize: 17, fontWeight: 600, letterSpacing: "-.02em", color: S.ink }}>
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Decay
// ─────────────────────────────────────────────────────────────────────────────

interface Aged {
  readonly label: string;
  readonly note: string;
  readonly artifact: Artifact<unknown>;
}

/**
 * One row per input, oldest first — and an unknown age sorts to the top.
 *
 * Deliberate. An artifact whose producer emits no timestamp cannot be reported
 * as stale by any freshness check, which is a worse position to be in than being
 * three days old and knowing it. `health.json` is the reference case: a
 * successful, complete run of a 4.0.0 producer is indistinguishable from a
 * current run that measured nothing.
 */
function byAge(rows: readonly Aged[]): readonly Aged[] {
  return [...rows].sort((a, b) => {
    const aAge = a.artifact.provenance.ageMs;
    const bAge = b.artifact.provenance.ageMs;
    if (aAge === null) return bAge === null ? 0 : -1;
    if (bAge === null) return 1;
    return bAge - aAge;
  });
}

function DecayRow({ row }: { row: Aged }) {
  const { ageMs } = row.artifact.provenance;
  const stale = isStale(row.artifact);
  const carries = row.artifact.state === "ok" || row.artifact.state === "stale"
    || row.artifact.state === "empty";

  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: "minmax(0,1fr) 46px", gap: 10,
        alignItems: "baseline", padding: "10px 0",
        borderTop: `1px solid rgba(27,26,22,.09)`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: S.ink }}>{row.label}</div>
        <div style={{ fontSize: 11.5, color: S.ink3, marginTop: 2, lineHeight: 1.45 }}>
          {carries ? row.note : row.artifact.reason}
        </div>
      </div>
      {ageMs === null ? (
        <span style={{ textAlign: "center" }} title="the producer emits no timestamp, so no freshness check can see this">
          <Nil surface={S} size={12} />
        </span>
      ) : (
        <span
          title={ageLine(row.artifact.provenance.producedAt) ?? "produced at an unknown time"}
          style={{
            fontFamily: MONO, fontSize: 11, textAlign: "center",
            color: stale ? S.noise : S.ink3,
            border: `1px solid ${stale ? S.noise : "rgba(27,26,22,.22)"}`,
            padding: "1px 4px",
          }}
        >
          {compactAge(ageMs)}
        </span>
      )}
    </div>
  );
}

function Decay(
  { rows, conflicts }: {
    rows: readonly Aged[]; conflicts: Artifact<MinutesConflicts>;
  },
) {
  const open = proven(conflicts)?.conflicts.length ?? null;
  return (
    <Panel eyebrow="Decay watch" title="What is ageing under the current answer">
      <div>{byAge(rows).map((row) => <DecayRow key={row.label} row={row} />)}</div>
      <div style={{ borderTop: `1px solid rgba(27,26,22,.09)`, paddingTop: 10 }}>
        <div style={{ fontSize: 13, color: S.ink }}>
          Unresolved minutes disagreements
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
          <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 500, color: S.ink }}>
            {open ?? <Nil surface={S} size={18} />}
          </span>
          <span style={{ fontSize: 11.5, color: S.ink3, lineHeight: 1.45 }}>
            each one a place where a tier-1 post and the fitted minutes say
            different things, and neither has been made to win.
          </span>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
        Ordered by age, with an unknown age first: an artifact whose producer
        emits no timestamp cannot be reported as stale by any check, which is
        worse than being old and saying so.
      </p>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Change
// ─────────────────────────────────────────────────────────────────────────────

function Change({ record }: { record: DeltaRecord }) {
  const impact = record.kind === "decision_impact";
  return (
    <div style={{ padding: "10px 0", borderTop: `1px solid rgba(27,26,22,.09)` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
          {record.observed_at ? record.observed_at.slice(0, 10) : "undated"}
        </span>
        <span style={{ fontSize: 13, color: S.ink }}>
          {impact
            // A captain-only flip leaves the root move identical, so naming the
            // armband is the only way this line says what changed.
            ? record.root_move_before === record.root_move_after
              && (record.captainBefore !== null || record.captainAfter !== null)
              ? `${record.entry_label ?? "entry"} · captain ${record.captainBefore ?? "none"} → ${record.captainAfter ?? "none"}`
              : `${record.entry_label ?? "entry"} · ${record.root_move_before ?? "?"} → ${record.root_move_after ?? "?"}`
            : record.player_name ?? `element ${record.element_id ?? "?"}`}
        </span>
        {impact && record.flipped ? (
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: S.conflict }}>
            flipped the call
          </span>
        ) : null}
      </div>
      {record.why_material ? (
        <p style={{ margin: "3px 0 0", fontSize: 11.5, lineHeight: 1.45, color: S.ink2 }}>
          {record.why_material}
        </p>
      ) : null}
      {record.trigger ? (
        <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
          {record.trigger.source} · tier {record.trigger.source_tier}
          {record.trigger.url ? (
            <>
              {" · "}
              <a
                href={record.trigger.url}
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: S.agree, textDecoration: "none", borderBottom: `1px solid ${S.hair}` }}
              >
                check it
              </a>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Ledger({ artifact }: { artifact: Artifact<DeltaFeed> }) {
  return (
    <Panel eyebrow="Ledger · append-only" title="What has changed since the last solve">
      <WhenProvenHere
        of={artifact}
        surface={S}
        compact
        showEmpty
        what="Nothing has changed since you last looked."
        then={(feed) => (
          feed.records.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: S.ink2 }}>
              Nothing has changed. The poller runs every fifteen minutes inside a
              press-conference or deadline window and writes only when something
              moves, so a quiet ledger is the poller working rather than the
              poller stopped — the age beside it in Decay is what tells the two
              apart.
            </p>
          ) : (
            <>
              <div>
                {feed.records.slice(0, 10).map((record) => (
                  <Change key={record.delta_id} record={record} />
                ))}
              </div>
              {feed.awaitingImpact.length > 0 ? (
                <p style={{ margin: "9px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
                  {feed.awaitingImpact.length} change
                  {feed.awaitingImpact.length === 1 ? " has" : "s have"} been
                  recorded with the decision half not yet assessed. The poller
                  emits the change within fifteen minutes; the agent fills in
                  whether it moved anything at its own cadence.
                </p>
              ) : null}
            </>
          )
        )}
      />
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calibration
// ─────────────────────────────────────────────────────────────────────────────

function Calibration({ artifact }: { artifact: Artifact<Accuracy> }) {
  return (
    <Panel eyebrow="Calibration" title="Whether the engine has been right">
      <WhenProvenHere
        of={artifact}
        surface={S}
        showEmpty
        compact
        what="No accuracy report has been published."
        then={(report) => (
          <>
            <div style={{ borderLeft: `3px solid ${S.agree}`, paddingLeft: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 500, color: S.ink }}>
                  {report.perfectModelRmse === null
                    ? <Nil surface={S} size={18} />
                    : report.perfectModelRmse.toFixed(3)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
                  RMSE &middot; perfect-model ceiling
                </span>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.5, color: S.ink2 }}>
                {report.perfectModelBasis
                  ?? "A forecaster that knew each player's true distribution would "
                    + "predict its mean and still incur its variance. This is that floor."}
              </p>
            </div>

            <div style={{ borderLeft: `3px solid ${report.measured?.overall ? S.agree : S.noise}`, paddingLeft: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 500, color: S.ink }}>
                  {report.measured?.overall
                    ? report.measured.overall.rmse.toFixed(3)
                    : <Nil surface={S} size={18} />}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
                  RMSE &middot; measured over {report.gameweeksSealed} sealed gameweek
                  {report.gameweeksSealed === 1 ? "" : "s"}
                </span>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.5, color: S.ink2 }}>
                {report.measured?.overall
                  ? `${report.observations.toLocaleString()} observations. `
                    + (report.excessOverCeiling === null
                      ? "The excess over the ceiling was not computed."
                      : `${report.excessOverCeiling.toFixed(3)} of that error is ours; the rest is irreducible.`)
                  : report.reason
                    ?? "Nothing has sealed, so there is no measured error distribution."}
              </p>
            </div>

            {beatsTheCeiling(report) ? (
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: S.conflict }}>
                The measured error is <strong>below</strong> the theoretical floor.
                That is not an achievement — a model cannot beat the ceiling, and
                the most likely cause is a look-ahead leak in how outcomes were
                joined to forecasts.
              </p>
            ) : null}

            <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
              Shown permanently and at the same size as everything else. One
              gameweek landing inside the interquartile band is not evidence, and
              this panel refuses to grade it.
            </p>
          </>
        )}
      />
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function WatchView({ gameweek }: { gameweek: number }) {
  const { artifact: status } = useArtifact<AgentStatus>(AGENT_STATUS);
  const { artifact: projections } = useArtifact<Projections>(projectionsDescriptor(gameweek));
  const { artifact: conflicts } =
    useArtifact<MinutesConflicts>(minutesConflictsDescriptor(gameweek));
  const { artifact: deltas } = useArtifact<DeltaFeed>(REGISTRY.deltas);
  const { artifact: fixtureXg } = useArtifact(REGISTRY.fixtureXg);
  const { artifact: accuracy } = useArtifact<Accuracy>(ACCURACY);

  const aged: Aged[] = [
    {
      label: "Per-player projections",
      note: "Every clean-sheet, goal and minutes number on the research table "
        + "inherits this age.",
      artifact: projections as Artifact<unknown>,
    },
    {
      label: "Market anchor and fixture rates",
      note: "The goal rates the optimiser ranks on, anchored to the market.",
      artifact: fixtureXg as Artifact<unknown>,
    },
    {
      label: "Minutes disagreements",
      note: "Rewritten on the fifteen-minute news tick.",
      artifact: conflicts as Artifact<unknown>,
    },
    {
      label: "Change ledger",
      note: "Written only when something moves, so age is the only signal that "
        + "the poller is alive.",
      artifact: deltas as Artifact<unknown>,
    },
    {
      label: "Phase resolver",
      note: "Republished every three hours whether or not the agent runs.",
      artifact: status as Artifact<unknown>,
    },
  ];

  return (
    // Two elements rather than one. The hairline between panels is a 1px grid
    // gap showing the container through, and `S.hair` is translucent — so a grid
    // that also owned the page ground let the app's dark body show below three
    // short panels, on the one view whose whole job is to look calm. The outer
    // div is the paper; the inner grid is only as tall as its rows.
    <div
      style={{ flex: 1, background: S.shell, color: S.ink }}
      data-testid="margin-watch"
    >
      <div
        style={{
          display: "grid", gap: 1, background: S.hair,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        }}
      >
        <Decay rows={aged} conflicts={conflicts} />
        <Ledger artifact={deltas} />
        <Calibration artifact={accuracy} />
      </div>
    </div>
  );
}
