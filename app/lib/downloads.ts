// Download queue engine: one queue on the desktop and the iPhone, both
// driving the host's native downloader behind `dl.*` (desktop: built into
// the Rust shell, src/dl; iPhone: ios/Rustflix/Downloads.swift). Nothing
// is shelled out.
//
// - ONE download at a time: a single scheduler (`pump`) runs the head of
//   the queue — get a link (the playing page's, else a hidden-page resolve
//   through lib/resolver.ts), then download — and starts the next when it
//   finishes, fails, is cancelled or parks as `needsPlay`.
// - The whole list and its order persist in `rustflix.downloads.v2` (no
//   cap; finished entries stay until removed; `v: 3` since the desktop
//   uses the native downloader). `dl.list` is the truth for running /
//   done / error. Desktop entries of the vid-dl era (v1/v2 stores) are
//   migrated once (migrateDesktop).
// - Desktop: the download folder in effect is the host's (`downloadDir`,
//   `changeDownloadDir`, which moves every download).
// - player.ts reaches this module through `registerDownloadEngine` (this
//   module imports player.ts, so player.ts cannot import it back). It is
//   loaded by screens/ResolverHost.tsx.
//
// Test hook: Storage `rustflix.dltest` = JSON DlTarget[] is enqueued 3 s
// after boot (and removed); while armed, every state/source/message/
// progress change writes a snapshot to `rustflix.dltest.result`.

import { computed, host, signal, Storage, untracked } from "nsh";
import type { Accessor } from "nsh";
import process from "process";
import {
  canDownload as playerCanDownload,
  currentStreamLink,
  debug,
  defaultDownloadDir as playerDefaultDownloadDir,
  downloads as legacyDownloads,
  episodes as playerEpisodes,
  homeDir,
  nextEpisodeOf,
  notify,
  onEpisodeWatched,
  onStreamLink,
  playerRoute,
  playerTitle,
  refreshStreams,
  registerDownloadEngine,
  setHomeDir,
  sourceId,
  type DownloadItem,
  type EpisodeInfo,
  type PlayerRoute,
  type StreamLink,
} from "./player";
import { cancelResolve, ensureResolverHost, resolveStream, type ResolveRequest, type ResolveResult } from "./resolver";
import { dropLink, findLink, linkKey, putLink, type CachedLink } from "./playback/linkcache";
import { navigate, selectTab } from "./router";
import { PLAYER_SOURCES, sourceSupports } from "./sources";
import { itemKey, libraryReady, onSettingsChange, progress, saveSettings, settings } from "./store";
import { loadCues, searchSubtitles, type Cue } from "./subtitles";

// --- Types ----------------------------------------------------------------------

export type DlState = "queued" | "resolving" | "running" | "done" | "error" | "needsPlay";
export type DlTarget = {
  type: "movie" | "tv" | "anime";
  id: number;
  season?: number;
  episode?: number;
  lang?: "sub" | "dub";
  title: string;
  episodeName?: string;
  poster?: string;
  still?: string;
};
export type DlEntry = DlTarget & {
  dlId: number;
  key: string;
  name: string;
  state: DlState;
  progress: number | null;
  message: string;
  reason: string | null;
  bytes: number | null;
  waiting: "wifi" | "network" | null;
  source: string | null;
  createdAt: number;
  finishedAt: number | null;
  file?: string;
  dir?: string;
  kind?: "file" | "hls";
};

/** Engine-only fields, persisted next to each entry (`x`). */
type Internal = {
  /** Expired-link recoveries used (max 2). */
  retries: number;
  /** The native downloader has a record with this id. */
  native?: boolean;
  /** Continue the native record without a new link (retry after cancel). */
  resumeNative?: boolean;
  subsTried?: boolean;
};

type Link = {
  url: string;
  kind: "hls" | "file";
  headers: Record<string, string>;
  ua: string;
  source: string | null;
  at: number;
};

// --- Platform -------------------------------------------------------------------

const PLATFORM = process.platform;
const IOS = PLATFORM === "ios";
let hostUp = false;
try {
  hostUp = host.available();
} catch {}
const ANDROID = PLATFORM === "android";
/** A desktop OS (macOS, the GPUI shell). */
const DESKTOP = !IOS && !ANDROID;
/** The host's native downloader (`dl.*`): the iPhone app, the desktop
 * shell and the Android app (the desktop's Rust downloader over JNI,
 * android/rustflix-dl) all have one. */
const NATIVE = (IOS || DESKTOP || ANDROID) && hostUp;

const DL_KEY = "rustflix.downloads.v2";
const OLD_KEY = "rustflix.downloads.v1";
const SRC_KEY = "rustflix.dlsources.v1";
const SUBS_PREFIX = "rustflix.dlsubs.";
const TEST_KEY = "rustflix.dltest";
const TEST_RESULT_KEY = "rustflix.dltest.result";

/** Sources that returned a link from a hidden page in real runs, in order. */
export const KNOWN_GOOD_SOURCES = ["vidfast", "vidrift", "aether"];
/** A stored link older than this is re-resolved instead. */
const LINK_TTL_MS = 10 * 60_000;
const MAX_EXPIRED_RETRIES = 2;
/** Ids the JS side made before `dl.nextId` answered. */
const PROVISIONAL_BASE = 2_000_000_000;
/** Saved subtitle JSON stays under this (Storage limits). */
const SUBS_MAX_CHARS = 400_000;

// --- State ----------------------------------------------------------------------

/** Every entry; the order of the waiting ones (queued / needsPlay) is the
 * queue order. */
const entries = signal<DlEntry[]>([]);
const internals = new Map<number, Internal>();
/** Links waiting for their entry's turn. */
const pendingLinks = new Map<number, Link>();
/** downloadCurrent() is waiting for the playing page's link: not scheduled. */
const held = new Set<number>();
/** Run tokens: cancel/remove/restart bump them so late callbacks of an
 * older run do nothing. */
const runs = new Map<number, number>();
/** Last toast per entry (state|tag), so each state change speaks once. */
const toasted = new Map<number, string>();
/** Renamed ids (provisional → native). */
const aliases = new Map<number, number>();
/** Native ids removed here: their late events are ignored. */
const removedIds = new Set<number>();
const reserving = new Map<number, Promise<number>>();
/** `${type}:${id}` → the source that last returned a link. */
let titleSources: Record<string, string> = {};
let seq = 0;
let provSeq = 0;
let ready = false;
let inited = false;

const ACTIVE: DlState[] = ["queued", "resolving", "running"];
const WAITING: DlState[] = ["queued", "needsPlay"];

function queueOf(all: DlEntry[]): DlEntry[] {
  return [
    ...all.filter((e) => e.state === "running" || e.state === "resolving"),
    ...all.filter((e) => WAITING.includes(e.state)),
  ];
}

/** Every entry: the queue in run order, then the rest, newest first. */
export const downloadList: Accessor<DlEntry[]> = computed<DlEntry[]>(() => {
  const all = entries();
  const rest = all
    .filter((e) => e.state === "done" || e.state === "error")
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
  return [...queueOf(all), ...rest];
});

/** queued | resolving | running | needsPlay, in run order. */
export const downloadQueue: Accessor<DlEntry[]> = computed<DlEntry[]>(() => queueOf(entries()));

/** queued + resolving + running (the Downloads badge). */
export const downloadActiveCount: Accessor<number> = computed<number>(
  () => entries().filter((e) => ACTIVE.includes(e.state)).length,
);

const spaceSig = signal<{ used: number; free: number } | null>(null);
/** Space used by downloads and free on their volume; null until
 * `refreshDownloadSpace()` ran (or where unknown). */
export const downloadSpace: Accessor<{ used: number; free: number } | null> = spaceSig;

export function canDownload(): boolean {
  return playerCanDownload();
}

// --- Keys and names -----------------------------------------------------------------

/** The entry key: itemKey with TV seasons defaulting to 1 and episodes to 1. */
function keyOf(t: { type: string; id: number; season?: number; episode?: number }): string {
  const type = t.type as DlTarget["type"];
  if (type === "movie") return itemKey(type, t.id, 0, 0);
  if (type === "tv") return itemKey(type, t.id, t.season || 1, t.episode || 1);
  return itemKey(type, t.id, 0, t.episode || 1);
}

