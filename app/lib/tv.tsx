// TV: the remote control. A Google TV or Android TV box is driven by a
// D-pad (four arrows and select, the media keys, sometimes a menu key), by a
// pointer remote ("air mouse"), or by both at once. NSH's Android views have
// no focus of their own, so the app keeps it here:
//
// - TV mode (`tvMode`): the device is a TV (`platform.idiom`, or the host's
//   `sys.deviceInfo`: television UI mode, leanback, no touchscreen), or Storage
//   `rustflix.tv` forces it ("1" on, "0" off). Decided once at boot
//   (`initTv`, before the first screen); everything TV is gated on it.
// - Keys: the host's `sys.key` events (SystemControls.java captures the
//   remote's keys while `sys.keyCapture` is on, in every window: the activity
//   and each modal dialog). Without that host (`cargo run` with TV forced on)
//   the arrows, Enter / Space and M come from `keymap`, a development aid only.
// - Focus: every pressable registers (`useFocusable`) with its scope, its
//   group (a rail of posters, a column) and its press handlers. An arrow
//   picks the best candidate in that direction from the measured frames
//   (the gap along the axis, plus the offset across it; inside the group
//   first along the group's axis) and reveals it. Groups and scopes remember
//   their last item; an item that goes takes the focus to the nearest one
//   left.
// - Scopes: each page (`TvPage`) is one, the shell's navigation rail is one,
//   and overlays (`TvScope`: a sheet, a dialog, the player) stack over them
//   and keep the D-pad inside while they are open.
// - Pointer: a pointer that moves or presses hides the highlight (hover and
//   press styles take over); the next arrow shows it again.
//
// Nothing here runs or registers outside TV mode: phones and the desktop
// behave as before.

import {
  cleanup,
  computed,
  context,
  effect,
  host,
  keymap,
  platform,
  signal,
  Storage,
  Text,
  untracked,
  View,
  type JSX,
  type ViewRef,
} from "nsh";
import { AlertDialog, Dialog } from "nsh/base";
import { route, stackRoutes } from "./router";

const ANDROID = platform.os === "android";
let hostUp = false;
try {
  hostUp = ANDROID && host.available();
} catch {}

// --- TV mode ---------------------------------------------------------------------------

/** What the host says about the device (`sys.deviceInfo`), once asked. */
interface DeviceInfo {
  tv: boolean;
  leanback: boolean;
  touch: boolean;
}

const deviceInfo = signal<DeviceInfo | null>(null);

/** The TV interface is on: the remote drives the app, the shell is the
 * navigation rail, the pages are laid out for a TV. Set once by `initTv`. */
export const tvMode = signal(false);

/** The remote's keys come from the host (`sys.key`); else from `keymap`. */
const hostKeys = hostUp;

let initDone: Promise<void> | null = null;

/** Decides TV mode: the Storage override, the platform's idiom, the host's
 * device report (waited for 1.5 s at most). Call before the first screen
 * mounts. */
export function initTv(): Promise<void> {
  initDone ??= (async () => {
    let forced = "";
    try {
      forced = (await Storage.getItem("rustflix.tv")) ?? "";
    } catch {}
    if (hostUp) {
      try {
        const r = (await Promise.race([
          Promise.resolve(host.call("sys.deviceInfo", {} as never)),
          new Promise((done) => setTimeout(() => done(null), 1500)),
        ])) as Partial<DeviceInfo> | null;
        if (r && typeof r === "object") {
          deviceInfo.set({ tv: !!r.tv, leanback: !!r.leanback, touch: r.touch !== false });
        }
      } catch {}
    }
    if (hostUp) {
      try {
        const v = (await Promise.race([
          Promise.resolve(host.call("sys.voice", { check: true } as never)),
          new Promise((done) => setTimeout(() => done(null), 1500)),
        ])) as { available?: boolean } | null;
        voiceAvailable.set(!!v?.available);
      } catch {}
    }
    const d = untracked(deviceInfo);
    const on =
      forced === "1"
        ? true
        : forced === "0"
          ? false
          : platform.idiom === "tv" || (!!d && (d.tv || !d.touch));
    tvMode.set(on);
  })();
  return initDone;
}

// --- Keys ----------------------------------------------------------------------------------

export type TvKeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "select"
  | "playpause"
  | "play"
  | "pause"
  | "stop"
  | "rewind"
  | "forward"
  | "next"
  | "prev"
  | "menu";

/** One key event of the remote, as the host sends it (`sys.key`). */
export interface TvKey {
  key: TvKeyName;
  action: "down" | "up";
  /** Auto-repeats of a held key (0 for the first press and the release). */
  repeat: number;
  /** The host took the focus off a text field for this key (up / down). */
  editing: boolean;
}

type Dir = "up" | "down" | "left" | "right";

const DIRS: Partial<Record<TvKeyName, Dir>> = { up: "up", down: "down", left: "left", right: "right" };
const KEY_NAMES = new Set<string>([
  "up", "down", "left", "right", "select", "playpause", "play", "pause", "stop",
  "rewind", "forward", "next", "prev", "menu",
]);

/** Holding select this long is a long press. */
const LONG_PRESS_MS = 600;

/** When the last key went down: pointer events right after one are the
 * content moving under a resting pointer, not the user. */
let lastKeyAt = 0;

if (hostKeys) {
  try {
    host.on("sys.key", (d: unknown) => {
      const e = d as Partial<TvKey> | null;
      if (!e || typeof e.key !== "string" || !KEY_NAMES.has(e.key)) return;
      handleKey({
        key: e.key as TvKeyName,
        action: e.action === "up" ? "up" : "down",
        repeat: typeof e.repeat === "number" ? e.repeat : 0,
        editing: !!e.editing,
      });
    });
  } catch {}
}

type KeyHandler = (k: TvKey) => boolean | void;
interface HandlerEntry {
  fn: KeyHandler;
  when?: () => boolean;
  scope: Scope | null;
}
const handlers: HandlerEntry[] = [];

