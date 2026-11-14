// The FPS monitor and the performance recorder (debug tooling).
//
// - The monitor: an always-on-top panel the host draws (`src/perf.rs` on
//   the desktop, `PerfMonitor.swift` on iPhone): frames per second, the
//   main thread's time per frame against one refresh (green / amber /
//   red bars), the gaps between frames, the JS thread's busy time and its
//   worst task. Toggled with ⌘⇧F (App.tsx) or Settings → Diagnostics;
//   remembered in Storage `rustflix.fpsmonitor`.
// - The recorder: while Storage `rustflix.perf` is "1" (read at launch;
//   `setPerfRecording` for the session) the host writes one JSON line per
//   second to `perf.jsonl` in the app's data directory (the format is in
//   src/perf.rs / PerfMonitor.swift). This module adds what only JS knows:
//   the route, the JS thread's long tasks (timer lag) with a label of what
//   ran, and the scripted scenario's step.
// - The scenario: Storage `rustflix.perfscript` ("1" for the default
//   steps, or a JSON array of steps) runs once at launch with the
//   recorder on, then is removed (`runPerfScript`).
//
// All of it costs nothing while off: no timers, no host messages; the
// `perfMark` / `perfTask` hooks are one boolean test.

import { host, signal, Storage, untracked } from "nsh";
import { route, type Route } from "./router";
import { notify } from "./player";

const MONITOR_KEY = "rustflix.fpsmonitor";
const RECORD_KEY = "rustflix.perf";
export const PERF_SCRIPT_KEY = "rustflix.perfscript";

/** The monitor panel shows (reactive). */
export const fpsMonitorOn = signal(false);
/** The recorder writes (reactive). */
export const perfRecording = signal(false);

let hostUp = false;
try {
  hostUp = host.available();
} catch {}
/** False once the host turned out not to handle `perf.*`. */
const handled = signal(true);

/** Whether this build's host has the monitor (reactive). */
export function fpsMonitorAvailable(): boolean {
  return hostUp && handled();
}

/** Measuring at all: the panel or the recorder. Plain flag for hot paths. */
let active = false;

function push() {
  active = untracked(fpsMonitorOn) || untracked(perfRecording);
  // Modules that must not import this one (lib files the Bun harness runs
  // on their own) leave breadcrumbs through a global while measuring.
  (globalThis as { __rfPerfMark?: (label: string) => void }).__rfPerfMark = active ? perfMark : undefined;
  if (!fpsMonitorAvailable()) return;
  void host
    // The panel always records too: what it shows can be saved
    // (`savePerfRecording`) and pinpointed afterwards.
    .call("perf.set", { hud: untracked(fpsMonitorOn), record: active })
    .catch((e: unknown) => {
      if (String(e).includes("handles no")) {
        handled.set(false);
        active = false;
      }
    });
  if (active) startProbe();
  else stopProbe();
}

export function setFpsMonitor(on: boolean) {
  fpsMonitorOn.set(on);
  void Storage.setItem(MONITOR_KEY, on ? "1" : "0").catch(() => {});
  push();
}

export function toggleFpsMonitor() {
  setFpsMonitor(!untracked(fpsMonitorOn));
}

/** Records for this session (Storage `rustflix.perf` decides at launch). */
export function setPerfRecording(on: boolean) {
  perfRecording.set(on);
  push();
}

/** Saves what the recorder has so far (the files are rotated to
 * timestamped names, which the toast says); on phones `share` hands them
 * to the share sheet / the app's external files folder. */
export async function savePerfRecording(share = false): Promise<string[]> {
  if (!fpsMonitorAvailable()) return [];
  try {
    const r = (await host.call("perf.save", { share })) as { ok?: boolean; files?: string[]; dir?: string } | null;
    const files = r?.files ?? [];
    notify(
      files.length
        ? `Performance recording saved: ${files.map((f) => f.split("/").pop()).join(", ")} in ${r?.dir ?? ""}`
        : "Nothing recorded yet: turn the FPS monitor on first (⌘⇧F)",
      files.length ? "success" : "info",
    );
    return files;
  } catch (e) {
    notify(`Could not save the recording: ${String(e)}`, "error");
    return [];
  }
}

