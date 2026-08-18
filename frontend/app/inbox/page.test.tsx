/**
 * A quiet channel is not a broken one.
 *
 * The agent writes `messages.json` only when it has something to say, so the
 * file is absent for roughly ten days of every fourteen-day cycle. This page
 * used to `throw` on a non-ok response, which put "feed unavailable (404)" in a
 * red error box beside copy insisting the channel had failed — telling the
 * reader the agent was broken when it was merely idle.
 *
 * That is the absent-versus-unreadable conflation `lib/data/load.ts` documents
 * at length, and this page already had correctly-worded empty-state copy
 * sitting unused one branch away. These tests pin the routing: 404 to empty,
 * everything else still to the error box.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import InboxPage from "@/app/inbox/page";

function respondWith(init: { status: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: init.status >= 200 && init.status < 300,
      status: init.status,
      json: async () => init.body ?? {},
    }),
  );
}

describe("the agent inbox when the agent is quiet", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => cleanup());

  it("treats a 404 as nothing-published, not as a failure", async () => {
    respondWith({ status: 404 });
    render(<InboxPage />);
    await waitFor(() => {
      expect(screen.getByText(/Nothing published yet/i)).toBeTruthy();
    });
    // The distinction the empty copy draws must be the one on screen.
    expect(screen.queryByText(/feed unavailable/i)).toBeNull();
  });

  it("still reports a real upstream failure", async () => {
    respondWith({ status: 500 });
    render(<InboxPage />);
    await waitFor(() => {
      expect(screen.getByText(/feed unavailable \(500\)/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Nothing published yet/i)).toBeNull();
  });

  it("renders a published message when there is one", async () => {
    respondWith({
      status: 200,
      body: {
        messages: [
          {
            id: "m1",
            gameweek: 1,
            severity: "info",
            title: "Sealed GW1",
            body: "The forecast was sealed before the deadline.",
            created_at: "2026-08-21T16:00:00Z",
          },
        ],
      },
    });
    render(<InboxPage />);
    await waitFor(() => {
      expect(screen.getByText(/Sealed GW1/i)).toBeTruthy();
    });
  });
});
