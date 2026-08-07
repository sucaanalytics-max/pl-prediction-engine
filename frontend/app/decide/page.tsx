"use client";

/**
 * Decide — what the move is, and how much to trust it.
 *
 * ## Two sources, and they are not equals
 *
 * The agent publishes `decision_public_gw{NN}_{label}.json`, which is solved on
 * two independent draw streams and carries its own `optimism_gap`. **No gameweek
 * has ever sealed**, so that file does not exist yet.
 *
 * The fallback is `lib/fpl-ranking-engine.ts`, and it is shown behind a loud
 * badge rather than silently. Its six tests contain **zero accuracy assertions**,
 * and it holds around twenty untested constants including:
 *
 *     Math.min(90, Math.max(45, (player.minutes / Math.max(1, player.totalPoints)) * 4.5))
 *
 * That is **minutes divided by points**, which is dimensionally meaningless and
 * rewards low-scoring players with higher projected minutes. The clamp bounds the
 * damage; it does not make it a model.
 *
 * A heuristic presented as a projection is the FPLReview problem reproduced in our
 * own code, so the badge is not decoration — it is the reason showing this at all
 * is defensible. Per the plan it goes when four gameweeks have sealed.
 *
 * ## Freshness is about the deadline, not the file
 *
 * `classifyDecision` in `lib/fpl-decision.ts` refuses to render expired advice as
 * actionable. Until `deadline` was added to `Decision.as_dict()` that branch was
 * unreachable — `Date.parse("")` is NaN, so every proposal read "ready".
 */

import { useMemo } from "react";
import { REGISTRY, decisionDescriptor, ENTRY_LABELS } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { ProvenanceStrip, Section, WhenProven } from "@/components/data/Artifact";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { proven } from "@/lib/data/artifact";
import { formatRemaining, msToDeadline } from "@/lib/fpl-decision";
import type { EntryLabel, MatchesFile, PublicDecision } from "@/lib/data/narrow";

function DeadlineBadge({ deadline }: { deadline: string | null }) {
  const remaining = deadline ? msToDeadline(deadline, new Date()) : null;

  if (remaining === null) {
    return (
      <span className="badge-amber text-[9px]" data-freshness="unknown">
        NO DEADLINE RECORDED
      </span>
    );
  }
  if (remaining <= 0) {
    // Reachable only because `deadline` now exists on the artifact.
    return (
      <span
        className="text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded"
        style={{ background: "rgba(248,113,113,0.12)", color: "var(--danger, #f87171)" }}
        data-freshness="expired"
      >
        DEADLINE PASSED — DO NOT ACT
      </span>
    );
  }
  return (
    <span className="badge-green text-[9px]" data-freshness="ready">
      {formatRemaining(remaining)} LEFT
    </span>
  );
}

function Proposal({ decision }: { decision: PublicDecision }) {
  const plan = decision.plan;
  if (!plan) return null;
  const moved = plan.transfers_out.length > 0 || plan.transfers_in.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
          {moved
            ? `${plan.transfers_out.join(", ")} → ${plan.transfers_in.join(", ")}`
            : "Hold — no transfer"}
          {plan.hits > 0 ? (
            <span style={{ color: "var(--danger, #f87171)" }}>
              {" "}(−{plan.hits * 4} for hits)
            </span>
          ) : null}
        </p>
        <DeadlineBadge deadline={decision.deadline} />
      </div>

      <div className="glass-inset p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <p className="stat-label">Captain</p>
          <p className="font-mono">{plan.captain ?? "—"}</p>
        </div>
        <div>
          <p className="stat-label">Projected</p>
          <p className="font-mono">
            {decision.mean_points !== null ? decision.mean_points.toFixed(1) : "—"}
          </p>
        </div>
        <div>
          <p className="stat-label">Optimism gap</p>
          {/* The winner's-curse correction. A large gap means the shortlist was
              chosen by simulation noise, and the honest response is more draws
              rather than a better-sounding rationale. */}
          <p className="font-mono">
            {decision.optimism_gap !== null ? decision.optimism_gap.toFixed(2) : "—"}
          </p>
        </div>
        <div>
          <p className="stat-label">Margin</p>
          <p className="font-mono">
            {decision.credible_margin ? "credible" : "noisy"}
          </p>
        </div>
      </div>

      {decision.warnings.length > 0 ? (
        <ul className="text-xs space-y-1" style={{ color: "var(--warning, #f59e0b)" }}>
          {decision.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
        Propose-only. Nothing here is submitted to FPL on your behalf.
      </p>
    </div>
  );
}

function EntrySection({ label, gameweek }: { label: EntryLabel; gameweek: number }) {
  // Rebuilt only when the gameweek changes; the hook keys on descriptor.path.
  const descriptor = useMemo(
    () => decisionDescriptor(gameweek, label), [gameweek, label],
  );
  const { artifact } = useArtifact<PublicDecision>(descriptor);

  return (
    <Section
      title={label === "season" ? "Season team" : "Weekly team"}
      subtitle={
        label === "season"
          ? "Maximises expected points; variance is a cost"
          : "Maximises the right tail; variance is the point"
      }
      aside={<ProvenanceStrip of={artifact} />}
    >
      <WhenProven
        of={artifact}
        what={
          `No proposal has been published for GW${gameweek}. The agent writes one ` +
          `per entry once a gameweek is sealed, and none has sealed yet.`
        }
        then={(decision) => <Proposal decision={decision} />}
      />
    </Section>
  );
}

/**
 * The fallback, named for what it is.
 *
 * Not hidden and not dressed as a projection: a heuristic presented as a model is
 * exactly the failure this whole rebuild is a response to.
 */
function HeuristicNotice() {
  return (
    <div
      className="card p-4 space-y-2"
      role="note"
      data-testid="heuristic-notice"
    >
      <span className="badge-amber text-[9px]">HEURISTIC — NOT A MODEL</span>
      <p className="text-sm" style={{ color: "var(--text-2)" }}>
        Until a gameweek seals, the recommendation lists on{" "}
        <code>/transfers</code>, <code>/optimizer</code>, <code>/captaincy</code> and{" "}
        <code>/rankings</code> come from an unvalidated heuristic, not from the
        decision engine.
      </p>
      <p className="text-xs" style={{ color: "var(--text-4)" }}>
        Its tests contain no accuracy assertions, and it projects minutes as
        <code> minutes ÷ total points × 4.5</code> — which rewards low-scoring
        players with more minutes. Treat its output as a prompt to think, never as
        a number.
      </p>
    </div>
  );
}

export default function DecidePage() {
  const { artifact: matches } = useArtifact<MatchesFile>(REGISTRY.matches);
  const gameweek = proven(matches)?.gameweek ?? null;

  return (
    <ErrorBoundary pageName="Decide">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
          >
            Decide
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            The move, and how much to trust it
          </p>
        </header>

        {gameweek === null ? (
          <div className="card p-6 text-center" role="status">
            <p className="text-sm" style={{ color: "var(--text-2)" }}>
              The current gameweek is unknown, so no proposal can be located.
            </p>
            <p className="text-xs mt-2" style={{ color: "var(--text-4)" }}>
              A decision is filed per gameweek, so the fixtures artifact has to be
              readable before one can be found.
            </p>
          </div>
        ) : (
          ENTRY_LABELS.map((label) => (
            <EntrySection key={label} label={label} gameweek={gameweek} />
          ))
        )}

        <HeuristicNotice />
      </div>
    </ErrorBoundary>
  );
}