/**
 * Hears the remote's keys before navigation does (the player's seek and
 * play/pause, an overlay's own keys): return `true` to consume the key.
 * Downs (with their repeats) and ups both come; the newest handler first.
 * `when`: only while it holds. `scoped`: only while the scope it is created
 * in (its `TvScope` or page) is the one the D-pad is in. Removed with the
 * component (or effect) that adds it; also returns the remover.
 */
export function onTvKey(fn: KeyHandler, opts?: { when?: () => boolean; scoped?: boolean }): () => void {
  const h: HandlerEntry = { fn, when: opts?.when, scope: opts?.scoped ? ScopeCtx() : null };
  handlers.push(h);
  const off = () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
  try {
    cleanup(off);
  } catch {}
  return off;
}

type BackFn = () => boolean | void;
const backHandlers: BackFn[] = [];

/** Hears the remote's Back before the shell does (newest first): return
 * `true` when it handled it. Removed with its owner; also returns the
 * remover. */
export function onTvBack(fn: BackFn): () => void {
  backHandlers.push(fn);
  const off = () => {
    const i = backHandlers.indexOf(fn);
    if (i >= 0) backHandlers.splice(i, 1);
  };
  try {
    cleanup(off);
  } catch {}
  return off;
}

/** Back in TV mode, before the shell's own (App.tsx): an open overlay's
 * `onBack`, then the `onTvBack` handlers. Whether one took it. */
export function runTvBack(): boolean {
  const o = activeOverlay();
  if (o?.onBack) {
    o.onBack();
    return true;
  }
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    try {
      if (backHandlers[i]() === true) return true;
    } catch {}
  }
  return false;
}

/** Hold-to-long-press state of the select key. */
let hold: { entry: Entry; timer: ReturnType<typeof setTimeout>; fired: boolean } | null = null;

function handleKey(k: TvKey) {
  if (!untracked(tvMode)) return;
  if (k.action === "down") lastKeyAt = Date.now();
  for (let i = handlers.length - 1; i >= 0; i--) {
    const h = handlers[i];
    if (!h) continue;
    if (h.when && !h.when()) continue;
    if (h.scope && untracked(primary) !== h.scope) continue;
    try {
      if (h.fn(k) === true) {
        if (k.key === "select") cancelHold();
        return;
      }
    } catch (e) {
      console.warn("tv: key handler failed", e);
    }
  }
  if (k.action === "up") {
    // The focused item hears its keys' releases too (hold to talk).
    const c = untracked(current);
    if (c && c.alive && inActive(c) && c.onKey) {
      try {
        if (c.onKey(k) === true) return;
      } catch (e) {
        console.warn("tv: onKey failed", e);
      }
    }
    if (k.key === "select") selectUp();
    return;
  }
  const dir = DIRS[k.key];
  // The first key after the pointer shows where the focus is (an arrow
  // moves nothing yet; select presses what the pointer was on).
  if (!untracked(keysMode) && (dir || k.key === "select" || k.key === "menu")) {
    keysMode.set(true);
    if (dir) {
      showAgain();
      return;
    }
  }
  const cur = untracked(current);
  if (cur && cur.alive && inActive(cur) && cur.onKey) {
    try {
      if (cur.onKey(k) === true) return;
    } catch (e) {
      console.warn("tv: onKey failed", e);
    }
  }
  if (dir) {
    queueMove(dir);
    return;
  }
  if (k.key === "select") selectDown(k);
  else if (k.key === "menu") {
    const t = target();
    if (t?.onLongPress) {
      provisional = false;
      t.onLongPress();
    }
  }
}

/** The focused item if the D-pad can act on it; else the focus goes back
 * into the scope shown (and nothing is pressed this time). */
function target(): Entry | null {
  const e = untracked(current);
  if (e && e.alive && inActive(e) && enabled(e)) return e;
  enterPrimary(false);
  return null;
}

function selectDown(k: TvKey) {
  if (k.repeat > 0) return;
  const e = target();
  if (!e) return;
  provisional = false;
  cancelHold();
  // A long press waits for the release; keys that have none (the
  // desktop's keymap) press at once.
  if (e.onLongPress && hostKeys) {
    const h = {
      entry: e,
      fired: false,
      timer: setTimeout(() => {
        if (hold !== h) return;
        h.fired = true;
        e.onLongPress?.();
      }, LONG_PRESS_MS),
    };
    hold = h;
    return;
  }
  e.onPress?.();
}

function selectUp() {
  const h = hold;
  hold = null;
  if (!h) return;
  clearTimeout(h.timer);
  if (!h.fired && h.entry.alive) h.entry.onPress?.();
}

function cancelHold() {
  if (hold) clearTimeout(hold.timer);
  hold = null;
}

// --- Scopes and entries ------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Memory {
  entry: Entry;
  index?: number;
}

interface Scope {
  kind: "page" | "overlay" | "shell";
  entries: Set<Entry>;
  /** The item last focused in it. */
  last: Entry | null;
  /** Each group's last item (and its index in a virtualized list). */
  memory: Map<string, Memory>;
  /** Overlays: counts only while this holds. */
  active?: () => boolean;
  /** Overlays: what the remote's Back does while it is open. */
  onBack?: () => void;
  alive: boolean;
}

/** What a virtualized rail offers its items (lib/ui.tsx `ListRow`). */
export interface TvList {
  /** Brings item `index` into view (the list mounts what is near it). */
  scrollToIndex: (index: number) => void;
  /** The list's own view, revealed in the page's scroll view. */
  container: () => ViewRef | undefined;
  /** How many items the list has. */
  count: () => number;
}

interface Group {
  id: string;
  axis: "row" | "column";
  list?: TvList;
}

