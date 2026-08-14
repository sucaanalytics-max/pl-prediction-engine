"use client";

import { useState, useMemo, useCallback, useRef } from "react";
import { useLocalStorage } from "@/lib/hooks";
import { pct } from "@/lib/formats";
import { kellyFraction, currentDrawdown, type KellyResult } from "@/lib/kelly";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import PnLChart from "@/components/PnLChart";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BetRecord {
  id: string;
  date: string;
  match: string;
  market: string;
  selection: string;
  decimalOdds: number;
  stake: number;
  result: "win" | "loss" | "void" | "pending";
}

interface BankrollState {
  initialBankroll: number;
  bets: BetRecord[];
}

const EMPTY_STATE: BankrollState = { initialBankroll: 100, bets: [] };

const MARKET_TYPES = ["1X2", "Goals O/U", "BTTS", "Corners", "Cards", "Goalscorer", "Player", "Other"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function computeTrajectory(initial: number, bets: BetRecord[]) {
  const settled = bets.filter((b) => b.result === "win" || b.result === "loss");
  const sorted = [...settled].sort((a, b) => a.date.localeCompare(b.date));

  const points: { gameweek: number; bankroll: number; peak: number }[] = [];
  let bankroll = initial;
  let peak = initial;

  points.push({ gameweek: 0, bankroll: initial, peak: initial });

  sorted.forEach((bet, i) => {
    if (bet.result === "win") {
      bankroll += bet.stake * (bet.decimalOdds - 1);
    } else {
      bankroll -= bet.stake;
    }
    bankroll = Math.max(0, bankroll);
    peak = Math.max(peak, bankroll);
    points.push({ gameweek: i + 1, bankroll: Math.round(bankroll * 100) / 100, peak });
  });

  return points;
}

function marketStats(bets: BetRecord[]) {
  const settled = bets.filter((b) => b.result === "win" || b.result === "loss");
  const grouped: Record<string, { wins: number; losses: number; pnl: number }> = {};

  for (const b of settled) {
    if (!grouped[b.market]) grouped[b.market] = { wins: 0, losses: 0, pnl: 0 };
    const g = grouped[b.market];
    if (b.result === "win") {
      g.wins++;
      g.pnl += b.stake * (b.decimalOdds - 1);
    } else {
      g.losses++;
      g.pnl -= b.stake;
    }
  }
  return grouped;
}

// ─── Component ────────────────────────────────────────────────────────────────

function BankrollContent() {
  const [state, setState] = useLocalStorage<BankrollState>("pl-engine-bankroll", EMPTY_STATE);
  const { initialBankroll, bets } = state;

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [formDate, setFormDate] = useState(new Date().toISOString().slice(0, 10));
  const [formMatch, setFormMatch] = useState("");
  const [formMarket, setFormMarket] = useState("1X2");
  const [formSelection, setFormSelection] = useState("");
  const [formOdds, setFormOdds] = useState("");
  const [formStake, setFormStake] = useState("");
  const [formResult, setFormResult] = useState<BetRecord["result"]>("pending");

  // Kelly calc
  const [calcProb, setCalcProb] = useState("0.55");
  const [calcOdds, setCalcOdds] = useState("2.00");
  const [kellyResult, setKellyResult] = useState<KellyResult | null>(null);

  // Initial bankroll edit
  const [editingBankroll, setEditingBankroll] = useState(false);
  const [newBankroll, setNewBankroll] = useState(initialBankroll.toString());

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<NodeJS.Timeout | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // Delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Computed
  const trajectory = useMemo(() => computeTrajectory(initialBankroll, bets), [initialBankroll, bets]);
  const currentValue = trajectory[trajectory.length - 1]?.bankroll ?? initialBankroll;
  const drawdown = currentDrawdown(trajectory.map((t) => t.bankroll));
  const roi = initialBankroll > 0 ? ((currentValue - initialBankroll) / initialBankroll) * 100 : 0;
  const settledBets = bets.filter((b) => b.result === "win" || b.result === "loss");
  const winRate = settledBets.length > 0
    ? settledBets.filter((b) => b.result === "win").length / settledBets.length
    : 0;
  const markets = useMemo(() => marketStats(bets), [bets]);

  const addBet = useCallback(() => {
    const o = parseFloat(formOdds);
    const s = parseFloat(formStake);
    if (!formMatch || isNaN(o) || isNaN(s) || o < 1 || s <= 0) return;

    const bet: BetRecord = {
      id: generateId(),
      date: formDate,
      match: formMatch,
      market: formMarket,
      selection: formSelection,
      decimalOdds: o,
      stake: s,
      result: formResult,
    };
    setState((prev) => ({ ...prev, bets: [...prev.bets, bet] }));
    setFormMatch("");
    setFormSelection("");
    setFormOdds("");
    setFormStake("");
    setFormResult("pending");
    setShowForm(false);
    showToast("✓ Bet recorded");
  }, [formDate, formMatch, formMarket, formSelection, formOdds, formStake, formResult, setState, showToast]);

  const updateResult = useCallback((id: string, result: BetRecord["result"]) => {
    setState((prev) => ({
      ...prev,
      bets: prev.bets.map((b) => (b.id === id ? { ...b, result } : b)),
    }));
  }, [setState]);

  const removeBet = useCallback((id: string) => {
    setState((prev) => ({ ...prev, bets: prev.bets.filter((b) => b.id !== id) }));
    setConfirmDeleteId(null);
    showToast("Bet removed");
  }, [setState, showToast]);

  const saveBankroll = useCallback(() => {
    const v = parseFloat(newBankroll);
    if (!isNaN(v) && v > 0) {
      setState((prev) => ({ ...prev, initialBankroll: v }));
    }
    setEditingBankroll(false);
  }, [newBankroll, setState]);

  const exportCSV = useCallback(() => {
    const header = "Date,Match,Market,Selection,Odds,Stake,Result\n";
    const rows = bets.map((b) =>
      `${b.date},"${b.match}",${b.market},"${b.selection}",${b.decimalOdds},${b.stake},${b.result}`
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bankroll_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [bets]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between flex-wrap gap-4 relative z-10 mb-6">
        <div>
          <h1
            className="text-4xl md:text-5xl font-extrabold tracking-tighter mb-2"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Bankroll Tracker
          </h1>
          <p className="text-sm font-medium tracking-wide" style={{ color: "var(--text-3)" }}>
            Performance tracking <span className="mx-1.5 opacity-50">•</span> Kelly calculator <span className="mx-1.5 opacity-50">•</span> Risk management
          </p>
        </div>
        <div className="flex gap-2">
          {bets.length > 0 && (
            <button
              onClick={exportCSV}
              className="px-3 py-1.5 text-xs rounded-none transition-colors"
              style={{ color: "var(--text-3)", background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              Export CSV
            </button>
          )}
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-3 py-1.5 text-xs text-[var(--bg)] rounded-none transition-colors font-medium"
            style={{ background: "var(--accent)" }}
          >
            {showForm ? "Cancel" : "+ Add Bet"}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="glass-panel p-5 rounded-none flex flex-col items-center justify-center text-center">
          <div className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.15em] mb-2" style={{ color: "var(--text-3)" }}>Current Value</div>
          <div className="text-2xl sm:text-3xl font-black tabular-nums" style={{ color: "var(--text-1)" }}>£{currentValue.toFixed(0)}</div>
        </div>
        <div className="glass-panel p-5 rounded-none flex flex-col items-center justify-center text-center relative overflow-hidden">
          <div className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.15em] mb-2" style={{ color: "var(--text-3)" }}>ROI</div>
          <div className={`text-2xl sm:text-3xl font-black tabular-nums ${roi >= 0 ? "text-[var(--success)]" : "text-[var(--error)]"}`}>
            {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
          </div>
        </div>
        <div className="glass-panel p-5 rounded-none flex flex-col items-center justify-center text-center relative overflow-hidden">
          <div className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.15em] mb-2" style={{ color: "var(--text-3)" }}>Drawdown</div>
          <div className={`text-2xl sm:text-3xl font-black tabular-nums ${drawdown > 0.2 ? "text-[var(--error)]" : drawdown > 0.1 ? "text-[var(--warning)]" : "text-[var(--success)]"}`}>
            {pct(drawdown)}
          </div>
        </div>
        <div className="glass-panel p-5 rounded-none flex flex-col items-center justify-center text-center">
          <div className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.15em] mb-2" style={{ color: "var(--text-3)" }}>Win Rate</div>
          <div className="text-2xl sm:text-3xl font-black tabular-nums" style={{ color: "var(--info)" }}>{settledBets.length > 0 ? pct(winRate) : "—"}</div>
        </div>
        <div className="glass-panel p-5 rounded-none flex flex-col items-center justify-center text-center cursor-pointer hover:bg-[var(--surface2)] transition-colors" onClick={() => { setEditingBankroll(true); setNewBankroll(initialBankroll.toString()); }}>
          <div className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.15em] mb-2" style={{ color: "var(--text-3)" }}>Starting</div>
          {editingBankroll ? (
            <div className="flex justify-center w-full">
              <input
                type="number"
                value={newBankroll}
                onChange={(e) => setNewBankroll(e.target.value)}
                className="w-20 rounded bg-black/20 px-2 py-1 text-base sm:text-lg font-mono font-bold text-center border focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                style={{ color: "var(--text-1)", border: "1px solid var(--border)" }}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && saveBankroll()}
                onBlur={saveBankroll}
                aria-label="Starting bankroll amount"
              />
            </div>
          ) : (
            <div className="text-2xl sm:text-3xl font-black tabular-nums" style={{ color: "var(--text-3)" }}>£{initialBankroll}</div>
          )}
        </div>
      </div>

      {/* Drawdown limits */}
      <div className="glass-panel p-4 rounded-none border border-[var(--border)]">
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <span style={{ color: "var(--text-3)" }}>Risk limits:</span>
          <span className={drawdown > 0.2 ? "text-[var(--error)] font-semibold" : ""} style={drawdown <= 0.2 ? { color: "var(--text-2)" } : undefined}>
            Soft stop: 20%
          </span>
          <span className={drawdown > 0.3 ? "text-[var(--error)] font-semibold" : ""} style={drawdown <= 0.3 ? { color: "var(--text-2)" } : undefined}>
            Hard stop: 30%
          </span>
          <span className="ml-auto">
            {drawdown < 0.1 ? (
              <span className="badge-green">Normal</span>
            ) : drawdown < 0.2 ? (
              <span className="badge-amber">Caution</span>
            ) : (
              <span className="text-[var(--error)] bg-[var(--error-muted)] px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider">Alert</span>
            )}
          </span>
        </div>
      </div>

      {/* Add Bet Form */}
      {showForm && (
        <div className="glass-panel p-6 space-y-5 rounded-none border border-[var(--border)] relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1.5 h-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]" />
          <h3 className="text-lg font-bold tracking-tight" style={{ color: "var(--text-1)" }}>Add Bet</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            <div>
              <label htmlFor="bet-date" className="form-label">Date</label>
              <input id="bet-date" type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)}
                className="form-input text-xs" />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label htmlFor="bet-match" className="form-label">Match</label>
              <input id="bet-match" type="text" placeholder="e.g. Arsenal v Chelsea" value={formMatch}
                onChange={(e) => setFormMatch(e.target.value)}
                className="form-input text-xs" />
            </div>
            <div>
              <label htmlFor="bet-market" className="form-label">Market</label>
              <select id="bet-market" value={formMarket} onChange={(e) => setFormMarket(e.target.value)}
                className="form-select text-xs">
                {MARKET_TYPES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="bet-selection" className="form-label">Selection</label>
              <input id="bet-selection" type="text" placeholder="e.g. Over 2.5" value={formSelection}
                onChange={(e) => setFormSelection(e.target.value)}
                className="form-input text-xs" />
            </div>
            <div>
              <label htmlFor="bet-odds" className="form-label">Odds</label>
              <input id="bet-odds" type="number" step="0.01" min="1" value={formOdds}
                onChange={(e) => setFormOdds(e.target.value)}
                className="form-input text-xs font-mono" />
            </div>
            <div>
              <label htmlFor="bet-stake" className="form-label">Stake (£)</label>
              <input id="bet-stake" type="number" step="0.50" min="0" value={formStake}
                onChange={(e) => setFormStake(e.target.value)}
                className="form-input text-xs font-mono" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="stat-label">Result:</label>
            {(["pending", "win", "loss", "void"] as const).map((r) => (
              <button key={r} onClick={() => setFormResult(r)}
                className={`px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors ${formResult === r
                    ? r === "win" ? "bg-[var(--success)]/20 text-[var(--success)] ring-1 ring-emerald-500/30"
                      : r === "loss" ? "bg-[var(--error-muted)] text-[var(--error)] ring-1 ring-red-500/30"
                        : r === "void" ? "bg-[var(--surface)] text-[var(--text-2)] ring-1 ring-slate-600/30"
                          : ""
                    : ""
                  }`}
                style={
                  formResult === r && r === "pending"
                    ? { background: "var(--accent-muted)", color: "var(--accent-text)", border: "1px solid var(--accent-border)" }
                    : formResult !== r
                      ? { color: "var(--text-3)" }
                      : undefined
                }
              >
                {r}
              </button>
            ))}
            <button onClick={addBet}
              className="ml-auto px-4 py-1.5 text-[var(--bg)] rounded-none text-xs font-medium transition-colors"
              style={{ background: "var(--accent)" }}>
              Save Bet
            </button>
          </div>
        </div>
      )}

      {/* PnL Chart */}
      {trajectory.length > 1 && (
        <div className="glass-panel p-6 rounded-none border border-[var(--border)] relative overflow-hidden">          <h3 className="text-lg font-bold mb-6 tracking-tight relative z-10" style={{ color: "var(--text-1)" }}>Bankroll Trajectory</h3>
          <div className="relative z-10"><PnLChart data={trajectory} initialBankroll={initialBankroll} /></div>
        </div>
      )}

      {/* Market Breakdown */}
      {Object.keys(markets).length > 0 && (
        <div className="glass-panel p-6 rounded-none border border-[var(--border)] relative overflow-hidden">
          <h3 className="text-lg font-bold mb-6 tracking-tight" style={{ color: "var(--text-1)" }}>Performance by Market</h3>
          <div className="space-y-2">
            {Object.entries(markets)
              .sort(([, a], [, b]) => b.pnl - a.pnl)
              .map(([market, stats]) => (
                <div key={market} className="flex items-center justify-between glass-inset px-3 py-2 text-xs">
                  <span className="font-medium" style={{ color: "var(--text-1)" }}>{market}</span>
                  <div className="flex items-center gap-4 font-mono">
                    <span style={{ color: "var(--text-3)" }}>{stats.wins}W {stats.losses}L</span>
                    <span style={{ color: "var(--text-3)" }}>
                      {((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0)}%
                    </span>
                    <span className={stats.pnl >= 0 ? "text-[var(--success)]" : "text-[var(--error)]"}>
                      {stats.pnl >= 0 ? "+" : ""}£{stats.pnl.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Bet History */}
      {bets.length > 0 ? (
        <div className="glass-panel overflow-x-auto rounded-none border border-[var(--border)]">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Match</th>
                <th scope="col" className="hidden sm:table-cell">Market</th>
                <th scope="col">Selection</th>
                <th scope="col">Odds</th>
                <th scope="col">Stake</th>
                <th scope="col">P&L</th>
                <th scope="col">Result</th>
                <th scope="col" className="w-8"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {[...bets].reverse().map((bet) => {
                const pnl = bet.result === "win"
                  ? bet.stake * (bet.decimalOdds - 1)
                  : bet.result === "loss"
                    ? -bet.stake
                    : 0;
                return (
                  <tr key={bet.id}>
                    <td>{bet.date}</td>
                    <td style={{ color: "var(--text-1)" }}>{bet.match}</td>
                    <td className="hidden sm:table-cell">{bet.market}</td>
                    <td style={{ color: "var(--text-1)" }}>{bet.selection}</td>
                    <td className="font-mono" style={{ color: "var(--text-1)" }}>{bet.decimalOdds.toFixed(2)}</td>
                    <td className="font-mono" style={{ color: "var(--text-1)" }}>£{bet.stake.toFixed(2)}</td>
                    <td className={`font-mono ${pnl > 0 ? "text-[var(--success)]" : pnl < 0 ? "text-[var(--error)]" : ""}`}
                      style={pnl === 0 ? { color: "var(--text-3)" } : undefined}>
                      {bet.result === "pending" ? "—" : `${pnl >= 0 ? "+" : ""}£${pnl.toFixed(2)}`}
                    </td>
                    <td>
                      <select
                        value={bet.result}
                        onChange={(e) => updateResult(bet.id, e.target.value as BetRecord["result"])}
                        aria-label={`Result for ${bet.match}`}
                        className={`bg-transparent border-none text-[10px] font-semibold uppercase ${bet.result === "win" ? "text-[var(--success)]"
                            : bet.result === "loss" ? "text-[var(--error)]"
                              : bet.result === "void" ? "text-[var(--text-3)]"
                                : "text-green-400"
                          }`}
                      >
                        <option value="pending">PEND</option>
                        <option value="win">WIN</option>
                        <option value="loss">LOSS</option>
                        <option value="void">VOID</option>
                      </select>
                    </td>
                    <td>
                      {confirmDeleteId === bet.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => removeBet(bet.id)}
                            className="text-[9px] font-semibold uppercase text-[var(--error)] hover:text-[var(--error)] transition-colors"
                            aria-label="Confirm delete"
                          >
                            Yes
                          </button>
                          <span style={{ color: "var(--text-4)" }}>/</span>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-[9px] font-semibold uppercase transition-colors"
                            style={{ color: "var(--text-3)" }}
                            aria-label="Cancel delete"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(bet.id)}
                          className="transition-colors hover:text-[var(--error)]"
                          style={{ color: "var(--text-4)" }}
                          aria-label="Remove bet"
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card p-8 text-center">
          <div className="text-sm" style={{ color: "var(--text-3)" }}>No bets recorded yet.</div>
          <div className="text-xs mt-1" style={{ color: "var(--text-4)" }}>Start tracking your bets to see P&L analysis and bankroll trajectory.</div>
          <button
            onClick={() => setShowForm(true)}
            className="mt-4 px-4 py-2 text-xs text-[var(--bg)] rounded-none transition-colors font-medium"
            style={{ background: "var(--accent)" }}
          >
            + Add Your First Bet
          </button>
        </div>
      )}

      <div className="glow-line" />

      {/* Kelly Calculator */}
      <div className="glass-panel p-6 space-y-5 rounded-none border border-[var(--border)] relative overflow-hidden mt-8">        <h3 className="text-lg font-bold tracking-tight relative z-10" style={{ color: "var(--text-1)" }}>Kelly Calculator</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="kelly-prob" className="form-label">Model Probability</label>
            <input
              id="kelly-prob" type="number" step="0.01" min="0" max="1" value={calcProb}
              onChange={(e) => setCalcProb(e.target.value)}
              className="form-input font-mono"
            />
          </div>
          <div>
            <label htmlFor="kelly-odds" className="form-label">Decimal Odds</label>
            <input
              id="kelly-odds" type="number" step="0.01" min="1" value={calcOdds}
              onChange={(e) => setCalcOdds(e.target.value)}
              className="form-input font-mono"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => setKellyResult(kellyFraction(parseFloat(calcProb), parseFloat(calcOdds)))}
              className="w-full text-[var(--bg)] rounded-none px-4 py-2 text-sm font-medium transition-colors"
              style={{ background: "var(--accent)" }}
            >
              Calculate
            </button>
          </div>
        </div>

        {kellyResult && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 pt-2">
            <div className="glass-inset p-3">
              <div className="stat-label">Full Kelly</div>
              <div className="text-lg font-bold" style={{ color: "var(--text-1)" }}>{pct(kellyResult.full_kelly)}</div>
            </div>
            <div className="glass-inset p-3">
              <div className="stat-label">Half Kelly</div>
              <div className="text-lg font-bold" style={{ color: "var(--info)" }}>{pct(kellyResult.half_kelly)}</div>
            </div>
            <div className="glass-inset p-3">
              <div className="stat-label">Quarter Kelly</div>
              <div className="text-lg font-bold" style={{ color: "var(--text-3)" }}>{pct(kellyResult.quarter_kelly)}</div>
            </div>
            <div className="glass-inset p-3">
              <div className="stat-label">Edge</div>
              <div className={`text-lg font-bold ${kellyResult.edge > 0 ? "text-[var(--success)]" : "text-[var(--error)]"}`}>
                {kellyResult.edge > 0 ? "+" : ""}{pct(kellyResult.edge)}
              </div>
            </div>
            <div className="glass-inset p-3">
              <div className="stat-label">EV</div>
              <div className={`text-lg font-bold ${kellyResult.ev > 0 ? "text-[var(--success)]" : "text-[var(--error)]"}`}>
                {kellyResult.ev > 0 ? "+" : ""}{kellyResult.ev.toFixed(3)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function BankrollPage() {
  return (
    <ErrorBoundary pageName="Bankroll">
      <BankrollContent />
    </ErrorBoundary>
  );
}
