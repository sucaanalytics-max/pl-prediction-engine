// @vitest-environment node
/**
 * Runs the real `public/sw.js` in a vm against in-memory stand-ins for the
 * Cache API and `fetch`. It is not a browser, so it cannot prove registration,
 * claiming or the cross-origin header exposure; it does prove the decisions the
 * worker makes — what it stores, what it refuses to, what it serves when the
 * network is gone — which are the ones that go wrong silently.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PUBLIC = join(__dirname, "..", "public");
const SW = readFileSync(join(PUBLIC, "sw.js"), "utf8");
const ROUTING = readFileSync(join(PUBLIC, "sw-routing.js"), "utf8");
const ORIGIN = "https://pl2627.vercel.app";

type Handler = (event: Record<string, unknown>) => void;

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(req: Request | string) {
    const found = this.entries.get(typeof req === "string" ? new URL(req, ORIGIN).href : req.url);
    return found?.clone();
  }
  async put(req: Request | string, res: Response) {
    this.entries.set(typeof req === "string" ? new URL(req, ORIGIN).href : req.url, res);
  }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(req: Request) { return this.entries.delete(req.url); }
  async addAll() {}
}

function boot(opts: { hostname?: string; hasActive?: boolean } = {}) {
  const stores = new Map<string, FakeCache>();
  const handlers: Record<string, Handler> = {};
  const posted: unknown[] = [];
  const state = { skipWaiting: 0, claimed: 0, network: null as null | ((r: Request) => Promise<Response>) };

  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async match(req: Request | string) {
      for (const cache of stores.values()) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const self: Record<string, unknown> = {
    location: { hostname: opts.hostname ?? "pl2627.vercel.app", origin: ORIGIN },
    registration: { active: opts.hasActive ? {} : null, unregister: async () => true },
    clients: {
      claim: () => { state.claimed++; },
      matchAll: async () => [{ postMessage: (m: unknown) => posted.push(m), navigate() {}, url: "/" }],
    },
    skipWaiting: () => { state.skipWaiting++; },
    addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
  };

  const context: Record<string, unknown> = {
    self, caches, Response, Request, Headers, URL, Promise, setTimeout, clearTimeout,
    fetch: (r: Request) => {
      if (!state.network) return Promise.reject(new TypeError("offline"));
      return state.network(r);
    },
    importScripts: () => { vm.runInContext(ROUTING, context); },
  };
  context.globalThis = context;
  vm.createContext(context);
  // `self` and the global scope are the same object in a worker.
  Object.assign(context, self);
  context.self = context;
  vm.runInContext(SW, context);

  async function fetchEvent(url: string, init: { method?: string; mode?: RequestMode } = {}) {
    const request = new Request(url, { method: init.method ?? "GET" });
    Object.defineProperty(request, "mode", { value: init.mode ?? "cors" });
    const waits: Promise<unknown>[] = [];
    // Asserted rather than annotated: assigned only inside the closure below, so
    // an annotation narrows to `null` and every later use reads as `never`.
    let responded = null as Promise<Response> | null;
    handlers.fetch({
      request,
      respondWith: (p: Promise<Response>) => { responded = Promise.resolve(p); },
      waitUntil: (p: Promise<unknown>) => { waits.push(Promise.resolve(p)); },
    });
    const response = responded ? await responded : null;
    await Promise.all(waits);
    return response;
  }

  return { stores, handlers, posted, state, fetchEvent, caches };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("public/sw.js", () => {
  let sw: ReturnType<typeof boot>;
  beforeEach(() => { sw = boot(); });

  it("stores prediction JSON stamped with x-sw-cached-at and serves it when the network is gone", async () => {
    sw.state.network = async () => json({ gw: 9 });
    const url = `${ORIGIN}/predictions/fpl/agent_status.json`;
    expect(await sw.fetchEvent(url)).not.toBeNull();
    const stored = await sw.stores.get("suca-fpl-data-v1")!.match(url);
    expect(stored).toBeDefined();
    const stamp = stored!.headers.get("x-sw-cached-at");
    expect(Number.isFinite(Date.parse(stamp ?? ""))).toBe(true);
    expect(await stored!.json()).toEqual({ gw: 9 });

    sw.state.network = null;
    const offline = await sw.fetchEvent(url);
    expect(offline!.headers.get("x-sw-cached-at")).toBe(stamp);
    expect(await offline!.json()).toEqual({ gw: 9 });
    // The network failed, so the worker tells open pages how old this is.
    expect(sw.posted).toContainEqual(
      expect.objectContaining({ type: "SW_SERVED_CACHED", kind: "data", cachedAt: stamp }),
    );
  });

  it("online, a fresh network copy wins over a stored one and nothing is announced", async () => {
    const url = `${ORIGIN}/predictions/fpl/decision_public_gw09_owner.json`;
    sw.state.network = async () => json({ captain: "old" });
    await sw.fetchEvent(url);
    sw.state.network = async () => json({ captain: "new" });
    const res = await sw.fetchEvent(url);
    // The regression this guards: stale-while-revalidate handed back "old" here,
    // unlabelled, while the page was online.
    expect(await res!.json()).toEqual({ captain: "new" });
    expect(sw.posted).toEqual([]);
  });

  it("a stalled network serves the stored copy and announces its age", async () => {
    vi.useFakeTimers();
    try {
      const slow = boot();
      const url = `${ORIGIN}/predictions/fpl/agent_status.json`;
      slow.state.network = async () => json({ gw: 9 });
      await slow.fetchEvent(url);
      slow.state.network = () => new Promise<Response>(() => {});
      const pending = slow.fetchEvent(url);
      await vi.advanceTimersByTimeAsync(3_100);
      const res = await pending;
      expect(await res!.json()).toEqual({ gw: 9 });
      expect(slow.posted).toContainEqual(expect.objectContaining({ type: "SW_SERVED_CACHED", kind: "data" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the network response unstamped when there is no stored copy", async () => {
    sw.state.network = async () => json({ a: 1 });
    const res = await sw.fetchEvent(`${ORIGIN}/predictions/x.json`);
    expect(res!.headers.get("x-sw-cached-at")).toBeNull();
  });

  it("does not store a 404 over the last good copy", async () => {
    const url = `${ORIGIN}/predictions/x.json`;
    sw.state.network = async () => json({ ok: true });
    await sw.fetchEvent(url);
    sw.state.network = async () => new Response("<html>404</html>", { status: 404 });
    await sw.fetchEvent(url);
    const stored = await sw.stores.get("suca-fpl-data-v1")!.match(url);
    expect(await stored!.json()).toEqual({ ok: true });
  });

  it("caches Supabase public storage artifacts", async () => {
    const url = "https://abcd.supabase.co/storage/v1/object/public/predictions/latest.json";
    sw.state.network = async () => json({ s: 1 });
    await sw.fetchEvent(url);
    expect(await sw.stores.get("suca-fpl-data-v1")!.match(url)).toBeDefined();
  });

  it("live: stores a state that carries data, falls back to it on network failure", async () => {
    const url = `${ORIGIN}/api/fpl/state`;
    sw.state.network = async () => json({ data: { event: 9 } });
    await sw.fetchEvent(url);
    sw.state.network = null;
    const offline = await sw.fetchEvent(url);
    expect(await offline!.json()).toEqual({ data: { event: 9 } });
    expect(offline!.headers.get("x-sw-cached-at")).not.toBeNull();
    expect(sw.posted).toContainEqual(expect.objectContaining({ kind: "live" }));
  });

  it("live: an error-shaped 200 is passed through and never replaces the last good state", async () => {
    const url = `${ORIGIN}/api/fpl/state`;
    sw.state.network = async () => json({ data: { event: 9 } });
    await sw.fetchEvent(url);
    sw.state.network = async () => json({ error: "upstream refused" });
    const res = await sw.fetchEvent(url);
    expect(await res!.json()).toEqual({ error: "upstream refused" });
    const stored = await sw.stores.get("suca-fpl-data-v1")!.match(url);
    expect(await stored!.json()).toEqual({ data: { event: 9 } });
  });

  it("live: a 5xx is passed through, not replaced by the stored copy", async () => {
    const url = `${ORIGIN}/api/fpl/state`;
    sw.state.network = async () => json({ data: 1 });
    await sw.fetchEvent(url);
    sw.state.network = async () => new Response("down", { status: 503 });
    expect((await sw.fetchEvent(url))!.status).toBe(503);
  });

  it("live: with nothing stored, a network failure rejects rather than inventing data", async () => {
    sw.state.network = null;
    const res = await sw.fetchEvent(`${ORIGIN}/api/fpl/state`);
    expect(res!.type).toBe("error");
  });

  it("never answers or stores the write path or any other API route", async () => {
    sw.state.network = async () => json({ data: 1 });
    for (const [url, method] of [
      [`${ORIGIN}/api/hub/position`, "POST"],
      [`${ORIGIN}/api/hub/position`, "GET"],
      [`${ORIGIN}/api/news/article`, "GET"],
      [`${ORIGIN}/api/fpl/state`, "POST"],
      [`${ORIGIN}/predictions/latest.json`, "POST"],
    ] as const) {
      expect(await sw.fetchEvent(url, { method }), `${method} ${url}`).toBeNull();
    }
    const data = sw.stores.get("suca-fpl-data-v1");
    expect(data ? data.entries.size : 0).toBe(0);
  });

  it("caps /_next/static, evicting the oldest", async () => {
    sw.state.network = async () => new Response("js", { status: 200 });
    for (let i = 0; i < 155; i++) await sw.fetchEvent(`${ORIGIN}/_next/static/c${i}.js`);
    const keys = [...sw.stores.get("suca-fpl-static-v1")!.entries.keys()];
    expect(keys).toHaveLength(150);
    expect(keys).not.toContain(`${ORIGIN}/_next/static/c0.js`);
    expect(keys).toContain(`${ORIGIN}/_next/static/c154.js`);
  });

  it("navigation: network wins when it answers, and the page is stored", async () => {
    sw.state.network = async () => new Response("<html>fresh</html>");
    const res = await sw.fetchEvent(`${ORIGIN}/players`, { mode: "navigate" });
    expect(await res!.text()).toContain("fresh");
    expect(await sw.stores.get("suca-fpl-shell-v12")!.match(`${ORIGIN}/players`)).toBeDefined();
  });

  it("navigation: offline serves the stored page, then /offline", async () => {
    const shell = await sw.caches.open("suca-fpl-shell-v12");
    await shell.put(`${ORIGIN}/players`, new Response("<html>stored</html>"));
    await shell.put("/offline", new Response("<html>offline</html>"));
    sw.state.network = null;
    expect(await (await sw.fetchEvent(`${ORIGIN}/players`, { mode: "navigate" }))!.text()).toContain("stored");
    expect(await (await sw.fetchEvent(`${ORIGIN}/unknown`, { mode: "navigate" }))!.text()).toContain("offline");
  });

  it("assets: answered cache-first from the shell cache, with the network gone", async () => {
    const shell = await sw.caches.open("suca-fpl-shell-v12");
    await shell.put(`${ORIGIN}/icon.svg`, new Response("<svg>stored</svg>"));
    sw.state.network = null;
    const res = await sw.fetchEvent(`${ORIGIN}/icon.svg`);
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain("stored");
  });

  it("assets: not precached means network, and the 200 is kept for next time", async () => {
    sw.state.network = async () => new Response("manifest-body");
    const url = `${ORIGIN}/manifest.webmanifest`;
    expect(await (await sw.fetchEvent(url))!.text()).toBe("manifest-body");
    expect(await sw.stores.get("suca-fpl-shell-v12")!.match(url)).toBeDefined();
    sw.state.network = null;
    expect(await (await sw.fetchEvent(url))!.text()).toBe("manifest-body");
  });

  it("assets: a failed fetch with nothing stored is the browser's to report, and nothing else is answered", async () => {
    sw.state.network = null;
    await expect(sw.fetchEvent(`${ORIGIN}/icon-192.png`)).rejects.toThrow();
    expect(await sw.fetchEvent(`${ORIGIN}/og.png`)).toBeNull();
  });

  it("install: activates at once only when no worker is active", () => {
    const first = boot({ hasActive: false });
    first.handlers.install({ waitUntil() {} });
    expect(first.state.skipWaiting).toBe(1);

    const update = boot({ hasActive: true });
    update.handlers.install({ waitUntil() {} });
    expect(update.state.skipWaiting).toBe(0);
    update.handlers.message({ data: { type: "SKIP_WAITING" } });
    expect(update.state.skipWaiting).toBe(1);
    update.handlers.message({ data: { type: "other" } });
    expect(update.state.skipWaiting).toBe(1);
  });

  it("activate: keeps the data and static caches, evicts older shells", async () => {
    for (const name of ["suca-fpl-shell-v10", "suca-fpl-shell-v11", "suca-fpl-shell-v12", "suca-fpl-data-v1", "suca-fpl-static-v1"]) {
      await sw.caches.open(name);
    }
    const waits: Promise<unknown>[] = [];
    sw.handlers.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect([...sw.stores.keys()].sort()).toEqual(
      ["suca-fpl-data-v1", "suca-fpl-shell-v12", "suca-fpl-static-v1"],
    );
    expect(sw.state.claimed).toBe(1);
  });

  it("localhost: answers nothing, and unregisters while deleting every cache", async () => {
    const local = boot({ hostname: "localhost" });
    local.state.network = async () => json({ data: 1 });
    expect(await local.fetchEvent(`${ORIGIN}/api/fpl/state`)).toBeNull();
    await local.caches.open("suca-fpl-data-v1");
    const waits: Promise<unknown>[] = [];
    local.handlers.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(local.stores.size).toBe(0);
    local.handlers.install({ waitUntil() {} });
    expect(local.state.skipWaiting).toBe(1);
  });
});
