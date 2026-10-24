import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PwaManager from "@/components/PwaManager";

type Listener = (event?: Event) => void;

class Target {
  private map = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) { this.map.get(type)?.delete(fn); }
  emit(type: string) { for (const fn of this.map.get(type) ?? []) fn(new Event(type)); }
}

class FakeWorker extends Target {
  state = "installed";
  postMessage = vi.fn();
}

function install(opts: { controller: boolean; waiting?: FakeWorker }) {
  const registration = Object.assign(new Target(), {
    waiting: opts.waiting ?? null,
    installing: null as FakeWorker | null,
    update: vi.fn(async () => undefined),
  });
  const container = Object.assign(new Target(), {
    controller: opts.controller ? {} : null,
    register: vi.fn(async () => registration),
  });
  Object.defineProperty(window.navigator, "serviceWorker", { value: container, configurable: true });
  return { registration, container };
}

const reload = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  Object.defineProperty(window, "location", {
    value: { ...originalLocation, reload }, configurable: true,
  });
  reload.mockClear();
  // This runner's Node ships a localStorage that throws without a backing file,
  // so the install-card dismissal is stubbed rather than read from jsdom.
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "suca-pwa-dismissed" ? "1" : null),
    setItem: () => undefined,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { value: originalLocation, configurable: true });
  // @ts-expect-error restoring the jsdom default
  delete window.navigator.serviceWorker;
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("PwaManager update flow", () => {
  it("shows nothing when no update is waiting", async () => {
    install({ controller: true });
    render(<PwaManager />);
    await flush();
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("offers Reload for a worker already waiting, and posts SKIP_WAITING on tap", async () => {
    const waiting = new FakeWorker();
    install({ controller: true, waiting });
    render(<PwaManager />);
    await flush();
    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });

  it("surfaces a worker that installs later, via updatefound", async () => {
    const { registration } = install({ controller: true });
    render(<PwaManager />);
    await flush();
    const worker = new FakeWorker();
    worker.state = "installing";
    act(() => {
      registration.installing = worker;
      registration.emit("updatefound");
    });
    expect(screen.queryByText("Update available")).toBeNull();
    act(() => { worker.state = "installed"; worker.emit("statechange"); });
    expect(screen.getByText("Update available")).toBeInTheDocument();
  });

  it("does not call a first install an update", async () => {
    const { registration } = install({ controller: false });
    render(<PwaManager />);
    await flush();
    const worker = new FakeWorker();
    act(() => {
      registration.installing = worker;
      registration.emit("updatefound");
      worker.emit("statechange");
    });
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("reloads once on controllerchange after a tap, and never without one", async () => {
    const { container } = install({ controller: true, waiting: new FakeWorker() });
    render(<PwaManager />);
    await flush();

    // A controllerchange nobody asked for (e.g. a first claim) must not reload.
    act(() => container.emit("controllerchange"));
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    act(() => container.emit("controllerchange"));
    act(() => container.emit("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("PwaManager install sheet", () => {
  async function openFromMore() {
    install({ controller: true });
    render(<PwaManager />);
    await flush();
    act(() => { window.dispatchEvent(new Event("suca:install-sheet")); });
  }

  it("stays closed until asked, even with the dismissal stored", async () => {
    install({ controller: true });
    render(<PwaManager />);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as a modal dialog with a label when /more asks for it", async () => {
    await openFromMore();
    const dialog = screen.getByRole("dialog", { name: "Put Suca on your home screen" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Keeps the last call readable offline");
  });

  it("moves focus into the sheet, and Escape closes it", async () => {
    await openFromMore();
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with no install event offers Got it and the by-hand instruction, not a dead Install", async () => {
    await openFromMore();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.getByRole("button", { name: "Got it" })).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).toMatch(/Add to Home Screen/);
  });

  it("persists the dismissal on Not now, as the old card's close did", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    install({ controller: true });
    render(<PwaManager />);
    await flush();
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    });
    act(() => { window.dispatchEvent(event); });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(setItem).toHaveBeenCalledWith("suca-pwa-dismissed", "1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