// The hosts' own gestures (two-finger triple tap; the panel's long press)
// come as events, so the switch in Settings and the stored state follow.
try {
  host.on("perf.toggle", () => toggleFpsMonitor());
  host.on("perf.saveRequest", () => void savePerfRecording(true));
} catch {}

void Promise.all([
  Storage.getItem(MONITOR_KEY).catch(() => null),
  Storage.getItem(RECORD_KEY).catch(() => null),
]).then(([m, r]) => {
  const hud = m === "1";
  const rec = r === "1";
  if (hud) fpsMonitorOn.set(true);
  if (rec) perfRecording.set(true);
  if (hud || rec) push();
});

// --- What ran: labels for the JS thread's long tasks ---------------------------

/** Long JS tasks this second: [ms, label]. */
let longTasks: [number, string][] = [];
let lastLabel = "";
let lastLabelAt = 0;
let step = "";

/** Names what the JS thread is about to do (a cheap breadcrumb). */
export function perfMark(label: string) {
  if (!active) return;
  lastLabel = label;
  lastLabelAt = performance.now();
}

/** Runs `fn`, recording it as a long task (with `label`) when it took 4 ms
 * or more. Only times while measuring. */
export function perfTask<T>(label: string, fn: () => T): T {
  if (!active) return fn();
  const t0 = performance.now();
  lastLabel = label;
  lastLabelAt = t0;
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    if (ms >= 4) note(ms, label);
  }
}

function note(ms: number, label: string) {
  if (longTasks.length < 40) longTasks.push([Math.round(ms * 10) / 10, label]);
}

// --- The JS thread's lag probe -------------------------------------------------------

/** A timer every TICK ms: how late it fires is how long the JS (engine)
 * thread was busy — the app's code and NSH's core (render, layout). */
const TICK = 50;
/** Lag from this is a long task. */
const LONG_MS = 8;

let probe: ReturnType<typeof setTimeout> | undefined;
let flush: ReturnType<typeof setInterval> | undefined;
let expected = 0;
/** This second's lags, with the breadcrumb of each. */
let lags: [number, string][] = [];

function tick() {
  const now = performance.now();
  const lag = Math.max(0, now - expected);
  // The breadcrumb left within the late stretch says what ran.
  const what = lastLabel && now - lastLabelAt <= lag + TICK ? lastLabel : "(unlabelled)";
  if (lags.length < 64) lags.push([lag, what]);
  expected = now + TICK;
  probe = setTimeout(tick, TICK);
}

/** The second's lags over their median: where timers fire late as a rule
 * (an iOS Simulator in a hidden workspace coalesces them by ~40 ms), only
 * what is late beyond that is the JS thread's work. On a device the
 * median is ~0 and this is the lag itself. */
function lagReport(): { max: number; sum: number; base: number; absMax: number; lateShare: number } {
  if (lags.length === 0) return { max: 0, sum: 0, base: 0, absMax: 0, lateShare: 0 };
  const sorted = lags.map((l) => l[0]).sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length / 2)];
  // Absolute too: a saturated JS thread is late on every tick, which the
  // median baseline would hide.
  const absMax = sorted[sorted.length - 1];
  const lateShare = sorted.filter((l) => l >= LONG_MS).length / sorted.length;
  let max = 0;
  let sum = 0;
  for (const [lag, what] of lags) {
    const over = lag - base;
    if (over > 0) sum += over;
    if (over > max) max = over;
    if (over >= LONG_MS) note(over, `lag: ${what}`);
  }
  lags = [];
  return { max, sum, base, absMax, lateShare };
}

function routeLabel(r: Route): string {
  if (r.name === "title") return `title:${r.type}:${r.id}`;
  if (r.name === "player") return `player:${r.type}:${r.id}`;
  return r.name;
}

function sendSecond() {
  if (!active || !fpsMonitorAvailable()) return;
  const lag = lagReport();
  const data = {
    route: routeLabel(untracked(route)),
    step,
    lagMax: Math.round(lag.max * 10) / 10,
    lagSum: Math.round(lag.sum),
    lagBase: Math.round(lag.base),
    lagAbsMax: Math.round(lag.absMax * 10) / 10,
    lagLateShare: Math.round(lag.lateShare * 100) / 100,
    long: longTasks,
  };
  longTasks = [];
  try {
    host.post("perf.js", data);
  } catch {}
}

