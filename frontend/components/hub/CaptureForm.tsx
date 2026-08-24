"use client";

import { useMemo, useState } from "react";

import { INK, MONO, SANS } from "@/lib/margin/tokens";

/**
 * Record the squad actually submitted to FPL, so the agent plans from truth.
 *
 * ## Why typing a squad is the right shape for this
 *
 * The obvious design prefills from the agent's own last proposal and asks only
 * "did you submit this?". That is the better form, and it is not yet buildable:
 * no `decision_public_gw*.json` exists, because only the SEAL phase calls
 * `_decide_for_entries` and the first seal has not happened. Prefill lands once
 * there is something to prefill from.
 *
 * So: names, one per line. Fifteen dropdowns would be more clicks and more code
 * for the same fifteen facts, and a paste from anywhere is the fastest route in.
 *
 * ## Resolution is shown, never guessed
 *
 * Every line reports what it resolved to, or why it did not. An ambiguous surname
 * is an error rather than a first match — silently choosing one Silva over another
 * would put a player the owner does not own into the optimiser's starting position.
 */

export interface PickablePlayer {
  readonly elementId: number;
  readonly name: string;
  readonly team: string;
}

const SQUAD_SIZE = 15;
const S = INK;

/**
 * Fold a name so a keyboard can reach it.
 *
 * NFD plus stripping combining marks handles most of it — `ğ` decomposes to `g`
 * plus a breve, `é` to `e` plus an acute. It does NOT handle letters that are
 * their own codepoint rather than a base plus a mark, and football is full of
 * them: `ı` (U+0131, dotless i) never decomposes, so `Kadıoğlu` folded to
 * `kadıoglu` and `Kadioglu` could not reach it. Those need an explicit map.
 */
const INDIVISIBLE: Record<string, string> = {
  "\u0131": "i", // ı dotless i — Turkish
  "\u0130": "i", // İ dotted capital I
  "\u00f8": "o", // ø
  "\u0111": "d", // đ
  "\u0142": "l", // ł
  "\u00df": "ss", // ß
  "\u00e6": "ae", // æ
  "\u0153": "oe", // œ
  "\u00f0": "d", // ð
  "\u00fe": "th", // þ
};

export function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u0131\u0130\u00f8\u0111\u0142\u00df\u00e6\u0153\u00f0\u00fe]/g,
             (character) => INDIVISIBLE[character] ?? character)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

type Resolution =
  | { line: string; player: PickablePlayer }
  | { line: string; error: string };

function resolve(line: string, players: readonly PickablePlayer[]): Resolution {
  const trimmed = line.trim();
  if (!trimmed) return { line, error: "blank" };

  // A bare number is an element id, which is what the artifacts join on.
  if (/^\d+$/.test(trimmed)) {
    const byId = players.find((p) => p.elementId === Number(trimmed));
    return byId ? { line, player: byId } : { line, error: "no player with that id" };
  }

  const needle = fold(trimmed);
  const exact = players.filter((p) => fold(p.name) === needle);
  if (exact.length === 1) return { line, player: exact[0] };
  if (exact.length > 1) {
    return { line, error: `${exact.length} players share that exact name — use the id` };
  }

  const partial = players.filter((p) => fold(p.name).includes(needle));
  if (partial.length === 1) return { line, player: partial[0] };
  if (partial.length === 0) return { line, error: "no match" };
  return {
    line,
    error: `matches ${partial.length}: ${partial.slice(0, 3).map((p) => p.name).join(", ")}${
      partial.length > 3 ? "…" : ""
    }`,
  };
}

