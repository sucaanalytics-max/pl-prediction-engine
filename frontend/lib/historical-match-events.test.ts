import arsenalVilla from "../public/predictions/h2h-events/arsenal--astonvilla.json";
import archiveIndex from "../public/predictions/h2h-events/index.json";
import {
  findHistoricalMatchEvents,
  type HistoricalMatchEventsFile,
} from "./predictions";

describe("historical match events", () => {
  it("covers every meeting requested by the head-to-head archive", () => {
    expect(archiveIndex.coverage.matchedFixtures).toBe(
      archiveIndex.coverage.requestedFixtures
    );
    expect(archiveIndex.recordCount).toBe(1004);
    expect(archiveIndex.pairFiles).toBe(281);
  });

  it("matches aliased team names without reversing home and away", () => {
    const file = {
      schemaVersion: 1,
      generatedAt: "2026-07-28T00:00:00Z",
      caveats: [],
      records: {
        "2526|2025-12-30|manutd|spurs": {
          fixtureId: 1,
          season: "2526",
          date: "2025-12-30",
          kickoffTime: "2025-12-30T20:00:00Z",
          homeTeam: "Man Utd",
          awayTeam: "Spurs",
          homeGoals: 2,
          awayGoals: 0,
          scorers: [],
          assists: [],
          ownGoals: [],
          yellowCards: [],
          redCards: [],
          saves: [],
          penaltiesSaved: [],
          penaltiesMissed: [],
          bonus: [],
          xgLeaders: [],
          xaLeaders: [],
          topPerformers: [],
          source: { label: "Archive", url: "https://example.com", attribution: "Test" },
        },
      },
    } satisfies HistoricalMatchEventsFile;

    expect(
      findHistoricalMatchEvents(
        file,
        {
          date: "2025-12-30T00:00:00",
          season: "2526",
          home_team: "Man United",
          away_team: "Tottenham",
          home_goals: 2,
          away_goals: 0,
        },
        "Man United",
        "Tottenham"
      )?.fixtureId
    ).toBe(1);
  });

  it("keeps scorer totals consistent with a known archived scoreline", () => {
    const file = arsenalVilla as HistoricalMatchEventsFile;
    const match = file.records["2324|2024-04-14|arsenal|astonvilla"];
    const scoredGoals =
      match.scorers.reduce((total, player) => total + player.value, 0) +
      match.ownGoals.reduce((total, player) => total + player.value, 0);

    expect(`${match.homeGoals}-${match.awayGoals}`).toBe("0-2");
    expect(scoredGoals).toBe(2);
    expect(match.assists.map((player) => player.name)).toEqual(
      expect.arrayContaining(["Youri Tielemans", "Lucas Digne"])
    );
  });
});
