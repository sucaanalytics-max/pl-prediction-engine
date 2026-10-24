import { describe, expect, it } from "vitest";
import routing from "../public/sw-routing.js";

const ORIGIN = "https://pl2627.vercel.app";
const classify = (path: string, method = "GET", mode = "cors", origin = ORIGIN) =>
  routing.classify(path.startsWith("http") ? path : `${ORIGIN}${path}`, method, mode, origin);

describe("sw-routing classify", () => {
  it("sends page loads to the navigate strategy", () => {
    expect(classify("/", "GET", "navigate")).toBe("navigate");
    expect(classify("/players?gw=9", "GET", "navigate")).toBe("navigate");
  });

  it("caches /_next/static cache-first and nothing else under /_next", () => {
    expect(classify("/_next/static/chunks/app-abc123.js")).toBe("static");
    expect(classify("/_next/image?url=%2Fog.png&w=640&q=75")).toBe("bypass");
    expect(classify("/_next/data/build/index.json")).toBe("bypass");
  });

  it("treats same-origin prediction JSON and JSONL as data", () => {
    expect(classify("/predictions/fpl/agent_status.json")).toBe("data");
    expect(classify("/predictions/fpl/xp_public_gw09.json")).toBe("data");
    expect(classify("/predictions/forecast_ledger.jsonl")).toBe("data");
  });

  it("does not treat non-data files under /predictions as data", () => {
    expect(classify("/predictions/readme.md")).toBe("bypass");
    expect(classify("/predictions/")).toBe("bypass");
  });

  it("recognises Supabase public storage on any *.supabase.co origin", () => {
    const base = "https://abcd1234.supabase.co/storage/v1/object/public/predictions";
    expect(classify(`${base}/latest.json`)).toBe("data");
    expect(classify(`${base}/fpl/agent_status.json`)).toBe("data");
  });

  it("refuses look-alike and non-public Supabase URLs", () => {
    const ok = "/storage/v1/object/public/predictions/latest.json";
    expect(classify(`https://evil.example.com${ok}`)).toBe("bypass");
    expect(classify(`https://abcd.supabase.co.evil.com${ok}`)).toBe("bypass");
    expect(classify(`https://notsupabase.co${ok}`)).toBe("bypass");
    expect(classify(`http://abcd.supabase.co${ok}`)).toBe("bypass");
    expect(classify("https://abcd.supabase.co/storage/v1/object/public/other/latest.json")).toBe("bypass");
    expect(classify("https://abcd.supabase.co/storage/v1/object/sign/predictions/latest.json")).toBe("bypass");
    expect(classify("https://abcd.supabase.co/rest/v1/fpl_snapshots")).toBe("bypass");
    expect(classify("https://abcd.supabase.co/storage/v1/object/public/predictions/a.png")).toBe("bypass");
  });

  it("serves exactly one API route as live", () => {
    expect(classify("/api/fpl/state")).toBe("live");
    expect(classify("/api/fpl/state?x=1")).toBe("live");
  });

  it("bypasses every other API route, including the write path", () => {
    for (const path of [
      "/api/hub/position", "/api/fpl/state/extra", "/api/fpl/other",
      "/api/news/article", "/api/fpl",
    ]) {
      expect(classify(path), path).toBe("bypass");
    }
  });

  it("bypasses every non-GET, whatever the path", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      for (const path of [
        "/api/hub/position", "/api/fpl/state", "/predictions/latest.json",
        "/_next/static/a.js", "/capture",
      ]) {
        expect(classify(path, method, "cors"), `${method} ${path}`).toBe("bypass");
      }
      expect(classify("/capture", method, "navigate")).toBe("bypass");
    }
  });

  it("is case-insensitive about the method it rejects", () => {
    expect(classify("/api/hub/position", "post")).toBe("bypass");
    expect(classify("/api/fpl/state", "get")).toBe("live");
  });

  it("bypasses other origins and unparseable URLs", () => {
    expect(classify("https://fonts.gstatic.com/s/plex.woff2")).toBe("bypass");
    expect(classify("https://fantasy.premierleague.com/api/bootstrap-static/")).toBe("bypass");
    expect(routing.classify("not a url", "GET", "cors", ORIGIN)).toBe("bypass");
  });

  it("bypasses ordinary same-origin assets", () => {
    expect(classify("/icon-192.png")).toBe("bypass");
    expect(classify("/manifest.webmanifest")).toBe("bypass");
  });

  it("accepts a URL object", () => {
    expect(routing.classify(new URL(`${ORIGIN}/api/fpl/state`), "GET", "cors", ORIGIN)).toBe("live");
  });
});
