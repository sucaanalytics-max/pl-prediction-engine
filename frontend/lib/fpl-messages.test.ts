import { describe, expect, it } from "vitest";
import {
  attentionCount,
  groupByGameweek,
  orderForReading,
  parseFeed,
  parseMessage,
  type AgentMessage,
} from "./fpl-messages";

const base = {
  id: "gw7-decision-season",
  gameweek: 7,
  kind: "decision",
  severity: "info",
  title: "GW7 ready",
  body: "1 transfer",
  created_at: "2026-10-01T09:00:00Z",
};

describe("parseMessage", () => {
  it("parses a well-formed record", () => {
    const message = parseMessage(base);
    expect(message?.id).toBe("gw7-decision-season");
    expect(message?.kind).toBe("decision");
  });

  it("rejects a record with no id or title, which cannot be rendered", () => {
    expect(parseMessage({ ...base, id: "" })).toBeNull();
    expect(parseMessage({ ...base, title: "" })).toBeNull();
    expect(parseMessage(null)).toBeNull();
  });

  it("coerces an unknown kind rather than dropping the message", () => {
    // A future agent version adding a tag must not cost the reader the text.
    const message = parseMessage({ ...base, kind: "telegram" });
    expect(message?.kind).toBe("status");
    expect(message?.body).toBe("1 transfer");
  });

  it("coerces an unknown severity down to info, never up", () => {
    const message = parseMessage({ ...base, severity: "apocalyptic" });
    expect(message?.severity).toBe("info");
  });
});

describe("parseFeed", () => {
  it("surfaces an unreadable record instead of silently dropping it", () => {
    // A feed that quietly shrinks is indistinguishable from a quiet agent, and
    // those need opposite responses from whoever is reading.
    const feed = parseFeed({ messages: [base, { nonsense: true }] });
    expect(feed.messages).toHaveLength(2);
    expect(feed.malformedCount).toBe(1);
    expect(feed.messages.some((m) => m.malformed)).toBe(true);
  });

  it("returns an empty feed for junk input rather than throwing", () => {
    expect(parseFeed(null).messages).toHaveLength(0);
    expect(parseFeed({}).messages).toHaveLength(0);
    expect(parseFeed({ messages: "nope" }).messages).toHaveLength(0);
  });
});

describe("orderForReading", () => {
  const make = (over: Partial<AgentMessage>): AgentMessage => ({
    id: Math.random().toString(),
    gameweek: 1,
    kind: "status",
    severity: "info",
    title: "t",
    body: "b",
    createdAt: "2026-08-01T00:00:00Z",
    ...over,
  });

  it("pins critical messages above newer routine ones", () => {
    // A gameweek that was never sealed is permanently unmeasurable. Burying it
    // under three weeks of status notes would be the page failing at its job.
    const ordered = orderForReading([
      make({ gameweek: 20, severity: "info", title: "recent" }),
      make({ gameweek: 3, severity: "critical", title: "never sealed" }),
    ]);
    expect(ordered[0].title).toBe("never sealed");
  });

  it("otherwise shows the newest gameweek first", () => {
    const ordered = orderForReading([
      make({ gameweek: 5, title: "older" }),
      make({ gameweek: 9, title: "newer" }),
    ]);
    expect(ordered[0].title).toBe("newer");
  });
});

describe("attentionCount", () => {
  it("counts only what needs attention, not everything present", () => {
    const messages = [
      { severity: "info" },
      { severity: "info" },
      { severity: "warning" },
      { severity: "critical" },
    ].map((m, i) => ({ ...m, id: `${i}`, gameweek: 1, kind: "status", title: "t", body: "b", createdAt: "" })) as AgentMessage[];
    expect(attentionCount(messages)).toBe(2);
  });
});

describe("groupByGameweek", () => {
  it("groups newest gameweek first", () => {
    const groups = groupByGameweek([
      { id: "a", gameweek: 3, kind: "status", severity: "info", title: "t", body: "", createdAt: "" },
      { id: "b", gameweek: 8, kind: "status", severity: "info", title: "t", body: "", createdAt: "" },
    ] as AgentMessage[]);
    expect(groups.map((g) => g.gameweek)).toEqual([8, 3]);
  });
});
