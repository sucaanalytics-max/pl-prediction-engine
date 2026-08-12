/**
 * A minimal Chrome DevTools Protocol client, for reading a signed-in browser.
 *
 * ## Why this exists rather than Playwright
 *
 * Chrome 144+ can enable remote debugging from `chrome://inspect/#remote-debugging`
 * without a relaunch, which is the only way to attach to a browser the user is
 * already signed into without disturbing it. That mode is deliberately narrower
 * than the `--remote-debugging-port` flag, and the difference is not documented
 * anywhere obvious. Measured against Chrome 151.0.7922.137:
 *
 *   * The HTTP discovery endpoints are OFF. `GET /json/version` and `/json/list`
 *     both return **404**, so any client that discovers its websocket that way —
 *     including Playwright's `--browserUrl` and chrome-devtools-mcp's
 *     `--autoConnect` — cannot find the browser and silently falls back to
 *     launching a fresh, signed-out one. The websocket URL is instead written to
 *     `DevToolsActivePort` in the user data directory.
 *   * Browser-context management is refused. `chromium.connectOverCDP` on the ws
 *     URL connects and then times out after 30s; against a different endpoint the
 *     same call reported `Protocol error (Browser.setDownloadBehavior): Browser
 *     context management is not supported`. Playwright's handshake needs it.
 *   * Raw CDP is otherwise fully functional: `Browser.getVersion`,
 *     `Target.getTargets` (66 targets), `Target.setDiscoverTargets` all succeed.
 *
 * So the capability is there and only the client was wrong. This speaks the
 * protocol directly using node's built-in `WebSocket` — no dependency, and nothing
 * that needs a browser context.
 *
 * ## Why this is safer than the Playwright path it replaces
 *
 * It can only ever touch a target it created itself. The Playwright version had to
 * borrow `contexts()[0]` and was one `browser.close()` away from closing the user's
 * tabs — measured doing exactly that, leaving the browser with zero page targets.
 * Here the only teardown is `Target.closeTarget` on an id this module minted.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where Chrome records its debug port and browser websocket path, per platform. */
const PORT_FILE_BY_PLATFORM = {
  darwin: ["Library", "Application Support", "Google", "Chrome"],
  linux: [".config", "google-chrome"],
  win32: ["AppData", "Local", "Google", "Chrome", "User Data"],
};

/** How long to let X's app shell hydrate before reading the DOM. */
const RENDER_WAIT_MS = 5000;
const NAV_TIMEOUT_MS = 45000;
const CALL_TIMEOUT_MS = 30000;

/**
 * How many times to scroll and re-read.
 *
 * Each pass adds roughly a viewport of posts. Twelve reaches ~40-60 on a busy
 * timeline, which comfortably covers the `X_SCAN_MAX_AGE_DAYS = 3` window that
 * `to_items` enforces anyway — scrolling further would read posts the ingest
 * discards. Bounded rather than "until the end" on purpose: a timeline has no end,
 * and an unbounded loop against someone else's service is the kind of thing
 * CLAUDE.md forbids for the odds API for the same reason.
 */
const SCROLLS = 12;

/** Time for X to fetch and render the next page after a scroll. */
const SCROLL_SETTLE_MS = 900;

/**
 * How long to wait for the websocket to open before assuming it is taken.
 *
 * Short, because the interesting case is not slowness. Chrome's browser-level
 * debug endpoint accepts **one** connection at a time, and a second client does
 * not get a refusal — the TCP connection is accepted, the websocket upgrade
 * completes, and then nothing ever answers. Measured: three stray
 * `chrome-devtools-mcp` daemons held the socket and every scan hung for 30s and
 * then reported "timed out opening ws://...", which reads as a broken browser
 * rather than a busy one.
 */
const OPEN_TIMEOUT_MS = 8000;

/**
 * Why a websocket that would not open, would not open — established by probing.
 *
 * The first version of this asserted a single cause: "something else is holding the
 * socket, run pkill". That was measured wrong. The far more common cause is a
 * **stale browser GUID**, and the two need opposite fixes, so guessing sends you
 * to the wrong one with full confidence.
 *
 * The distinguishing probe is a plain HTTP GET on the websocket's own path:
 *
 *   * **426 Upgrade Required** — the path is live and the browser is simply
 *     refusing a second client. Chrome's browser-level endpoint takes ONE at a
 *     time and hangs the second rather than refusing it, so this is the "busy"
 *     case. Reproduced by holding the socket deliberately.
 *   * **404 Not Found** — the browser does not recognise that GUID. The debugging
 *     *session* has ended while the port carries on listening, so
 *     `DevToolsActivePort` still names a target that no longer exists. Measured:
 *     a session enabled at 20:42 was dead by 21:19 with the port still bound and
 *     Chrome up 12 hours. Chrome 144+'s `chrome://inspect` toggle is
 *     session-scoped, not persistent — which is fine for an on-demand scan and
 *     fatal for an unattended one.
 *
 * Both are reported with the command that actually fixes that case.
 */
