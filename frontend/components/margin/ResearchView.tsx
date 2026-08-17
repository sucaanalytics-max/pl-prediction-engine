"use client";

/**
 * Research — every player the simulation has a view on, as a distribution.
 *
 * ## The one view here that is fully backed today
 *
 * `fpl/xp_public_gw{NN}.json` ships a projection for every player in the game
 * with `xp`, `xp_sd`, `mode`, `p_appears`, `p_60`, `e_minutes`, `p_goal`,
 * `p_clean_sheet`, `p_ge_5`, `p_ge_10`, `q10`, `q50`, `q90` and a five-way
 * decomposition. Nothing on this screen is derived, defaulted or filled in.
 *
 * ## Why the mode column sits next to the mean
 *
 * The published benchmark puts the top six public models within 0.08 RMSE of
 * each other and all near the theoretical ceiling, so the mean is not where the
 * information is. What is decision-relevant is that a player at `xp 6.4` most
 * often returns **2** — the mean is carried by a haul that lands one week in
 * six. Seven of eight competitors publish only the mean, which is why the
 * distribution glyph is a column rather than a detail view.
 *
 * ## Truncation is announced
 *
 * The table renders a bounded number of rows by default because 581 rows of
 * fourteen cells is 8,000 nodes on a screen that also re-sorts on click. The
 * count that was dropped is printed next to the control that restores it —
 * "showing 100 of 581" rather than a list that quietly ends.
 */

import { useCallback, useMemo, useState } from "react";
import { proven, describeProducer } from "@/lib/data/artifact";
import {
  projectionsDescriptor, skew, type Projection, type Projections,
} from "@/lib/data/projections";
import { REGISTRY, type PlayerRow } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { istDateTime } from "@/lib/formats";
import { findTwins } from "@/lib/margin/twins";
import { Compare } from "@/components/margin/Compare";
import { Scatter } from "@/components/margin/Scatter";
import { PAPER, MONO, SANS } from "@/lib/margin/tokens";
import {
  Distribution, Eyebrow, Hollow, MarginState, Nil, WhenProvenHere,
} from "@/components/margin/Marks";

const S = PAPER;

/** Rows shown before the reader asks for the rest. */
const PAGE = 100;

/** Four columns is where the labels stop fitting; beyond that it is a table. */
const MAX_COMPARE = 4;

type SortKey = "xp" | "sd" | "mode" | "p5" | "p10" | "pcs" | "mins" | "skew";

const SORTS: ReadonlyArray<{ key: SortKey; label: string; of: (p: Projection) => number | null }> = [
  { key: "xp", label: "xP", of: (p) => p.xp },
  { key: "skew", label: "mean − mode", of: (p) => skew(p) },
  { key: "sd", label: "sd", of: (p) => p.xpSd },
  { key: "mode", label: "mode", of: (p) => p.mode },
  { key: "p5", label: "P≥5", of: (p) => p.pGe5 },
  { key: "p10", label: "P≥10", of: (p) => p.pGe10 },
  { key: "pcs", label: "P(CS)", of: (p) => p.pCleanSheet },
  { key: "mins", label: "xMins", of: (p) => p.eMinutes },
];

/** `68%`, or `∅` when the producer did not compute it. */
function Pct({ of }: { of: number | null }) {
  if (of === null) return <Nil surface={S} size={11} />;
  return <>{Math.round(of * 100)}%</>;
}

function Num({ of, dp = 1 }: { of: number | null; dp?: number }) {
  if (of === null) return <Nil surface={S} size={11} />;
  return <>{of.toFixed(dp)}</>;
}

const COLUMNS = "24px 26px minmax(92px,1.3fr) 44px 100px 38px 38px 44px 44px 44px 46px 44px 42px 40px 40px 60px";

