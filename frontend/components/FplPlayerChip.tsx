import { Crown, ShieldAlert } from "lucide-react";
import type { SquadPlayer } from "@/lib/fpl-portal";

const difficultyClass: Record<number, string> = {
  1: "fdr-1",
  2: "fdr-2",
  3: "fdr-3",
  4: "fdr-4",
  5: "fdr-5",
};

export function FplPlayerChip({ player }: { player: SquadPlayer }) {
  return (
    <div className={`pitch-player ${player.bench ? "pitch-player-bench" : ""}`}>
      <div className="relative">
        <div className="player-shirt" aria-hidden="true">
          <span>{player.team}</span>
        </div>
        {player.status === "captain" && (
          <span className="captain-mark" title="Current captain"><Crown size={10} /> C</span>
        )}
        {player.status === "vice" && <span className="vice-mark">V</span>}
        {player.status === "monitor" && <ShieldAlert className="player-alert" size={14} />}
      </div>
      <span className="player-name">{player.name}</span>
      <span className={`player-fixture ${difficultyClass[player.difficulty]}`}>
        {player.fixture}
      </span>
    </div>
  );
}