interface Entry {
  scope: Scope;
  ref: ViewRef | undefined;
  group?: Group;
  key?: () => unknown;
  index?: () => number;
  onPress?: () => void;
  onLongPress?: () => void;
  onKey?: (k: TvKey) => boolean | void;
  onFocus?: () => void;
  disabled?: () => boolean;
  autoFocus: boolean;
  rect: Rect | null;
  /** Its view was last measured out of the tree (a branch that went). */
  detached: boolean;
  alive: boolean;
  seq: number;
}

function newScope(kind: Scope["kind"]): Scope {
  return { kind, entries: new Set(), last: null, memory: new Map(), alive: true };
}

const ScopeCtx = context<Scope | null>(null);
const GroupCtx = context<Group | null>(null);
const CellCtx = context<(() => number) | null>(null);

/** The shell's own items (the navigation rail): beside every page. */
const shellScope = newScope("shell");

/** Page scopes by the route object their page renders. */
const pageScopes = new Map<unknown, Scope>();
const pagesVersion = signal(0);
const overlays = signal<Scope[]>([]);

/** The page the D-pad is in: the top page of the tab shown (none while the
 * player shows: it brings its own scope). */
const activePage = computed<Scope | null>(() => {
  pagesVersion();
  if (route().name === "player") return null;
  const stack = stackRoutes();
  const top = stack[stack.length - 1];
  return (top && pageScopes.get(top)) ?? null;
});

function activeOverlay(): Scope | null {
  const list = untracked(overlays);
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s.active || untracked(s.active)) return s;
  }
  return null;
}

/** The scope the D-pad is confined to: the top open overlay, else the page. */
const primary = computed<Scope | null>(() => {
  const list = overlays();
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s.active || s.active()) return s;
  }
  return activePage();
});

function activeScopes(): Scope[] {
  const p = untracked(primary);
  if (p && p.kind === "overlay") return [p];
  if (untracked(route).name === "player") return [];
  return p ? [p, shellScope] : [shellScope];
}

function inActive(e: Entry): boolean {
  return activeScopes().includes(e.scope);
}

function enabled(e: Entry): boolean {
  // Not by `detached`: a cell that could not be measured for a moment (a
  // rail still laying out) is measured again by the next move.
  return e.alive && !!e.ref && !(e.disabled && e.disabled());
}

/** The item with the focus (its highlight shows in keys mode only). */
const current = signal<Entry | null>(null);
/** The highlight shows: the keys drive, not the pointer. */
const keysMode = signal(true);
/** The focus was put somewhere by default, not by the user: a better
 * default arriving later (the billboard's Play) may take it. */
let provisional = true;
/** Focus the item with this key as soon as it is there (`focusKey`). */
let wantKey: unknown = null;

/** The focus highlight shows (TV mode, the keys driving). */
export const focusVisible = computed(() => tvMode() && keysMode());

/** The focus is in the shell's navigation rail (its labels show). */
export const shellFocused = computed(() => {
  const c = current();
  return !!c && c.scope === shellScope && keysMode();
});

let entrySeq = 0;

function register(e: Entry) {
  e.scope.entries.add(e);
  if (wantKey != null && e.key && e.key() === wantKey && inActive(e)) {
    wantKey = null;
    focusEntry(e, { reveal: true });
    return;
  }
  const p = untracked(primary);
  const cur = untracked(current);
  if (e.scope === p && (pendingEnter === p || provisional || !cur || !cur.alive)) scheduleEnter();
}

function unregister(e: Entry) {
  e.alive = false;
  e.scope.entries.delete(e);
  if (hold?.entry === e) cancelHold();
  if (untracked(current) === e) setTimeout(() => void lostFocus(e), 0);
}

/** The focused item went: the nearest one left in its scope takes the
 * focus (a scope no longer shown hands over to the one that is). */
async function lostFocus(e: Entry, detached = false) {
  if (untracked(current) !== e) return;
  if (detached && e.scope.last === e) e.scope.last = null;
  const s = e.scope;
  if (!s.alive || !activeScopes().includes(s)) {
    enterPrimary(false);
    return;
  }
  const from = e.rect;
  const list = [...s.entries].filter(enabled);
  if (!from || list.length === 0) {
    enterPrimary(provisional);
    return;
  }
  const rects = await measureAll(list);
  if (untracked(current) !== e) return;
  let best: Entry | null = null;
  let bestD = Infinity;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  for (const [c, r] of rects) {
    const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best) focusEntry(best, { reveal: true, provisional });
  else enterPrimary(provisional);
}

// --- Choosing and moving the focus -------------------------------------------------------------

async function rectOf(e: Entry): Promise<Rect | null> {
  const r = e.ref;
  if (!r) return null;
  try {
    const m = await r.measure();
    if (!m) {
      e.detached = true;
      return null;
    }
    e.detached = false;
    const w = m.bounds.size.width;
    const h = m.bounds.size.height;
    if (!(w > 0 && h > 0)) return null;
    const rect = { x: m.pagePosition.x, y: m.pagePosition.y, w, h };
    e.rect = rect;
    return rect;
  } catch {
    return null;
  }
}

async function measureAll(list: Entry[]): Promise<[Entry, Rect][]> {
  const rects = await Promise.all(list.map((e) => rectOf(e)));
  const out: [Entry, Rect][] = [];
  rects.forEach((r, i) => {
    if (r) out.push([list[i], r]);
  });
  return out;
}

/** Whether `b` lies in direction `dir` of `a` (Android's FocusFinder rule). */
function inDirection(a: Rect, b: Rect, dir: Dir): boolean {
  switch (dir) {
    case "right":
      return (a.x < b.x || a.x + a.w <= b.x) && a.x + a.w < b.x + b.w;
    case "left":
      return (a.x + a.w > b.x + b.w || a.x >= b.x + b.w) && a.x > b.x;
    case "down":
      return (a.y < b.y || a.y + a.h <= b.y) && a.y + a.h < b.y + b.h;
    case "up":
      return (a.y + a.h > b.y + b.h || a.y >= b.y + b.h) && a.y > b.y;
  }
}