function Header({ sort, onSort }: { sort: SortKey; onSort: (key: SortKey) => void }) {
  // A spacer for the pin column. Without it the header labels sit one column
  // left of the numbers they name, which is the kind of bug that reads as a
  // wrong value rather than as a broken layout.
  const cell = (key: SortKey | null, label: string, align: "left" | "right" = "right") => (
    <span
      key={label}
      onClick={key ? () => onSort(key) : undefined}
      style={{
        textAlign: align,
        cursor: key ? "pointer" : "default",
        color: key && key === sort ? S.ink : S.ink3,
        textDecoration: key && key === sort ? "underline" : "none",
        textUnderlineOffset: 3,
      }}
    >
      {label}
    </span>
  );

  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: COLUMNS, gap: 6,
        padding: "7px 18px", borderBottom: `1px solid rgba(27,26,22,.25)`,
        fontFamily: MONO, fontSize: 9, letterSpacing: ".06em",
        textTransform: "uppercase", color: S.ink3,
        position: "sticky", top: 52, background: S.shell, zIndex: 2,
      }}
    >
      {cell(null, "", "left")}
      {cell(null, "", "left")}
      {cell(null, "Player", "left")}
      {cell("xp", "xP")}
      {cell(null, "distribution", "left")}
      {cell("sd", "sd")}
      {cell("mode", "mode")}
      {cell("skew", "m−mo")}
      {cell(null, "P(app)")}
      {cell(null, "P(60)")}
      {cell("mins", "xMins")}
      {cell(null, "P(goal)")}
      {cell("pcs", "P(CS)")}
      {cell("p5", "P≥5")}
      {cell("p10", "P≥10")}
      {cell(null, "q10–q90")}
    </div>
  );
}

function Row(
  { player, selected, onSelect, pinned, onPin }: {
    player: Projection; selected: boolean; onSelect: () => void;
    pinned: boolean; onPin: () => void;
  },
) {
  const gap = skew(player);
  return (
    <div
      onClick={onSelect}
      data-testid="margin-player"
      style={{
        display: "grid", gridTemplateColumns: COLUMNS, gap: 6,
        alignItems: "center", padding: "8px 18px",
        borderBottom: `1px solid rgba(27,26,22,.06)`, cursor: "pointer",
        fontFamily: MONO, fontSize: 11.5, color: S.ink,
        background: selected ? S.bar : "transparent",
        boxShadow: selected ? `inset 3px 0 0 ${S.agree}` : undefined,
      }}
    >
      {/* `stopPropagation` because the row itself opens the detail panel: without
          it, pinning a player also swaps the panel under the reader's cursor. */}
      <button
        type="button"
        data-testid="research-pin"
        aria-label={pinned ? `remove ${player.name} from the comparison`
                           : `compare ${player.name}`}
        aria-pressed={pinned}
        onClick={(event) => { event.stopPropagation(); onPin(); }}
        style={{
          fontFamily: MONO, fontSize: 11, lineHeight: 1, cursor: "pointer",
          background: "transparent", padding: "2px 4px",
          border: `1px solid ${pinned ? S.agree : "transparent"}`,
          color: pinned ? S.agree : S.ink3,
        }}
      >
        {pinned ? "✓" : "+"}
      </button>
      <span style={{ fontSize: 9, color: S.ink3 }}>{player.position ?? "—"}</span>
      <span
        style={{
          fontFamily: SANS, fontSize: 12.5, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis", paddingRight: 8,
        }}
        title={player.team ?? undefined}
      >
        {player.name ?? `#${player.elementId}`}
      </span>
      <span style={{ textAlign: "right", fontWeight: 600 }}>
        {/* A blank gameweek is published with a projection of zero fixtures. The
            number is real and acting on it is not, so it is drawn hollow rather
            than hidden — the same mark the uncalibrated flags get. */}
        {player.blank
          ? <Hollow surface={S} size={12}>{player.xp?.toFixed(1) ?? "0.0"}</Hollow>
          : <Num of={player.xp} />}
      </span>
      <span>
        <Distribution
          of={{
            q10: player.q10, q25: player.q25, q50: player.q50,
            q75: player.q75, q90: player.q90,
            mean: player.xp, mode: player.mode,
          }}
          surface={S}
          width={100}
        />
      </span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Num of={player.xpSd} /></span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Num of={player.mode} dp={0} /></span>
      <span style={{ textAlign: "right", color: gap !== null && gap > 2 ? S.noise : S.ink2 }}>
        <Num of={gap} />
      </span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Pct of={player.pAppears} /></span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Pct of={player.p60} /></span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Num of={player.eMinutes} dp={0} /></span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Pct of={player.pGoal} /></span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Pct of={player.pCleanSheet} /></span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Pct of={player.pGe5} /></span>
      <span style={{ textAlign: "right", color: S.ink2 }}><Pct of={player.pGe10} /></span>
      <span style={{ textAlign: "right", color: S.ink3, fontSize: 10.5 }}>
        {player.q10 === null || player.q90 === null
          ? <Nil surface={S} size={10} />
          : `${player.q10}–${player.q90}`}
      </span>
    </div>
  );
}