async function diagnose(ws) {
  const { port, path } = splitWs(ws);
  let status = null;
  if (port && path) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(4000),
      });
      status = response.status;
    } catch {
      status = null;
    }
  }

  const head = `could not talk to ${ws}` + (status ? ` (GET on that path: ${status})` : "");

  if (status === 404) {
    return [
      head,
      "",
      "Chrome does not recognise that browser id, so DevToolsActivePort is STALE.",
      "Chrome 144+'s chrome://inspect/#remote-debugging toggle is scoped to a",
      "debugging session, and the port keeps listening after the session ends —",
      "which is why this looks like a live endpoint that ignores you.",
      "",
      "  Re-enable it: open chrome://inspect/#remote-debugging and turn it on.",
      "  That rewrites DevToolsActivePort with a fresh id.",
    ].join("\n");
  }

  if (status === 426) {
    return [
      head,
      "",
      "The path is live (426 = upgrade required), so the browser is refusing a",
      "SECOND client: its browser-level endpoint takes one at a time and hangs",
      "the rest rather than refusing them. Something else is holding it — most",
      "often a chrome-devtools-mcp daemon, started implicitly by any Chrome MCP",
      "tool call or CLI command.",
      "",
      "  pgrep -fl chrome-devtools-mcp     # see what is holding it",
      "  pkill -f chrome-devtools-mcp      # release it",
    ].join("\n");
  }

  return [
    head,
    "",
    "The endpoint neither upgraded nor reported a known status. Check that Chrome",
    "is running and that chrome://inspect/#remote-debugging is enabled.",
  ].join("\n");
}

/** The port and path out of a `ws://host:port/path` URL, for the HTTP probe. */
function splitWs(ws) {
  const match = /^wss?:\/\/[^/:]+:(\d+)(\/.*)$/.exec(ws);
  return match ? { port: match[1], path: match[2] } : { port: null, path: null };
}

/**
 * The default Chrome profile directory for this platform.
 *
 * Only used to locate `DevToolsActivePort`; nothing here reads cookies, history or
 * any other profile content.
 */
export function defaultProfileDir() {
  const parts = PORT_FILE_BY_PLATFORM[process.platform];
  if (!parts) return null;
  return join(homedir(), ...parts);
}

/**
 * The browser websocket URL, from whichever source can supply it.
 *
 * Tries, in order: an explicit `ws://` URL; HTTP discovery on an `http://` URL;
 * then `DevToolsActivePort` in the profile directory. The last is what makes the
 * `chrome://inspect` mode work, and it is also the only source that survives a
 * Chrome restart changing the browser GUID — which it does every time, so a
 * hand-copied URL is stale by the next session.
 */
export async function resolveWsEndpoint({ url = "", profileDir = null } = {}) {
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return { ws: url, via: "explicit ws endpoint" };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(new URL("/json/version", url), {
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body.webSocketDebuggerUrl) {
          return { ws: body.webSocketDebuggerUrl, via: "HTTP discovery" };
        }
      }
      // A 404 here is the chrome://inspect mode, not a broken browser. Fall
      // through to the port file rather than reporting failure.
    } catch {
      // Unreachable or timed out; the port file may still answer.
    }
  }

  const dir = profileDir || defaultProfileDir();
  if (dir) {
    try {
      const raw = readFileSync(join(dir, "DevToolsActivePort"), "utf8");
      const [port, path] = raw.split("\n");
      if (port && path) {
        return {
          ws: `ws://127.0.0.1:${port.trim()}${path.trim()}`,
          via: `DevToolsActivePort in ${dir}`,
        };
      }
    } catch {
      // No such file: remote debugging has never been enabled in that profile.
    }
  }

  return { ws: null, via: null };
}