/** Lower is better: the gap along the axis, weighted, plus the offset
 * across it (none while the two overlap across the axis: "in the beam"). */
function score(a: Rect, b: Rect, dir: Dir): number {
  const horiz = dir === "left" || dir === "right";
  const major = Math.max(
    0,
    dir === "right"
      ? b.x - (a.x + a.w)
      : dir === "left"
        ? a.x - (b.x + b.w)
        : dir === "down"
          ? b.y - (a.y + a.h)
          : a.y - (b.y + b.h),
  );
  const overlap = horiz
    ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const centres = horiz
    ? Math.abs(a.y + a.h / 2 - (b.y + b.h / 2))
    : Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
  // In the beam the nearer centre wins a tie (the poster below, not the
  // row's first that also overlaps).
  if (overlap > 0) return 13 * major * major + 0.02 * centres * centres;
  const minor =
    overlap > 0
      ? 0
      : horiz
        ? Math.abs(a.y + a.h / 2 - (b.y + b.h / 2))
        : Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
  return 13 * major * major + minor * minor;
}

function pick(from: Rect, dir: Dir, list: [Entry, Rect][]): Entry | null {
  let best: Entry | null = null;
  let bestScore = Infinity;
  for (const [e, r] of list) {
    if (!inDirection(from, r, dir)) continue;
    const s = score(from, r, dir);
    if (s < bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return best;
}

/** Whether `dir` runs along group `g`'s axis. */
const along = (g: Group | undefined, dir: Dir) =>
  !!g && (g.axis === "row" ? dir === "left" || dir === "right" : dir === "up" || dir === "down");

let moving = false;
let queued: Dir | null = null;

/** One move at a time; a key held down queues one more at most. */
function queueMove(dir: Dir) {
  if (moving) {
    queued = dir;
    return;
  }
  moving = true;
  void move(dir)
    .catch((e) => console.warn("tv: move failed", e))
    .finally(() => {
      moving = false;
      const next = queued;
      queued = null;
      if (next) queueMove(next);
    });
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function move(dir: Dir) {
  provisional = false;
  const cur = untracked(current);
  if (!cur || !cur.alive || !inActive(cur)) {
    enterPrimary(false);
    return;
  }
  // The rail: up / down inside it, right back into the page.
  if (cur.scope === shellScope) {
    if (dir === "right") {
      // On another tab's item, Right opens that tab (as select does).
      if (cur.key && cur.key() !== railKey() && cur.onPress) cur.onPress();
      else enterPage();
      return;
    }
    if (dir === "left") return;
  }
  const from = await rectOf(cur);
  if (!from) {
    // Its view went (or never showed): as if it had unmounted.
    if (cur.detached) await lostFocus(cur, true);
    else enterPrimary(false);
    return;
  }
  const pageItems: Entry[] = [];
  const shellItems: Entry[] = [];
  for (const s of activeScopes()) {
    for (const e of s.entries) {
      if (e === cur || !enabled(e)) continue;
      (s === shellScope ? shellItems : pageItems).push(e);
    }
  }
  let best: Entry | null = null;
  if (cur.scope === shellScope) {
    best = pick(from, dir, await measureAll(shellItems));
  } else {
    const g = cur.group;
    // Along its group's axis, the group first (a rail of posters keeps
    // left / right); a virtualized rail is asked for its next item first.
    if (g && along(g, dir)) {
      if (g.list && cur.index) {
        // A virtualized rail goes by index: the next cell, mounted or not
        // yet (frames measured while it scrolls would pick another row).
        const i = cur.index();
        const next = dir === "right" || dir === "down" ? i + 1 : i - 1;
        if (next >= 0 && next < g.list.count()) {
          best = await cellAt(cur, g, next);
          if (untracked(current) !== cur) return;
          if (!best) return;
        }
      } else {
        const mates = pageItems.filter((e) => e.group?.id === g.id);
        best = pick(from, dir, await measureAll(mates));
      }
      // The end of a rail: left goes to the navigation rail, right stays
      // (never into another row).
      if (!best && g.axis === "row") {
        if (dir === "left" && shellItems.length) best = railItem();
        if (!best) return;
      }
    }
    if (!best) best = pick(from, dir, await measureAll(pageItems));
    // Into the rail only by "left", when the page has nothing there.
    if (!best && dir === "left" && shellItems.length) best = railItem();
  }
  if (!best || untracked(current) !== cur) return;
  // Into another group: the item it was left at.
  if (best.group && best.group.id !== cur.group?.id) best = remembered(best) ?? best;
  focusEntry(best, { reveal: true });
}

/** The cell showing item `index` of `cur`'s virtualized rail: the mounted
 * one, else the list is scrolled there and its cell awaited (half a second
 * at most). */
async function cellAt(cur: Entry, g: Group, index: number): Promise<Entry | null> {
  // The cell must be in the tree (a recycled one waiting in the pool still
  // says its old index).
  const find = async () => {
    for (const e of cur.scope.entries) {
      if (e !== cur && e.group?.id === g.id && e.index && enabled(e) && e.index() === index && (await rectOf(e))) return e;
    }
    return null;
  };
  let e = await find();
  if (e) return e;
  g.list?.scrollToIndex(index);
  for (let n = 0; n < 6 && !e; n++) {
    await wait(80);
    if (untracked(current) !== cur) return null;
    e = await find();
  }
  return e;
}

/** `e`'s group's last item, when it is still there (in a virtualized rail:
 * the cell showing the same index). */
function remembered(e: Entry): Entry | null {
  const g = e.group;
  if (!g) return null;
  const m = e.scope.memory.get(g.id);
  if (!m) return null;
  const same = (x: Entry) => enabled(x) && (m.index == null || !x.index || x.index() === m.index);
  if (same(m.entry)) return m.entry;
  if (m.index == null) return null;
  for (const x of e.scope.entries) {
    if (x.group?.id === g.id && x.index && enabled(x) && x.index() === m.index) return x;
  }
  return null;
}

/** The rail item's key of the tab shown (App.tsx `setRailKey`). */
let railKey: () => unknown = () => null;

function railItem(): Entry | null {
  const k = railKey();
  for (const e of shellScope.entries) if (enabled(e) && e.key && e.key() === k) return e;
  for (const e of shellScope.entries) if (enabled(e)) return e;
  return null;
}

/** Tells the engine which rail item stands for the tab shown (by its
 * `key`): Left from a page lands there. */
export function setRailKey(fn: () => unknown) {
  railKey = fn;
}

/** Scrolls `e` into view, centred, so what is around it shows too (a
 * virtualized rail through its list: one item before it stays in view). */
function reveal(e: Entry) {
  try {
    const list = e.group?.list;
    if (list && e.index) {
      list.scrollToIndex(e.index());
      list.container()?.reveal({ vertical: "center" });
      return;
    }
    e.ref?.reveal({ vertical: "center", horizontal: "center" });
  } catch {}
}

function focusEntry(e: Entry, o: { reveal?: boolean; provisional?: boolean; quiet?: boolean } = {}) {
  current.set(e);
  provisional = !!o.provisional;
  e.scope.last = e;
  if (e.group) e.scope.memory.set(e.group.id, { entry: e, index: e.index?.() });
  if (o.reveal && untracked(keysMode)) reveal(e);
  void rectOf(e);
  if (!o.quiet) {
    try {
      e.onFocus?.();
    } catch {}
  }
}

let pendingEnter: Scope | null = null;
let enterTimer: ReturnType<typeof setTimeout> | undefined;

/** Enters the scope shown once the items registering now are all in. */
function scheduleEnter() {
  if (enterTimer !== undefined) return;
  enterTimer = setTimeout(() => {
    enterTimer = undefined;
    enterPrimary(provisional);
  }, 0);
}

function enterPrimary(fresh: boolean) {
  const p = untracked(primary);
  if (p) void enterScope(p, fresh);
  else if (untracked(route).name !== "player") {
    const r = railItem();
    if (r) focusEntry(r, { provisional: true, quiet: true });
  }
}

/** Puts the focus in `s`: its last item, else its first `autoFocus` item,
 * else the top left one. An empty page lends the focus to the rail until
 * its items come. `fresh`: choose again (the last pick was a default). */
async function enterScope(s: Scope, fresh: boolean): Promise<void> {
  const last = s.last;
  let t: Entry | null = null;
  let byDefault = true;
  if (!fresh && last) {
    const r = remembered(last) ?? (enabled(last) ? last : null);
    if (r) {
      t = r;
      byDefault = false;
    }
  }
  if (!t) for (const e of s.entries) if (e.autoFocus && enabled(e) && (!t || e.seq < t.seq)) t = e;
  if (!t) {
    const list = [...s.entries].filter(enabled);
    if (list.length === 0) {
      pendingEnter = s;
      if (s.kind === "page" && untracked(primary) === s) {
        const r = railItem();
        if (r && untracked(current) !== r) focusEntry(r, { provisional: true, quiet: true });
      }
      return;
    }
    const rects = await measureAll(list);
    if (untracked(primary) !== s) return;
    let minY = Infinity;
    for (const [, r] of rects) minY = Math.min(minY, r.y);
    let bestX = Infinity;
    for (const [e, r] of rects) {
      if (r.y <= minY + 8 && r.x < bestX) {
        bestX = r.x;
        t = e;
      }
    }
  }
  if (!t) return;
  if (pendingEnter === s) pendingEnter = null;
  // The user's own focus in the scope wins over a default.
  const cur = untracked(current);
  if (byDefault && cur && cur.alive && cur.scope === s && !provisional && cur !== t) return;
  focusEntry(t, { reveal: true, provisional: byDefault });
}

/** From the rail into the page: the item it was left at. */
export function enterPage() {
  const p = untracked(activePage);
  if (!p || untracked(primary) !== p) return;
  provisional = false;
  void enterScope(p, false);
}

/** Shows the focus again after the pointer: where it was, else the scope's
 * default. */
function showAgain() {
  const e = untracked(current);
  if (e && e.alive && inActive(e)) reveal(e);
  else enterPrimary(false);
}

/** Focuses the item registered with `key`, now or as soon as it mounts (a
 * settings row that comes back when its picker closes). */
export function focusKey(key: unknown) {
  if (!untracked(tvMode)) return;
  for (const s of activeScopes()) {
    for (const e of s.entries) {
      if (enabled(e) && e.key && e.key() === key) {
        wantKey = null;
        focusEntry(e, { reveal: true });
        return;
      }
    }
  }
  wantKey = key;
}

// --- Pointer ---------------------------------------------------------------------------------------

let lastPointer: { x: number; y: number } | null = null;

/** The pointer moved (or a view moved under a resting pointer): whether
 * it is the user's doing. The highlight goes while the pointer drives. */
function pointerMoved(p?: { x: number; y: number }): boolean {
  if (Date.now() - lastKeyAt < 400) return false;
  if (p) {
    if (lastPointer && Math.abs(p.x - lastPointer.x) < 2 && Math.abs(p.y - lastPointer.y) < 2) return false;
    lastPointer = { x: p.x, y: p.y };
  }
  if (untracked(keysMode)) keysMode.set(false);
  return true;
}

/** `onMouseMove` of the shell's root: pointer movement hides the highlight. */
export function tvPointerMoved(e?: { pagePosition?: { x: number; y: number } }) {
  if (!untracked(tvMode)) return;
  pointerMoved(e?.pagePosition);
}

// --- Focusables ---------------------------------------------------------------------------------------

export interface FocusableOptions {
  /** Select. A pointer's or a finger's press is the view's own: give the
   * view the same handler as its `onPress`. */
  onPress?: () => void;
  /** Holding select ~600 ms, and the menu key. */
  onLongPress?: () => void;
  /** Keys while it has the focus, before navigation (a segmented control's
   * left / right): `true` consumes the key. */
  onKey?: (k: TvKey) => boolean | void;
  /** It got the focus from the keys (not the pointer). */
  onFocus?: () => void;
  /** Identity across remounts (`focusKey`), e.g. a settings row's id. */
  key?: () => unknown;
  /** Its scope's first choice when the scope opens (Play on a title page). */
  autoFocus?: boolean;
  /** Skipped by the D-pad while true. */
  disabled?: () => boolean;
}

/** What `useFocusable` gives a view: put `ref`, `onMouseEnter` and `onPressIn`
 * on it and style it by `focused()`. Outside TV mode it is inert (`ref` a
 * no-op, the handlers `undefined`, `focused` false). */
export interface Focusable {
  ref: (node: ViewRef) => void;
  /** The highlight is on it now. */
  focused: () => boolean;
  /** It holds the focus (also while the pointer hides the highlight). */
  isCurrent: () => boolean;
  onMouseEnter: ((e: { pagePosition?: { x: number; y: number } }) => void) | undefined;
  onPressIn: (() => void) | undefined;
  /** Gives it the focus from code, shown. */
  focus: () => void;
  /** Takes the focus quietly: it was used another way (a text field the
   * pointer focused). */
  claim: () => void;
}

const no = () => false;
const INERT: Focusable = {
  ref: () => {},
  focused: no,
  isCurrent: no,
  onMouseEnter: undefined,
  onPressIn: undefined,
  focus: () => {},
  claim: () => {},
};

/**
 * Registers a pressable with the D-pad. Call in the component's body: its
 * scope (page or overlay) and its group (`TvGroup`) come from where it is
 * rendered; it unregisters with the component.
 *
 *   const f = useFocusable({ onPress: save });
 *   <View ref={f.ref} onMouseEnter={f.onMouseEnter} onPressIn={f.onPressIn}
 *     onPress={save} class={f.focused() ? tvFocus.control : "bg-white/10"} />
 */
export function useFocusable(opts: FocusableOptions): Focusable {
  if (!untracked(tvMode)) return INERT;
  const e: Entry = {
    scope: ScopeCtx() ?? shellScope,
    ref: undefined,
    group: GroupCtx() ?? undefined,
    key: opts.key,
    index: CellCtx() ?? undefined,
    onPress: opts.onPress,
    onLongPress: opts.onLongPress,
    onKey: opts.onKey,
    onFocus: opts.onFocus,
    disabled: opts.disabled,
    autoFocus: !!opts.autoFocus,
    rect: null,
    detached: false,
    alive: true,
    seq: ++entrySeq,
  };
  let registered = false;
  cleanup(() => unregister(e));
  const isCurrent = computed(() => current() === e);
  const focused = computed(() => isCurrent() && keysMode());
  return {
    ref: (node: ViewRef) => {
      e.ref = node;
      e.detached = false;
      if (!registered && e.alive) {
        registered = true;
        register(e);
      }
    },
    focused,
    isCurrent,
    onMouseEnter: (ev) => {
      if (!pointerMoved(ev?.pagePosition)) return;
      if (enabled(e) && inActive(e)) focusEntry(e, { quiet: true });
    },
    onPressIn: () => {
      if (untracked(keysMode)) keysMode.set(false);
      if (e.alive) focusEntry(e, { quiet: true });
    },
    focus: () => {
      if (!e.alive) return;
      keysMode.set(true);
      focusEntry(e, { reveal: true });
    },
    claim: () => {
      if (e.alive) focusEntry(e, { quiet: true });
    },
  };
}

/** A button view in the D-pad's focus: select presses it, the highlight
 * (`focusClass`, the row look by default) shows while it has the focus.
 * Outside TV mode it is the plain pressable view. */
export function TvPressable(props: {
  onPress: () => void;
  label?: string;
  class?: string;
  focusClass?: string;
  style?: Record<string, unknown>;
  autoFocus?: boolean;
  selected?: boolean;
  onFocus?: () => void;
  children?: unknown;
}) {
  const f = useFocusable({ onPress: () => props.onPress(), autoFocus: props.autoFocus, onFocus: () => props.onFocus?.() });
  return (
    <View
      ref={f.ref}
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: !!props.selected }}
      onMouseEnter={f.onMouseEnter}
      onPress={() => props.onPress()}
      class={`${props.class ?? ""} ${f.focused() ? (props.focusClass ?? tvFocus.row) : ""}`}
      style={props.style as never}
    >
      {props.children as never}
    </View>
  );
}

/** A page's scope (App.tsx wraps every page of the stacks): its items and
 * its remembered focus (Back returns to the card that opened the next
 * page). */
export function TvPage(props: { route: object; children: JSX.Element }) {
  if (!untracked(tvMode)) return props.children;
  const s = newScope("page");
  pageScopes.set(props.route, s);
  pagesVersion.set(untracked(pagesVersion) + 1);
  cleanup(() => {
    s.alive = false;
    if (pageScopes.get(props.route) === s) pageScopes.delete(props.route);
    pagesVersion.set(untracked(pagesVersion) + 1);
  });
  return <ScopeCtx.Provider value={s}>{props.children}</ScopeCtx.Provider>;
}

/** The shell's own items (the navigation rail). */
export function TvShellScope(props: { children: JSX.Element }) {
  if (!untracked(tvMode)) return props.children;
  return <ScopeCtx.Provider value={shellScope}>{props.children}</ScopeCtx.Provider>;
}

/**
 * An overlay's scope: while it is mounted (and `active()` holds, when given)
 * the D-pad stays inside it; when it goes, the focus returns to where it
 * was. A sheet, a dialog's card, a menu, the player. `onBack`: the remote's
 * Back while it is open, for an overlay drawn in the page (a `Dialog`
 * hears Back itself: `onOpenChange` / `onCancel`).
 */
export function TvScope(props: { children: JSX.Element; active?: () => boolean; onBack?: () => void }) {
  if (!untracked(tvMode)) return props.children;
  const s = newScope("overlay");
  if (props.active) s.active = () => !!props.active?.();
  if (props.onBack) s.onBack = () => props.onBack?.();
  overlays.set([...untracked(overlays), s]);
  cleanup(() => {
    s.alive = false;
    overlays.set(untracked(overlays).filter((x) => x !== s));
  });
  return <ScopeCtx.Provider value={s}>{props.children}</ScopeCtx.Provider>;
}

/** A group of items: a rail (`axis` "row", the default: left / right stay
 * in it) or a column ("column": up / down stay in it). Coming back into a
 * group returns to its last item. `list`: a virtualized list, whose cells
 * say their index (`TvCell`). */
export function TvGroup(props: { axis?: "row" | "column"; list?: TvList; children: JSX.Element }) {
  if (!untracked(tvMode)) return props.children;
  const g: Group = { id: `g${++entrySeq}`, axis: props.axis ?? "row", list: props.list };
  return <GroupCtx.Provider value={g}>{props.children}</GroupCtx.Provider>;
}

/** A virtualized list's cell: the index of the item it shows (it follows a
 * recycled cell). */
export function TvCell(props: { index: () => number; children: JSX.Element }) {
  if (!untracked(tvMode)) return props.children;
  return <CellCtx.Provider value={props.index}>{props.children}</CellCtx.Provider>;
}

// --- The look ---------------------------------------------------------------------------------------

/**
 * The focus highlight: one definition for the whole TV interface, seen
 * from across a room on any artwork.
 * - `card`: posters and stills: a white ring off the artwork, a slight lift.
 * - `control`: buttons, chips, the rail: filled white (`controlText` and
 *   `CONTROL_INK` for what is drawn on it).
 * - `row`: rows and icon buttons: a bright wash with a white edge inside
 *   (their text stays as it is).
 * - `motion`: on every focusable's base class, so the lift eases in.
 */
export const tvFocus = {
  card: "outline-4 outline-offset-2 outline-white scale-105",
  control: "bg-white scale-105",
  controlText: "text-black",
  row: "bg-white/20 outline-2 -outline-offset-2 outline-white",
  motion: "transition-transform duration-150",
} as const;

/** The colour of icons drawn on a focused control's white fill. */
export const CONTROL_INK = "#0a0a0a";

/** The TV's overscan-safe area: text and controls stay inside it
 * (backgrounds may bleed). */
export const TV_SAFE = { left: 48, right: 48, top: 27, bottom: 27 } as const;

/** The navigation rail's width while closed (App.tsx); pages start there. */
export const RAIL_W = 80;

// --- The TV sheet: menus and confirmations ------------------------------------------------------

export interface SheetAction {
  id: string;
  label: string;
  role?: "default" | "destructive" | "cancel";
}

interface SheetReq {
  title?: string;
  description?: string;
  actions: SheetAction[];
  resolve: (id: string | null) => void;
}

const sheet = signal<SheetReq | null>(null);

/** Asks in the TV's own sheet (a card over the app, its actions in a column
 * the D-pad moves in; Back cancels): the chosen action's id, or null (a
 * "cancel" action, Back). One at a time: a new one cancels the open one. */
export function tvAsk(req: { title?: string; description?: string; actions: SheetAction[] }): Promise<string | null> {
  const prev = untracked(sheet);
  if (prev) prev.resolve(null);
  return new Promise((resolve) => sheet.set({ ...req, resolve }));
}

function answerSheet(id: string | null) {
  const s = untracked(sheet);
  sheet.set(null);
  s?.resolve(id);
}

/** `AlertDialog.show` outside TV mode; the TV sheet in it (a native alert
 * is not in the D-pad's focus). The same answer, `{ action }`. */
export async function showActions(opts: {
  title?: string;
  description?: string;
  presentation?: "actionSheet";
  actions: SheetAction[];
}): Promise<{ action: string | null | undefined }> {
  if (untracked(tvMode)) return { action: await tvAsk(opts) };
  return (await AlertDialog.show(opts as never)) as { action: string | null | undefined };
}

function SheetButton(props: { action: SheetAction; first: boolean }) {
  const press = () => answerSheet(props.action.role === "cancel" ? null : props.action.id);
  const f = useFocusable({ onPress: press, autoFocus: props.first });
  return (
    <View
      ref={f.ref}
      role="button"
      accessibilityLabel={props.action.label}
      onMouseEnter={f.onMouseEnter}
      onPressIn={f.onPressIn}
      onPress={press}
      class={`h-12 cursor-pointer justify-center rounded-xl px-5 ${tvFocus.motion} ${
        f.focused() ? tvFocus.control : "bg-white/10 hover:bg-white/20 active:bg-white/25"
      }`}
    >
      <Text
        class={`font-semibold ${
          f.focused() ? tvFocus.controlText : props.action.role === "destructive" ? "text-red-400" : "text-foreground"
        }`}
        style={{ fontSize: 17, lineHeight: 22, numberOfLines: 1 }}
      >
        {props.action.label}
      </Text>
    </View>
  );
}

/** Where the TV sheet shows (the TV shell mounts it once). It is a dialog,
 * so it shows over the player too. */
export function TvSheetHost() {
  return (
    <If when={sheet()}>
      {(s) => {
        // Cancel last; the first action that destroys nothing has the focus.
        const list = [
          ...s().actions.filter((a) => a.role !== "cancel"),
          ...s().actions.filter((a) => a.role === "cancel"),
        ];
        const first = Math.max(0, list.findIndex((a) => a.role !== "destructive"));
        return (
          <Dialog
            open
            animation="fade"
            onOpenChange={(e: { open: boolean }) => {
              if (!e.open) answerSheet(null);
            }}
            class="absolute inset-0 items-center justify-center bg-black/70"
          >
            <TvScope>
              <View class="gap-2 rounded-2xl border border-border bg-card p-6" style={{ width: 440, maxWidth: "90%" }}>
                <If when={s().title}>
                  {(t) => (
                    <Text class="font-bold text-foreground" style={{ fontSize: 20, lineHeight: 26, numberOfLines: 2 }}>
                      {t()}
                    </Text>
                  )}
                </If>
                <If when={s().description}>
                  {(d) => (
                    <Text class="text-muted-foreground" style={{ fontSize: 15, lineHeight: 21 }}>
                      {d()}
                    </Text>
                  )}
                </If>
                <View class="gap-2 pt-2">
                  <Each of={list}>{(a, i) => <SheetButton action={a()} first={i() === first} />}</Each>
                </View>
              </View>
            </TvScope>
          </Dialog>
        );
      }}
    </If>
  );
}

// --- Host calls ---------------------------------------------------------------------------------------

/** Taps the window that has the focus at (`x`, `y`) dp (`sys.tap`): select on a
 * source's own web page in the player. Android only; false elsewhere. */
export async function tvTap(x: number, y: number): Promise<boolean> {
  if (!hostUp) return false;
  try {
    const r = (await host.call("sys.tap", { x, y } as never)) as { ok?: boolean } | null;
    return !!r?.ok;
  } catch {
    return false;
  }
}

// --- Voice --------------------------------------------------------------------------------------------

/** The device can take dictation (`sys.voice`: Android's speech
 * recognition, on a TV the remote's microphone). Set by `initTv`. */
export const voiceAvailable = signal(false);

/** What is being heard while `tvListen` listens ("" before the first word). */
export const voicePartial = signal("");
/** Why the last listening heard nothing, when it failed (the recognizer's
 * error code: 3 the microphone could not be opened, 9 no permission); 0
 * when it did not fail. */
export const voiceError = signal(0);

let voiceWaiter: ((text: string | null) => void) | null = null;
if (hostUp) {
  try {
    host.on("sys.voicePartial", (d: unknown) => {
      const t = (d as { text?: unknown } | null)?.text;
      if (voiceWaiter) voicePartial.set(typeof t === "string" ? t : "");
    });
    host.on("sys.voiceResult", (d: unknown) => {
      const w = voiceWaiter;
      voiceWaiter = null;
      voicePartial.set("");
      const err = (d as { error?: unknown } | null)?.error;
      voiceError.set(typeof err === "number" ? err : 0);
      const t = (d as { text?: unknown } | null)?.text;
      w?.(typeof t === "string" && t.trim() ? t.trim() : null);
    });
  } catch {}
}

/** Listens once (the system's voice input shows over the app): what was
 * said, or null (nothing heard, cancelled, not available). */
/** Hold to talk: ends the listening now (`tvListen` resolves with what was
 * heard). */
export function tvListenStop() {
  if (!hostUp) return;
  void Promise.resolve(host.call("sys.voiceStop", {} as never)).catch(() => {});
}

/** The key was only tapped: the listening ends by itself at the next pause. */
export function tvListenRelease() {
  if (!hostUp) return;
  void Promise.resolve(host.call("sys.voiceHold", { on: false } as never)).catch(() => {});
}

/** `hold`: keep listening through pauses until `tvListenStop` (or
 * `tvListenRelease`). */
export async function tvListen(prompt?: string, hold = false): Promise<string | null> {
  if (!hostUp || !untracked(voiceAvailable)) return null;
  voiceWaiter?.(null);
  voiceWaiter = null;
  voicePartial.set("");
  voiceError.set(0);
  try {
    const r = (await host.call("sys.voice", { prompt: prompt ?? "", hold } as never)) as { ok?: boolean } | null;
    if (!r?.ok) return null;
  } catch {
    return null;
  }
  return new Promise((done) => {
    const mine = (t: string | null) => done(t);
    voiceWaiter = mine;
    // A lost result must not leave the button listening for ever.
    setTimeout(() => {
      if (voiceWaiter === mine) {
        voiceWaiter = null;
        done(null);
      }
    }, 60000);
  });
}

// --- Install --------------------------------------------------------------------------------------------

/** The TV layer's effects (App, once): the host's key capture, the desktop's
 * stand-in keys, the focus following the scope shown. */
export function installTv() {
  // The host captures the remote's keys while the TV interface runs and
  // leaves them to Android everywhere else (a TV forced off too).
  effect(() => {
    const on = tvMode();
    if (!hostUp) return;
    void Promise.resolve(host.call("sys.keyCapture", { on } as never)).catch(() => {});
  });
  // `cargo run` with `rustflix.tv` = "1": the keyboard stands in for the
  // remote (arrows; Enter / Space select; M the menu key). Never otherwise.
  effect(() => {
    if (!tvMode() || hostKeys) return;
    const down = (key: TvKeyName) => () => handleKey({ key, action: "down", repeat: 0, editing: false });
    try {
      keymap.bind(
        { up: down("up"), down: down("down"), left: down("left"), right: down("right") },
        { when: "notEditing", repeat: true },
      );
      keymap.bind({ enter: down("select"), space: down("select"), m: down("menu") }, { when: "notEditing" });
    } catch {}
  });
  // Another scope shown (a page pushed or popped, a tab, an overlay opened
  // or closed): the focus goes there, unless it already is (or is in the
  // rail beside the page).
  effect(() => {
    if (!tvMode()) return;
    const p = primary();
    untracked(() => {
      if (!p) return;
      const cur = current();
      if (cur && cur.alive && cur.scope === p) return;
      if (cur && cur.alive && cur.scope === shellScope && p.kind === "page") return;
      void enterScope(p, false);
    });
  });
}
