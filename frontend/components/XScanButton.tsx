"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Trigger the X scan, and say honestly what happened.
 *
 * ## What it actually does
 *
 * Asks `/api/x-scan` to dispatch a GitHub workflow. The scan needs a real browser —
 * a logged-out X profile is a JavaScript app shell, so `curl` gets no post text —
 * and it has to commit the result, because the committed inbox is what the
 * fifteen-minute poller reads. Neither belongs in a browser tab.
 *
 * ## Why it does not report "done"
 *
 * A dispatch returns 204 with no run id, and the scan takes about a minute: read
 * the profile, merge the inbox, file the claims, rebase, push. So this reports
 * "queued" and then polls the run's real state. Claiming success at dispatch time
 * would be claiming an outcome that has not happened — and a scan CAN fail, most
 * plausibly by X refusing the runner.
 *
 * The new posts appear on this page after the next deploy picks up the commit, not
 * immediately. The component says so rather than leaving a user refreshing.
 */

interface LastRun {
  readonly id: number;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly url: string | null;
}

interface ScanState {
  readonly configured: boolean;
  readonly reason?: string;
  readonly requiresSecret?: boolean;
  readonly cooldownMinutes?: number;
  readonly lastRun: LastRun | null;
}

/** Where the secret lives between visits. Never sent anywhere but our own route. */
const SECRET_KEY = "x-scan-secret";

function describeRun(run: LastRun | null): string {
  if (!run) return "No scan has run yet.";
  const when = run.started_at
    ? new Date(run.started_at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "an unknown time";
  if (run.status !== "completed") return `A scan is ${run.status ?? "running"} (started ${when}).`;
  // Name the failure rather than rounding it to "finished".
  return run.conclusion === "success"
    ? `Last scan succeeded at ${when}.`
    : `Last scan ${run.conclusion ?? "did not succeed"} at ${when}.`;
}

export default function XScanButton() {
  const [state, setState] = useState<ScanState | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/x-scan", { cache: "no-store" });
      setState((await response.json()) as ScanState);
    } catch {
      // A status read failing is not worth an error banner; the button simply
      // stays in its last known state.
      setState(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    try {
      const saved = window.localStorage.getItem(SECRET_KEY);
      if (saved) setSecret(saved);
    } catch {
      // Private browsing denies localStorage. The field just starts empty.
    }
  }, [refresh]);

  const trigger = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    setMessage(null);
    try {
      const response = await fetch("/api/x-scan", {
        method: "POST",
        headers: { "x-scan-secret": secret },
      });
      const body = (await response.json()) as { ok?: boolean; reason?: string };
      if (response.ok && body.ok) {
        setMessage(
          "Scan queued. It takes about a minute; new posts appear here once the " +
            "commit deploys.",
        );
        try {
          window.localStorage.setItem(SECRET_KEY, secret);
        } catch {
          // Not fatal — the secret just will not be remembered.
        }
        // Give GitHub a moment to create the run, then show its real state.
        window.setTimeout(() => void refresh(), 4000);
      } else {
        setFailed(true);
        setMessage(body.reason ?? `The trigger failed (${response.status}).`);
      }
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "The trigger failed.");
    } finally {
      setBusy(false);
    }
  }, [secret, refresh]);

  // Not configured is a state with its own answer, not a disabled button with no
  // explanation. It is also the normal state of a local dev server.
  if (state && !state.configured) {
    return (
      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        {state.reason}
      </p>
    );
  }

  const needsSecret = state?.requiresSecret !== false;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {needsSecret ? (
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder="scan secret"
            aria-label="Scan trigger secret"
            className="rounded border px-2 py-1 text-xs"
            style={{
              background: "var(--surface, #0f172a)",
              borderColor: "var(--border, #334155)",
              color: "var(--text-1)",
            }}
          />
        ) : null}
        <button
          type="button"
          onClick={() => void trigger()}
          disabled={busy || (needsSecret && !secret)}
          className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
          style={{
            // The hardcoded fallback was already a blue, which is what this role
            // wanted all along; `--brand` is that hue as a token.
            background: "var(--brand, #2563eb)",
            color: "var(--bg)",
          }}
        >
          {busy ? "Queueing…" : "Scan X now"}
        </button>
        <span className="text-xs" style={{ color: "var(--text-3)" }}>
          {describeRun(state?.lastRun ?? null)}
        </span>
      </div>

      {message ? (
        <p
          className="text-xs"
          role={failed ? "alert" : "status"}
          style={{ color: failed ? "var(--error)" : "var(--text-3)" }}
        >
          {message}
        </p>
      ) : null}

      {state?.lastRun?.url ? (
        <a
          className="text-xs underline"
          href={state.lastRun.url}
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--text-3)" }}
        >
          View the run log
        </a>
      ) : null}
    </div>
  );
}
