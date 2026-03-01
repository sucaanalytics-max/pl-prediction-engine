"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { usePredictions } from "@/lib/PredictionsContext";
import {
  getMatchById, correctScoreToGrid, getHalfKellyPct,
  effectiveEdge, confidenceTier, marketLabel, marketIcon,
} from "@/lib/predictions";
import { pct, xg, odds, shortDate, kickoffTime, confidenceColor, edgeColor, impliedOdds } from "@/lib/formats";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";
import ReactMarkdown from "react-markdown";
import ScorelineHeatmap from "@/components/ScorelineHeatmap";
import DistributionChart from "@/components/DistributionChart";
import SHAPWaterfall from "@/components/SHAPWaterfall";
import { CONF_BADGES, MARKET_ICON_LABELS, edgePrefix } from "@/lib/theme";

function MatchDetailContent() {
  const params = useParams();
  const matchId = params.id as string;
  const { predictions: data, loading, error, refresh } = usePredictions();

  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !data) return <PageSkeleton rows={6} />;

  const match = getMatchById(data, decodeURIComponent(matchId));
  if (!match) {
    return (
      <div className="card p-8 text-center">
        <p className="text-red-400 font-medium">Match not found</p>
        <Link href="/" className="mt-4 inline-block text-sm" style={{ color: "var(--accent)" }}>
          Back to fixtures
        </Link>
      </div>
    );
  }

  const p = match.probabilities["1x2"];
  const maxProb = Math.max(p.home, p.draw, p.away);
  const prediction = p.home === maxProb ? "home" : p.away === maxProb ? "away" : "draw";
  const { home_team, away_team, referee, is_derby } = match.fixture;

  const scoreGrid = correctScoreToGrid(match.probabilities.correct_score);
  const ahLines = Object.entries(match.probabilities.asian_handicap)
    .filter(([k]) => k.startsWith("home_"))
    .sort(([a], [b]) => parseFloat(a.replace("home_", "")) - parseFloat(b.replace("home_", "")));
  const cornerLines = ["8.5", "9.5", "10.5", "11.5"];
  const cardLines = ["2.5", "3.5", "4.5"];

  const goalsHome = match.distributions.goals_home ?? [];
  const goalsAway = match.distributions.goals_away ?? [];
  const cornersDist = match.distributions.corners ?? match.distributions.total_corners ?? [];
  const cardsDist = match.distributions.cards ?? match.distributions.total_cards ?? [];
  const bookings = match.player_bookings?.top_bookings ?? [];
  const goalscorer = match.goalscorer;
  const oddsComp = match.odds_comparison;

  return (
    <div className="space-y-8">
      {/* Back */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm transition-colors"
        style={{ color: "var(--text-3)" }}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to fixtures
      </Link>

      {/* Header card */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider flex-wrap" style={{ color: "var(--text-3)" }}>
            <span>{shortDate(match.fixture.date)} · {kickoffTime(match.fixture.date)} · GW{match.fixture.gameweek}</span>
            {is_derby && <span className="badge-amber">DERBY</span>}
            {referee && (
              <span className="normal-case tracking-normal" style={{ color: "var(--text-2)" }}>
                Ref: <span style={{ color: "var(--text-1)" }}>{referee}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {match.model_disagreement !== undefined && match.model_disagreement > 0.15 && (
              <span className="badge-amber text-[9px]">MODELS DISAGREE</span>
            )}
            <span className={confidenceColor(maxProb * 100) + " text-xs font-mono"}>
              {pct(maxProb)} confidence
            </span>
          </div>
        </div>

        {/* Teams & xG */}
        <div className="flex items-center justify-center gap-6 my-6">
          <div className="text-right flex-1">
            <h2
              className="text-2xl font-bold"
              style={{ color: prediction === "home" ? "var(--text-1)" : "var(--text-3)" }}
            >
              {home_team}
            </h2>
            <p className="text-sm font-mono mt-1" style={{ color: "var(--text-3)" }}>xG {xg(match.expected_goals.home)}</p>
          </div>
          <div className="flex flex-col items-center px-4">
            <div className="text-3xl font-bold" style={{ color: "var(--home)" }}>
              {match.expected_goals.home.toFixed(1)} — {match.expected_goals.away.toFixed(1)}
            </div>
            <span className="text-[10px] uppercase tracking-wider mt-1" style={{ color: "var(--text-4)" }}>Expected</span>
          </div>
          <div className="text-left flex-1">
            <h2
              className="text-2xl font-bold"
              style={{ color: prediction === "away" ? "var(--text-1)" : "var(--text-3)" }}
            >
              {away_team}
            </h2>
            <p className="text-sm font-mono mt-1" style={{ color: "var(--text-3)" }}>xG {xg(match.expected_goals.away)}</p>
          </div>
        </div>

        {/* 1X2 bar */}
        <div className="space-y-2">
          <div className="flex h-3 rounded-full overflow-hidden" style={{ background: "var(--surface2)" }}>
            <div className="prob-bar rounded-l-full" style={{ width: pct(p.home), background: "var(--home)" }} />
            <div className="prob-bar" style={{ width: pct(p.draw), background: "var(--draw)" }} />
            <div className="prob-bar rounded-r-full" style={{ width: pct(p.away), background: "var(--away)" }} />
          </div>
          <div className="flex justify-between text-xs">
            <span className="font-mono" style={{ color: "var(--home)" }}>{pct(p.home)} H ({impliedOdds(p.home)})</span>
            <span className="font-mono" style={{ color: "var(--draw)" }}>{pct(p.draw)} D ({impliedOdds(p.draw)})</span>
            <span className="font-mono" style={{ color: "var(--away)" }}>{pct(p.away)} A ({impliedOdds(p.away)})</span>
          </div>
        </div>

        {/* Clean sheet */}
        {match.probabilities.clean_sheet && (
          <div className="mt-4 pt-4 flex justify-between text-xs" style={{ borderTop: "1px solid var(--border)", color: "var(--text-3)" }}>
            <span>{home_team} CS: <span className="font-mono" style={{ color: "var(--text-1)" }}>{pct(match.probabilities.clean_sheet.home)}</span></span>
            <span>{away_team} CS: <span className="font-mono" style={{ color: "var(--text-1)" }}>{pct(match.probabilities.clean_sheet.away)}</span></span>
          </div>
        )}
      </div>

      {/* Model vs Odds Comparison */}
      {oddsComp?.h2h && Object.keys(oddsComp.h2h).length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Model vs Odds</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider" style={{ borderBottom: "1px solid var(--border)", color: "var(--text-3)" }}>
                  <th scope="col" className="pb-2 font-medium">Bookmaker</th>
                  <th scope="col" className="pb-2 font-medium text-center">Home</th>
                  <th scope="col" className="pb-2 font-medium text-center">Draw</th>
                  <th scope="col" className="pb-2 font-medium text-center">Away</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-2 font-medium" style={{ color: "var(--success)" }}>Model</td>
                  <td className="py-2 text-center font-mono" style={{ color: "var(--text-1)" }}>{pct(p.home)}</td>
                  <td className="py-2 text-center font-mono" style={{ color: "var(--text-1)" }}>{pct(p.draw)}</td>
                  <td className="py-2 text-center font-mono" style={{ color: "var(--text-1)" }}>{pct(p.away)}</td>
                </tr>
                {Object.entries(oddsComp.h2h).slice(0, 5).map(([bk, o]) => {
                  const impH = 1 / o.home;
                  const impD = 1 / o.draw;
                  const impA = 1 / o.away;
                  const total = impH + impD + impA;
                  return (
                    <tr key={bk} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td className="py-2" style={{ color: "var(--text-3)" }}>{bk.replace(/_/g, " ")}</td>
                      <td className="py-2 text-center font-mono">
                        <span style={{ color: p.home > impH / total ? "var(--success)" : "var(--text-3)" }}>
                          {pct(impH / total)}
                        </span>
                      </td>
                      <td className="py-2 text-center font-mono">
                        <span style={{ color: p.draw > impD / total ? "var(--success)" : "var(--text-3)" }}>
                          {pct(impD / total)}
                        </span>
                      </td>
                      <td className="py-2 text-center font-mono">
                        <span style={{ color: p.away > impA / total ? "var(--success)" : "var(--text-3)" }}>
                          {pct(impA / total)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] mt-2" style={{ color: "var(--text-4)" }}>Green = model gives higher probability (potential edge).</p>
        </div>
      )}

      {/* Markets grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* O/U 2.5 */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>Over/Under 2.5 Goals</h3>
          {match.probabilities.over_under["2.5"] ? (
            <>
              <div className="flex justify-between items-center">
                <div>
                  <span className="text-lg font-display font-bold" style={{ color: "var(--text-1)" }}>
                    {pct(match.probabilities.over_under["2.5"].over)}
                  </span>
                  <span className="text-xs ml-1" style={{ color: "var(--text-3)" }}>over</span>
                </div>
                <div>
                  <span className="text-xs mr-1" style={{ color: "var(--text-3)" }}>under</span>
                  <span className="text-lg font-display font-bold" style={{ color: "var(--text-3)" }}>
                    {pct(match.probabilities.over_under["2.5"].under)}
                  </span>
                </div>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden" style={{ background: "var(--surface2)" }}>
                <div className="prob-bar bg-emerald-500" style={{ width: pct(match.probabilities.over_under["2.5"].over) }} />
              </div>
            </>
          ) : <span className="text-sm" style={{ color: "var(--text-4)" }}>—</span>}
        </div>

        {/* BTTS */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>Both Teams to Score</h3>
          <div className="flex justify-between items-center">
            <div>
              <span className="text-lg font-display font-bold" style={{ color: "var(--text-1)" }}>{pct(match.probabilities.btts)}</span>
              <span className="text-xs ml-1" style={{ color: "var(--text-3)" }}>yes</span>
            </div>
            <div>
              <span className="text-xs mr-1" style={{ color: "var(--text-3)" }}>no</span>
              <span className="text-lg font-display font-bold" style={{ color: "var(--text-3)" }}>{pct(1 - match.probabilities.btts)}</span>
            </div>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden" style={{ background: "var(--surface2)" }}>
            <div className="prob-bar bg-amber-500" style={{ width: pct(match.probabilities.btts) }} />
          </div>
        </div>

        {/* Corners */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>Corners</h3>
          <div className="stat-value">
            {match.expected_corners.toFixed(1)}
            <span className="text-xs font-normal ml-1" style={{ color: "var(--text-3)" }}>expected</span>
          </div>
          <div className="space-y-1">
            {cornerLines.map((line) => {
              const ou = match.probabilities.corners[line];
              if (!ou) return null;
              return (
                <div key={line} className="flex justify-between text-xs font-mono" style={{ color: "var(--text-3)" }}>
                  <span>O/U {line}</span>
                  <span className="text-emerald-400">{pct(ou.over)}</span>
                  <span>/</span>
                  <span>{pct(ou.under)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Cards */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>Cards</h3>
          <div className="stat-value">
            {match.expected_cards.toFixed(1)}
            <span className="text-xs font-normal ml-1" style={{ color: "var(--text-3)" }}>expected</span>
          </div>
          <div className="space-y-1">
            {cardLines.map((line) => {
              const ou = match.probabilities.cards[line];
              if (!ou) return null;
              return (
                <div key={line} className="flex justify-between text-xs font-mono" style={{ color: "var(--text-3)" }}>
                  <span>O/U {line}</span>
                  <span className="text-amber-400">{pct(ou.over)}</span>
                  <span>/</span>
                  <span>{pct(ou.under)}</span>
                </div>
              );
            })}
          </div>
          {is_derby && (
            <p className="text-[10px] text-amber-500/70 pt-1">Derby boost applied</p>
          )}
        </div>

        {/* HT/FT */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>HT/FT Combos</h3>
          <div className="grid grid-cols-3 gap-1 text-center text-xs font-mono">
            {Object.entries(match.probabilities.ht_ft)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 6)
              .map(([combo, prob]) => (
                <div key={combo} className="glass-inset rounded px-1.5 py-1.5">
                  <span style={{ color: "var(--text-2)" }}>{combo}</span>
                  <span className="ml-1" style={{ color: "var(--text-3)" }}>{pct(prob, 0)}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Asian Handicap */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>Asian Handicap (Home)</h3>
          <div className="space-y-1">
            {ahLines.slice(0, 7).map(([line, prob]) => {
              const lineNum = line.replace("home_", "");
              return (
                <div key={line} className="flex justify-between text-xs font-mono">
                  <span style={{ color: "var(--text-3)" }}>AH {lineNum}</span>
                  <span style={{ color: "var(--home)" }}>{pct(prob as number)}</span>
                  <span style={{ color: "var(--away)" }}>{pct(1 - (prob as number))}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Goalscorer Probabilities */}
      {goalscorer && (goalscorer.home_scorers.length > 0 || goalscorer.away_scorers.length > 0) && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Goalscorer Probabilities</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Home scorers */}
            {goalscorer.home_scorers.length > 0 && (
              <div>
                <h4 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--home)" }}>{home_team}</h4>
                <div className="space-y-2">
                  {goalscorer.home_scorers.slice(0, 6).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 glass-inset rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{s.web_name}</span>
                        <span className="text-[10px] ml-1.5" style={{ color: "var(--text-3)" }}>{s.position}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono flex-shrink-0">
                        <span style={{ color: "var(--text-3)" }}>xG/90 {s.xg_per_90.toFixed(2)}</span>
                        <span className="text-emerald-400 font-semibold">{pct(s.anytime_prob)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Away scorers */}
            {goalscorer.away_scorers.length > 0 && (
              <div>
                <h4 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--away)" }}>{away_team}</h4>
                <div className="space-y-2">
                  {goalscorer.away_scorers.slice(0, 6).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 glass-inset rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{s.web_name}</span>
                        <span className="text-[10px] ml-1.5" style={{ color: "var(--text-3)" }}>{s.position}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono flex-shrink-0">
                        <span style={{ color: "var(--text-3)" }}>xG/90 {s.xg_per_90.toFixed(2)}</span>
                        <span className="text-emerald-400 font-semibold">{pct(s.anytime_prob)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="text-[10px] mt-3" style={{ color: "var(--text-4)" }}>
            Anytime scorer probability from Poisson model. Match xG: {home_team} {goalscorer.match_xg?.home.toFixed(2) ?? "—"} / {away_team} {goalscorer.match_xg?.away.toFixed(2) ?? "—"}.
          </p>
        </div>
      )}

      {/* Scoreline Heatmap */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Correct Score Probabilities</h3>
        <ScorelineHeatmap grid={scoreGrid} homeTeam={home_team} awayTeam={away_team} />
      </div>

      {/* Distributions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {goalsHome.length > 0 && (
          <div className="card p-4">
            <DistributionChart data={goalsHome} label={`${home_team} Goals`} color="#2aad1f" />
          </div>
        )}
        {goalsAway.length > 0 && (
          <div className="card p-4">
            <DistributionChart data={goalsAway} label={`${away_team} Goals`} color="#38bdf8" />
          </div>
        )}
        {cornersDist.length > 0 && (
          <div className="card p-4">
            <DistributionChart data={cornersDist} label="Total Corners" color="#a78bfa" startLabel={0} />
          </div>
        )}
        {cardsDist.length > 0 && (
          <div className="card p-4">
            <DistributionChart data={cardsDist} label="Total Cards" color="#fbbf24" startLabel={0} />
          </div>
        )}
      </div>

      {/* Player Bookings */}
      {bookings.length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Player Booking Probabilities</h3>
          <div className="space-y-2">
            {bookings.map((b, i) => (
              <div key={i} className="flex items-center gap-3 glass-inset rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{b.web_name}</span>
                  <span className="text-xs ml-2" style={{ color: "var(--text-3)" }}>{b.team}</span>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono flex-shrink-0">
                  <div className="w-20 rounded-full h-1.5 overflow-hidden" style={{ background: "var(--surface2)" }}>
                    <div
                      className="h-full bg-amber-500 rounded-full"
                      style={{ width: `${Math.min(b.adjusted_prob * 400, 100)}%` }}
                    />
                  </div>
                  <span className="text-amber-400 w-10 text-right">{pct(b.adjusted_prob)}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] mt-3" style={{ color: "var(--text-4)" }}>
            Adjusted for referee profile{referee ? ` (${referee})` : ""}, derby context, and foul rates.
          </p>
        </div>
      )}

      {/* SHAP */}
      {match.shap_features.length > 0 && (
        <div className="card p-6">
          <SHAPWaterfall features={match.shap_features} />
        </div>
      )}

      {/* Value Bets */}
      {match.value_bets.length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Value Bets</h3>
          <div className="space-y-3">
            {match.value_bets.map((bet, i) => {
              const tier = bet.confidence_tier ?? confidenceTier(effectiveEdge(bet));
              const badge = CONF_BADGES[tier] ?? CONF_BADGES.low;
              return (
                <div key={i} className="flex items-center justify-between glass-inset rounded-lg p-3 gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs opacity-60" role="img" aria-label={MARKET_ICON_LABELS[marketIcon(bet.market)] ?? "Market"}>{marketIcon(bet.market)}</span>
                    <div>
                      <span className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{bet.selection ?? bet.market}</span>
                      {bet.selection && (
                        <span className="text-[10px] ml-2" style={{ color: "var(--text-3)" }}>{marketLabel(bet.market)}</span>
                      )}
                    </div>
                    <span className={`${badge.cls} text-[9px] ml-1`}>{badge.label}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono">
                    <span className="text-emerald-400">{pct(bet.model_prob)} model</span>
                    <span style={{ color: "var(--text-3)" }}>{pct(bet.implied_prob)} impl.</span>
                    {bet.devigged_prob && (
                      <span style={{ color: "var(--text-2)" }}>{pct(bet.devigged_prob)} devig</span>
                    )}
                    <span className={`font-semibold ${edgeColor(effectiveEdge(bet))}`}>
                      {edgePrefix(effectiveEdge(bet))}{pct(effectiveEdge(bet))} edge
                    </span>
                    {(bet.decimal_odds ?? 0) > 0 && (
                      <span style={{ color: "var(--info)" }}>{odds(bet.decimal_odds!)}</span>
                    )}
                    <span style={{ color: "var(--text-2)" }}>½K {pct(getHalfKellyPct(bet))}</span>
                    {bet.bookmaker && (
                      <span style={{ color: "var(--text-4)" }}>{bet.bookmaker.replace(/_/g, " ")}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Narrative */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}>
          Match Preview
        </h3>
        <div
          className="text-sm leading-relaxed space-y-2 [&_strong]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:uppercase [&_h3]:tracking-wider [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold"
          style={{ color: "var(--text-2)" }}
        >
          <ReactMarkdown>{match.narrative}</ReactMarkdown>
        </div>
      </div>

      {/* Confidence / entropy */}
      {match.confidence && (
        <div className="card p-4 flex items-center justify-between text-xs gap-2 flex-wrap" style={{ color: "var(--text-3)" }}>
          <span>Entropy: {match.confidence.entropy.toFixed(3)}</span>
          {match.confidence.home_goals_ci && (
            <span>{home_team} goals 95% CI: [{match.confidence.home_goals_ci[0].toFixed(1)}, {match.confidence.home_goals_ci[1].toFixed(1)}]</span>
          )}
          {match.confidence.away_goals_ci && (
            <span>{away_team} goals 95% CI: [{match.confidence.away_goals_ci[0].toFixed(1)}, {match.confidence.away_goals_ci[1].toFixed(1)}]</span>
          )}
          {match.n_simulations && (
            <span>{(match.n_simulations / 1000).toFixed(0)}K simulations</span>
          )}
        </div>
      )}
    </div>
  );
}

export default function MatchDetailPage() {
  return (
    <ErrorBoundary pageName="Match Detail">
      <MatchDetailContent />
    </ErrorBoundary>
  );
}
