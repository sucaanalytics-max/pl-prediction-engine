/**
 * The agent's message feed: everything it has to say, in one place.
 *
 * There is no email. This page is the only channel the agent has, which changes
 * what the loader owes the reader. With a second channel, a parse failure here
 * was an inconvenience; now it is the difference between being told and not.
 *
 * So nothing is silently dropped. A malformed message is surfaced as a
 * malformed message rather than filtered out of the list, because a feed that
 * quietly shrinks is indistinguishable from a quiet agent — and those need very
 * different responses from whoever is reading.
 *
 * Mirrors the Python contract in `pipeline/learning/messages.py`. The feed
 * served here is the published copy: no entry ids, no counterfactuals.
 */

export type MessageKind = "decision" | "status" | "warning" | "result";
export type MessageSeverity = "info" | "warning" | "critical";

export interface AgentMessage {
  id: string;
  gameweek: number;
  kind: MessageKind;
  severity: MessageSeverity;
  title: string;
  body: string;
  createdAt: string;
  detail?: Record<string, unknown>;
  /** Set when the record could not be parsed. Rendered, never hidden. */
  malformed?: boolean;
}

export interface MessageFeed {
  messages: AgentMessage[];
  generatedAt: string | null;
  /** Records that failed to parse. Counted so the page can say so. */
  malformedCount: number;
}

const KINDS: MessageKind[] = ["decision", "status", "warning", "result"];
const SEVERITIES: MessageSeverity[] = ["info", "warning", "critical"];

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Parse one record.
 *
 * An unrecognised kind or severity is coerced to the safest option rather than
 * rejected: the message text is the payload, and losing it because a future
 * agent version added a new tag would be a worse failure than showing it under
 * a generic heading.
 */
export function parseMessage(raw: unknown): AgentMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const id = asString(record.id);
  const title = asString(record.title);
  if (!id || !title) return null;

  const kind = KINDS.includes(record.kind as MessageKind)
    ? (record.kind as MessageKind)
    : "status";
  const severity = SEVERITIES.includes(record.severity as MessageSeverity)
    ? (record.severity as MessageSeverity)
    : "info";

  const gameweek =
    typeof record.gameweek === "number" && Number.isFinite(record.gameweek)
      ? record.gameweek
      : 0;

  return {
    id,
    gameweek,
    kind,
    severity,
    title,
    body: asString(record.body),
    createdAt: asString(record.created_at ?? record.createdAt),
    detail:
      record.detail && typeof record.detail === "object"
        ? (record.detail as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Parse the published feed.
 *
 * Unparseable records are counted and replaced with a visible placeholder
 * rather than discarded, so the page can tell the reader that something the
 * agent said could not be displayed. Silently shrinking the list would hide
 * exactly the message most likely to matter.
 */
export function parseFeed(raw: unknown): MessageFeed {
  const empty: MessageFeed = { messages: [], generatedAt: null, malformedCount: 0 };
  if (!raw || typeof raw !== "object") return empty;

  const record = raw as Record<string, unknown>;
  const list = Array.isArray(record.messages) ? record.messages : [];

  const messages: AgentMessage[] = [];
  let malformedCount = 0;

  list.forEach((entry, index) => {
    const parsed = parseMessage(entry);
    if (parsed) {
      messages.push(parsed);
      return;
    }
    malformedCount += 1;
    messages.push({
      id: `malformed-${index}`,
      gameweek: 0,
      kind: "status",
      severity: "warning",
      title: "A message could not be displayed",
      body:
        "The agent published something this page could not read. Check the raw " +
        "feed rather than assuming nothing was said.",
      createdAt: "",
      malformed: true,
    });
  });

  return {
    messages,
    generatedAt: asString(record.generated_at ?? record.generatedAt) || null,
    malformedCount,
  };
}

/** Newest first, with critical messages pulled to the top regardless of age. */
export function orderForReading(messages: AgentMessage[]): AgentMessage[] {
  const rank = (m: AgentMessage) => (m.severity === "critical" ? 0 : 1);
  return [...messages].sort((a, b) => {
    const bySeverity = rank(a) - rank(b);
    if (bySeverity !== 0) return bySeverity;
    if (a.gameweek !== b.gameweek) return b.gameweek - a.gameweek;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/**
 * Unread-style summary for the navigation badge.
 *
 * Counts what needs attention, not what exists: a feed of forty routine status
 * notes should not look like forty things to read.
 */
export function attentionCount(messages: AgentMessage[]): number {
  return messages.filter(
    (m) => m.severity === "critical" || m.severity === "warning",
  ).length;
}

export function groupByGameweek(
  messages: AgentMessage[],
): { gameweek: number; messages: AgentMessage[] }[] {
  const groups = new Map<number, AgentMessage[]>();
  for (const message of messages) {
    const bucket = groups.get(message.gameweek) ?? [];
    bucket.push(message);
    groups.set(message.gameweek, bucket);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([gameweek, entries]) => ({ gameweek, messages: entries }));
}