/** £m as typed to integer tenths, the unit EntryState uses. "3.5" -> 35. */
function tenths(value: string): number | null {
  const parsed = Number(value.trim().replace(/^£/, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const scaled = Math.round(parsed * 10);
  // Rejects 3.55 rather than rounding it: a tenth of a million is FPL's own
  // resolution, so a third decimal means the number was misread.
  return Math.abs(parsed * 10 - scaled) < 1e-9 ? scaled : null;
}

const field: React.CSSProperties = {
  background: S.inset,
  border: `1px solid ${S.hair}`,
  color: S.ink,
  font: `13px ${MONO}`,
  padding: "6px 8px",
  borderRadius: 0,
  width: "100%",
};

const label: React.CSSProperties = {
  font: `11px ${SANS}`,
  color: S.ink3,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  display: "block",
  marginBottom: 4,
};

export default function CaptureForm({
  players,
  entryId,
  gameweek,
}: {
  players: readonly PickablePlayer[];
  /**
   * The entry this capture is for. One number, not a chooser: this form used to
   * render a button per target from a three-team list, and the two it offered
   * were the entries nothing here decides for any more.
   */
  entryId: number;
  gameweek: number;
}) {
  const [week, setWeek] = useState(String(gameweek));
  const [text, setText] = useState("");
  const [bank, setBank] = useState("0.0");
  const [squadValue, setSquadValue] = useState("100.0");
  const [freeTransfers, setFreeTransfers] = useState("1");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<
    { ok: true; message: string } | { ok: false; message: string } | null
  >(null);

  const lines = useMemo(
    () => text.split("\n").filter((line) => line.trim().length > 0),
    [text]
  );
  const resolutions = useMemo(
    () => lines.map((line) => resolve(line, players)),
    [lines, players]
  );
  const resolved = resolutions.flatMap((r) => ("player" in r ? [r.player] : []));
  const duplicated = resolved.length !== new Set(resolved.map((p) => p.elementId)).size;

  const bankTenths = tenths(bank);
  const value = Number(squadValue);
  const ready =
    resolved.length === SQUAD_SIZE &&
    resolutions.length === SQUAD_SIZE &&
    !duplicated &&
    bankTenths !== null &&
    Number.isFinite(value) &&
    value >= 0 &&
    /^\d+$/.test(freeTransfers.trim()) &&
    /^\d+$/.test(week.trim());

  async function submit() {
    if (!ready) return;
    setPending(true);
    setOutcome(null);
    try {
      const response = await fetch("/api/hub/position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryId,
          gameweek: Number(week),
          squad: resolved.map((p) => p.elementId),
          bank: bankTenths,
          freeTransfers: Number(freeTransfers),
          squadValue: value,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOutcome({ ok: false, message: payload.error ?? `Refused (${response.status}).` });
      } else {
        const sha = typeof payload.commit === "string" ? payload.commit.slice(0, 7) : null;
        setOutcome({
          ok: true,
          // Quotes the commit rather than saying "Saved!". A capture is only real
          // once it is in the record, and the sha is the part that can be checked;
          // "saved" is a reassurance the screen has no way to back up.
          message:
            `${payload.recorded?.players ?? SQUAD_SIZE} players recorded for GW${
              payload.recorded?.gameweek ?? week
            }${sha ? ` in commit ${sha}` : ""}. The next agent run reads it — ` +
            `every half hour inside a deadline window. Prices were not supplied, so ` +
            `selling prices stay flagged as uncertain.`,
        });
      }
    } catch {
      setOutcome({ ok: false, message: "The request never reached the server. Nothing was recorded." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 18, maxWidth: 760 }}>
      {/* Stated, not chosen. There is one entry, so a selector would offer a
          decision that does not exist — and the id is worth printing because it
          is what the committed filename is keyed on. */}
      <p style={{ font: `12px ${MONO}`, color: S.ink2, margin: 0 }}>
        Capturing for entry {entryId} — the one team this repo decides for.
      </p>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(4, 1fr)" }}>
        <div>
          <label style={label} htmlFor="capture-gw">Gameweek</label>
          <input id="capture-gw" style={field} value={week}
                 onChange={(e) => setWeek(e.target.value)} inputMode="numeric" />
        </div>
        <div>
          <label style={label} htmlFor="capture-value">Squad value £m</label>
          <input id="capture-value" style={field} value={squadValue}
                 onChange={(e) => setSquadValue(e.target.value)} inputMode="decimal" />
        </div>
        <div>
          <label style={label} htmlFor="capture-bank">Bank £m</label>
          <input id="capture-bank" style={field} value={bank}
                 onChange={(e) => setBank(e.target.value)} inputMode="decimal" />
        </div>
        <div>
          <label style={label} htmlFor="capture-ft">Free transfers</label>
          <input id="capture-ft" style={field} value={freeTransfers}
                 onChange={(e) => setFreeTransfers(e.target.value)} inputMode="numeric" />
        </div>
      </div>

      <div>
        <label style={label} htmlFor="capture-squad">
          Squad — one player per line, name or element id
        </label>
        <textarea
          id="capture-squad"
          style={{ ...field, minHeight: 220, resize: "vertical" }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Raya\nSaliba\n328\n…"}
        />
        <p style={{ font: `11px ${SANS}`, color: S.ink3, marginTop: 6 }}>
          {resolutions.length} lines · {resolved.length} of {SQUAD_SIZE} resolved
          {duplicated ? " · a player appears twice" : ""}
        </p>
      </div>

      {resolutions.length > 0 && (
        <ol style={{ display: "grid", gap: 2, margin: 0, padding: 0, listStyle: "none" }}>
          {resolutions.map((r, index) => (
            <li
              key={`${r.line}-${index}`}
              style={{
                font: `12px ${MONO}`,
                display: "flex",
                gap: 10,
                padding: "3px 0",
                borderBottom: `1px solid ${S.hair}`,
                color: "player" in r ? S.ink : S.conflict,
              }}
            >
              <span style={{ color: S.ink3, width: 22, textAlign: "right" }}>{index + 1}</span>
              <span style={{ flex: 1 }}>{r.line}</span>
              <span style={{ color: "player" in r ? S.ink2 : S.conflict }}>
                {"player" in r
                  ? `${r.player.name} · ${r.player.team} · ${r.player.elementId}`
                  : r.error}
              </span>
            </li>
          ))}
        </ol>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          type="button"
          onClick={submit}
          disabled={!ready || pending}
          style={{
            ...field,
            width: "auto",
            cursor: ready && !pending ? "pointer" : "not-allowed",
            background: ready ? S.ink : S.inset,
            color: ready ? S.shell : S.ink4,
          }}
        >
          {pending ? "Recording…" : "Record this position"}
        </button>
        {!ready && (
          <span style={{ font: `11px ${SANS}`, color: S.ink3 }}>
            Needs {SQUAD_SIZE} resolved players and valid numbers.
          </span>
        )}
      </div>

      {outcome && (
        <p
          role="status"
          style={{
            font: `12px ${SANS}`,
            color: outcome.ok ? S.agree : S.conflict,
            border: `1px solid ${outcome.ok ? S.agree : S.conflict}`,
            padding: "8px 10px",
            margin: 0,
          }}
        >
          {outcome.message}
        </p>
      )}
    </div>
  );
}