/**
 * Two players the mean cannot separate, found in the file rather than written down.
 *
 * See `lib/margin/twins.ts` for why this is a search: a pair named in a constant
 * stops being true within a week, and an example a reader checks and finds false
 * discredits the argument the whole screen is making.
 */
function Twins({ players }: { players: readonly Projection[] }) {
  const pair = useMemo(() => findTwins(players), [players]);

  if (pair === null) {
    return (
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: S.ink2 }}>
        No two players in this gameweek have the same mean and materially
        different shapes, so the panel that usually makes that point is not
        showing an approximation of it.
      </p>
    );
  }

  const line = (p: Projection) => (
    <div style={{ display: "grid", gridTemplateColumns: "92px 40px minmax(0,1fr)", gap: 12, alignItems: "center", marginBottom: 8 }}>
      <span style={{ fontSize: 12.5, color: S.ink }}>{p.name}</span>
      <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, textAlign: "right", color: S.ink }}>
        {p.xp?.toFixed(1)}
      </span>
      <Distribution
        of={{
          q10: p.q10, q25: p.q25, q50: p.q50, q75: p.q75, q90: p.q90,
          mean: p.xp, mode: p.mode,
        }}
        surface={S}
        width={220}
        height={18}
      />
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 22 }}>
      <div>
        <Eyebrow surface={S} style={{ fontSize: 10, letterSpacing: ".1em", marginBottom: 8 }}>
          Same mean, different asset
        </Eyebrow>
        {line(pair.steady)}
        {line(pair.volatile)}
      </div>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: S.ink2 }}>
        sd {pair.steady.xpSd?.toFixed(1)} against {pair.volatile.xpSd?.toFixed(1)};
        P(&ge;10) {Math.round((pair.steady.pGe10 ?? 0) * 100)}% against{" "}
        {Math.round((pair.volatile.pGe10 ?? 0) * 100)}%. Their means differ by{" "}
        {pair.meanGap.toFixed(2)}. For a season entry you want the first; chasing a
        rank from behind, the second. Invisible in every product that ships one
        number per player.
      </p>
    </div>
  );
}

