import {
  FPL_ENTRY_ID,
  asSquadPlayers,
  positionFromFpl,
  type FplLivePlayer,
} from "./fpl-live";

describe("FPL live helpers", () => {
  it("defaults to the portal owner's FPL entry", () => {
    expect(FPL_ENTRY_ID).toBe(20945);
  });

  it("accepts every official FPL position", () => {
    expect(["GKP", "DEF", "MID", "FWD"].map(positionFromFpl)).toEqual([
      "GKP",
      "DEF",
      "MID",
      "FWD",
    ]);
  });

  it("rejects an unknown position instead of silently corrupting formation", () => {
    expect(() => positionFromFpl("UNK")).toThrow("Unsupported FPL position");
  });

  it("maps live enriched players to pitch players", () => {
    const player: FplLivePlayer = {
      elementId: 25,
      pickPosition: 15,
      name: "Gyökeres",
      team: "ARS",
      position: "FWD",
      price: 7.5,
      ownership: 13.8,
      fixture: "COV (H)",
      difficulty: 1,
      fixtures: [
        {
          gameweek: 1,
          label: "COV (H)",
          difficulty: 1,
          kickoffTime: "2026-08-21T19:00:00Z",
        },
      ],
      status: undefined,
      bench: true,
      chanceOfPlaying: null,
      news: "",
    };

    expect(asSquadPlayers([player])).toEqual([
      {
        name: "Gyökeres",
        team: "ARS",
        position: "FWD",
        price: 7.5,
        fixture: "COV (H)",
        difficulty: 1,
        status: undefined,
        bench: true,
      },
    ]);
  });
});