function startProbe() {
  if (probe !== undefined) return;
  expected = performance.now() + TICK;
  probe = setTimeout(tick, TICK);
  flush = setInterval(sendSecond, 1000);
}

function stopProbe() {
  if (probe !== undefined) clearTimeout(probe);
  if (flush !== undefined) clearInterval(flush);
  probe = undefined;
  flush = undefined;
  longTasks = [];
  lags = [];
}

/** Tells the host the route as it changes (only while measuring: the read
 * is the effect's dependency, the post is skipped otherwise). Called once
 * from App(). */
export function watchPerfRoute(effect: (fn: () => void) => void) {
  effect(() => {
    const r = route();
    if (!active) return;
    perfMark(`route ${routeLabel(r)}`);
    try {
      host.post("perf.route", { route: routeLabel(r) });
    } catch {}
  });
}

// --- The scripted scenario -------------------------------------------------------

/** What the scenario drives (App.tsx wires these to the screens). */
export interface PerfDriver {
  scrollHome(y: number): void;
  scrollHomeInstant(y: number): void;
  scrollRow(index: number, x: number): void;
  openFirstTitle(): boolean;
  openTitle(type: string, id: number): void;
  scrollTitle(y: number): void;
  scrollLibrary(y: number): void;
  /** Mounts `n` plain views in one commit (0: removes them). */
  flood(n: number): void;
  back(): void;
  tab(name: string): void;
  play(): boolean;
  exitPlayer(): void;
}

const DEFAULT_STEPS = [
  "wait:4000",
  "scroll:300",
  "wait:900",
  "scroll:700",
  "wait:900",
  "row:0:800",
  "wait:900",
  "row:1:800",
  "wait:900",
  "scroll:1400",
  "wait:900",
  "scroll:2200",
  "wait:900",
  "scroll:0",
  "wait:1500",
  "title",
  "wait:3000",
  "back",
  "wait:2000",
  "title",
  "wait:3000",
  "back",
  "wait:2000",
  "tab:search",
  "wait:1500",
  "tab:library",
  "wait:1500",
  "tab:downloads",
  "wait:1500",
  "tab:settings",
  "wait:1500",
  "tab:home",
  "wait:2500",
  "tab:search",
  "wait:1500",
  "tab:home",
  "wait:2500",
  "scroll:900",
  "wait:1200",
  "scroll:0",
  "wait:2000",
];

/** `rustflix.perfscript` = "selftest": known work with known answers.
 * The desktop recorder checks it itself and writes one line, `{"kind":
 * "selftest", "pass": …, "steps": [{step, pass, expect, seen}]}`, to
 * perf.jsonl when the scenario ends: `idle` no frames and none late; each
 * `block:N` one frame of ~N ms main-thread work, late on glass (its stacks
 * go through `selftest_block`); `jsblock:30` a ~30 ms JS task and no slow
 * frame; `flood:2000` 2000 mount items applied (or a stall applying them);
 * `scrollanim` frames ≈ the display's rate, at most 2 late a second. */
const SELFTEST_STEPS = [
  // Launch work (rows, images, the other tabs' pages) settles first.
  "wait:7000",
  "idle:2000",
  "block:20",
  "wait:1500",
  "block:50",
  "wait:1500",
  "jsblock:30",
  "wait:1500",
  "flood:2000",
  "wait:2000",
  "flood:0",
  "wait:1500",
  "idle:2000",
  "scrollanim:1200:2000",
  "wait:500",
  "scrollanim:0:2000",
  "wait:1000",
  // The late path: a 50 ms block in the middle of a scroll run must show
  // as a late frame, ~5 refreshes late at 120 Hz.
  "blockscroll:50",
  "wait:1500",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

declare const requestAnimationFrame: (f: (t: number) => void) => number;

/** Scrolls Home to `y` over `ms`, one jump a display frame (nsh 0.4.0's
 * animated `scrollTo` takes no duration: this drives the offset from JS,
 * so it costs a JS call and a commit a frame, as a scroll listener would;
 * a real trackpad / touch scroll costs neither). Starts from where the
 * previous `scrollanim` ended. */
let animY = 0;
function scrollAnim(driver: PerfDriver, y: number, ms: number): Promise<void> {
  const from = animY;
  const t0 = performance.now();
  return new Promise((done) => {
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / Math.max(1, ms));
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      driver.scrollHomeInstant(from + (y - from) * e);
      if (k < 1) requestAnimationFrame(step);
      else {
        animY = y;
        done();
      }
    };
    requestAnimationFrame(step);
  });
}

