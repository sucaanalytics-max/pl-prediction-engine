"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CircleAlert,
  Gauge,
  Layers3,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { useFplLive } from "@/lib/FplLiveContext";

export default function OptimizerPage() {
  const { state, loading } = useFplLive();
  const [horizon, setHorizon] = useState<4 | 6>(6);
  const [transferCount, setTransferCount] = useState<2 | 3>(2);
  const [freeTransfers, setFreeTransfers] = useState(1);
  const [risk, setRisk] = useState(35);

  const plans = useMemo(() => {
    const source =
      horizon === 4
        ? state?.recommendations?.multiTransferPlans4 ?? []
        : state?.recommendations?.multiTransferPlans6 ?? [];
    return source
      .filter((plan) => plan.transferCount === transferCount)
      .map((plan) => {
        const differentialScore =
          plan.moves.reduce(
            (total, move) => total + Math.max(0, 12 - move.playerIn.ownership),
            0
          ) / plan.moves.length;
        const gross = horizon === 4 ? plan.delta4 : plan.delta6;
        const hit =
          state?.event.phase === "preseason"
            ? 0
            : Math.max(0, plan.transferCount - freeTransfers) * 4;
        return {
          ...plan,
          hit,
          net: gross - hit,
          adjusted: gross - hit + differentialScore * (risk / 100) * 0.16,
        };
      })
      .sort((left, right) => right.adjusted - left.adjusted);
  }, [freeTransfers, horizon, risk, state, transferCount]);
  const best = plans[0];

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="portal-header">
        <div>
          <div className="eyebrow"><Layers3 size={13} /> Constraint-based squad search</div>
          <h1>Multi-transfer optimizer</h1>
          <p>
            Coordinate budget across two or three moves instead of judging isolated
            swaps. Every plan preserves positions, affordability and club limits.
          </p>
        </div>
        <div className="segmented">
          {[4, 6].map((value) => (
            <button key={value} className={horizon === value ? "active" : ""} onClick={() => setHorizon(value as 4 | 6)}>
              {value} GW
            </button>
          ))}
        </div>
      </header>

      <section className="optimizer-controls">
        <div>
          <span>Plan size</span>
          <div className="segmented">
            {[2, 3].map((value) => (
              <button key={value} className={transferCount === value ? "active" : ""} onClick={() => setTransferCount(value as 2 | 3)}>
                {value} transfers
              </button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="free-transfers">Free transfers</label>
          <select id="free-transfers" value={freeTransfers} onChange={(event) => setFreeTransfers(Number(event.target.value))}>
            {[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
          <small>{state?.event.phase === "preseason" ? "Unlimited preseason changes: no hit applied." : "Four points deducted for each extra move."}</small>
        </div>
        <div>
          <label htmlFor="optimizer-risk">Differential appetite <strong>{risk}</strong></label>
          <input id="optimizer-risk" type="range" min="0" max="100" value={risk} onChange={(event) => setRisk(Number(event.target.value))} />
          <small>Higher values reward useful low-owned arrivals.</small>
        </div>
      </section>

      {best ? (
        <section className="optimizer-best-plan">
          <div className="optimizer-best-copy">
            <span className="kicker"><Sparkles size={12} /> Best legal plan · {transferCount} moves</span>
            <h2>{best.moves.map((move) => move.playerIn.name).join(" + ")}</h2>
            <p>
              {best.net >= 0 ? "+" : ""}{best.net.toFixed(1)} net projected points over {horizon} gameweeks
              {best.hit ? ` after a ${best.hit}-point hit` : " with no transfer hit"}.
            </p>
            <div className="optimizer-move-strip">
              {best.moves.map((move) => (
                <div key={`${move.playerOut.elementId}-${move.playerIn.elementId}`}>
                  <span><ArrowDownLeft size={12} /> {move.playerOut.name}</span>
                  <ArrowRight size={14} />
                  <strong><ArrowUpRight size={12} /> {move.playerIn.name}</strong>
                </div>
              ))}
            </div>
          </div>
          <div className="optimizer-score">
            <span>Net uplift</span>
            <strong>{best.net >= 0 ? "+" : ""}{best.net.toFixed(1)}</strong>
            <small>{best.confidence}% confidence · £{best.bankAfter.toFixed(1)}m ITB</small>
          </div>
        </section>
      ) : (
        <section className="decision-card empty-recommendations">
          <Layers3 size={27} />
          <strong>{loading ? "Searching legal squad paths…" : "No positive plan found"}</strong>
          <p>Try another horizon or transfer count.</p>
        </section>
      )}

      <section className="decision-card">
        <div className="section-title-row">
          <div><span className="kicker">Alternative paths</span><h2>Ranked coordinated plans</h2></div>
          <span className="muted-meta">Net of configured hits</span>
        </div>
        <div className="optimizer-plan-list">
          {plans.map((plan, index) => (
            <article key={plan.moves.map((move) => move.playerIn.elementId).join("-")}>
              <span className="optimizer-rank">#{index + 1}</span>
              <div className="optimizer-plan-moves">
                {plan.moves.map((move) => (
                  <span key={move.playerOut.elementId}>
                    <del>{move.playerOut.name}</del>
                    <ArrowRight size={12} />
                    <strong>{move.playerIn.name}</strong>
                    <small>£{move.playerIn.price.toFixed(1)}m</small>
                  </span>
                ))}
              </div>
              <div className="optimizer-plan-metrics">
                <span>Gross <strong>+{(horizon === 4 ? plan.delta4 : plan.delta6).toFixed(1)}</strong></span>
                <span>Hit <strong>{plan.hit ? `-${plan.hit}` : "0"}</strong></span>
                <span>Bank <strong>£{plan.bankAfter.toFixed(1)}m</strong></span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="optimizer-guardrails">
        <div><ShieldCheck size={17} /><strong>Squad legality</strong><span>Same-position swaps and maximum three players per club.</span></div>
        <div><WalletCards size={17} /><strong>Budget continuity</strong><span>Sale value is released before the next purchase in the sequence.</span></div>
        <div><Gauge size={17} /><strong>Beam search</strong><span>High-upside and high-value candidates are explored across each step.</span></div>
        <div><CircleAlert size={17} /><strong>Red-team limit</strong><span>No price-rise prediction, wildcard assumption or invented free transfer.</span></div>
      </section>

      <p className="data-disclaimer">
        Plans use current listed prices, not your exact purchase-price sale values. Confirm
        actual selling prices in FPL before executing a sequence.
      </p>
    </div>
  );
}
