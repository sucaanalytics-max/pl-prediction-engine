"use client";

/**
 * The Summary tab: how the season is going, in four figures and three shapes.
 *
 * Nothing here is scannable detail — that is the Detailed data tab's job. The
 * split exists because the two answer different questions, and a page that
 * answers both at once answers neither first.
 *
 * Bench waste leads. Measured 2026-09-09: the bench had cost 27 points across
 * three gameweeks against the single transfer's 3, so ordering these by
 * novelty rather than magnitude buries the finding.
 */
import { ProvenanceStrip, StateCard } from "@/components/data/Artifact";
import {
  BenchChart, MarginChart, RankChart, millions, type SeasonPoint,
} from "@/components/review/SeasonCharts";
import { proven } from "@/lib/data/artifact";
import { seasonTotals } from "@/lib/data/manager-history";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { SIGNAL as S } from "@/lib/margin/tokens";

const NOT_YET = "—";

const LABEL = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".15em",
  color: S.ink3,
} as const;

function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0";
}

function Figure(
  { label, value, note, children, testId }: {
    label: string; value: string; note?: string;
    children?: React.ReactNode; testId?: string;
  },
) {
  return (
    <div data-testid={testId}>
      <div style={LABEL}>{label}</div>
      <div
        style={{
          fontSize: 30, fontWeight: 600, lineHeight: 1.05, marginTop: 6,
          color: S.ink, fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {note ? (
        <div style={{ fontSize: 11, color: S.ink3, marginTop: 5 }}>{note}</div>
      ) : null}
      {children}
    </div>
  );
}

function Band({ children, aside }: { children: string; aside?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 32 }}>
      <div style={LABEL}>{children}</div>
      <div style={{ flex: 1, height: 1, background: S.hair }} />
      {aside ? (
        <div style={{ fontSize: 11, color: S.ink3, whiteSpace: "nowrap" }}>{aside}</div>
      ) : null}
    </div>
  );
}

export default function ReviewSummary() {
  const { artifact } = useArtifact(REGISTRY.managerHistory);
  const ledger = proven(artifact);

  if (!ledger) {
    return (
      <StateCard
        of={artifact}
        weight="line"
        what="your manager history — each gameweek, and what each transfer returned"
      />
    );
  }

  const totals = seasonTotals(ledger);
  const weeks = [...ledger.gameweeks].sort((a, b) => a.event - b.event);
  const points = weeks.reduce((sum, w) => sum + w.points, 0);
  const perWeek = weeks.length > 0
    ? Math.round(totals.benchPoints / weeks.length)
    : 0;
  const latest = weeks[weeks.length - 1];
  const first = weeks[0];

  const rankRows: SeasonPoint[] = weeks.map((w) => ({
    event: w.event, value: w.overallRank,
  }));
  const marginRows: SeasonPoint[] = weeks.map((w) => ({
    event: w.event,
    value: w.averageEntryScore === null ? null : w.points - w.averageEntryScore,
  }));
  const benchRows: SeasonPoint[] = weeks.map((w) => ({
    event: w.event, value: w.benchPoints,
  }));

  const above = marginRows.filter((r) => (r.value ?? 0) > 0).length;
  const below = marginRows.filter((r) => (r.value ?? 0) < 0).length;

  return (
    <section className="space-y-3">
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <ProvenanceStrip of={artifact} />
      </div>

      <div
        style={{
          display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          borderTop: `1px solid ${S.hair}`, borderBottom: `1px solid ${S.hair}`,
        }}
      >
        <div style={{ padding: "16px 22px 16px 0" }}>
          <Figure
            testId="summary-points"
            label="Points"
            value={String(points)}
            note={totals.vsAverage === null
              ? "the field's average is not published"
              : `${signed(totals.vsAverage)} on the field`}
          />
        </div>
        <div style={{ padding: "16px 22px", borderLeft: `1px solid ${S.hair}` }}>
          <Figure
            testId="summary-rank"
            label="Overall rank"
            value={latest?.overallRank == null ? NOT_YET : millions(latest.overallRank)}
            note={first?.overallRank == null
              ? undefined
              : `from ${millions(first.overallRank)} after GW${first.event}`}
          />
        </div>
        <div style={{ padding: "16px 22px", borderLeft: `1px solid ${S.hair}` }}>
          <Figure
            testId="summary-bench"
            label="Left on the bench"
            value={String(totals.benchPoints)}
            note={`${perWeek} a week — your largest cost`}
          />
        </div>
        <div style={{ padding: "16px 0 16px 22px", borderLeft: `1px solid ${S.hair}` }}>
          <Figure
            testId="summary-armband"
            label="Armband"
            value={String(totals.captainPoints)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
              <div style={{ flex: 1, height: 4, background: S.hair }}>
                <div
                  style={{
                    width: totals.bestCaptainPoints > 0
                      ? `${Math.round((totals.captainPoints / totals.bestCaptainPoints) * 100)}%`
                      : "0%",
                    height: 4,
                    background: "#3b5480",
                  }}
                />
              </div>
              <div style={{ fontSize: 11, color: S.ink3, whiteSpace: "nowrap" }}>
                of {totals.bestCaptainPoints}
              </div>
            </div>
          </Figure>
        </div>
      </div>

      <Band aside={`up is better · ${weeks.length} of 38 gameweeks`}>Overall rank</Band>
      <div data-testid="chart-rank">
        <RankChart rows={rankRows} />
      </div>

      <div
        style={{
          display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 36, marginTop: 26,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={LABEL}>Against the field</div>
          <div data-testid="chart-margin">
            <MarginChart rows={marginRows} />
          </div>
          <div style={{ fontSize: 11, color: S.ink3 }}>
            {above} {above === 1 ? "week" : "weeks"} above the average,
            {" "}{below} below
            {totals.vsAverage === null ? "" : ` — ${signed(totals.vsAverage)} on the run`}.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={LABEL}>Left on the bench</div>
          <div data-testid="chart-bench">
            <BenchChart rows={benchRows} />
          </div>
          <div style={{ fontSize: 11, color: S.ink3 }}>
            {totals.benchPoints} across {weeks.length}
            {weeks.length === 1 ? " week" : " weeks"} — auto-subs recovered
            {" "}{totals.autoSubRescue}.
          </div>
        </div>
      </div>

      <p
        data-testid="summary-caveat"
        style={{
          fontSize: 11.5, lineHeight: 1.6, color: S.ink3,
          marginTop: 26, maxWidth: "78ch",
        }}
      >
        Transfers are not charted here: {ledger.transfers.length}
        {ledger.transfers.length === 1 ? " made" : " made"}, and the windows are
        reported on the Detailed data tab. Every figure on this tab is the settled
        record — nothing here is a projection.
      </p>
    </section>
  );
}
