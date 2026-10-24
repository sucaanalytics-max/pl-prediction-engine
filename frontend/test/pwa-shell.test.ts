/**
 * The installable shell: one definition of the bottom nav's height, and a
 * manifest that matches the app that ships.
 *
 * Both were measured wrong on pl2627.vercel.app on 2026-10-24: the install card
 * sat at a hard-coded `bottom: 76px` over a 99px nav and covered its second row;
 * the manifest described a retired "Top 10 rankings" page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

describe("bottom nav height", () => {
  it("is defined once, as --bottom-nav-h, from the nav's own arithmetic", () => {
    const defs = css.match(/--bottom-nav-h:\s*calc\([^;]+\);/g) ?? [];
    expect(defs).toHaveLength(1);
    // One row: a 52px target, 4px of padding and a 1px rule. Not two rows.
    expect(defs[0]).toContain("57px");
    expect(defs[0]).not.toContain("2 *");
    expect(defs[0]).toContain("env(safe-area-inset-bottom)");
  });

  it("is what body padding and the nav read", () => {
    expect(css).toMatch(/body\s*\{\s*padding-bottom:\s*var\(--bottom-nav-h\)/);
    expect(css).toMatch(/\.mobile-bottom-nav\s*\{[^}]*min-height:\s*var\(--bottom-nav-h\)/);
  });

  it("is what the update bar floats above, and no component restates 99px", () => {
    const manager = readFileSync(join(__dirname, "..", "components", "PwaManager.tsx"), "utf8");
    expect(manager).toContain("var(--bottom-nav-h)");
    expect(manager).not.toMatch(/99px/);
  });

  it("gives every phone tab a 48px-or-larger target", () => {
    const rule = css.match(/\.mobile-bottom-nav a\s*\{[^}]*\}/)?.[0] ?? "";
    const px = Number(/min-height:\s*(\d+)px/.exec(rule)?.[1]);
    expect(px).toBeGreaterThanOrEqual(48);
  });

  it("puts the install sheet over the nav and carries the home-indicator inset itself", () => {
    // A modal sheet is not offset by the nav: the scrim makes the nav unreachable.
    const sheet = css.match(/\.pwa-install-sheet\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sheet).toContain("env(safe-area-inset-bottom)");
    expect(Number(/z-index:\s*(\d+)/.exec(sheet)?.[1])).toBeGreaterThan(65);
  });

  it("no longer hard-codes the old 76px offset", () => {
    expect(css).not.toMatch(/bottom:\s*calc\(76px/);
  });
});

describe("web app manifest", () => {
  const m = manifest();

  it("has a stable id and no reference to retired pages", () => {
    expect(m.id).toBe("/");
    expect(m.description).not.toMatch(/top 10|rankings/i);
  });

  it("shortcuts point at live pages only", () => {
    expect((m.shortcuts ?? []).map((s) => s.url)).toEqual(["/players", "/capture", "/phases"]);
  });

  it("carries a 512 maskable PNG as well as the SVG", () => {
    const icons = m.icons ?? [];
    expect(icons.some((i) => i.src === "/icon-maskable-512.png"
      && i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
    expect(icons.some((i) => i.src === "/icon-maskable.svg")).toBe(true);
    const png = readFileSync(join(__dirname, "..", "public", "icon-maskable-512.png"));
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
  });
});