function entryName(t: DlTarget): string {
  const ep =
    t.type === "tv"
      ? ` S${t.season || 1}E${t.episode || 1}`
      : t.type === "anime"
        ? ` E${t.episode || 1}${t.lang === "dub" ? " (dub)" : ""}`
        : "";
  const base = `${t.title || "video"}${ep}`.replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 120);
  return base || "video";
}

function cleanTarget(t: DlTarget): DlTarget {
  const out: DlTarget = { type: t.type, id: Number(t.id), title: String(t.title || "") };
  if (t.type === "tv") out.season = Number(t.season) || 1;
  if (t.type !== "movie") out.episode = Number(t.episode) || 1;
  if (t.type === "anime") out.lang = t.lang === "dub" ? "dub" : "sub";
  if (t.episodeName) out.episodeName = String(t.episodeName);
  if (t.poster) out.poster = String(t.poster);
  if (t.still) out.still = String(t.still);
  return out;
}

function resolveId(id: number): number {
  let cur = id;
  for (let i = 0; i < 5 && aliases.has(cur); i++) cur = aliases.get(cur)!;
  return cur;
}

function get(id: number): DlEntry | undefined {
  const real = resolveId(id);
  return untracked(entries).find((e) => e.dlId === real);
}

function byKey(key: string): DlEntry | undefined {
  return untracked(entries).find((e) => e.key === key);
}

/** The entry for a player route (the same episode; anime: the same audio). */
function forRoute(r: { type: string; id: number; season?: number; episode?: number; lang?: string }): DlEntry | undefined {
  const e = byKey(keyOf(r));
  if (!e) return undefined;
  if (e.type === "anime" && (e.lang ?? "sub") !== (r.lang ?? "sub")) return undefined;
  return e;
}

function internal(id: number): Internal {
  let x = internals.get(id);
  if (!x) {
    x = { retries: 0 };
    internals.set(id, x);
  }
  return x;
}

/** Reactive lookup by title/episode. */
export function downloadFor(
  type: DlTarget["type"],
  id: number,
  season?: number,
  episode?: number,
): DlEntry | null {
  const key = keyOf({ type, id, season, episode });
  return entries().find((e) => e.key === key) ?? null;
}

/** Reactive: every episode of a title. `done`: finished, `active`:
 * queued + resolving + running. */
export function titleDownloads(
  type: DlTarget["type"],
  id: number,
): { done: number; active: number; entries: DlEntry[] } {
  const list = downloadList().filter((e) => e.type === type && e.id === id);
  return {
    done: list.filter((e) => e.state === "done").length,
    active: list.filter((e) => ACTIVE.includes(e.state)).length,
    entries: list,
  };
}

// --- Changes, persistence, toasts --------------------------------------------------

function setEntries(next: DlEntry[], immediate: boolean) {
  entries.set(next);
  mirrorLegacy(next);
  persistSoon(immediate);
}

function patch(id: number, p: Partial<DlEntry>) {
  const cur = get(id);
  if (!cur) return;
  const next = { ...cur, ...p };
  const stateChanged = next.state !== cur.state;
  setEntries(
    untracked(entries).map((e) => (e.dlId === cur.dlId ? next : e)),
    stateChanged || next.reason !== cur.reason,
  );
  if (stateChanged) debug("download: state", { id: cur.dlId, from: cur.state, to: next.state, msg: next.message });
  noteTest(cur, next);
}

function insert(e: DlEntry, x?: Internal) {
  if (x) internals.set(e.dlId, x);
  setEntries([...untracked(entries), e], true);
  noteTest(null, e);
}

/** At most one toast per entry and state change (`tag`). */
function toast(e: DlEntry, tag: string, text: string, kind: "info" | "success" | "error") {
  if (toasted.get(e.dlId) === tag) return;
  toasted.set(e.dlId, tag);
  notify(text, kind);
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(immediate: boolean) {
  if (!ready) return;
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = undefined;
    persistNow();
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    persistNow();
  }, 2000);
}

/** v3: entries of the native downloader on every platform (v2 desktop
 * entries were vid-dl's). */
const STORE_VERSION = 3;

function persistNow() {
  const list = untracked(entries).map((e) => ({ ...e, x: internals.get(e.dlId) ?? { retries: 0 } }));
  void Storage.setItem(DL_KEY, JSON.stringify({ v: STORE_VERSION, seq, entries: list })).catch(() => {});
}

function mirrorLegacy(list: DlEntry[]) {
  const status = (s: DlState): DownloadItem["status"] =>
    s === "done" ? "done" : s === "error" || s === "needsPlay" ? "error" : "running";
  legacyDownloads.set(
    list.map((e) => ({
      id: e.dlId,
      name: e.name,
      status: status(e.state),
      progress: e.progress,
      message: e.message,
      key: e.key,
      type: e.type,
      mediaId: e.id,
      season: e.season,
      episode: e.episode,
      title: e.title,
      dir: e.dir,
      file: e.file,
      kind: e.kind,
      createdAt: e.createdAt,
    })),
  );
}

function rememberSource(e: DlEntry, source: string | null) {
  if (!source || !KNOWN_GOOD_SOURCES.includes(source)) return;
  const k = `${e.type}:${e.id}`;
  if (titleSources[k] === source) return;
  const next: Record<string, string> = { [k]: source };
  for (const [key, v] of Object.entries(titleSources).slice(0, 199)) if (key !== k) next[key] = v;
  titleSources = next;
  void Storage.setItem(SRC_KEY, JSON.stringify(titleSources)).catch(() => {});
}

// --- Test hook ----------------------------------------------------------------------

let testArmed = false;
const testLog: string[] = [];
let testTimer: ReturnType<typeof setTimeout> | undefined;
let testT0 = 0;

function noteTest(prev: DlEntry | null, next: DlEntry) {
  if (!testArmed) return;
  const changed =
    !prev ||
    prev.state !== next.state ||
    prev.source !== next.source ||
    prev.message !== next.message ||
    prev.progress !== next.progress;
  if (!changed) return;
  if (!prev || prev.state !== next.state || prev.source !== next.source) {
    testLog.push(`+${Date.now() - testT0}ms #${next.dlId} ${next.key} ${next.state} ${next.source ?? "-"} ${next.message}`);
    if (testLog.length > 200) testLog.shift();
  }
  if (testTimer) return;
  testTimer = setTimeout(() => {
    testTimer = undefined;
    writeTestSnapshot();
  }, 500);
}

function writeTestSnapshot() {
  const list = untracked(downloadList).map((e) => ({
    dlId: e.dlId,
    key: e.key,
    name: e.name,
    state: e.state,
    source: e.source,
    message: e.message,
    progress: e.progress,
    reason: e.reason,
    waiting: e.waiting,
  }));
  const idle = !list.some((e) => ACTIVE.includes(e.state));
  void Storage.setItem(TEST_RESULT_KEY, JSON.stringify({ at: Date.now(), idle, entries: list, log: testLog })).catch(() => {});
}

async function armTestHook() {
  let raw: string | null = null;
  try {
    raw = await Storage.getItem(TEST_KEY);
  } catch {}
  if (!raw) return;
  try {
    await Storage.removeItem(TEST_KEY);
  } catch {}
  let targets: DlTarget[] = [];
  try {
    const v = JSON.parse(raw);
    targets = Array.isArray(v) ? v : [v];
  } catch (e) {
    await Storage.setItem(TEST_RESULT_KEY, JSON.stringify({ error: `bad JSON: ${String(e)}` })).catch(() => {});
    return;
  }
  testArmed = true;
  testT0 = Date.now();
  setTimeout(() => {
    testLog.push(`+${Date.now() - testT0}ms enqueue ${targets.length}`);
    enqueueMany(targets);
    writeTestSnapshot();
  }, 3000);
}

// --- Scheduler ------------------------------------------------------------------------

function busy(): DlEntry | undefined {
  return untracked(entries).find((e) => e.state === "running" || e.state === "resolving");
}

function bump(id: number): number {
  const t = (runs.get(id) ?? 0) + 1;
  runs.set(id, t);
  return t;
}

function live(id: number, t: number): boolean {
  const real = resolveId(id);
  return runs.get(real) === t && !!get(real);
}

/** Starts the head of the queue when nothing runs. */
function pump() {
  if (!ready || dirChanging) return;
  if (busy()) return;
  const next = untracked(entries).find((e) => e.state === "queued" && !held.has(e.dlId));
  if (!next) return;
  void runEntry(next.dlId);
}

function freshLink(l: Link | undefined): l is Link {
  return !!l && Date.now() - l.at <= LINK_TTL_MS;
}

