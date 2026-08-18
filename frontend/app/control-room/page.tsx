"use client";

/**
 * The control room — what needs me, across all three teams.
 *
 * ## Why this route exists beside the ones it resembles
 *
 * It ships alongside `/`, `/now` and `/margin`, unchanged, so the two surfaces can
 * be compared before anything is replaced. This repository has already stranded a
 * 612-line page by deleting the only two components that linked to it; rescue
 * precedes deletion, and a new screen earns its predecessor's retirement by being
 * looked at next to it.
 *
 * ## The design, and the one place this departs from it
 *
 * `handoff_suca_control_room/BUILD-THIS.md` is the specification: masthead with a
 * live countdown, the team strip as the global switcher, the answer in Newsreader
 * before any figure, the decision queue with its solid/dashed tense marks, the
 * eight-row facet × team matrix, the change feed and the ambient column. All of
 * that is built here.
 *
 * What is not built is its **content**. §4 shows Ronny at 54 and Wazza at 53,
 * `Thomas → Senesi`, `Thomas → Kroupi Jr`, `£96.9m · £3.1m`, last runs at
 * `06:14 today` — and §9 says, in its own words, that the two sample proposals and
 * every quantile in every design file are fabricated. They are: neither bot has
 * ever published a decision, `fpl/agent_status.json` reports `agent_ran: false`,
 * and no `decision_public_*` file has been written. Building §4 literally would
 * ship invented numbers as real ones, so §9's governing rule applies instead — *if
 * you cannot source a figure, render `∅` and say what was not fitted* — and the
 * matrix keeps all eight rows so the argument the rows make survives their empty
 * cells. See `components/control-room/Matrix.tsx`.
 *
 * ## Rule 1, and where the state lives
 *
 * No empty state, no skeleton, no spinner, no reserved empty axis. Every section
 * renders `proven(artifact) ?? proven(retained)` through {@link read}, which pairs
 * the value with the age of the artifact it actually came from, and an old figure
 * renders at full strength with its age beside it rather than dimmed. The single
 * exception is data never computed at all, and on this board that is one sentence
 * in the ambient column.
 *
 * The artifacts are loaded here rather than inside each section, which is a
 * deliberate reading of §8's "each section owns its own state; no page-level gate".
 * The property that matters is the *rendering*: there is no gate, no early return
 * and no shared `loading` — each section is handed its own `Read` and states its
 * own absence, so one absent artifact still costs exactly one section. Loading them
 * once is what stops three sections issuing three fetches for the same 590-player
 * projection.
 *
 * ## Read-only
 *
 * There is no approve, reject or defer control anywhere on this screen, by design.
 * The only thing that responds to a click is the team strip, which is navigation:
 * it writes `?team=` so a view of one team is a link somebody can send.
 */

import { useCallback, useEffect, useState } from "react";

import { AGENT_STATUS, type AgentStatus } from "@/lib/data/agent-status";
import { ACCURACY } from "@/lib/data/accuracy";
import { useArtifact } from "@/lib/data/useArtifact";
import { useCurrentGameweek } from "@/lib/data/gameweek";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { REGISTRY, decisionDescriptor } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { ErrorBoundary } from "@/components/ErrorBoundary";

import {
  countdownLong, modeOf, reasonWithoutCountdown, remainingMs, tickPeriodMs,
} from "@/lib/margin/mode";
import { ageLine, deadlineStamp } from "@/lib/formats";
import { ProvenanceLegend } from "@/components/margin/Provenance";
import {
  TEAMS, calibratedWeeks, teamFromParam, withQuartiles, xiSwap, xiTotal,
  type TeamKey,
} from "@/lib/control-room/model";
import { read, type Read } from "@/lib/control-room/read";
import { Matrix } from "@/components/control-room/Matrix";
import { Ambient } from "@/components/control-room/Ambient";
import { Squad } from "@/components/control-room/Squad";
import { ChangeFeed, Queue, calibrationClaim, type QueueRow } from "@/components/control-room/Queue";
import {
  Answer, Body, Figure, Label, S, Sub,
} from "@/components/control-room/parts";

