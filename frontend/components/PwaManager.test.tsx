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