function fromStream(l: StreamLink): Link {
  return { url: l.url, kind: l.kind, headers: l.headers, ua: l.ua, source: l.source, at: l.at };
}

/** A link of the shared cache (lib/playback/linkcache.ts) as a download link. */
function fromCache(l: CachedLink): Link {
  const headers = { ...l.headers };
  if (l.cookies && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers["Cookie"] = l.cookies;
  return { url: l.url, kind: l.kind, headers, ua: l.ua, source: l.source, at: l.at };
}

/** A stored link still fresh, else the playing page's link when the
 * player shows this entry's episode, else one the player resolved (the
 * episode playing, or the next one resolved ahead) in the shared cache. */
function takeLink(e: DlEntry | undefined): Link | null {
  if (!e) return null;
  const p = pendingLinks.get(e.dlId);
  pendingLinks.delete(e.dlId);
  if (freshLink(p)) return p;
  const live = untracked(() => currentStreamLink());
  if (live && forRoute(live.route)?.dlId === e.dlId) return fromStream(live);
  const cached = findLink(e, resolveOrder(e)) ?? findLink(e);
  if (cached) return fromCache(cached);
  return null;
}

/** An expired link: no cached link of this episode is handed out again. */
function dropLinks(e: DlEntry) {
  for (const s of PLAYER_SOURCES) dropLink(linkKey(e, s.id));
}

async function runEntry(id: number) {
  const e = get(id);
  if (!e) return;
  const t = bump(id);
  const x = internal(id);
  if (NATIVE && x.resumeNative && x.native) {
    x.resumeNative = false;
    patch(id, { state: "running", reason: null, message: "Resuming…" });
    await nativeStart(id, t, null);
    return;
  }
  x.resumeNative = false;
  let link = takeLink(e);
  if (!link) {
    patch(id, { state: "resolving", reason: null, message: "Getting the video link…" });
    link = await resolveEntry(id, t);
    if (!live(id, t)) return;
    if (!link) {
      parkNeedsPlay(id);
      pump();
      return;
    }
  }
  await startTransfer(id, t, link);
}

async function startTransfer(id: number, t: number, link: Link) {
  const e = get(id);
  if (!e) return;
  rememberSource(e, link.source);
  patch(id, { state: "running", reason: null, waiting: null, source: link.source, kind: link.kind, message: "Starting…" });
  if (NATIVE) {
    await nativeStart(id, t, link);
    return;
  }
  fail(id, "failed", "Downloads aren't available here.");
  pump();
}

/** Source order for a hidden resolve: the one that worked for this title,
 * the user's own when it is a known-good one, then the rest of the
 * known-good set — only those that can play the title. Anime: Vidnest,
 * once. */
export function resolveOrder(t: { type: DlTarget["type"]; id: number }): string[] {
  if (t.type === "anime") return sourceSupports("vidnest", "anime") ? ["vidnest"] : [];
  const list: string[] = [];
  const mem = titleSources[`${t.type}:${t.id}`];
  if (mem && KNOWN_GOOD_SOURCES.includes(mem)) list.push(mem);
  const sel = untracked(sourceId);
  if (KNOWN_GOOD_SOURCES.includes(sel)) list.push(sel);
  list.push(...KNOWN_GOOD_SOURCES);
  return [...new Set(list)].filter((s) => sourceSupports(s, t.type));
}

function sourceLabel(id: string): string {
  return PLAYER_SOURCES.find((s) => s.id === id)?.label ?? id;
}

async function resolveEntry(id: number, t: number): Promise<Link | null> {
  const e0 = get(id);
  if (!e0) return null;
  for (const src of resolveOrder(e0)) {
    if (!live(id, t)) return null;
    const pl = takeLink(get(id));
    if (pl) return pl;
    const e = get(id)!;
    patch(id, { source: src, message: `Getting the video link (${sourceLabel(src)})…` });
    const req: ResolveRequest = {
      type: e.type,
      id: e.id,
      season: e.season,
      episode: e.episode,
      lang: e.lang,
      source: src,
      // The resolver's own per-source budget (resolvecore SOURCE_TIMEOUT).
      // The resolver's queue: the player's resolves go first.
      tag: "dl",
      priority: 0,
      // Desktop, app not in front and the hidden view not made yet.
      onWaiting: () => {
        if (live(id, t) && get(id)?.message !== "Waiting to continue…") patch(id, { message: "Waiting to continue…" });
      },
    };
    let res: ResolveResult;
    try {
      res = await resolver(req);
    } catch (err) {
      res = { ok: false, error: String(err), source: src, mode: "opacity", ms: 0, steps: [] };
    }
    if (!live(id, t)) return null;
    if (res.ok && res.url) {
      const source = res.source === "player" ? (untracked(() => currentStreamLink())?.source ?? src) : res.source;
      const link: Link = {
        url: res.url,
        kind: res.kind ?? (/\.m3u8(\?|#|$)/i.test(res.url) ? "hls" : "file"),
        headers: res.headers ?? {},
        ua: res.ua ?? "",
        source,
        at: Date.now(),
      };
      // Shared with the player: playing this episode now needs no resolve.
      const cookies = typeof res.cookies === "string" && res.cookies ? res.cookies : undefined;
      if (res.native !== false) putLink(linkKey(e, source ?? src), { ...link, source: source ?? src, cookies, frameOrigin: res.frameOrigin });
      if (cookies && !Object.keys(link.headers).some((k) => k.toLowerCase() === "cookie")) link.headers = { ...link.headers, Cookie: cookies };
      return link;
    }
    // Cancelled because the playing page gave a link meanwhile.
    const late = takeLink(get(id));
    if (late) return late;
    debug("download: resolve failed", { id, src, error: res.error });
  }
  return takeLink(get(id));
}

function parkNeedsPlay(id: number) {
  const e = get(id);
  if (!e) return;
  patch(id, { state: "needsPlay", reason: null, source: null, progress: e.progress, message: "Play once to download" });
  const n = get(id)!;
  toast(n, "needsPlay", `Couldn't get ${n.name} in the background — play it once to download`, "info");
}

function plainError(reason: string, detail?: string): string {
  switch (reason) {
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "The video link expired. Try again.";
    case "drm":
      return "This video is protected and can't be downloaded.";
    case "nolink":
      return "Couldn't get a video link.";
    case "space":
      return detail || "Not enough free space.";
    default:
      return detail ? `Download failed: ${detail}` : "Download failed.";
  }
}

function normReason(r: unknown): string {
  return r === "expired" || r === "cancelled" || r === "space" || r === "drm" || r === "nolink" ? (r as string) : "failed";
}

function fail(id: number, reason: string, message: string, free?: number) {
  const e = get(id);
  if (!e) return;
  patch(id, { state: "error", reason, message, waiting: null });
  const n = get(id)!;
  if (reason === "cancelled") return;
  const text =
    reason === "space"
      ? `${n.name}: not enough space${typeof free === "number" ? ` (${formatSize(free)} free)` : ""}`
      : `${n.name} download failed: ${message}`;
  toast(n, `error|${reason}`, text, "error");
}

function finished(id: number, p: Partial<DlEntry>) {
  patch(id, { progress: 100, waiting: null, ...p, state: "done", reason: null, finishedAt: Date.now() });
  const n = get(id);
  if (n) toast(n, "done", `${n.name} downloaded`, "success");
}

/** An expired link: get a fresh one and continue (at most twice per entry). */
async function onExpired(id: number) {
  // The link that expired is never handed out again (shared cache).
  const exp = get(resolveId(id));
  if (exp) dropLinks(exp);
  const x = internal(resolveId(id));
  if (x.retries >= MAX_EXPIRED_RETRIES) {
    fail(id, "expired", plainError("expired"));
    pump();
    return;
  }
  x.retries++;
  const t = bump(resolveId(id));
  patch(id, { state: "resolving", waiting: null, message: "The link expired — getting a fresh one…" });
  const link = await resolveEntry(id, t);
  if (!live(id, t)) return;
  if (!link) {
    parkNeedsPlay(id);
    pump();
    return;
  }
  await startTransfer(resolveId(id), t, link);
}

// --- Public actions ------------------------------------------------------------------

function newEntry(t: DlTarget): DlEntry {
  const c = cleanTarget(t);
  const id = NATIVE ? PROVISIONAL_BASE + ++provSeq : ++seq;
  const e: DlEntry = {
    ...c,
    dlId: id,
    key: keyOf(c),
    name: entryName(c),
    state: "queued",
    progress: null,
    message: "Waiting",
    reason: null,
    bytes: null,
    waiting: null,
    source: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  insert(e, { retries: 0 });
  if (NATIVE) reserveNativeId(id);
  return e;
}

/** Back into the queue (at its end) for another try. */
function requeue(e: DlEntry) {
  const x = internal(e.dlId);
  x.retries = 0;
  x.resumeNative = NATIVE && !!x.native && e.reason === "cancelled";
  bump(e.dlId);
  toasted.delete(e.dlId);
  const next: DlEntry = { ...e, state: "queued", reason: null, message: "Waiting", waiting: null };
  setEntries([...untracked(entries).filter((x2) => x2.dlId !== e.dlId), next], true);
  noteTest(e, next);
}

function willWait(exceptId?: number): boolean {
  return !!busy() || untracked(entries).some((e) => e.state === "queued" && e.dlId !== exceptId && !held.has(e.dlId));
}

function enqueueOne(t: DlTarget): { entry: DlEntry; added: boolean; waits: boolean } {
  const key = keyOf(cleanTarget(t));
  const ex = byKey(key);
  if (ex && ex.state !== "error") return { entry: ex, added: false, waits: false };
  const waits = willWait(ex?.dlId);
  if (ex) requeue(ex);
  const e = ex ? get(ex.dlId)! : newEntry(t);
  return { entry: e, added: true, waits };
}

/** Adds a title/episode to the queue; returns the existing entry when it
 * has one that is not an error (an error entry is queued again). */
export function enqueueDownload(t: DlTarget): DlEntry {
  const r = enqueueOne(t);
  if (r.added && r.waits) toast(r.entry, "queued", "Added to downloads", "info");
  pump();
  return get(r.entry.dlId) ?? r.entry;
}

/** Adds several, keeping the given order (one toast for the lot). */
export function enqueueMany(ts: DlTarget[]): DlEntry[] {
  const out: DlEntry[] = [];
  let added = 0;
  let waits = false;
  for (const t of ts) {
    const r = enqueueOne(t);
    out.push(r.entry);
    if (r.added) {
      added++;
      waits = waits || r.waits || added > 1;
    }
  }
  if (added && waits) {
    const last = out[out.length - 1];
    if (last) toast(last, "queued", added > 1 ? `Added ${added} downloads` : "Added to downloads", "info");
  }
  pump();
  return out.map((e) => get(e.dlId) ?? e);
}

/** Moves an entry to the front of the waiting queue. */
function toFront(id: number) {
  const e = get(id);
  if (!e) return;
  setEntries([e, ...untracked(entries).filter((x) => x.dlId !== e.dlId)], true);
}

/** The video in the player, from the link its page already exposed (no
 * hidden resolve). Waits up to ~8 s for a fresh link. */
export function downloadCurrent(): DlEntry | null {
  const r = playerRoute();
  if (!r) return null;
  if (!canDownload()) {
    notify("Downloads aren't available here", "error");
    return null;
  }
  const ep = r.type !== "movie" ? playerEpisodes().find((x) => x.n === (r.episode ?? 1)) : undefined;
  const target: DlTarget = {
    type: r.type,
    id: r.id,
    season: r.type === "tv" ? r.season ?? 1 : undefined,
    episode: r.type === "movie" ? undefined : r.episode ?? 1,
    lang: r.type === "anime" ? r.lang ?? "sub" : undefined,
    title: playerTitle(),
    poster: r.poster,
    episodeName: ep?.name || undefined,
    still: ep?.still,
  };
  const ex = forRoute(r) ?? byKey(keyOf(target));
  if (ex?.state === "done") {
    notify(`${ex.name} is already downloaded`, "info");
    return ex;
  }
  if (ex && (ex.state === "running" || ex.state === "resolving")) {
    notify(`${ex.name} is already downloading — it keeps going if you leave`, "info");
    return ex;
  }
  let e: DlEntry;
  if (ex) {
    if (ex.state === "error") requeue(ex);
    e = get(ex.dlId)!;
  } else {
    e = newEntry(target);
  }
  const id = e.dlId;
  held.add(id);
  patch(id, { message: "Waiting for the video link…" });
  const matches = (): StreamLink | null => {
    const l = untracked(() => currentStreamLink());
    return l && forRoute(l.route)?.dlId === resolveId(id) ? l : null;
  };
  const go = (l: StreamLink) => {
    const real = resolveId(id);
    held.delete(real);
    pendingLinks.set(real, fromStream(l));
    toFront(real);
    const waits = !!busy();
    const n = get(real)!;
    if (waits) toast(n, "queued", "Added to downloads", "info");
    else toast(n, "current", `Downloading ${n.name} — keeps going if you leave`, "info");
    pump();
  };
  const now = matches();
  if (now) {
    go(now);
    return get(id) ?? e;
  }
  refreshStreams();
  const t0 = Date.now();
  const iv = setInterval(() => {
    const real = resolveId(id);
    if (!get(real) || !held.has(real)) {
      clearInterval(iv);
      return;
    }
    const l = matches();
    if (l) {
      clearInterval(iv);
      go(l);
      return;
    }
    if (Date.now() - t0 >= 8000) {
      clearInterval(iv);
      held.delete(real);
      fail(real, "nolink", "No video link yet — let the video play a few seconds, then try again.");
      pump();
      return;
    }
    refreshStreams();
  }, 1000);
  return get(id) ?? e;
}

/** Stops it and keeps the row as error/cancelled (retry possible). */
export function cancelDownload(dlId: number): void {
  const e = get(dlId);
  if (!e || e.state === "done" || e.state === "error") return;
  const id = e.dlId;
  bump(id);
  held.delete(id);
  pendingLinks.delete(id);
  if (e.state === "resolving") cancelResolve("dl");
  if (e.state === "running") stopTransfer(id);
  patch(id, { state: "error", reason: "cancelled", message: "Cancelled", waiting: null });
  pump();
}

function stopTransfer(id: number) {
  if (NATIVE && internal(id).native) void host.call("dl.cancel", { id }).catch(() => {});
}

/** Queues an error / needsPlay entry again. */
export function retryDownload(dlId: number): void {
  const e = get(dlId);
  if (!e || (e.state !== "error" && e.state !== "needsPlay")) return;
  requeue(e);
  pump();
}

/** Stops it if running, deletes its files (Mac: its folder to the Trash)
 * and drops the row. */
export async function removeDownload(dlId: number): Promise<void> {
  const e = get(dlId);
  if (!e) return;
  const id = e.dlId;
  bump(id);
  held.delete(id);
  pendingLinks.delete(id);
  const wasResolving = e.state === "resolving";
  // Gone from the list first: late callbacks find nothing to update.
  setEntries(untracked(entries).filter((x) => x.dlId !== id), true);
  if (wasResolving) cancelResolve("dl");
  const x = internals.get(id);
  internals.delete(id);
  toasted.delete(id);
  removedIds.add(id);
  const pg = { ...untracked(pages) };
  delete pg[id];
  pages.set(pg);
  // The host stops it and moves its folder (partial files included) to
  // the Trash.
  if (NATIVE && x?.native) await host.call("dl.remove", { id }).catch(() => {});
  await Storage.removeItem(SUBS_PREFIX + id).catch(() => {});
  pump();
}

/** Removes finished downloads watched to ≥ 95%; how many. */
export async function removeWatchedDownloads(): Promise<number> {
  const list = untracked(entries).filter((e) => e.state === "done" && watchedFraction(e) >= 0.95);
  for (const e of list) await removeDownload(e.dlId);
  return list.length;
}

function watchedFraction(e: DlEntry): number {
  const keys = new Set<string>([e.key]);
  if (e.type === "tv" && (e.season ?? 1) === 1) keys.add(itemKey("tv", e.id, 0, e.episode ?? 1));
  if (e.type === "anime" && (e.episode ?? 1) === 1) keys.add(itemKey("anime", e.id, 0, 0));
  let best = 0;
  for (const p of untracked(progress)) {
    if (keys.has(p.key) && p.duration > 0) best = Math.max(best, p.position / p.duration);
  }
  return best;
}

/** Reorders inside the waiting queue; `toIndex` is a position in
 * `downloadQueue()` (the running/resolving head cannot be passed). */
export function moveDownload(dlId: number, toIndex: number): void {
  const e = get(dlId);
  if (!e || !WAITING.includes(e.state)) return;
  const all = untracked(entries);
  const head = all.filter((x) => x.state === "running" || x.state === "resolving").length;
  const waiting = all.filter((x) => WAITING.includes(x.state));
  const rest = waiting.filter((x) => x.dlId !== e.dlId);
  const at = Math.max(0, Math.min(rest.length, Math.round(toIndex) - head));
  rest.splice(at, 0, e);
  let i = 0;
  setEntries(
    all.map((x) => (WAITING.includes(x.state) ? rest[i++] : x)),
    true,
  );
}

/** Opens the local copy in the player (no network needed). */
export function playDownload(dlId: number): void {
  const e = get(dlId);
  if (!e || e.state !== "done") return;
  if (NATIVE && IOS && e.kind === "hls" && !e.file) {
    void host.call("dl.play", { id: e.dlId }).catch(() => {});
    return;
  }
  navigate({
    name: "player",
    type: e.type,
    id: e.id,
    season: e.type === "tv" ? e.season : undefined,
    episode: e.type === "movie" ? undefined : e.episode,
    title: e.title,
    poster: e.poster,
    lang: e.type === "anime" ? e.lang : undefined,
  });
}

/** Mac: shows the download (its file, or an HLS download's folder) in
 * Finder; iPhone: the share sheet (single files only; nothing for HLS). */
export function revealDownload(dlId: number): void {
  const e = get(dlId);
  if (!e || !NATIVE || !internal(e.dlId).native) return;
  if (ANDROID) return; // no file manager to show it in
  if (IOS && e.kind === "hls") return;
  void host.call("dl.reveal", { id: e.dlId }).catch(() => {});
}

/** Refreshes `downloadSpace`. */
export async function refreshDownloadSpace(): Promise<void> {
  try {
    if (!NATIVE) return;
    // The downloads' own folders and the volume of the folder in effect.
    const r = (await host.call("dl.space")) as { used?: number; free?: number } | null;
    spaceSig.set({ used: num(r?.used) ?? 0, free: num(r?.free) ?? 0 });
  } catch (e) {
    debug("download: space failed", String(e));
  }
}

// --- The native downloader (dl.*) --------------------------------------------------------

type NativeRec = {
  id: number;
  name?: string;
  status?: string;
  progress?: number | null;
  message?: string;
  kind?: string;
  key?: string | null;
  type?: string | null;
  mediaId?: number | null;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  createdAt?: number;
  /** iPhone: the file's name; desktop: its absolute path. */
  file?: string;
  /** Desktop: the record's folder. */
  dir?: string;
  reason?: string | null;
  bytes?: number | null;
  totalBytes?: number | null;
  done?: number | null;
  total?: number | null;
  waiting?: string | null;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function reserveNativeId(id: number) {
  const p = (async () => {
    try {
      const r = (await host.call("dl.nextId")) as { id?: unknown } | null;
      const nid = num(r?.id);
      if (nid && nid > 0 && get(id)) {
        renameEntry(id, nid);
        return nid;
      }
    } catch {}
    return id;
  })();
  reserving.set(id, p);
  void p.finally(() => reserving.delete(id));
}

/** Gives an entry its native id (provisional → reserved). */
function renameEntry(from: number, to: number) {
  if (from === to) return;
  const e = get(from);
  if (!e) return;
  aliases.set(from, to);
  for (const m of [internals, pendingLinks, runs, toasted] as Map<number, unknown>[]) {
    if (m.has(from)) {
      m.set(to, m.get(from));
      m.delete(from);
    }
  }
  if (held.has(from)) {
    held.delete(from);
    held.add(to);
  }
  setEntries(
    untracked(entries).map((x) => (x.dlId === from ? { ...x, dlId: to } : x)),
    true,
  );
}

function nativeMeta(e: DlEntry) {
  return {
    key: e.key,
    type: e.type,
    mediaId: e.id,
    season: e.type === "tv" ? e.season ?? 1 : null,
    episode: e.type === "movie" ? null : e.episode ?? 1,
    title: e.title,
  };
}

async function nativeStart(id: number, t: number, link: Link | null) {
  let real = resolveId(id);
  const pend = reserving.get(real);
  if (pend) real = await pend;
  if (!live(real, t)) return;
  const e = get(real);
  if (!e) return;
  const provisional = e.dlId >= PROVISIONAL_BASE;
  const args: Record<string, unknown> = { name: e.name, meta: nativeMeta(e) };
  if (!provisional) args.id = e.dlId;
  if (link) {
    args.url = link.url;
    args.headers = link.headers;
    args.kind = link.kind;
  }
  let res: { ok?: boolean; id?: number; error?: string; reason?: string; free?: number; status?: string; resumed?: boolean } | null;
  try {
    res = (await host.call("dl.start", args)) as typeof res;
  } catch (err) {
    res = { ok: false, error: String(err instanceof Error ? err.message : err), reason: "failed" };
  }
  if (res?.ok && typeof res.id === "number" && res.id !== e.dlId) renameEntry(e.dlId, res.id);
  real = resolveId(real);
  if (!live(real, t)) {
    // Cancelled or removed while the call was in flight.
    if (res?.ok) {
      const gone = !get(real);
      void host.call(gone ? "dl.remove" : "dl.cancel", { id: real }).catch(() => {});
    }
    return;
  }
  if (res?.ok) {
    internal(real).native = true;
    persistSoon(true);
    if (res.status === "done") finished(real, { message: "Downloaded" });
    else if (get(real)?.message === "Starting…" || get(real)?.message === "Resuming…") {
      patch(real, { message: "Downloading…" });
    }
    if (link) void saveSubtitles(real);
    return;
  }
  const reason = normReason(res?.reason);
  if (reason === "space") {
    const free = num(res?.free) ?? undefined;
    fail(real, "space", `Not enough free space${free != null ? ` (${formatSize(free)} left)` : ""} — remove some downloads or free up storage.`, free);
  } else {
    fail(real, reason, plainError(reason, res?.error));
  }
  pump();
}

function nativeMessage(d: NativeRec): string {
  if (d.waiting === "wifi") return "Waiting for Wi-Fi";
  if (d.waiting === "network") return "Waiting for a connection";
  const p = num(d.progress);
  if (p != null) return `Downloading · ${Math.round(p)}%`;
  const msg = String(d.message ?? "").trim();
  return msg ? msg[0].toUpperCase() + msg.slice(1) : "Downloading…";
}

function nativeNumbers(d: NativeRec): Partial<DlEntry> {
  const out: Partial<DlEntry> = {
    progress: num(d.progress),
    bytes: num(d.bytes),
    waiting: d.waiting === "wifi" || d.waiting === "network" ? d.waiting : null,
  };
  if (d.kind === "hls" || d.kind === "file") out.kind = d.kind;
  if (typeof d.file === "string" && d.file) out.file = d.file;
  if (typeof d.dir === "string" && d.dir) out.dir = d.dir;
  return out;
}

let nativeMerged = false;
const nativeBuffer: NativeRec[] = [];

function onNativeEvent(data: unknown) {
  (globalThis as { __rfPerfMark?: (l: string) => void }).__rfPerfMark?.("downloads: native event");
  const d = data as NativeRec | null;
  if (!d || typeof d.id !== "number") return;
  if (!nativeMerged) {
    nativeBuffer.push(d);
    return;
  }
  if (removedIds.has(d.id)) return;
  const e = get(d.id);
  if (!e) {
    // A record this side never knew (an older build started it).
    const n = fromNative(d);
    if (n) insert(n, { retries: 0, native: true });
    return;
  }
  const id = e.dlId;
  internal(id).native = true;
  const nums = nativeNumbers(d);
  if (d.status === "running") {
    if (e.state !== "running") return;
    patch(id, { ...nums, message: nativeMessage(d) });
    return;
  }
  if (d.status === "done") {
    if (e.state === "done") return;
    finished(id, { ...nums, progress: 100, message: "Downloaded" });
    pump();
    return;
  }
  if (d.status === "error") {
    if (e.state !== "running") {
      patch(id, { bytes: nums.bytes ?? e.bytes });
      return;
    }
    const reason = normReason(d.reason);
    if (reason === "expired") {
      void onExpired(id);
      return;
    }
    if (reason === "cancelled") {
      patch(id, { ...nums, state: "error", reason, message: "Cancelled", waiting: null });
      pump();
      return;
    }
    fail(id, reason, reason === "space" ? "Storage is almost full — free up space, then retry." : plainError(reason, d.message));
    pump();
  }
}

function fromNative(d: NativeRec, prev?: DlEntry): DlEntry | null {
  const type = (d.type === "tv" || d.type === "anime" || d.type === "movie" ? d.type : prev?.type) ?? null;
  const mediaId = num(d.mediaId) ?? prev?.id ?? null;
  const base: DlTarget = prev
    ? { ...prev }
    : cleanTarget({
        type: type ?? "movie",
        id: mediaId ?? 0,
        season: num(d.season) ?? undefined,
        episode: num(d.episode) ?? undefined,
        title: d.title || d.name || "video",
      });
  const status = d.status;
  const state: DlState = status === "done" ? "done" : status === "error" ? "error" : "running";
  const reason = state === "error" ? normReason(d.reason) : null;
  const key = type && mediaId ? keyOf(base) : `native:${d.id}`;
  return {
    ...base,
    dlId: d.id,
    key,
    name: d.name || prev?.name || entryName(base),
    state,
    reason,
    message:
      state === "done"
        ? "Downloaded"
        : state === "error"
          ? reason === "cancelled"
            ? "Cancelled"
            : plainError(reason!, d.message)
          : nativeMessage(d),
    progress: state === "done" ? 100 : num(d.progress),
    bytes: num(d.bytes),
    waiting: state === "running" && (d.waiting === "wifi" || d.waiting === "network") ? d.waiting : null,
    source: prev?.source ?? null,
    createdAt: num(d.createdAt) ?? prev?.createdAt ?? Date.now(),
    finishedAt: state === "done" ? prev?.finishedAt ?? num(d.createdAt) ?? Date.now() : null,
    kind: d.kind === "hls" || d.kind === "file" ? d.kind : prev?.kind,
    file: typeof d.file === "string" && d.file ? d.file : prev?.file,
    dir: typeof d.dir === "string" && d.dir ? d.dir : prev?.dir,
  };
}

/** Saved entries + `dl.list`: native records win for running/done/error. */
function mergeNative(saved: { e: DlEntry; x: Internal }[], list: NativeRec[]): { e: DlEntry; x: Internal }[] {
  const byId = new Map(list.filter((d) => typeof d?.id === "number").map((d) => [d.id, d]));
  const out: { e: DlEntry; x: Internal }[] = [];
  const head: { e: DlEntry; x: Internal }[] = [];
  for (const s of saved) {
    const d = byId.get(s.e.dlId);
    if (d) {
      byId.delete(s.e.dlId);
      const e = fromNative(d, s.e)!;
      const x = { ...s.x, native: true };
      // Expired while the app was away: back in line for a fresh link
      // (the native record continues with it).
      if (e.state === "error" && e.reason === "expired" && x.retries < MAX_EXPIRED_RETRIES) {
        head.push({ e: { ...e, state: "queued", reason: null, message: "Waiting for a fresh link" }, x });
      } else {
        out.push({ e, x });
      }
      continue;
    }
    if (s.e.state === "done") continue; // its files are gone
    if (s.e.state === "running" || s.e.state === "resolving") {
      head.push({ e: { ...s.e, state: "queued", message: "Waiting", waiting: null }, x: { ...s.x, native: false } });
      continue;
    }
    out.push(s);
  }
  for (const d of byId.values()) {
    const e = fromNative(d);
    if (!e) continue;
    const x: Internal = { retries: 0, native: true };
    if (e.state === "error" && e.reason === "expired" && e.key.indexOf("native:") !== 0) {
      head.push({ e: { ...e, state: "queued", reason: null, message: "Waiting for a fresh link" }, x });
    } else {
      out.push({ e, x });
    }
  }
  return [...head, ...out];
}

// --- Host helpers ---------------------------------------------------------------------

function hostCall(name: string, data: Record<string, unknown>): Promise<unknown> {
  if (!hostUp) return Promise.reject(new Error("no host"));
  return host.call(name, data);
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return `${homeDir()}${p.slice(1)}`;
  return p;
}

/** A folder path without trailing slashes ("/" stays). */
function normDir(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

function formatSize(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} KB`;
}

// --- Download folder (desktop) ------------------------------------------------------------
//
// The host owns the folder in effect (it moves the record folders and
// keeps the records and the folder in one file). `settings.downloadDir`
// mirrors it for display and old callers; writes to it that differ are
// put back — the only way to change it is changeDownloadDir().

type DirInfo = { dir?: string; defaultDir?: string; home?: string; configured?: boolean; minFree?: number };

const dirSig = signal<string>("");
const defaultDirSig = signal<string>("");
/** The engine's folder is known: the setting mirror is enforced from now on. */
let dirKnown = false;
let dirConfigured = false;
let dirChanging = false;

/** The default download folder (`~/Downloads/rustflix`, absolute) — for a
 * "Use default" button. */
export function defaultDownloadDir(): string {
  return defaultDirSig() || playerDefaultDownloadDir();
}

/** The download folder in effect (absolute). */
export const downloadDir: Accessor<string> = computed<string>(() => dirSig() || defaultDownloadDir());

const changingSig = signal(false);
/** False while anything is resolving or running (queued items are fine)
 * or a change is under way. */
export const canChangeDownloadDir: Accessor<boolean> = computed<boolean>(
  () => !entries().some((e) => e.state === "resolving" || e.state === "running") && !changingSig(),
);

function applyDirInfo(r: DirInfo | null | undefined) {
  if (!r) return;
  if (typeof r.home === "string" && r.home && !homeDir()) setHomeDir(r.home);
  if (typeof r.defaultDir === "string" && r.defaultDir) defaultDirSig.set(r.defaultDir);
  if (typeof r.dir === "string" && r.dir) dirSig.set(normDir(r.dir));
  if (typeof r.configured === "boolean") dirConfigured = r.configured;
}

/** Puts the setting mirror back to the folder in effect. */
function syncDirSetting() {
  if (!dirKnown) return;
  const want = untracked(downloadDir);
  if ((untracked(settings).downloadDir ?? "") !== want) void saveSettings({ downloadDir: want }).catch(() => {});
}

/** Moves every download to `path` and makes it the download folder.
 * `ok`: the folder changed (`error` then lists downloads that could not
 * be moved and stayed where they were); `moved`: how many moved. */
export async function changeDownloadDir(path: string): Promise<{ ok: boolean; moved: number; error?: string }> {
  const no = (error: string) => ({ ok: false, moved: 0, error });
  if (!DESKTOP || !NATIVE) return no("The download folder can't be changed here.");
  if (!inited || !dirKnown) return no("Downloads are still starting — try again in a moment.");
  const raw = String(path ?? "").trim();
  if (!raw) return no("Choose a folder.");
  const p = normDir(expandHome(raw));
  if (!p.startsWith("/")) return no("Choose a full folder path (starting with / or ~).");
  if (/(^|\/)\.\.?(\/|$)/.test(p)) return no('The folder path may not contain "." or "..".');
  if (p === untracked(downloadDir)) return no("That's already the download folder.");
  if (dirChanging) return no("The download folder is already being moved.");
  if (!untracked(canChangeDownloadDir)) {
    return no("Downloads are in progress — let them finish or cancel them first (queued ones can wait).");
  }
  dirChanging = true;
  changingSig.set(true);
  try {
    let r: (DirInfo & { ok?: boolean; moved?: number; error?: string }) | null = null;
    try {
      r = (await hostCall("dl.options", { dir: p })) as typeof r;
    } catch (e) {
      return no(`Couldn't change the folder: ${String(e instanceof Error ? e.message : e)}`);
    }
    if (!r?.ok) return no(r?.error || "Couldn't change the folder.");
    applyDirInfo(r);
    syncDirSetting();
    await refreshNativePaths();
    void refreshDownloadSpace();
    const moved = num(r.moved) ?? 0;
    debug("download: folder changed", { dir: untracked(downloadDir), moved, error: r.error });
    return r.error ? { ok: true, moved, error: r.error } : { ok: true, moved };
  } finally {
    dirChanging = false;
    changingSig.set(false);
    pump();
  }
}

/** Entries take the record paths `dl.list` reports (after a move). */
async function refreshNativePaths() {
  let list: NativeRec[] = [];
  try {
    const r = await host.call("dl.list");
    if (Array.isArray(r)) list = r as NativeRec[];
  } catch {
    return;
  }
  for (const d of list) {
    const e = get(d.id);
    if (!e) continue;
    const p: Partial<DlEntry> = {};
    if (typeof d.dir === "string" && d.dir !== e.dir) p.dir = d.dir;
    if (typeof d.file === "string" && d.file && d.file !== e.file) p.file = d.file;
    if (Object.keys(p).length) patch(e.dlId, p);
  }
}

/** Waits (up to `ms`) for the library — the saved settings — to load. */
async function libraryLoaded(ms: number) {
  const t0 = Date.now();
  while (!untracked(libraryReady) && Date.now() - t0 < ms) {
    await new Promise((res) => setTimeout(res, 50));
  }
}

// --- Desktop: entries of the vid-dl era ----------------------------------------------------

/** Saved entries from before the built-in downloader (store v1/v2 on the
 * desktop): a finished file that still exists becomes a done record of
 * the native downloader (`dl.adopt` moves it into a record folder of its
 * own beside it); waiting/interrupted ones go back in the queue (with a
 * fresh id); anything else is dropped quietly. The folder the old build
 * used becomes the engine's when it has none of its own yet. */
async function migrateDesktop(list: { e: DlEntry; x: Internal }[]): Promise<{ e: DlEntry; x: Internal }[]> {
  if (!dirConfigured) {
    await libraryLoaded(5000);
    const fromSetting = (untracked(settings).downloadDir || "").trim();
    const fromEntries = list.find((it) => it.e.state === "done" && it.e.dir)?.e.dir ?? "";
    const want = normDir(expandHome(fromSetting || fromEntries || ""));
    if (want.startsWith("/") && want !== untracked(downloadDir)) {
      try {
        const r = (await hostCall("dl.options", { dir: want })) as (DirInfo & { ok?: boolean }) | null;
        if (r?.ok) applyDirInfo(r);
        else debug("download: the old download folder was not taken", { want, error: (r as { error?: string } | null)?.error });
      } catch {}
    }
  }
  const out: { e: DlEntry; x: Internal }[] = [];
  for (const { e } of list) {
    if (e.state === "done") {
      if (!e.file) continue;
      let r: { ok?: boolean; id?: number; record?: NativeRec; subs?: string | null } | null = null;
      try {
        r = (await hostCall("dl.adopt", {
          file: e.file,
          name: e.name,
          meta: nativeMeta(e),
          createdAt: e.createdAt,
          subs: e.dir ? `${e.dir}/.rustflix-subs-${e.dlId}.json` : undefined,
          page: e.dir ? `${e.dir}/.rustflix-player-${e.dlId}.html` : undefined,
        })) as typeof r;
      } catch {}
      const id = num(r?.id);
      if (!r?.ok || !id) {
        debug("download: an old download was dropped (its file is gone)", { name: e.name });
        continue;
      }
      if (typeof r.subs === "string" && r.subs) await Storage.setItem(SUBS_PREFIX + id, r.subs).catch(() => {});
      const rec = r.record ?? ({ id } as NativeRec);
      out.push({
        e: {
          ...e,
          dlId: id,
          kind: "file",
          file: typeof rec.file === "string" ? rec.file : e.file,
          dir: typeof rec.dir === "string" ? rec.dir : e.dir,
          bytes: num(rec.bytes) ?? e.bytes,
          progress: 100,
          message: "Downloaded",
          reason: null,
        },
        x: { retries: 0, native: true },
      });
      continue;
    }
    if (WAITING.includes(e.state) || e.state === "running" || e.state === "resolving") {
      const { dir: _d, file: _f, ...rest } = e;
      out.push({
        e: { ...rest, dlId: PROVISIONAL_BASE + ++provSeq, state: "queued", message: "Waiting", reason: null, progress: null, waiting: null },
        x: { retries: 0 },
      });
    }
    // error rows of the old downloader: dropped.
  }
  return out;
}

// --- Local playback (the host's localhost player page) ----------------------------------

/** download id → localhost player URL from the host's media server. */
const pages = signal<Record<number, string | "pending" | "failed">>({});

function ensurePage(id: number) {
  if (untracked(pages)[id] !== undefined) return;
  pages.set({ ...untracked(pages), [id]: "pending" });
  host
    .call("dl.playUrl", { id })
    .then((res: unknown) => {
      const url = (res as { url?: string } | null)?.url;
      pages.set({ ...untracked(pages), [id]: url || "failed" });
    })
    .catch(() => pages.set({ ...untracked(pages), [id]: "failed" }));
}

function localPage(r: PlayerRoute): string | null {
  const e = entries().find((x) => x.state === "done" && x.key === keyOf(r));
  if (!e || (e.type === "anime" && (e.lang ?? "sub") !== (r.lang ?? "sub"))) return null;
  if (!NATIVE) return null;
  // iPhone: legacy native-asset HLS records play in AVKit instead.
  if (IOS && e.kind === "hls" && !e.file) return null;
  const p = pages()[e.dlId];
  if (p === "failed") return null;
  if (p && p !== "pending") return p;
  untracked(() => ensurePage(e.dlId));
  return "";
}

function offlineEpisodes(r: PlayerRoute): { seasons: number[]; episodes: EpisodeInfo[] } | null {
  const mine = untracked(entries).filter((e) => e.type === r.type && e.id === r.id && e.state === "done");
  if (!mine.length) return null;
  const seasons = [...new Set(mine.map((e) => e.season ?? 1))].sort((a, b) => a - b);
  const season = r.type === "tv" ? r.season ?? 1 : undefined;
  const eps = mine
    .filter((e) => r.type !== "tv" || (e.season ?? 1) === season)
    .sort((a, b) => (a.episode ?? 1) - (b.episode ?? 1))
    .map((e) => ({
      season: e.type === "tv" ? e.season : undefined,
      n: e.episode ?? 1,
      name: e.episodeName || `Episode ${e.episode ?? 1}`,
      still: e.still,
    }));
  return { seasons: r.type === "tv" ? seasons : [], episodes: eps };
}

// --- Offline subtitles ---------------------------------------------------------------------

/** When a download starts: the best subtitle in the user's first
 * available language, parsed, saved in Storage (`rustflix.dlsubs.<id>`,
 * both platforms). Failures never touch the download. */
async function saveSubtitles(id: number) {
  const x = internal(id);
  if (x.subsTried) return;
  x.subsTried = true;
  try {
    const e = get(id);
    if (!e) return;
    const langs = (untracked(settings).myLanguages ?? []).filter(Boolean);
    if (!langs.length) return;
    const list = await searchSubtitles({
      type: e.type,
      tmdbId: e.id,
      season: e.type === "tv" ? e.season ?? 1 : undefined,
      episode: e.type === "movie" ? undefined : e.episode ?? 1,
      langs,
      // The source page's own subtitles first (captured when its link was resolved).
      page: true,
    });
    for (const lang of langs) {
      for (const res of list.filter((r) => r.lang === lang).slice(0, 3)) {
        let cues: Cue[];
        try {
          cues = await loadCues(res);
        } catch {
          continue;
        }
        if (!cues.length) continue;
        const json = JSON.stringify({ v: 1, lang, cues });
        if (json.length > SUBS_MAX_CHARS) continue;
        const cur = get(id);
        if (!cur) return;
        await Storage.setItem(SUBS_PREFIX + cur.dlId, json);
        debug("download: subtitles saved", { id: cur.dlId, lang, n: cues.length });
        return;
      }
    }
  } catch (err) {
    debug("download: subtitles failed", String(err));
  }
}

async function offlineSubtitles(r: PlayerRoute): Promise<{ lang: string; cues: Cue[] } | null> {
  const e = untracked(entries).find((x) => x.state === "done" && x.key === keyOf(r));
  if (!e) return null;
  const raw: string | null = await Storage.getItem(SUBS_PREFIX + e.dlId).catch(() => null);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { lang?: unknown; cues?: unknown };
    if (typeof v.lang !== "string" || !Array.isArray(v.cues)) return null;
    const cues = (v.cues as Cue[]).filter((c) => c && typeof c.s === "number" && typeof c.e === "number" && typeof c.t === "string");
    return cues.length ? { lang: v.lang, cues } : null;
  } catch {
    return null;
  }
}

// --- Player links + auto next ---------------------------------------------------------------

/** The playing page exposed a link: an entry of that episode that waits
 * (needsPlay / queued / resolving) takes it — now if nothing runs, else
 * as the next to run. */
function onPlayerLink(l: StreamLink) {
  if (!ready) return;
  const e = forRoute(l.route);
  if (!e || held.has(e.dlId)) return;
  if (e.state === "needsPlay" || e.state === "queued") {
    pendingLinks.set(e.dlId, fromStream(l));
    patch(e.dlId, { state: "queued", message: "Link ready — starts next" });
    toFront(e.dlId);
    pump();
  } else if (e.state === "resolving") {
    pendingLinks.set(e.dlId, fromStream(l));
    cancelResolve("dl");
  }
}

/** While the player shows an episode whose entry waits for a link, ask
 * its page for links every few seconds. */
function watchPlayer() {
  if (!ready) return;
  const r = playerRoute();
  if (!r) return;
  const e = forRoute(r);
  if (!e || held.has(e.dlId) || pendingLinks.has(e.dlId)) return;
  if (e.state === "needsPlay" || e.state === "queued" || e.state === "resolving") refreshStreams();
}

async function onWatched(r: PlayerRoute) {
  if (!untracked(settings).downloadAutoNext || r.type === "movie") return;
  // Only after the watched episode's own download finished.
  const e = forRoute(r);
  if (!e || e.state !== "done") return;
  const n = await nextEpisodeOf({ type: r.type, id: r.id, season: r.season, episode: r.episode });
  if (!n) return;
  if (downloadFor(r.type, r.id, n.season, n.episode)) return;
  debug("download: auto next", { from: e.key, season: n.season, episode: n.episode });
  enqueueDownload({
    type: e.type,
    id: e.id,
    season: n.season,
    episode: n.episode,
    lang: e.lang,
    title: e.title,
    poster: e.poster,
    episodeName: n.name,
    still: n.still,
  });
}

// --- Boot -----------------------------------------------------------------------------------

let resolver: (req: ResolveRequest) => Promise<ResolveResult> = resolveStream;

/** The version of the store `parseSaved` read (1: the v1 rows). */
let savedVersion = STORE_VERSION;

function parseSaved(raw: string | null): { e: DlEntry; x: Internal }[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { v?: number; seq?: number; entries?: (DlEntry & { x?: Internal })[] };
    if (!v || !Array.isArray(v.entries)) return null;
    savedVersion = typeof v.v === "number" ? v.v : 2;
    if (typeof v.seq === "number" && v.seq > seq) seq = v.seq;
    return v.entries
      .filter((e) => e && typeof e.dlId === "number" && typeof e.state === "string")
      .map(({ x, ...e }) => ({ e: e as DlEntry, x: { retries: 0, ...(x ?? {}) } }));
  } catch {
    return null;
  }
}

/** `rustflix.downloads.v1` records (the old single-download rows). */
function migrateV1(raw: string | null): { e: DlEntry; x: Internal }[] {
  if (!raw) return [];
  let list: Record<string, unknown>[] = [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) list = v;
  } catch {
    return [];
  }
  const out: { e: DlEntry; x: Internal }[] = [];
  for (const d of list) {
    if (!d || typeof d.id !== "number") continue;
    const type = d.type === "tv" || d.type === "anime" || d.type === "movie" ? d.type : null;
    const mediaId = num(d.mediaId);
    const base = cleanTarget({
      type: type ?? "movie",
      id: mediaId ?? 0,
      season: num(d.season) ?? undefined,
      episode: num(d.episode) ?? undefined,
      title: String(d.title ?? d.name ?? "video"),
    });
    const status = d.status === "done" ? "done" : d.status === "running" ? "running" : "error";
    const msg = String(d.message ?? "");
    const reason = status === "error" ? (/cancel/i.test(msg) ? "cancelled" : "failed") : null;
    out.push({
      e: {
        ...base,
        dlId: d.id,
        key: type && mediaId ? keyOf(base) : `legacy:${d.id}`,
        name: String(d.name ?? entryName(base)),
        state: status,
        progress: status === "done" ? 100 : num(d.progress),
        message: status === "done" ? "Downloaded" : status === "error" ? (reason === "cancelled" ? "Cancelled" : msg || "Download failed.") : "Waiting",
        reason,
        bytes: null,
        waiting: null,
        source: null,
        createdAt: num(d.createdAt) ?? Date.now(),
        finishedAt: status === "done" ? num(d.createdAt) ?? Date.now() : null,
        file: typeof d.file === "string" ? d.file : undefined,
        dir: typeof d.dir === "string" ? d.dir : undefined,
        kind: d.kind === "hls" || d.kind === "file" ? d.kind : undefined,
      },
      x: { retries: 0 },
    });
  }
  // Old rows were newest first; the queue runs oldest first.
  return out.reverse();
}

