"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
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
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="font-display text-2xl font-bold text-white tracking-tight">
            Bankroll Tracker
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Performance tracking · Kelly calculator · Risk management
          </p>
        </div>
        <div className="flex gap-2">
          {bets.length > 0 && (
            <button
              onClick={exportCSV}
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-700/50 rounded-lg transition-colors"
            >
              Export CSV
            </button>
          )}
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-3 py-1.5 text-xs text-white bg-pitch-600 hover:bg-pitch-500 rounded-lg transition-colors font-medium"
          >
            {showForm ? "Cancel" : "+ Add Bet"}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="card p-4">
          <div className="stat-label">Current Value</div>
          <div className="stat-value text-white">£{currentValue.toFixed(0)}</div>
        </div>
        <div className="card p-4">
          <div className="stat-label">ROI</div>
          <div className={`stat-value ${roi >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Drawdown</div>
          <div className={`stat-value ${drawdown > 0.2 ? "text-red-400" : drawdown > 0.1 ? "text-amber-400" : "text-emerald-400"}`}>
            {pct(drawdown)}
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Win Rate</div>
          <div className="stat-value text-sky-400">{settledBets.length > 0 ? pct(winRate) : "—"}</div>
        </div>
        <div className="card p-4 cursor-pointer" onClick={() => { setEditingBankroll(true); setNewBankroll(initialBankroll.toString()); }}>
          <div className="stat-label">Starting</div>
          {editingBankroll ? (
            <div className="flex gap-1">
              <input
                type="number"
                value={newBankroll}
                onChange={(e) => setNewBankroll(e.target.value)}
                className="w-16 bg-slate-700 rounded px-1 text-sm text-white font-mono"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && saveBankroll()}
                onBlur={saveBankroll}
                aria-label="Starting bankroll amount"
              />
            </div>
          ) : (
            <div className="stat-value text-slate-400">£{initialBankroll}</div>
          )}
        </div>
      </div>

      {/* Drawdown limits */}
      <div className="card p-4">
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <span className="text-slate-500">Risk limits:</span>
          <span className={drawdown > 0.2 ? "text-red-400 font-semibold" : "text-slate-400"}>
            Soft stop: 20%
          </span>
          <span className={drawdown > 0.3 ? "text-red-400 font-semibold" : "text-slate-400"}>
            Hard stop: 30%
          </span>
          <span className="ml-auto">
            {drawdown < 0.1 ? (
              <span className="badge-green">Normal</span>
            ) : drawdown < 0.2 ? (
              <span className="badge-amber">Caution</span>
            ) : (
              <span className="text-red-400 bg-red-500/10 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider">Alert</span>
            )}
          </span>
        </div>
      </div>

      {/* Add Bet Form */}
      {showForm && (
        <div className="card p-6 space-y-4">
          <h3 className="text-sm font-display font-semibold text-white">Add Bet</h3>
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
                className={`px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  formResult === r
                    ? r === "win" ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30"
                    : r === "loss" ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/30"
                    : r === "void" ? "bg-slate-700/50 text-slate-300 ring-1 ring-slate-600/30"
                    : "bg-pitch-600/30 text-pitch-400 ring-1 ring-pitch-500/30"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {r}
              </button>
            ))}
            <button onClick={addBet}
              className="ml-auto px-4 py-1.5 bg-pitch-600 hover:bg-pitch-500 text-white rounded-lg text-xs font-medium transition-colors">
              Save Bet
            </button>
          </div>
        </div>
      )}

      {/* PnL Chart */}
      {trajectory.length > 1 && (
        <div className="card p-6">
          <h3 className="text-sm font-display font-semibold text-white mb-4">Bankroll Trajectory</h3>
          <PnLChart data={trajectory} initialBankroll={initialBankroll} />
        </div>
      )}

      {/* Market Breakdown */}
      {Object.keys(markets).length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-display font-semibold text-white mb-4">Performance by Market</h3>
          <div className="space-y-2">
            {Object.entries(markets)
              .sort(([, a], [, b]) => b.pnl - a.pnl)
              .map(([market, stats]) => (
                <div key={market} className="flex items-center justify-between bg-slate-800/30 rounded-lg px-3 py-2 text-xs">
                  <span className="text-white font-medium">{market}</span>
                  <div className="flex items-center gap-4 font-mono">
                    <span className="text-slate-400">{stats.wins}W {stats.losses}L</span>
                    <span className="text-slate-400">
                      {((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0)}%
                    </span>
                    <span className={stats.pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
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
        <div className="card overflow-x-auto">
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
                  <tr key={bet.id} className="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors">
                    <td className="px-4 py-2 text-slate-400">{bet.date}</td>
                    <td className="px-4 py-2 text-white">{bet.match}</td>
                    <td className="px-4 py-2 text-slate-400 hidden sm:table-cell">{bet.market}</td>
                    <td className="px-4 py-2 text-white">{bet.selection}</td>
                    <td className="px-4 py-2 text-white font-mono">{bet.decimalOdds.toFixed(2)}</td>
                    <td className="px-4 py-2 text-white font-mono">£{bet.stake.toFixed(2)}</td>
                    <td className={`px-4 py-2 font-mono ${pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-red-400" : "text-slate-500"}`}>
                      {bet.result === "pending" ? "—" : `${pnl >= 0 ? "+" : ""}£${pnl.toFixed(2)}`}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={bet.result}
                        onChange={(e) => updateResult(bet.id, e.target.value as BetRecord["result"])}
                        aria-label={`Result for ${bet.match}`}
                        className={`bg-transparent border-none text-[10px] font-semibold uppercase ${
                          bet.result === "win" ? "text-emerald-400"
                          : bet.result === "loss" ? "text-red-400"
                          : bet.result === "void" ? "text-slate-400"
                          : "text-pitch-400"
                        }`}
                      >
                        <option value="pending">PEND</option>
                        <option value="win">WIN</option>
                        <option value="loss">LOSS</option>
                        <option value="void">VOID</option>
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      {confirmDeleteId === bet.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => removeBet(bet.id)}
                            className="text-[9px] font-semibold uppercase text-red-400 hover:text-red-300 transition-colors"
                            aria-label="Confirm delete"
                          >
                            Yes
                          </button>
                          <span className="text-slate-600">/</span>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-[9px] font-semibold uppercase text-slate-500 hover:text-slate-300 transition-colors"
                            aria-label="Cancel delete"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(bet.id)}
                          className="text-slate-600 hover:text-red-400 transition-colors"
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
          <div className="text-slate-500 text-sm">No bets recorded yet.</div>
          <div className="text-slate-600 text-xs mt-1">Start tracking your bets to see P&L analysis and bankroll trajectory.</div>
          <button
            onClick={() => setShowForm(true)}
            className="mt-4 px-4 py-2 text-xs text-white bg-pitch-600 hover:bg-pitch-500 rounded-lg transition-colors font-medium"
          >
            + Add Your First Bet
          </button>
        </div>
      )}

      <div className="glow-line" />

      {/* Kelly Calculator */}
      <div className="card p-6 space-y-4">
        <h3 className="text-sm font-display font-semibold text-white">Kelly Calculator</h3>
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
              className="w-full bg-pitch-600 hover:bg-pitch-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            >
              Calculate
            </button>
          </div>
        </div>

        {kellyResult && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 pt-2">
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="stat-label">Full Kelly</div>
              <div className="text-lg font-display font-bold text-white">{pct(kellyResult.full_kelly)}</div>
            </div>
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="stat-label">Half Kelly</div>
              <div className="text-lg font-display font-bold text-sky-400">{pct(kellyResult.half_kelly)}</div>
            </div>
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="stat-label">Quarter Kelly</div>
              <div className="text-lg font-display font-bold text-slate-400">{pct(kellyResult.quarter_kelly)}</div>
            </div>
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="stat-label">Edge</div>
              <div className={`text-lg font-display font-bold ${kellyResult.edge > 0 ? "text-emerald-400" : "text-red-400"}`}>
                {kellyResult.edge > 0 ? "+" : ""}{pct(kellyResult.edge)}
              </div>
            </div>
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="stat-label">EV</div>
              <div className={`text-lg font-display font-bold ${kellyResult.ev > 0 ? "text-emerald-400" : "text-red-400"}`}>
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
