"use client";

import { useState } from "react";
import { pct } from "@/lib/formats";
import { kellyFraction, simulateBankroll, currentDrawdown, type KellyResult } from "@/lib/kelly";
import PnLChart from "@/components/PnLChart";

// Demo bankroll data — in production, this would be tracked per user
const DEMO_DATA = Array.from({ length: 28 }, (_, i) => {
  const gw = i + 1;
  const noise = Math.sin(gw * 0.8) * 15 + Math.random() * 10;
  const trend = gw * 1.2;
  const bankroll = Math.max(80, 100 + trend + noise);
  return {
    gameweek: gw,
    bankroll: Math.round(bankroll * 100) / 100,
    peak: 0,
  };
});

// Calculate running peak
let peak = 0;
for (const d of DEMO_DATA) {
  peak = Math.max(peak, d.bankroll);
  d.peak = peak;
}

export default function BankrollPage() {
  const [bankroll] = useState(100);
  const [calcProb, setCalcProb] = useState("0.55");
  const [calcOdds, setCalcOdds] = useState("2.00");
  const [kellyResult, setKellyResult] = useState<KellyResult | null>(null);

  const handleCalc = () => {
    const result = kellyFraction(
      parseFloat(calcProb),
      parseFloat(calcOdds)
    );
    setKellyResult(result);
  };

  const currentBankrollValue = DEMO_DATA[DEMO_DATA.length - 1].bankroll;
  const drawdown = currentDrawdown(DEMO_DATA.map((d) => d.bankroll));
  const roi = ((currentBankrollValue - bankroll) / bankroll) * 100;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-white tracking-tight">
          Bankroll Tracker
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Performance tracking · Kelly calculator · Risk management
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card p-4">
          <div className="stat-label">Current Value</div>
          <div className="stat-value text-white">£{currentBankrollValue.toFixed(0)}</div>
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
          <div className="stat-label">Starting</div>
          <div className="stat-value text-slate-400">£{bankroll}</div>
        </div>
      </div>

      {/* Drawdown limits */}
      <div className="card p-4">
        <div className="flex items-center gap-4 text-xs">
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
              <span className="badge-red">Alert</span>
            )}
          </span>
        </div>
      </div>

      {/* PnL Chart */}
      <div className="card p-6">
        <h3 className="text-sm font-display font-semibold text-white mb-4">Bankroll Trajectory</h3>
        <PnLChart data={DEMO_DATA} initialBankroll={bankroll} />
      </div>

      <div className="glow-line" />

      {/* Kelly Calculator */}
      <div className="card p-6 space-y-4">
        <h3 className="text-sm font-display font-semibold text-white">Kelly Calculator</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="stat-label block mb-1.5">Model Probability</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={calcProb}
              onChange={(e) => setCalcProb(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:ring-1 focus:ring-pitch-500/50"
            />
          </div>
          <div>
            <label className="stat-label block mb-1.5">Decimal Odds</label>
            <input
              type="number"
              step="0.01"
              min="1"
              value={calcOdds}
              onChange={(e) => setCalcOdds(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:ring-1 focus:ring-pitch-500/50"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handleCalc}
              className="w-full bg-pitch-600 hover:bg-pitch-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            >
              Calculate
            </button>
          </div>
        </div>

        {kellyResult && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2">
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="stat-label">Full Kelly</div>
              <div className="text-lg font-display font-bold text-white">
                {pct(kellyResult.full_kelly)}
              </div>
            </div>
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="stat-label">Half Kelly</div>
              <div className="text-lg font-display font-bold text-sky-400">
                {pct(kellyResult.half_kelly)}
              </div>
            </div>
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="stat-label">Quarter Kelly</div>
              <div className="text-lg font-display font-bold text-slate-400">
                {pct(kellyResult.quarter_kelly)}
              </div>
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
    </div>
  );
}
