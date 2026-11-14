// Router: one page stack per tab, and a trail of the places visited.
//
// Each tab keeps its own stack of pages (bottom to top, its root first) for
// the whole session: switching tabs shows the other tab's stack as it was
// left (its last page), and the shells keep every tab's `<NavStack>`
// mounted (pages stay, so going back keeps scroll positions). The player
// shows over the stacks; it is a place of its own, and stays resumable
// after navigation leaves it (one player entry at a time).
//
// The trail is the desktop's back/forward history: the places the user
// was, in order (a tab with its stack as it was then, or the player), so
// Back retraces what was visited across tabs and into the player, and
// Forward redoes it. Each route object is the identity of its page: a
// stack keeps a page while its object stays.

import { batch, computed, signal, type Signal, type ViewRef } from "nsh";
import type { MediaType } from "./sources";

export type Route =
  | { name: "home" }
  | { name: "search" }
  | { name: "library" }
  | { name: "downloads" }
  | { name: "settings" }
  /** Phones and tablets in portrait: one Settings category (or a picker,
   * "pick:<row id>") pushed on the Settings tab's stack, so the system
   * back (header chevron, swipe, Android back) leaves it
   * (screens/settings/index.tsx). */
  | { name: "settingsPage"; page: string }
  | { name: "setup" }
  | {
      name: "title";
      type: MediaType;
      id: number;
      /** The poster of the card that opened it (the URL the details resolve
       * to, so it is one cached image): the page's poster slot shows it at
       * once. */
      image?: string;
      /** The title's backdrop at the header's size (the URL the details
       * resolve to), known from the list it was picked in: the header asks
       * for it before the details load. "" when the title has none (the
       * header shows the poster from the first frame). */
      backdrop?: string;
      /** The card's title: shown before the details load. */
      title?: string;
      /** Where the card's poster was on screen (points, in the window), on
       * the desktop: the poster flies from there into the page's poster
       * slot. */
      from?: HeroRect;
      /** The card's poster view, to fly back to on Back while it is still
       * on screen. */
      source?: ViewRef;
      /** That card's `cardKey` (lib/hero.tsx `hiddenCard`). */
      sourceKey?: string;
    }
  | {
      name: "player";
      type: MediaType;
      id: number;
      season?: number;
      episode?: number;
      title?: string;
      poster?: string;
      lang?: "sub" | "dub";
      next?: { season?: number; episode?: number };
    };

/** A frame on screen, in points. */
export interface HeroRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TabName = "home" | "search" | "library" | "downloads" | "settings";

const TAB_NAMES: readonly string[] = ["home", "search", "library", "downloads", "settings"];

export function isTab(r: Route): r is Extract<Route, { name: TabName }> {
  return TAB_NAMES.includes(r.name);
}

/** Each tab's root route, one object per tab for the whole session: the
 * shells keep one page stack per tab mounted (hidden while another tab
 * shows), and a page lives as long as its route object, so a tab's root
 * page — its scroll position, its state — survives switching tabs. */
const TAB_ROOTS: Record<TabName, Route> = {
  home: { name: "home" },
  search: { name: "search" },
  library: { name: "library" },
  downloads: { name: "downloads" },
  settings: { name: "settings" },
};

/** Tab `name`'s root route (the same object every time). */
export function tabRoot(name: TabName): Route {
  return TAB_ROOTS[name];
}

type PlayerRoute = Extract<Route, { name: "player" }>;

/** A place on the trail: a tab showing `path` (its stack then, bottom to
 * top), or the player (the one player entry, whatever it holds now). */
type Loc = { kind: "tab"; tab: TabName; path: Route[] } | { kind: "player" };

const PLAYER: Loc = { kind: "player" };

/** How many places the trail keeps (the oldest go first). */
const TRAIL_MAX = 50;

const initial: Route = TAB_ROOTS.home;

/** The route on top (what is shown). */
export const route = signal<Route>(initial);

/** Each tab's stack, bottom to top (its root first). */
const stacks: Record<TabName, Signal<Route[]>> = {
  home: signal<Route[]>([TAB_ROOTS.home]),
  search: signal<Route[]>([TAB_ROOTS.search]),
  library: signal<Route[]>([TAB_ROOTS.library]),
  downloads: signal<Route[]>([TAB_ROOTS.downloads]),
  settings: signal<Route[]>([TAB_ROOTS.settings]),
};