/**
 * The gameweek this board reads.
 *
 * The `?? 1` below is not a default for the week — it is a placeholder for the
 * PATH. A hook cannot be called conditionally, so a descriptor is always needed,
 * and week 1's is the one that exists. Nothing downstream may treat the resulting
 * artifact as this week's until `gameweek` is non-null, because the number becomes
 * a fetch path (`fpl/xp_public_gw{NN}.json`) and a wrong last resort does not
 * mislabel a figure — it reads a different gameweek's file.
 *
 * Every consumer therefore gates on `gameweek === null` rather than on whether the
 * fetch succeeded. An earlier version of this docstring claimed the `?? 1` was
 * "deliberately absent" three lines above the `?? 1`, which is how the squad board
 * came to show week 1's projections for an unresolved week.
 */
function useProjections(gameweek: number | null) {
  // A descriptor is required, so an unresolved week reads week 1's path and the
  // section below refuses to trust it. Guarded by `gameweek === null` at every
  // consumer rather than by a silent default.
  return useArtifact(projectionsDescriptor(gameweek ?? 1));
}

export default function ControlRoomPage() {
  // ── cross-cutting: the phase, the gameweek, the focused team ──────────────
  const statusResult = useArtifact(AGENT_STATUS);
  const status = read(statusResult, (value) => value.generatedAt);
  const gameweek = useCurrentGameweek();
  const mode = modeOf(status.value);

  const [team, setTeam] = useState<TeamKey>("mine");

  // Read in an effect rather than during render: reading `location.search` while
  // rendering hydrates with a mismatch on every deep link, which is the bug the
  // same pattern on `/margin` was written to avoid.
  useEffect(() => {
    setTeam(teamFromParam(new URLSearchParams(window.location.search).get("team")));
  }, []);

  const focus = useCallback((next: TeamKey) => {
    setTeam(next);
    const url = new URL(window.location.href);
    url.searchParams.set("team", next);
    // `replaceState`, not a push: this is the same screen with a different team in
    // focus, and a history entry per tile makes Back undo something nobody did.
    window.history.replaceState(null, "", url);
  }, []);

  // ── per-section artifacts ────────────────────────────────────────────────
  const projectionsResult = useProjections(gameweek);
  const projections = read(projectionsResult, (value) => value.generatedAt);
  const liveResult = useHeuristics();
  const live = read(liveResult, (value) => value.generatedAt);
  const accuracyResult = useArtifact(ACCURACY);
  const accuracy = read(accuracyResult, (value) => value.generatedAt);
  const matches = read(useArtifact(REGISTRY.matches), (value) => value.generated_at);
  const fixtureXg = read(useArtifact(REGISTRY.fixtureXg), (value) => value.generated_at);
  const playerStats = read(useArtifact(REGISTRY.playerStats), () => null);
  const deltas = read(useArtifact(REGISTRY.deltas), () => null);

  // The two bots' own proposals, fetched so that "not published" is a measured
  // absence rather than an assumption this page makes about them.
  const ronny = read(
    useArtifact(decisionDescriptor(gameweek ?? 1, "season")),
    (value) => value.generated_at,
  );
  const wazza = read(
    useArtifact(decisionDescriptor(gameweek ?? 1, "weekly")),
    (value) => value.generated_at,
  );

  // Gated on a resolved gameweek, not just on a readable file. With the week
  // unknown the projection descriptor falls back to `gw01`'s path, and a total
  // summed from a week the board cannot name would be a figure labelled with a
  // gameweek nobody resolved — the exact reason `useCurrentGameweek` returns null
  // rather than 1.
  const squad = live.value?.squad ?? null;
  const xi = gameweek === null || squad === null || projections.value === null
    ? null
    : xiTotal(squad.players, projections.value.players);

  /**
   * The better legal eleven inside the fifteen already owned.
   *
   * Gated on a resolved gameweek for the same reason `xi` is: with the week unknown the
   * descriptor read week 1's file, and advising a lineup change off another week's
   * projection is worse than advising none.
   */
  const swap = gameweek === null || squad === null || projections.value === null
    ? null
    : xiSwap(squad.players, projections.value.players);

  /**
   * The squad's age, from the squad's own stamp rather than the view's.
   *
   * `live.age` is derived from `HeuristicView.generatedAt`, which the route stamps at
   * REQUEST time — so it read `0h old` beside a squad hand-captured on 18 August, on the
   * one line whose job is to say how stale the squad is. `SquadView.capturedAt` is what
   * the route actually sent for the squad; when FPL serves real picks it equals the fetch
   * time, so this is the honest age on both paths.
   */
  const squadAge = ageLine(squad?.capturedAt ?? null, new Date()) ?? live.age;

  /*
   * The producer's reason, minus the duration the countdown already owns.
   *
   * `schedule.py` stamps "GW1 deadline in 71.0h; nothing due yet" when the agent runs, and
   * the masthead recomputes the same deadline on every tick — so hours later the board
   * showed a frozen 71.0h beside a live 2d 23h. One clock.
   */
  const trimmedReason = reasonWithoutCountdown(status.value?.reason ?? null);

  const calibrated = calibratedWeeks(accuracy.value);
  const sealed = accuracy.value?.gameweeksSealed ?? null;

  const queue = buildQueue({ status, calibrated, sealed });

  return (
    <ErrorBoundary pageName="Control room">
      <div style={{ background: S.shell, border: `1px solid ${S.rule}` }}>
        <div className="mx-auto max-w-[1240px] px-10 pt-[34px] pb-10">

          <Masthead
            gameweek={gameweek}
            season={matches.value?.season ?? null}
            deadline={status.value?.deadline ?? null}
            mode={mode}
            reason={trimmedReason}
            statusAge={status.age}
            statusInitialising={status.initialising}
          />

          <TeamStrip focused={team} onFocus={focus} />

          <Lead
            projectionsAge={projections.age}
            squadAge={squadAge}
            squadSource={live.value?.squad?.source ?? null}
            agentRan={status.value?.agentRan ?? null}
            reason={trimmedReason}
            players={projections.value?.players.length ?? null}
            quartiled={
              projections.value === null ? null : withQuartiles(projections.value.players)
            }
            draws={projections.value?.nDraws ?? null}
            swapWaiting={swap !== null}
          />

          <Queue rows={queue} />

          <Matrix
            gameweek={gameweek}
            focus={team}
            status={status}
            projections={projections}
            live={live}
            xi={xi}
            swap={swap}
            xiSwapSource={squad?.source === "official_public"
              ? "official picks"
              : `captured draft${squadAge === null ? "" : ` · ${squadAge}`}`}
            calibrated={calibrated}
            calibrationSource={
              sealed === null ? null : `${accuracy.path} · ${sealed} gameweeks sealed`
            }
            ronny={ronny}
            wazza={wazza}
          />

          <Squad
            team={team}
            squad={squad?.players ?? null}
            projections={projections.value?.players ?? null}
            gameweek={gameweek}
            squadAge={squadAge}
            squadSource={squad?.source ?? null}
            notices={team === "mine" ? live.value?.notices ?? [] : []}
            botPath={team === "ronny" ? ronny.path : team === "wazza" ? wazza.path : null}
            initialising={team === "mine" ? live.initialising : (
              team === "ronny" ? ronny.initialising : wazza.initialising
            )}
          />

          <div
            className="grid gap-[34px] mt-[26px] pt-[9px] grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
            style={{ borderTop: `1px solid ${S.rule}` }}
          >
            <ChangeFeed feed={deltas} />
            <Ambient
              gameweek={gameweek}
              matches={matches}
              fixtureXg={fixtureXg}
              playerStats={playerStats}
              projections={projections}
              sealed={sealed}
            />
          </div>

          {/* The legend, once per screen. Rows carry marks only — a legend per row
              is the badge farm Rule 2 exists to prevent. */}
          <div className="mt-6 pt-[9px]" style={{ borderTop: `1px solid ${S.hair}` }}>
            <ProvenanceLegend surface={S} />
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Masthead
// ─────────────────────────────────────────────────────────────────────────────

const MODE_LABEL: Record<string, string> = {
  deadline: "Deadline mode · engine has run",
  idle: "Idle · engine gated",
  // The agent is locked, not the gameweek: this phase is the 30 minutes BEFORE the
  // deadline (schedule.py:288), so the team is still changeable.
  locked: "Locked · agent will not re-seal",
  unknown: "Phase unknown",
};

function Masthead(
  { gameweek, season, deadline, mode, reason, statusAge, statusInitialising }: {
    gameweek: number | null;
    season: string | null;
    deadline: string | null;
    mode: string;
    reason: string | null;
    statusAge: string | null;
    /** True only while the first read of `agent_status.json` is open. */
    statusInitialising: boolean;
  },
) {
  const stamp = deadlineStamp(deadline);
  return (
    <header
      className="grid items-end gap-6 pb-3 grid-cols-[minmax(0,1fr)_auto]"
      style={{ borderBottom: `2px solid ${S.ink}` }}
    >
      <div>
        {/* The wordmark takes `brand`, hue 250, not `--accent`. Accent is the
            semantic "fine" green, and spending it on identity is the defect the
            brand token was added to fix: a green nav tile and a green "agrees
            with the market" were one colour. */}
        <Label size={12.5} tone={S.brand} style={{ fontWeight: 600, letterSpacing: ".2em" }}>
          Control room
        </Label>
        <div className="mt-[5px] flex flex-wrap items-center gap-x-3 gap-y-1">
          <Label size={11} tone={S.ink3}>
            {[
              gameweek === null ? null : `Gameweek ${gameweek}`,
              season === null ? null : season.replace("-", "/"),
              "three teams, one desk",
              "read-only",
            ].filter((part) => part !== null).join(" · ")}
          </Label>
          <span
            data-testid="phase-chip"
            data-mode={mode}
            title={reason ?? undefined}
            style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "3px 8px",
              // Never a warning hue for `idle`: idle is the engine behaving
              // correctly, and colouring it as a fault trains a reader to ignore
              // the one state that is one.
              border: `1px solid ${mode === "unknown" ? S.conflict : S.hair}`,
              color: mode === "unknown" ? S.conflict : S.ink3,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 5, height: 5,
                ...(mode === "deadline"
                  ? { background: S.ink }
                  : { border: `1px solid ${S.ink3}` }),
              }}
            />
            <Label size={11} tone="inherit">{MODE_LABEL[mode] ?? MODE_LABEL.unknown}</Label>
          </span>
        </div>
      </div>
      <div className="text-right">
        <Label size={11} tone={S.ink3} style={{ letterSpacing: ".12em" }}>
          Deadline in
        </Label>
        <Countdown deadline={deadline} />
        <div>
          <Sub>
            {stamp
              ?? (deadline === null
                // "Not published" is a finding; a read in flight has produced none yet.
                ? statusInitialising
                  ? `reading ${AGENT_STATUS.path}`
                  : `no deadline published${statusAge === null ? "" : ` · ${statusAge}`}`
                : "the deadline states no time zone, so none is named here")}
          </Sub>
        </div>
      </div>
    </header>
  );
}