/** Boot hook: runs the scenario in Storage `rustflix.perfscript` (removed
 * first, so it runs once) with the recorder on. Steps: `wait:<ms>`,
 * `scroll:<y>` (Home's page), `row:<index>:<x>` (a Home row sideways),
 * `title` (opens the first Home card's title page), `open:<type>:<id>`
 * (a title page: `open:anime:21`), `tscroll:<y>` (the top title page), `back`,
 * `lscroll:<y>` (My List), `scrollanim:<y>:<ms>` (Home scrolled over a
 * duration); self-tests: `block:<ms>` (the main thread busy for exactly
 * that long inside one frame), `jsblock:<ms>` (the JS thread busy),
 * `flood:<n>` (n views made in one commit; `flood:0` removes them),
 * `idle:<ms>` (nothing; expect no frames, no red),
 * `tab:<name>`, `play` / `exit` (the player; network-bound). */
export async function runPerfScript(driver: PerfDriver) {
  let raw: string | null = null;
  try {
    raw = await Storage.getItem(PERF_SCRIPT_KEY);
  } catch {}
  if (!raw) return;
  await Storage.removeItem(PERF_SCRIPT_KEY).catch(() => {});
  let steps = DEFAULT_STEPS;
  if (raw === "selftest") steps = SELFTEST_STEPS;
  else if (raw !== "1") {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) steps = v.map(String);
    } catch {}
  }
  const wasRecording = untracked(perfRecording);
  setPerfRecording(true);
  step = "start";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const [kind, a, b] = s.split(":");
    // Waits keep the step they follow: each second is labelled with the
    // action it follows ("7 title"); `idle` is a step of its own (the
    // self-test checks it draws nothing).
    if (kind !== "wait") {
      step = `${i} ${s}`;
      perfMark(`step ${s}`);
      // The hosts label spikes with the step at once (not at the next
      // second's report).
      try {
        host.post("perf.route", { route: routeLabel(untracked(route)), step });
      } catch {}
    }
    try {
      if (kind === "wait") await sleep(Number(a) || 0);
      else if (kind === "scroll") driver.scrollHome(Number(a) || 0);
      else if (kind === "row") driver.scrollRow(Number(a) || 0, Number(b) || 0);
      else if (kind === "title") driver.openFirstTitle();
      else if (kind === "open") driver.openTitle(a, Number(b) || 0);
      else if (kind === "tscroll") driver.scrollTitle(Number(a) || 0);
      else if (kind === "lscroll") driver.scrollLibrary(Number(a) || 0);
      // Self-test steps: known work, to check what the monitor reports.
      else if (kind === "block") {
        // The main thread, busy for exactly `a` ms inside one frame.
        await host.call("perf.block", { ms: Number(a) || 0 }).catch(() => {});
      } else if (kind === "jsblock") {
        // The JS (engine) thread, busy for `a` ms in one task.
        perfTask(`selftest jsblock ${a}`, () => {
          const until = performance.now() + (Number(a) || 0);
          let x = 0;
          while (performance.now() < until) x = (x * 1103515245 + 12345) | 0;
          return x;
        });
      } else if (kind === "flood") {
        driver.flood(Number(a) || 0);
      } else if (kind === "idle") await sleep(Number(a) || 0);
      else if (kind === "scrollanim") await scrollAnim(driver, Number(a) || 0, Number(b) || 600);
      else if (kind === "blockscroll") {
        // Scroll to 1200 and back over 1.6 s; block the main thread 0.5 s in.
        const run = scrollAnim(driver, 1200, 1600);
        await sleep(500);
        await host.call("perf.block", { ms: Number(a) || 0 }).catch(() => {});
        await run;
        await scrollAnim(driver, 0, 400);
      }
      else if (kind === "back") driver.back();
      else if (kind === "tab") driver.tab(a);
      else if (kind === "play") driver.play();
      else if (kind === "exit") driver.exitPlayer();
    } catch {}
  }
  step = "done";
  try {
    host.post("perf.route", { route: routeLabel(untracked(route)), step });
  } catch {}
  await sleep(2500);
  step = "";
  if (!wasRecording) setPerfRecording(false);
}