/** The tab shown (under the player while it shows). */
const tabNow = signal<TabName>("home");

/** The places visited; `at` is the one shown. */
const trail = signal<Loc[]>([{ kind: "tab", tab: "home", path: [initial] }]);
const at = signal(0);

/** The player entry: the play showing, or the one left (resumable). */
let player: PlayerRoute | null = null;
/** Where that play was started from: the player's own close goes back
 * there. */
let playerOver: Extract<Loc, { kind: "tab" }> | null = null;

/** A tab shortcut's excursion: where it started (`origin`) and where the
 * last shortcut landed; the same shortcut again goes back to `origin`. */
let shortcut: { origin: Loc; landed: Loc } | null = null;

/** Bumped when the user picks the tab that is already active (after its
 * stack went back to its root): the root page scrolls to its top. */
export const tabReselected = signal(0);

/** The tab whose stack is shown (the one under the player while it shows). */
export const currentTab = computed<TabName>(() => tabNow());

/** The pages of the current tab's stack, bottom to top (the player shows
 * over them, never in them). */
export const stackRoutes = computed<Route[]>(() => stacks[tabNow()]());

/** Tab `name`'s stack, bottom to top (reactive): what its `<NavStack>`
 * shows, kept while another tab shows. */
export function tabStack(name: TabName): Route[] {
  return stacks[name]();
}

// Runs once whenever navigation leaves the player for a page (back,
// forward, a tab, a fresh navigate): the player uses it to save progress
// and pause the page so nothing keeps playing off-screen.
let leaveHook: (() => void) | null = null;
export function setLeaveHook(fn: (() => void) | null) {
  leaveHook = fn;
}

/** Two routes showing the same thing (the player's display fields aside). */
function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === "title" && b.name === "title") return a.type === b.type && a.id === b.id;
  if (a.name === "settingsPage" && b.name === "settingsPage") return a.page === b.page;
  if (a.name === "player" && b.name === "player") {
    return (
      a.type === b.type &&
      a.id === b.id &&
      a.season === b.season &&
      a.episode === b.episode &&
      (a.lang ?? "sub") === (b.lang ?? "sub")
    );
  }
  return true;
}