/**
 * The one clock on this screen.
 *
 * It owns its own tick so a second passing does not re-render the matrix, and it
 * initialises to `null` and sets `now` on mount — a `new Date()` initialiser makes
 * the server render and the first client render disagree on a value that changes
 * every second.
 *
 * `remainingMs` returns null rather than NaN on an unparseable deadline. That is
 * not defensive tidiness: `Date.parse("")` is NaN, NaN arithmetic propagates
 * silently, and it is why every expired proposal in this app once read "ready".
 */
function Countdown({ deadline }: { deadline: string | null }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const period = tickPeriodMs(remainingMs(deadline, new Date()));
    const id = setInterval(() => setNow(new Date()), period);
    return () => clearInterval(id);
  }, [deadline]);

  return (
    <div data-testid="control-room-countdown">
      <Figure size={25} style={{ fontWeight: 600, letterSpacing: "-.02em", lineHeight: 1.1 }}>
        {now === null ? "—" : countdownLong(remainingMs(deadline, now))}
      </Figure>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Team strip — the global switcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Always visible, always saying which team you are looking at.
 *
 * The rule between the cells is the separator; there is no card. The focused tile
 * takes `brand` rather than the semantic green, for the reason given at the
 * wordmark.
 */
function TeamStrip(
  { focused, onFocus }: { focused: TeamKey; onFocus: (team: TeamKey) => void },
) {
  return (
    <nav
      data-testid="team-strip"
      aria-label="Focused team"
      className="grid gap-[22px] py-[11px] grid-cols-3"
      style={{ borderBottom: `1px solid ${S.rule}` }}
    >
      {TEAMS.map((team, i) => {
        const active = team.key === focused;
        return (
          <button
            key={team.key}
            type="button"
            data-testid={`team-tile-${team.key}`}
            aria-current={active ? "true" : undefined}
            onClick={() => onFocus(team.key)}
            className="flex items-baseline gap-[10px] text-left"
            style={{
              background: "transparent",
              border: 0,
              cursor: "pointer",
              ...(i > 0
                ? { paddingLeft: 22, borderLeft: `1px solid ${S.rule}` }
                : null),
            }}
          >
            <Answer size={17} as="span" style={{ color: active ? S.brand : S.ink }}>
              {team.name}
            </Answer>
            <Figure size={11} tone={S.ink3} style={{ fontWeight: 400 }}>
              {team.entryId}
            </Figure>
            <Label size={11}>{team.mandate}</Label>
          </button>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · The lead — the answer, in words, before any figure
// ─────────────────────────────────────────────────────────────────────────────

function Lead(
  {
    projectionsAge, squadAge, squadSource, agentRan, reason, players, quartiled, draws,
    swapWaiting,
  }: {
    projectionsAge: string | null;
    squadAge: string | null;
    squadSource: string | null;
    agentRan: boolean | null;
    reason: string | null;
    players: number | null;
    /** How many of them carry all five measured quantiles. Counted, not claimed. */
    quartiled: number | null;
    draws: number | null;
    /**
     * Whether a better legal eleven exists inside the fifteen already owned.
     *
     * Passed in rather than recomputed: the same `xiSwap` the `call` cell renders, so the
     * headline and the cell can never disagree about whether anything is waiting.
     */
    swapWaiting: boolean;
  },
) {
  /*
   * The largest type on the board must not contradict what is three sections below it.
   *
   * "Nothing needs you tonight" is a claim about the whole desk, printed at 46px, and it
   * was true only about the two bots — it kept saying it while the board's own arithmetic
   * had a better legal eleven inside the fifteen already owned. That is the same defect
   * class as the two captains: two parts of one screen, both defensible alone, disagreeing
   * with each other.
   *
   * Only the `agentRan === false` arm changes. The `true` arm describes a state where the
   * bots have spoken and the queue leads instead; the `null` arm is materially different —
   * it says the board cannot see, which stays true whatever the squad says.
   */
  const headline = agentRan === true
    ? "Both bots have run, and what they produced is below."
    : agentRan === false
      ? swapWaiting
        ? "Your eleven is not the best eleven in your fifteen."
        : "Nothing needs you tonight, and neither bot has spoken yet."
      : "Nothing is waiting on you that this board can see.";

  return (
    <div>
      <Answer as="h1" size={46} style={{ marginTop: 26, lineHeight: 1.1, letterSpacing: "-.02em", maxWidth: 900 }}>
        {headline}
      </Answer>
      <Body size={15} style={{ marginTop: 14, lineHeight: 1.6, maxWidth: 820 }}>
        {players === null
          ? "This gameweek's projection has not been read, so the eleven below is "
            + "priced but not scored."
          : `This gameweek's projection is published — ${players.toLocaleString()} `
            + `players${draws === null ? "" : `, ${draws.toLocaleString()} draws`}`
            + `${quartiled === null
              ? ""
              : `, with measured quartiles on ${quartiled.toLocaleString()} of them`}. `}
        {agentRan === false
          ? `Neither bot has run: ${reason ?? "the agent gates on the deadline"}. `
            + `So the two bot columns below are empty, and they say which file would `
            + `have carried each figure rather than showing you a number nobody `
            + `computed.`
          : agentRan === null
            ? "Whether the agent has run could not be read, which is not the same as "
              + "it having not run."
            : "Approve on each team's own screen; nothing here submits a team."}
      </Body>
      <div className="mt-[10px]">
        <Sub>
          {[
            `projections: ${projectionsAge ?? "no timestamp"}`,
            `squad: ${squadAge ?? "no timestamp"}${
              squadSource === "captured_authenticated_draft" ? " (captured draft)" : ""
            }`,
            "calls: none published",
          ].join("  ·  ")}
        </Sub>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · The queue's rows, built from the artifacts
// ─────────────────────────────────────────────────────────────────────────────

function buildQueue(
  { status, calibrated, sealed }: {
    status: Read<AgentStatus>;
    calibrated: number | null;
    sealed: number | null;
  },
): readonly QueueRow[] {
  const rows: QueueRow[] = [];
  const deadline = status.value?.deadline ?? null;
  const stamp = deadlineStamp(deadline);

  if (stamp !== null) {
    rows.push({
      id: "deadline",
      team: "Mine",
      claim: "Your team is due before the deadline, and nothing here can submit it.",
      reason:
        "The only thing on the clock. FPL takes the team you have set when it "
        + "passes, so an unattended board is a submitted board.",
      when: stamp.split(" · ")[1] ?? stamp,
      scheduled: true,
      anchor: "model",
      freshness: status.age,
      stale: status.stale,
    });
  }

  rows.push({
    id: "calibration",
    team: "Wazza",
    claim: "It cannot legitimately run its own objective yet, and says so.",
    reason: calibrationClaim(calibrated),
    when: "Standing",
    scheduled: false,
    anchor: "model",
    freshness: sealed === null ? null : "live",
    stale: false,
  });

  return rows;
}