let lastWifi: boolean | null = null;
/** iPhone and Android: Wi-Fi only (the desktop has no such option). */
function pushWifi(on: boolean) {
  if (!NATIVE || !(IOS || ANDROID) || lastWifi === on) return;
  lastWifi = on;
  void host.call("dl.options", { wifiOnly: on }).catch(() => {
    lastWifi = null;
  });
}

async function init() {
  if (inited) return;
  inited = true;
  if (!NATIVE) {
    ready = true;
    return;
  }
  try {
    const src = await Storage.getItem(SRC_KEY).catch(() => null);
    if (src) {
      const v = JSON.parse(src);
      if (v && typeof v === "object") titleSources = v;
    }
  } catch {}
  let saved = parseSaved(await Storage.getItem(DL_KEY).catch(() => null));
  if (!saved) {
    const v1 = IOS ? [] : migrateV1(await Storage.getItem(OLD_KEY).catch(() => null));
    savedVersion = v1.length ? 1 : STORE_VERSION;
    saved = v1;
  }
  host.on("dl.event", onNativeEvent);
  // Android: a download notification was tapped.
  if (ANDROID) host.on("dl.openTab", () => selectTab("downloads"));
  if (DESKTOP) {
    try {
      applyDirInfo((await host.call("dl.options", {})) as DirInfo | null);
    } catch {}
    for (const it of saved) {
      if (it.e.dlId >= PROVISIONAL_BASE) provSeq = Math.max(provSeq, it.e.dlId - PROVISIONAL_BASE);
    }
    if (savedVersion < STORE_VERSION) saved = await migrateDesktop(saved);
    dirKnown = true;
  }
  let native: NativeRec[] = [];
  try {
    const r = await host.call("dl.list");
    if (Array.isArray(r)) native = r as NativeRec[];
  } catch {}
  const list = mergeNative(saved, native);
  for (const it of list) {
    if (it.e.dlId >= PROVISIONAL_BASE) provSeq = Math.max(provSeq, it.e.dlId - PROVISIONAL_BASE);
  }
  for (const it of list) internals.set(it.e.dlId, it.x);
  entries.set(list.map((it) => it.e));
  mirrorLegacy(untracked(entries));
  ready = true;
  persistNow();
  nativeMerged = true;
  for (const d of nativeBuffer.splice(0)) onNativeEvent(d);
  for (const e of untracked(entries)) if (e.dlId >= PROVISIONAL_BASE) reserveNativeId(e.dlId);
  if (untracked(libraryReady)) pushWifi(untracked(settings).downloadWifiOnly !== false);
  if (DESKTOP) syncDirSetting();
  setInterval(watchPlayer, 3000);
  // The one hidden resolver web view, made now while the app is in front
  // (on macOS creating a web view activates the app).
  ensureResolverHost();
  void armTestHook();
  pump();
}

onSettingsChange((next) => {
  if (inited) pushWifi(next.downloadWifiOnly !== false);
  // The folder setting is read-only in practice: only changeDownloadDir
  // (which moves the downloads) changes it.
  if (dirKnown && (next.downloadDir ?? "") !== untracked(downloadDir)) syncDirSetting();
});
onStreamLink(onPlayerLink);
onEpisodeWatched((r) => {
  void onWatched(r);
});

registerDownloadEngine({
  init,
  downloadCurrent,
  cancel: cancelDownload,
  remove: removeDownload,
  play: playDownload,
  reveal: revealDownload,
  localPage,
  offlineEpisodes,
  offlineSubtitles,
});

/** Called by ResolverHost so this module is part of the bundle. */
export function downloadEngineLoaded(): boolean {
  return true;
}

/** Tests only: swap the hidden-page resolver. */
export function __setResolverForTest(fn: ((req: ResolveRequest) => Promise<ResolveResult>) | null) {
  resolver = fn ?? resolveStream;
}