function Selected({ player, file }: { player: Projection; file: Projections }) {
  const parts = player.decomposition;
  const rows = parts
    ? [
        { label: "Appearance", pts: parts.appearance },
        { label: "Goals", pts: parts.goals },
        { label: "Assists", pts: parts.assists },
        { label: "Clean sheet", pts: parts.cleanSheets },
        { label: "Other", pts: parts.other },
      ]
    : [];
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.pts), 0);

  return (
    <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 15 }}>
      <div>
        <Eyebrow surface={S} style={{ fontSize: 10, letterSpacing: ".12em" }}>Selected</Eyebrow>
        <h2 style={{ margin: "5px 0 2px", fontFamily: SANS, fontSize: 20, fontWeight: 600, letterSpacing: "-.02em", color: S.ink }}>
          {player.name ?? `#${player.elementId}`}
        </h2>
        <div style={{ fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
          {player.position ?? "—"} &middot; {player.team ?? "club unknown"} &middot;{" "}
          {player.nFixtures} fixture{player.nFixtures === 1 ? "" : "s"}
          {player.blank ? " · blank" : ""}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${S.hair}`, borderBottom: `1px solid ${S.hair}`, padding: "13px 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
          <span style={{ fontFamily: MONO, fontSize: 32, fontWeight: 500, color: S.ink, letterSpacing: "-.03em", lineHeight: 1 }}>
            {player.xp === null ? <Nil surface={S} size={28} /> : player.xp.toFixed(1)}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: S.ink3 }}>
            &plusmn;{player.xpSd?.toFixed(1) ?? "—"} &middot; most likely{" "}
            {player.mode ?? "—"}
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <Distribution
            of={{
              q10: player.q10, q25: player.q25, q50: player.q50,
            q75: player.q75, q90: player.q90,
              mean: player.xp, mode: player.mode,
            }}
            surface={S}
            width={280}
            height={22}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
          <span>q10 {player.q10 ?? "—"}</span>
          <span>median {player.q50 ?? "—"}</span>
          <span>q90 {player.q90 ?? "—"}</span>
        </div>
        {skew(player) !== null ? (
          <p style={{ margin: "9px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink2 }}>
            The mean sits {skew(player)?.toFixed(1)} above the most likely return.
            That gap is the haul, and it is the reason a mean read as a forecast
            is read wrongly.
          </p>
        ) : null}
      </div>

      <div>
        <Eyebrow surface={S} style={{ fontSize: 10, letterSpacing: ".12em", marginBottom: 9 }}>
          Where the points come from
        </Eyebrow>
        {parts === null ? (
          <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
            No decomposition was published for this player. The producer omits all
            five parts rather than some — a breakdown whose parts do not sum to the
            mean is worse than none.
          </p>
        ) : (
          <>
            {rows.map((row) => (
              <div key={row.label} style={{ display: "grid", gridTemplateColumns: "78px minmax(0,1fr) 34px", gap: 10, alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: S.ink2 }}>{row.label}</span>
                <span style={{ display: "block", height: 9, background: "rgba(27,26,22,.09)" }}>
                  <span
                    style={{
                      display: "block", height: 9,
                      width: `${total > 0 ? (Math.max(0, row.pts) / total) * 100 : 0}%`,
                      background: "rgba(27,26,22,.55)",
                    }}
                  />
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink, textAlign: "right" }}>
                  {row.pts.toFixed(1)}
                </span>
              </div>
            ))}
            <p style={{ margin: "7px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
              Clean sheet is drawn jointly with the rest of the defence, so it is
              not additive with a teammate&apos;s.
            </p>
          </>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${S.hair}`, paddingTop: 13, display: "flex", flexDirection: "column", gap: 5, fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>draws</span>
          <span style={{ color: S.ink }}>{file.nDraws ?? "unstated"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>gameweek</span>
          <span style={{ color: S.ink }}>{file.gameweek ?? "—"} · {file.season ?? "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>produced</span>
          {/* Through `istDateTime` rather than raw: the ISO string carries six
              decimal places of a second, none of which anyone reads, and it is
              in UTC while every other time on this app is in Kolkata. */}
          <span style={{ color: S.ink }}>
            {file.generatedAt ? istDateTime(file.generatedAt) : "unstated"}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ResearchView({ gameweek }: { gameweek: number }) {
  const { artifact } = useArtifact(projectionsDescriptor(gameweek));
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("xp");
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /**
   * Who is pinned for comparison, in the order they were picked.
   *
   * An array rather than a Set: the comparison reads left to right and the
   * reader chose that order, so insertion order is information.
   */
  const [compareIds, setCompareIds] = useState<readonly number[]>([]);
  const { artifact: statsArtifact } = useArtifact(REGISTRY.playerStats);
  const stats = useMemo(
    () => (proven(statsArtifact) ?? []) as readonly PlayerRow[], [statsArtifact],
  );

  const togglePin = useCallback((elementId: number) => {
    setCompareIds((current) => {
      if (current.includes(elementId)) return current.filter((id) => id !== elementId);
      // Four columns is where the labels stop fitting on a laptop, and a
      // comparison of eight is a table, which this screen already has.
      if (current.length >= MAX_COMPARE) return current;
      return [...current, elementId];
    });
  }, []);

  const file = proven(artifact);
  // Memoised so the `?? []` fallback is not a fresh identity on every render,
  // which would re-sort 581 rows on each keystroke into the search box.
  const players = useMemo(() => file?.players ?? [], [file]);

  const ranked = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const of = SORTS.find((s) => s.key === sort)?.of ?? ((p: Projection) => p.xp);
    return players
      .filter((p) => {
        if (!needle) return true;
        return `${p.name ?? ""} ${p.team ?? ""} ${p.position ?? ""}`
          .toLowerCase()
          .includes(needle);
      })
      // Nulls sink. A missing value sorted as 0 would put every player the model
      // has no view on at the bottom of an ascending sort and the top of a
      // descending one, which reads as a measurement either way.
      .sort((a, b) => {
        const av = of(a);
        const bv = of(b);
        if (av === null) return bv === null ? 0 : 1;
        if (bv === null) return -1;
        return bv - av || a.elementId - b.elementId;
      });
  }, [players, query, sort]);

  const shown = showAll ? ranked : ranked.slice(0, PAGE);
  const selected =
    ranked.find((p) => p.elementId === selectedId) ?? ranked[0] ?? null;

  return (
    <div
      style={{
        flex: 1, display: "grid", alignItems: "start",
        gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 340px)",
        background: S.shell, color: S.ink,
      }}
      data-testid="margin-research"
    >
      <div style={{ borderRight: `1px solid ${S.hair}`, minWidth: 0 }}>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 9, padding: "12px 18px",
            borderBottom: `1px solid ${S.hair}`, background: S.bar, flexWrap: "wrap",
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`search ${players.length} players`}
            aria-label="Search players"
            style={{
              fontFamily: MONO, fontSize: 11, color: S.ink,
              border: `1px solid ${S.hair}`, padding: "5px 10px",
              minWidth: 190, background: "transparent",
            }}
          />
          <span style={{ fontFamily: MONO, fontSize: 11, padding: "5px 10px", background: S.ink, color: S.bar }}>
            GW{file?.gameweek ?? gameweek}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 11, padding: "5px 10px", border: `1px solid ${S.hair}`, color: S.ink2 }}>
            sort {SORTS.find((s) => s.key === sort)?.label} &darr;
          </span>
          <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
            {file?.nDraws ? `${file.nDraws.toLocaleString()} draws` : "draw count unstated"}
            {" · joint clean sheets · producer "}
            {/* Labelled. `describeProducer` returns a bare "1" for this artifact,
                which read as a stray count at the end of a line about draws. */}
            {describeProducer(artifact.provenance)}
          </span>
        </div>

        <WhenProvenHere
          of={artifact}
          surface={S}
          what={`No per-player projection has been published for GW${gameweek}.`}
          then={() => (
            <>
              {/* Above the table, because it is what you assembled from it and
                  scrolling back to a comparison you built is the whole cost of
                  putting it below. */}
              {/* The chart is a way of finding two players worth comparing, so
                  it sits above the panel it feeds. */}
              <div style={{ padding: "12px 18px 0" }}>
                <Scatter rows={stats} pinned={compareIds} onPin={togglePin} />
              </div>

              {compareIds.length > 0 ? (
                <div style={{ padding: "12px 18px 0" }}>
                  <Compare
                    ids={compareIds}
                    projections={players}
                    stats={stats}
                    statsArtifact={statsArtifact as never}
                    onRemove={togglePin}
                    onClear={() => setCompareIds([])}
                  />
                </div>
              ) : null}
              <Header sort={sort} onSort={setSort} />
              {shown.map((player) => (
                <Row
                  key={player.elementId}
                  player={player}
                  selected={selected?.elementId === player.elementId}
                  onSelect={() => setSelectedId(player.elementId)}
                  pinned={compareIds.includes(player.elementId)}
                  onPin={() => togglePin(player.elementId)}
                />
              ))}

              {/* Never a list that quietly ends. */}
              <div style={{ padding: "12px 18px", borderBottom: `1px solid ${S.hair}`, display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
                  showing {shown.length} of {ranked.length}
                  {query ? ` matching “${query}”` : ""}
                  {ranked.length !== players.length ? ` · ${players.length} in the file` : ""}
                </span>
                {ranked.length > shown.length ? (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    style={{
                      fontFamily: MONO, fontSize: 10, letterSpacing: ".08em",
                      textTransform: "uppercase", color: S.ink,
                      background: "transparent", border: 0, cursor: "pointer",
                      borderBottom: `1px solid ${S.hair}`, padding: 0,
                    }}
                  >
                    show the other {ranked.length - shown.length}
                  </button>
                ) : null}
              </div>

              <div style={{ padding: "15px 18px", background: S.bar, borderTop: `1px solid ${S.hair}` }}>
                <Twins players={players} />
                <p style={{ margin: "14px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
                  This artifact carries no price. Buying decisions need one, and
                  joining a price here from a different source with a different
                  refresh would put two ages in one row — see Players for the
                  official price list.
                </p>
              </div>
            </>
          )}
        />
      </div>

      {selected && file ? (
        <Selected player={selected} file={file} />
      ) : (
        <div style={{ padding: "18px 20px" }}>
          <MarginState
            of={artifact}
            surface={S}
            what="Nothing is selected, because no projection could be read."
          />
        </div>
      )}
    </div>
  );
}