function samePath(a: Route[], b: Route[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

function sameLoc(a: Loc, b: Loc): boolean {
  if (a.kind === "player" || b.kind === "player") return a.kind === b.kind;
  return a.tab === b.tab && samePath(a.path, b.path);
}

/** The place shown. */
function here(): Loc {
  return trail()[at()];
}

/** Tab `name` as it was left (its stack's last page). */
function tabLoc(name: TabName): Loc {
  return { kind: "tab", tab: name, path: stacks[name]() };
}

/** Shows `loc`, with the trail becoming `list` at `i` (`loc` is
 * `list[i]`). Leaving the player for a page runs the leave hook first,
 * while the player's route is still the current one. */
function show(list: Loc[], i: number) {
  const loc = list[i];
  const to: Route | undefined =
    loc.kind === "player" ? player ?? undefined : loc.path[loc.path.length - 1];
  if (!to) return;
  if (route().name === "player" && to.name !== "player") {
    // Navigation completes even if saving the player's state fails.
    try {
      leaveHook?.();
    } catch {}
  }
  batch(() => {
    if (loc.kind === "tab") {
      const s = stacks[loc.tab];
      if (!samePath(s(), loc.path)) s.set(loc.path);
      if (tabNow() !== loc.tab) tabNow.set(loc.tab);
    }
    trail.set(list);
    at.set(i);
    route.set(to);
  });
}

/** Goes to `loc` as a new place: forward places are dropped; the same
 * place as the one shown is not added twice. */
function push(loc: Loc) {
  const cur = here();
  if (sameLoc(cur, loc)) {
    const list = trail().slice();
    list[at()] = loc;
    show(list, at());
    return;
  }
  let list = [...trail().slice(0, at() + 1), loc];
  if (list.length > TRAIL_MAX) list = list.slice(list.length - TRAIL_MAX);
  show(list, list.length - 1);
}

/** Shows `loc` in place of the place shown (no new trail entry). */
function replaceHere(loc: Loc) {
  const list = trail().slice();
  list[at()] = loc;
  show(list, at());
}

/** Goes back to `loc`: a step back when it is the place before this one
 * (Forward then returns), else a new place. */
function returnTo(loc: Loc) {
  if (loc.kind === "player" && !player) return;
  if (at() > 0 && sameLoc(trail()[at() - 1], loc)) show(trail(), at() - 1);
  else push(loc);
}

/** A new play replaces the one left: its places go from the trail (the
 * place shown is a page then), and repeats that meet are merged. */
function dropPlayerPlaces() {
  const list: Loc[] = [];
  let i = 0;
  trail().forEach((l, j) => {
    if (l.kind === "player") return;
    const dup = list.length > 0 && sameLoc(list[list.length - 1], l);
    if (!dup) list.push(l);
    if (j === at()) i = list.length - 1;
  });
  batch(() => {
    trail.set(list);
    at.set(i);
  });
}

/** Tab `name` from `navigate` (a screen's or the palette's own link):
 * the tab as it was left; when it is the tab shown, its root. */
function goTab(name: TabName) {
  const cur = here();
  if (cur.kind === "tab" && cur.tab === name) {
    if (cur.path.length > 1) push({ kind: "tab", tab: name, path: [TAB_ROOTS[name]] });
    return;
  }
  // The key page is done with once the app moves on (Setup saves and
  // goes home): its tab does not keep it.
  if (cur.kind === "tab" && cur.path[cur.path.length - 1].name === "setup") {
    stacks[cur.tab].set(cur.path.slice(0, -1));
  }
  push(tabLoc(name));
}

/** Goes to `to`. Nothing happens when it is already shown. A tab goes to
 * that tab as it was left (its root when it is the tab shown). The player:
 * one entry at a time — a new play replaces the one left (and its places
 * on the trail); from the player, it is swapped in place. A page is pushed
 * on the current tab's stack (from the player: the stack it opened over,
 * and when that stack's top is `to`, the player just closes onto it);
 * `replace` swaps the top page instead (the player in place). */
export function navigate(to: Route, opts?: { replace?: boolean }) {
  if (isTab(to)) {
    goTab(to.name);
    return;
  }
  const cur = route();
  if (sameRoute(cur, to)) return;
  if (to.name === "player") {
    if (cur.name === "player") {
      // Another episode / audio of the play: in place, no new place.
      player = to;
      route.set(to);
      return;
    }
    const base = here();
    if (player && !sameRoute(player, to)) dropPlayerPlaces();
    player = to;
    if (base.kind === "tab") playerOver = base;
    push(PLAYER);
    return;
  }
  const loc = here();
  const fromPlayer = loc.kind === "player";
  const base: Extract<Loc, { kind: "tab" }> =
    loc.kind === "tab" ? loc : playerOver ?? { kind: "tab", tab: tabNow(), path: stacks[tabNow()]() };
  let path = base.path;
  if (fromPlayer && sameRoute(path[path.length - 1], to)) {
    push({ ...base, path });
    return;
  }
  if (opts?.replace && !fromPlayer && path.length > 1) {
    path = path.slice(0, -1);
    const below = path[path.length - 1];
    const next: Loc = sameRoute(below, to)
      ? { kind: "tab", tab: base.tab, path }
      : { kind: "tab", tab: base.tab, path: [...path, to] };
    replaceHere(next);
    return;
  }
  push({ kind: "tab", tab: base.tab, path: [...path, to] });
}

/** A tab picked in the tab bar or the sidebar: that tab as it was left;
 * when it is the tab shown, its root, and `tabReselected` bumped (the
 * root scrolls up). */
export function selectTab(name: TabName) {
  const cur = here();
  if (cur.kind === "tab" && cur.tab === name) {
    if (cur.path.length > 1) push({ kind: "tab", tab: name, path: [TAB_ROOTS[name]] });
    tabReselected.set(tabReselected() + 1);
    return;
  }
  push(tabLoc(name));
}

/** A tab's keyboard shortcut (⌘1, ⌘F, ⌘L, ⌘D, ⌘,): goes to that tab as it
 * was left, remembering where the shortcuts started from; the same
 * shortcut again, while its tab shows, goes back there (the player
 * resumes). With no such start, it goes back one place. */
export function toggleTab(name: TabName) {
  const cur = here();
  if (cur.kind === "tab" && cur.tab === name) {
    const s = shortcut;
    shortcut = null;
    if (s && sameLoc(s.landed, cur)) returnTo(s.origin);
    else goBack();
    return;
  }
  const origin = shortcut && sameLoc(shortcut.landed, cur) ? shortcut.origin : cur;
  goTab(name);
  shortcut = { origin, landed: here() };
}

export function canGoBack(): boolean {
  return at() > 0;
}

export function canGoForward(): boolean {
  return at() < trail().length - 1;
}

/** What a page plays before Back takes it away (the title page's poster
 * flying back to its card), by the page's route. */
const leavers = new WeakMap<Route, () => Promise<void>>();
let leavingPage = false;

/** Sets (or with `null` clears) what `r`'s page plays before `goBack`
 * pops it off its stack; the pop happens once it resolves. */
export function setPageLeaver(r: Route, fn: (() => Promise<void>) | null) {
  if (fn) leavers.set(r, fn);
  else leavers.delete(r);
}

/** Back one place on the trail (another tab, the player, the page below).
 * A page with a leaver plays it first when Back pops it off its stack. */
export function goBack() {
  if (!canGoBack() || leavingPage) return;
  const cur = here();
  const target = trail()[at() - 1];
  const pops =
    cur.kind === "tab" &&
    target.kind === "tab" &&
    target.tab === cur.tab &&
    target.path.length === cur.path.length - 1 &&
    target.path.every((r, i) => r === cur.path[i]);
  const r = route();
  const leave = pops ? leavers.get(r) : undefined;
  if (!leave) {
    show(trail(), at() - 1);
    return;
  }
  leavingPage = true;
  void leave()
    .catch(() => {})
    .finally(() => {
      leavingPage = false;
      // Still that page (nothing else navigated meanwhile): leave it.
      if (route() === r && here() === cur && canGoBack()) show(trail(), at() - 1);
    });
}

export function goForward() {
  if (!canGoForward()) return;
  show(trail(), at() + 1);
}

/** The user popped `r`'s page natively (iOS swipe back, the header's back
 * button, Android back): its stack already removed it, so the router
 * shows the page below it, dropping it and what was above it (a native
 * pop has no forward). Never another tab. Nothing when no stack holds
 * that page any more. The desktop's own Back (`goBack`) keeps its forward
 * history. */
export function pagePopped(r: Route) {
  const order = [tabNow(), ...TAB_NAMES.filter((t) => t !== tabNow())] as TabName[];
  for (const tab of order) {
    const list = stacks[tab]();
    const i = list.indexOf(r);
    if (i <= 0) continue;
    const path = list.slice(0, i);
    const cur = here();
    if (cur.kind === "tab" && cur.tab === tab) push({ kind: "tab", tab, path });
    else stacks[tab].set(path);
    if (playerOver && playerOver.tab === tab && playerOver.path.includes(r)) {
      playerOver = { kind: "tab", tab, path };
    }
    return;
  }
}

/** Leaves the player (its close controls, a back press): back to the page
 * it opened over (or home). The play stays resumable (Forward). */
export function exitPlayer() {
  if (route().name !== "player") return;
  shortcut = null;
  returnTo(playerOver ?? tabLoc(tabNow()));
}

export function goTitle(
  type: MediaType,
  id: number,
  from?: {
    image?: string;
    backdrop?: string;
    title?: string;
    from?: HeroRect;
    source?: ViewRef;
    sourceKey?: string;
  },
) {
  navigate({
    name: "title",
    type,
    id,
    image: from?.image || undefined,
    // "" (no backdrop) is kept: it is an answer, not a missing one.
    backdrop: from?.backdrop,
    title: from?.title || undefined,
    from: from?.from,
    source: from?.source,
    sourceKey: from?.sourceKey,
  });
}
