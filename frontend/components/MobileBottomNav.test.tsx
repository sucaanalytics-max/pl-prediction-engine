import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

async function draw(pathname: string) {
  vi.resetModules();
  vi.doMock("next/navigation", () => ({ usePathname: () => pathname }));
  const { default: MobileBottomNav } = await import("@/components/MobileBottomNav");
  return render(<MobileBottomNav />);
}

afterEach(() => { cleanup(); vi.doUnmock("next/navigation"); });

describe("the phone nav", () => {
  it("is one row of five tabs in the designed order", async () => {
    await draw("/");
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Call", "Players", "Fixtures", "Stats", "More"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/", "/players", "/phases", "/stats", "/more"]);
  });

  it("marks exactly the current tab with aria-current", async () => {
    await draw("/players");
    const current = screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => l.textContent)).toEqual(["Players"]);
  });

  it("does not light Call for every path", async () => {
    await draw("/stats");
    expect(screen.getByRole("link", { name: "Call" }).getAttribute("aria-current")).toBeNull();
  });

  it.each(["/more", "/capture", "/evidence", "/review"])("lights More for %s", async (path) => {
    await draw(path);
    const current = screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => l.textContent)).toEqual(["More"]);
  });
});