/** One CDP connection, with promise-per-command bookkeeping. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.socket.onmessage = (event) => this.receive(event);
  }

  static async open(ws) {
    const socket = new WebSocket(ws);
    try {
      // One rejection path for both failure shapes. A dead GUID produces *no*
      // websocket event at all — no open, no close, no error — while a busy
      // endpoint hangs identically, so neither can be told apart here. The
      // diagnosis is probed after the fact, not inferred from which handler fired.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no-ws-event")), OPEN_TIMEOUT_MS);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error("ws-error")); };
      });
    } catch (error) {
      // Close the socket on the way out.
      //
      // The first version rejected without closing, which leaks the connection —
      // and against an endpoint that allows ONE client at a time, a leaked
      // connection is not merely untidy, it is the next run's failure. Two failed
      // attempts made the third fail for a different reason than the first, which
      // is how a transient problem starts looking permanent.
      try { socket.close(); } catch { /* already gone */ }
      // Probe for the actual cause now that the socket is released, so the probe
      // cannot itself be the second client competing for a one-client endpoint.
      throw new Error(await diagnose(ws), { cause: error });
    }
    return new Cdp(socket);
  }

  receive(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id === undefined) return;   // an event, not a reply
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    } else {
      waiter.resolve(message.result ?? {});
    }
  }

  /**
   * Call one method. `sessionId` targets an attached page rather than the browser.
   *
   * Every call is individually timed out. A CDP reply that never arrives would
   * otherwise hang the process forever, which is the failure this route already
   * hit once via a different mechanism.
   */
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply within ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already gone; nothing to do.
    }
  }
}

/**
 * Open one tab, read it with the given extractor, close that tab.
 *
 * Returns whatever the extractor returned. Creating a tab rather than reusing one
 * is deliberate: navigating a tab the user is reading would be worse than briefly
 * opening one, and it keeps teardown to a single id this function owns.
 */
export async function scanViaCdp({
  ws, url, extractSource,
  renderWaitMs = RENDER_WAIT_MS,
  scrolls = SCROLLS,
}) {
  const cdp = await Cdp.open(ws);
  let targetId = null;
  try {
    ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    // Navigate, then wait. `Page.navigate` resolves when the navigation is
    // committed, not when the app has rendered — X is a JavaScript shell, so the
    // DOM is empty at that moment and reading it immediately returns zero posts.
    await cdp.send("Page.navigate", { url }, sessionId);
    await waitForArticles(cdp, sessionId, renderWaitMs);

    // Read, scroll, read again — because X **virtualises** the timeline.
    //
    // Measured on the signed-in home feed: one read returns 5 posts, which is
    // simply what fits the viewport. Articles scrolled out of view are removed
    // from the DOM entirely, so a single read of a 200-post timeline yields 5 and
    // looks like a working scan. Accumulating across scrolls, keyed by status id,
    // is the only way to see more than a screenful — and the merge must be by id
    // rather than by index because the same post reappears in overlapping reads.
    const merged = new Map();
    let head = null;
    for (let pass = 0; pass <= scrolls; pass += 1) {
      const value = await evaluateExtractor(cdp, sessionId, extractSource);
      if (!value || !Array.isArray(value.posts)) {
        throw new Error(
          `extractor returned ${JSON.stringify(value)} — expected { handle, posts }`,
        );
      }
      // The first pass fixes handle and sign-in state; later passes only add posts.
      head ??= value;
      for (const post of value.posts) {
        if (post?.status_id && !merged.has(post.status_id)) {
          merged.set(post.status_id, post);
        }
      }
      if (pass === scrolls) break;

      const before = merged.size;
      await cdp.send(
        "Runtime.evaluate",
        { expression: "window.scrollBy(0, window.innerHeight * 0.9)" },
        sessionId,
      );
      await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));
      // Stop early once scrolling stops yielding anything new: the timeline has
      // ended, or X is rate-limiting the fetch. Either way more scrolls are waste.
      const after = await countArticles(cdp, sessionId);
      if (after === 0 && before === merged.size) break;
    }

    return { ...head, posts: [...merged.values()] };
  } finally {
    // The only thing this module ever closes, and it created it.
    if (targetId) {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    cdp.close();
  }
}

/** Run the shared extractor in the page and return its value. */
async function evaluateExtractor(cdp, sessionId, extractSource) {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(${extractSource})()`,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error(
      `extractor threw: ${exceptionDetails.exception?.description
        || exceptionDetails.text}`,
    );
  }
  return result?.value ?? null;
}

/** How many articles are currently in the DOM. */
async function countArticles(cdp, sessionId) {
  const { result } = await cdp.send(
    "Runtime.evaluate",
    {
      expression: "document.querySelectorAll('article').length",
      returnByValue: true,
    },
    sessionId,
  );
  return result?.value ?? 0;
}

/**
 * Poll until the timeline has rendered, or the budget runs out.
 *
 * Polling beats a flat sleep in both directions: a fast render is not punished,
 * and a slow one is not silently read empty. Returning after the budget rather
 * than throwing is correct because a profile with genuinely no posts must not fail
 * the run — the caller decides what zero posts means.
 */
async function waitForArticles(cdp, sessionId, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { result } = await cdp.send(
      "Runtime.evaluate",
      {
        expression: "document.querySelectorAll('article').length",
        returnByValue: true,
      },
      sessionId,
    );
    if ((result?.value ?? 0) > 0) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export { NAV_TIMEOUT_MS, RENDER_WAIT_MS };
