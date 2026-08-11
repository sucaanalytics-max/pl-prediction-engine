import {
  Activity,
  ArrowUpRight,
  CircleAlert,
  Goal,
  Handshake,
  Shield,
  Sparkles,
  Star,
} from "lucide-react";
import type { HistoricalMatchEvents } from "@/lib/predictions";

function PlayerValues({
  players,
  suffix = "",
}: {
  players: HistoricalMatchEvents["scorers"];
  suffix?: string;
}) {
  if (!players.length) return <span className="historical-empty">None recorded</span>;
  return (
    <div className="historical-player-values">
      {players.map((player) => (
        <span key={`${player.name}-${player.team}`}>
          <strong>{player.name}</strong>
          <small>
            {suffix
              ? `${player.value}${suffix}`
              : player.value > 1
                ? `×${player.value}`
                : player.team}
          </small>
        </span>
      ))}
    </div>
  );
}

export default function HistoricalMatchDetails({
  events,
  homeTeam,
  awayTeam,
  date,
}: {
  events: HistoricalMatchEvents | null;
  homeTeam: string;
  awayTeam: string;
  date: string;
}) {
  const transfermarktQuery = encodeURIComponent(`${homeTeam} ${awayTeam} ${date}`);

  if (!events) {
    return (
      <div className="historical-missing">
        <CircleAlert size={17} />
        <div>
          <strong>Detailed FPL match data is unavailable for this meeting.</strong>
          <span>The score remains verified in the head-to-head archive.</span>
        </div>
        <a
          href={`https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche?query=${transfermarktQuery}`}
          target="_blank"
          rel="noreferrer"
        >
          Check Transfermarkt <ArrowUpRight size={13} />
        </a>
      </div>
    );
  }

  const homeScorers = events.scorers.filter((player) => player.team === events.homeTeam);
  const awayScorers = events.scorers.filter((player) => player.team === events.awayTeam);
  const homeAssists = events.assists.filter((player) => player.team === events.homeTeam);
  const awayAssists = events.assists.filter((player) => player.team === events.awayTeam);

  return (
    <div className="historical-details">
      <div className="historical-score-events">
        <section>
          <span className="historical-team-name">{events.homeTeam}</span>
          <div><Goal size={14} /><strong>Scorers</strong></div>
          <PlayerValues players={homeScorers} />
          <div><Handshake size={14} /><strong>FPL assists</strong></div>
          <PlayerValues players={homeAssists} />
        </section>
        <div className="historical-final-score">
          <span>FT</span>
          <strong>{events.homeGoals}–{events.awayGoals}</strong>
          <small>Fixture #{events.fixtureId}</small>
        </div>
        <section className="away">
          <span className="historical-team-name">{events.awayTeam}</span>
          <div><Goal size={14} /><strong>Scorers</strong></div>
          <PlayerValues players={awayScorers} />
          <div><Handshake size={14} /><strong>FPL assists</strong></div>
          <PlayerValues players={awayAssists} />
        </section>
      </div>

      <div className="historical-stat-grid">
        <section>
          <div className="historical-stat-title"><Sparkles size={14} /> Top FPL returns</div>
          {events.topPerformers.slice(0, 3).map((player) => (
            <div className="historical-stat-row" key={player.name}>
              <span><strong>{player.name}</strong><small>{player.team} · {player.minutes}&apos;</small></span>
              <b>{player.points} pts</b>
            </div>
          ))}
        </section>
        <section>
          <div className="historical-stat-title"><Star size={14} /> Bonus / BPS</div>
          {events.bonus.slice(0, 3).map((player) => {
            const performer = events.topPerformers.find((item) => item.name === player.name);
            return (
              <div className="historical-stat-row" key={player.name}>
                <span><strong>{player.name}</strong><small>{player.team}</small></span>
                <b>{player.value} bonus{performer ? ` · ${performer.bps} BPS` : ""}</b>
              </div>
            );
          })}
        </section>
        <section>
          <div className="historical-stat-title"><Activity size={14} /> xG / xA leaders</div>
          {events.xgLeaders.slice(0, 2).map((player) => (
            <div className="historical-stat-row" key={`xg-${player.name}`}>
              <span><strong>{player.name}</strong><small>{player.team}</small></span>
              <b>{player.value.toFixed(2)} xG</b>
            </div>
          ))}
          {events.xaLeaders.slice(0, 1).map((player) => (
            <div className="historical-stat-row" key={`xa-${player.name}`}>
              <span><strong>{player.name}</strong><small>{player.team}</small></span>
              <b>{player.value.toFixed(2)} xA</b>
            </div>
          ))}
        </section>
        <section>
          <div className="historical-stat-title"><Shield size={14} /> Discipline & goalkeeping</div>
          <PlayerValues players={events.saves.slice(0, 2)} suffix=" saves" />
          {events.yellowCards.length ? (
            <span className="historical-inline-stat">
              {events.yellowCards.length} yellow card{events.yellowCards.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {events.redCards.length ? (
            <span className="historical-inline-stat danger">
              {events.redCards.length} red card{events.redCards.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </section>
      </div>

      {(events.ownGoals.length ||
        events.penaltiesMissed.length ||
        events.penaltiesSaved.length) ? (
        <div className="historical-exceptions">
          {events.ownGoals.length ? <span>Own goals: {events.ownGoals.map((item) => item.name).join(", ")}</span> : null}
          {events.penaltiesMissed.length ? <span>Penalties missed: {events.penaltiesMissed.map((item) => item.name).join(", ")}</span> : null}
          {events.penaltiesSaved.length ? <span>Penalties saved: {events.penaltiesSaved.map((item) => item.name).join(", ")}</span> : null}
        </div>
      ) : null}

      <footer className="historical-source">
        <div>
          <strong>{events.source.label}</strong>
          <span>FPL assists may differ from league assists; event minutes are not present in this archive.</span>
        </div>
        <a href={events.source.url} target="_blank" rel="noreferrer">
          Source data <ArrowUpRight size={12} />
        </a>
        <a
          href={`https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche?query=${transfermarktQuery}`}
          target="_blank"
          rel="noreferrer"
        >
          Transfermarkt cross-check <ArrowUpRight size={12} />
        </a>
      </footer>
    </div>
  );
}
