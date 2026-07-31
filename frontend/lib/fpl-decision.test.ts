import {
  classifyDecision,
  formatRemaining,
  msToDeadline,
  parseDecision,
  type Decision,
} from "./fpl-decision";

const DEADLINE = "2026-09-12T10:30:00Z";
const BEFORE = new Date("2026-09-12T06:30:00Z"); // T-4h
const AFTER = new Date("2026-09-12T12:00:00Z"); // T+1.5h

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    gameweek: 5,
    deadline: DEADLINE,
    generatedAt: "2026-09-12T06:00:00Z",
    teams: [
      {
        label: "season",
        captain: "Haaland",
        transfers: [{ out: "Smith", in: "Jones" }],
        projectedPoints: 61.2,
        status: "ok",
      },
    ],
    ...overrides,
  };
}

describe("decision freshness", () => {
  it("is ready before the deadline for the current gameweek", () => {
    const view = classifyDecision(decision(), 5, BEFORE);
    expect(view.freshness).toBe("ready");
    expect(view.reason).toContain("4h 0m");
  });

  it("is expired once the deadline has passed", () => {
    // The dangerous case: still parses, still looks authoritative, but acting
    // on it costs a gameweek.
    const view = classifyDecision(decision(), 5, AFTER);
    expect(view.freshness).toBe("expired");
    expect(view.reason).toContain("Do not act on this");
  });

  it("expiry beats a gameweek mismatch", () => {
    // Both wrong, but "the deadline has gone" is the more urgent thing to say.
    const view = classifyDecision(decision(), 6, AFTER);
    expect(view.freshness).toBe("expired");
  });

  it("is stale when published for a different gameweek", () => {
    // Detects the agent having failed to run, which comparing the artifact to
    // itself never could.
    const view = classifyDecision(decision({ gameweek: 4 }), 5, BEFORE);
    expect(view.freshness).toBe("stale");
    expect(view.reason).toContain("has not published");
  });

  it("is absent when nothing has been published", () => {
    const view = classifyDecision(null, 5, BEFORE);
    expect(view.freshness).toBe("absent");
    expect(view.decision).toBeNull();
  });

  it("does not claim staleness when the current gameweek is unknown", () => {
    const view = classifyDecision(decision(), null, BEFORE);
    expect(view.freshness).toBe("ready");
  });

  it("treats an unparseable deadline as not expired rather than guessing", () => {
    const view = classifyDecision(decision({ deadline: "not a date" }), 5, BEFORE);
    expect(view.freshness).toBe("ready");
    expect(view.msToDeadline).toBeNull();
  });
});

describe("countdown formatting", () => {
  it("reports days and hours when far out", () => {
    expect(formatRemaining(2 * 86400000 + 3 * 3600000)).toBe("2d 3h");
  });

  it("reports hours and minutes within a day", () => {
    expect(formatRemaining(3 * 3600000 + 20 * 60000)).toBe("3h 20m");
  });

  it("reports minutes in the last hour", () => {
    expect(formatRemaining(25 * 60000)).toBe("25m");
  });

  it("never reports negative time remaining", () => {
    expect(formatRemaining(-5000)).toBe("0m");
  });

  it("says unknown rather than inventing a number", () => {
    expect(formatRemaining(null)).toBe("unknown");
  });
});

describe("deadline arithmetic", () => {
  it("is positive before and negative after", () => {
    expect(msToDeadline(DEADLINE, BEFORE)).toBeGreaterThan(0);
    expect(msToDeadline(DEADLINE, AFTER)).toBeLessThan(0);
  });

  it("returns null for an unparseable deadline", () => {
    expect(msToDeadline("nonsense", BEFORE)).toBeNull();
  });
});

describe("parsing the published artifact", () => {
  it("maps the Python artifact's snake_case fields", () => {
    const parsed = parseDecision({
      gameweek: 7,
      deadline: DEADLINE,
      generated_at: "2026-09-12T06:00:00Z",
      teams: [
        {
          label: "weekly",
          captain: "Saka",
          vice_captain: "Palmer",
          projected_points: 58.9,
          projected_interval: "[40, 79]",
          status: "field_model_uncalibrated",
          transfers: [{ out: "A", in: "B", note: "-4 hit" }],
        },
      ],
    });
    expect(parsed?.gameweek).toBe(7);
    expect(parsed?.teams[0].viceCaptain).toBe("Palmer");
    expect(parsed?.teams[0].projectedPoints).toBe(58.9);
    expect(parsed?.teams[0].status).toBe("field_model_uncalibrated");
    expect(parsed?.teams[0].transfers?.[0].note).toBe("-4 hit");
  });

  it("returns null for a payload without a gameweek", () => {
    expect(parseDecision({ teams: [] })).toBeNull();
    expect(parseDecision(null)).toBeNull();
    expect(parseDecision("nope")).toBeNull();
  });

  it("treats a missing transfers list as an empty one, not undefined", () => {
    // "No transfers" is a real decision and must render as such.
    const parsed = parseDecision({ gameweek: 3, teams: [{ label: "season" }] });
    expect(parsed?.teams[0].transfers).toEqual([]);
  });
});
