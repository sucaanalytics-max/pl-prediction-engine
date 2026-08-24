/**
 * The capture form's resolution and unit handling.
 *
 * Two classes of bug matter here and neither is visual. A name resolved to the
 * WRONG player puts someone the owner does not own into the optimiser's starting
 * position, and a bank read in the wrong unit misprices every transfer. So most of
 * these tests are about refusing to guess.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import CaptureForm, { fold, type PickablePlayer } from "./CaptureForm";
import { OWNER_ENTRY } from "@/lib/entry";

const PLAYERS: PickablePlayer[] = [
  { elementId: 1, name: "David Raya", team: "Arsenal" },
  { elementId: 2, name: "William Saliba", team: "Arsenal" },
  { elementId: 3, name: "Bernardo Silva", team: "Man City" },
  { elementId: 4, name: "Rodrigo Silva", team: "Brighton" },
  { elementId: 5, name: "Dominik Szoboszlai", team: "Liverpool" },
  { elementId: 6, name: "Ferdi Kadıoğlu", team: "Brighton" },
  ...Array.from({ length: 12 }, (_, index) => ({
    elementId: 100 + index,
    name: `Filler ${index}`,
    team: "Everton",
  })),
];

function form() {
  return render(
    <CaptureForm players={PLAYERS} entryId={OWNER_ENTRY} gameweek={2} />,
  );
}

/** Fifteen resolvable lines, so validity is not the thing under test. */
function fifteen(): string {
  return [
    "David Raya",
    "William Saliba",
    "Szoboszlai",
    "Kadıoğlu",
    "Bernardo Silva",
    ...Array.from({ length: 10 }, (_, index) => `Filler ${index}`),
  ].join("\n");
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({
        status: "saved",
        capturedAt: "2026-08-25T09:00:00.000Z",
        commit: "abc1234def5678",
        recorded: { entryId: OWNER_ENTRY, gameweek: 2, players: 15, pricesSupplied: 0 },
      }),
      { status: 201 }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("fold", () => {
  it("strips combining marks", () => {
    expect(fold("Ødegaard")).toBe("odegaard");
    expect(fold("Martínez")).toBe("martinez");
    expect(fold("Højbjerg")).toBe("hojbjerg");
  });

  it("maps letters that are their own codepoint and never decompose", () => {
    // The case that broke first: NFD leaves ı alone, because it is a distinct
    // letter rather than i plus a mark.
    expect(fold("Kadıoğlu")).toBe("kadioglu");
    expect(fold("Szczęsny")).toBe("szczesny");
    expect(fold("Wőber")).toBe("wober");
  });

  it("is idempotent, so an already-folded name still matches", () => {
    expect(fold(fold("Kadıoğlu"))).toBe(fold("Kadıoğlu"));
  });
});

describe("who is being captured", () => {
  it("names the owner's own entry, and offers no other", () => {
    // Inverted when this shipped: the form filtered the deleted control room's
    // three-team list to `kind === "bot"`, so the only two ids it offered were
    // the entries that had moved to another project, and the one entry
    // `_read_entry` opens a capture file for could not be selected at all.
    form();
    expect(screen.getByText(new RegExp(String(OWNER_ENTRY)))).toBeTruthy();
    expect(screen.queryByText(/2561567|2561099/)).toBeNull();
  });
});

describe("resolution refuses to guess", () => {
  it("resolves an exact name", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), "David Raya");
    expect(screen.getByText(/David Raya · Arsenal · 1/)).toBeTruthy();
  });

  it("resolves a unique partial", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), "Saliba");
    expect(screen.getByText(/William Saliba · Arsenal · 2/)).toBeTruthy();
  });

  it("refuses an ambiguous surname rather than taking the first match", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), "Silva");
    expect(screen.getByText(/matches 2/)).toBeTruthy();
    expect(screen.queryByText(/Bernardo Silva · Man City/)).toBeNull();
  });

  it("says so when nothing matches", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), "Nobody At All");
    expect(screen.getByText("no match")).toBeTruthy();
  });

  it("matches through accents, which FPL renders and people do not type", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), "Kadioglu");
    expect(screen.getByText(/Ferdi Kadıoğlu · Brighton · 6/)).toBeTruthy();
  });

  it("accepts a bare element id, which is the artifacts' own join", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), "5");
    expect(screen.getByText(/Dominik Szoboszlai · Liverpool · 5/)).toBeTruthy();
  });

  it("reports an id that exists in no artifact", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), "9999");
    expect(screen.getByText("no player with that id")).toBeTruthy();
  });
});

describe("refusing to submit", () => {
  it("keeps the button disabled below fifteen players", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), "David Raya");
    expect(screen.getByRole("button", { name: /Record this position/ })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("refuses a duplicated player, which would leave a slot silently empty", async () => {
    form();
    const lines = fifteen().split("\n");
    lines[14] = lines[0];
    await userEvent.type(screen.getByLabelText(/one player per line/), lines.join("\n"));
    expect(screen.getByText(/a player appears twice/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Record this position/ })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("refuses a bank finer than a tenth, rather than rounding it", async () => {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), fifteen());
    const bank = screen.getByLabelText(/Bank/);
    await userEvent.clear(bank);
    await userEvent.type(bank, "3.55");
    expect(screen.getByRole("button", { name: /Record this position/ })).toHaveProperty(
      "disabled",
      true
    );
  });
});

describe("submitting", () => {
  async function fill() {
    form();
    await userEvent.type(screen.getByLabelText(/one player per line/), fifteen());
    const bank = screen.getByLabelText(/Bank/);
    await userEvent.clear(bank);
    await userEvent.type(bank, "3.5");
  }

  it("sends the bank as integer tenths, not millions", async () => {
    await fill();
    await userEvent.click(screen.getByRole("button", { name: /Record this position/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.bank).toBe(35);
    expect(body.squad).toHaveLength(15);
    expect(body.entryId).toBe(OWNER_ENTRY);
    expect(body.gameweek).toBe(2);
  });

  it("quotes the commit rather than claiming success", async () => {
    await fill();
    await userEvent.click(screen.getByRole("button", { name: /Record this position/ }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/15 players recorded for GW2/);
    // The sha is the checkable part; "saved" would be a reassurance.
    expect(status.textContent).toMatch(/commit abc1234/);
    expect(status.textContent).toMatch(/uncertain/);
  });

  it("shows the server's refusal verbatim rather than a generic failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "squad must be 15 DISTINCT element ids." }), {
        status: 400,
      })
    );
    await fill();
    await userEvent.click(screen.getByRole("button", { name: /Record this position/ }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/15 DISTINCT/);
  });

  it("says nothing was recorded when the request never lands", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await fill();
    await userEvent.click(screen.getByRole("button", { name: /Record this position/ }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Nothing was recorded/);
  });
});
