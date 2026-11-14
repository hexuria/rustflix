// Hidden-page stream resolver: loads a title's embed page in a second web
// view nobody sees (screens/ResolverHost.tsx, a full-size container at
// opacity 0) and returns the stream the page plays — the URL it fetched,
// with the headers, user agent, frame origin and cookies the native stream
// proxy needs (`dl.stream.open`).
//
// - Push-based: the all-frames media sniffer (lib/adblock.ts SNIFF_JS; on
//   Android the native Sniffer for inner frames) reports every media
//   request as it happens ({t:-11} / {t:-2}). The first playlist starts a
//   ~500 ms settle (a master playlist ends it at once); the best candidate
//   wins (lib/resolvecore.ts). The old 1.5 s `streams` poll of the top
//   bridge stays as a backup.
// - Resolver mode in every frame (RESOLVER_BRIDGE → `__rf_sniff.resolver()`):
//   media muted, paused once a playlist was seen, the page told it is
//   visible, one synthetic click on a play element where a page waits for
//   one, the ad guard's isolation off.
// - Queue with priorities (`priority`, higher first; the playing title's
//   resolve preempts a waiting/running lower one, which is retried after);
//   `cancelResolve(tag?)` ends one caller's resolves or all of them.
// - ONE hidden web view for the whole session (ResolverHost.tsx). On macOS
//   wry asks the OS to activate the app every time a web view is CREATED
//   (lb-wry 0.53.3 src/wkwebview/mod.rs), so it is created once while the
//   app is in front (`ensureResolverHost`, called at boot) and never
//   unmounted. Its `src` prop stays "about:blank" for good; a resolve
//   navigates it through the ref (`location.replace` by injectJavaScript).
//   After each resolve (success, failure, cancel) it goes back to
//   about:blank: no page keeps running. It is marked as the resolver's for
//   the native hosts (`sys.webGuard {markResolver}`), which then also block
//   its images, fonts and pings.
// - Its bridge messages go only to this module, never to the player.
// - While the player shows the requested episode and its page already
//   exposed a link, that link is returned and no hidden page loads (unless
//   `fresh`).
//
// Test hook: `runResolveTest()` (called at boot from App.tsx) runs the JSON
// array in Storage key `rustflix.resolvetest` (ResolveRequest[]) and writes
// ResolveResult[] to `rustflix.resolvetest.result` after every entry.

import { host, lifecycle, platform, signal, Storage, untracked } from "nsh";
import type { WebViewRef } from "nsh";
import { currentStreamLink, debug, PLAYER_BRIDGE, sourceId } from "./player";
import { resolverRules } from "./adblock";
import { CandidateSet, headersFor, sameSite, SOURCE_TIMEOUT, SubtitleSet, type StreamCandidate, type StreamFormat } from "./resolvecore";
import { pageSubKey, pageSubtitleResults, setPageSubtitles, type SubResult } from "./subtitles";
import { getSourceUrl, PLAYER_SOURCES, sourcesFor, sourceSupports, type MediaType } from "./sources";
import { settings } from "./store";
import { externalIds } from "./tmdb";

/** Only `opacity` remains (the other spike modes failed or showed a
 * visible view); the field is accepted and ignored. */
export type ResolveMode = "opacity";

export interface ResolveRequest {
  type: MediaType;
  id: number;
  season?: number;
  episode?: number;
  lang?: "sub" | "dub";
  source?: string;
  mode?: ResolveMode;
  /** Counted from the page load (time waiting for the view excluded).
   * Default: per source (resolvecore SOURCE_TIMEOUT), else 30 s. */
  timeoutMs?: number;
  /** Called (repeatedly) while the hidden view cannot be made yet because
   * the app is not active (desktop). */
  onWaiting?: () => void;
  /** Higher runs first; a higher one preempts a running lower one (which
   * is retried afterwards). Suggested: playing title 10, next-episode
   * pre-resolve 5, downloads 0 (default). */
  priority?: number;
  /** Who asked (for `cancelResolve(tag)`), e.g. "player", "prefetch", "dl". */
  tag?: string;
  /** Never answer with the playing page's link (a re-resolve after the
   * proxy reported the link expired). */
  fresh?: boolean;
  /** The page's subtitles that arrive after the answer (the full list
   * each time). They also reach the subtitle engine by themselves
   * (`setPageSubtitles`, keyed by title/episode). */
  onSubtitles?: (list: SubResult[]) => void;
}

/** A stream candidate as reported in the result. */
export interface ResolveCandidate {
  url: string;
  format: StreamFormat;
  role: string;
  via: string;
  frameOrigin: string;
  inner?: string;
}

export interface ResolveResult {
  ok: boolean;
  url?: string;
  kind?: "hls" | "file";
  /** Request headers for the proxy / downloader: the page's own for this
   * URL, plus Referer (the requesting frame's), Origin (cross-origin
   * fetch/XHR), User-Agent. */
  headers?: Record<string, string>;
  ua?: string;
  /** "player" when the playing page's link was used instead. */
  source: string;
  mode: string;
  ms: number;
  steps: string[];
  error?: string;
  cancelled?: boolean;
  /** Added for native playback ------------------------------------------- */
  /** hls | mp4 | dash. DASH is not playable natively (ok:false then). */
  format?: StreamFormat;
  /** The URL can be handed to `dl.stream.open` (hls or mp4). */
  native?: boolean;
  /** Origin of the frame that requested the stream. */
  frameOrigin?: string;
  /** The Referer the proxy must send (also in `headers`). */
  referer?: string;
  /** A Cookie header for the stream's host: WebKit's own cookie store
   * where the host offers it (`sys.webCookies`, HttpOnly included), else
   * the requesting frame's document.cookie when it is the same site. */
  cookies?: string;
  /** Set when the page fetched its playlist through a page-side proxy:
   * `url` is that proxy URL (fetch exactly it), `inner` the URL inside. */
  wrapper?: string;
  inner?: string;
  /** Every stream URL seen, best first (at most 12). */
  candidates?: ResolveCandidate[];
  /** The subtitle files the page offered (its <track>s, its player's
   * list, its subtitle API, files it fetched), as subtitle results
   * (provider "source", ISO 639-1 language, the headers to fetch them
   * with). What was known at the answer; later ones: `onSubtitles`. */
  subtitles?: SubResult[];
}

/** The page the hidden web view shows (an embed URL, or "about:blank"
 * when idle); null until it exists. Informational: ResolverHost's `src`
 * never changes. */
export const resolverPage = signal<string | null>(null);
/** Whether ResolverHost renders the hidden web view. Turned on once and
 * left on; off only when the view was lost (resolverHostGone). */
export const resolverHostOn = signal(false);

/** Same per-platform user agents as Player.tsx's <WebView>. */
export const RESOLVER_UA = platform.select({
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
});

// Forces every <video>/<audio> silent: after load and every second.
const MUTE_JS =
  "(function(){try{var vs=document.querySelectorAll('video,audio');for(var i=0;i<vs.length;i++){var v=vs[i];if(!v.muted)v.muted=true;if(v.volume)v.volume=0;}}catch(e){}})();";
const PAUSE_JS =
  "(function(){try{window.__rf_resolved=true;var vs=document.querySelectorAll('video,audio');for(var i=0;i<vs.length;i++){try{vs[i].pause();}catch(e){}}}catch(e){}})();";

/** The player's bridge (with the ad guard and the media sniffer) plus a
 * document-start guard that mutes any media element the moment it loads,
 * plays or changes volume, keeps it paused once a link was taken, and puts
 * every frame of the page in resolver mode. Nothing runs on about:blank,
 * so the idle view has no timers and sends no messages. */
export const RESOLVER_BRIDGE =
  "(function(){try{if(String(location.protocol)==='about:')return;}catch(e){}\n" +
  PLAYER_BRIDGE +
  "\n;(function(){try{window.__rf_resolver=1;if(window.__rf_sniff&&window.__rf_sniff.resolver)window.__rf_sniff.resolver();}catch(e){}})();" +
  "\n;(function(){try{var m=function(e){var v=e&&e.target;if(!v||(v.tagName!=='VIDEO'&&v.tagName!=='AUDIO'))return;try{if(!v.muted)v.muted=true;if(v.volume)v.volume=0;if(window.__rf_resolved&&e.type==='play')v.pause();}catch(x){}};" +
  "['loadstart','loadedmetadata','play','playing','volumechange'].forEach(function(n){document.addEventListener(n,m,true);});}catch(e){}})();\n})();";

const POLL_MS = 1500;
const MUTE_MS = 1000;
/** After the first playlist: wait this long for a better one (a master). */
const SETTLE_MS = 500;
/** After the answer, the page keeps running this long for late subtitle
 * lists (the next resolve waits; a cancel or a preemption ends it). */
const SUB_GRACE_MS = 2000;
/** The title the idle resolver page carries, so the native hosts can find
 * its web view (sys.webGuard markResolver). */
const RESOLVER_TITLE = "__rf_resolver__";

function log(line: string, data?: unknown) {
  debug(`resolver: ${line}`, data);
  try {
    console.log(`[rustflix] resolver: ${line}`);
  } catch {}
}

/** The source the player would pick for `type`. */
function pickSourceId(req: ResolveRequest): string {
  if (req.source) return req.source;
  const sel = untracked(sourceId);
  if (sourceSupports(sel, req.type)) return sel;
  return sourcesFor(req.type)[0]?.id ?? sel;
}

const imdbCache = new Map<string, string>();

/** The embed URL `playerUrl()` would build for this request. */
async function embedUrl(req: ResolveRequest, sid: string, step: (s: string) => void): Promise<string | null> {
  const src = PLAYER_SOURCES.find((s) => s.id === sid);
  if (!src || !sourceSupports(sid, req.type)) {
    step(`source ${sid} cannot play ${req.type}`);
    return null;
  }
  let overrideId: string | undefined;
  if (src.idType === "imdb") {
    if (req.type === "anime") return null;
    const key = `${req.type}:${req.id}`;
    overrideId = imdbCache.get(key);
    if (!overrideId) {
      try {
        const ids = await externalIds(req.type === "tv" ? "tv" : "movie", req.id);
        if (ids.imdb_id) imdbCache.set(key, ids.imdb_id);
      } catch (e) {
        step(`imdb lookup failed: ${String(e instanceof Error ? e.message : e)}`);
      }
      overrideId = imdbCache.get(key);
    }
    if (!overrideId) return null;
  }
  const s = untracked(settings);
  return getSourceUrl(
    sid,
    { type: req.type, id: req.id, season: req.season, episode: req.episode, lang: req.lang, overrideId },
    {},
    s.accent,
    s.myLanguages?.[0] || s.subtitleLang || null,
  );
}

/** The player shows exactly this episode (anime: in this audio). */
function playerShows(req: ResolveRequest, r: { type: MediaType; id: number; season?: number; episode?: number; lang?: string }): boolean {
  if (r.type !== req.type || r.id !== req.id) return false;
  if (req.type === "movie") return true;
  if ((r.episode ?? 1) !== (req.episode ?? 1)) return false;
  if (req.type === "tv") return (r.season ?? 1) === (req.season ?? 1);
  return (r.lang ?? "sub") === (req.lang ?? "sub");
}

// --- The hidden web view (ResolverHost) --------------------------------------

let hostRef: WebViewRef | null = null;
let marked = false;
/** ResolverHost's ref callback. */
export function setResolverRef(r: WebViewRef | null) {
  hostRef = r;
  marked = false;
  if (r) void markResolverView();
}

/** Tells the native hosts which web view is the resolver's: the idle page
 * gets a known title, the host finds the view by it and adds the
 * resolver's rule list (no images/fonts/pings). Retried a few times (the
 * view may not have its page yet). */
async function markResolverView() {
  let available = false;
  try {
    available = host.available();
  } catch {}
  if (!available) return;
  for (let i = 0; i < 6 && !marked && hostRef; i++) {
    await new Promise((r) => setTimeout(r, 400 + i * 600));
    if (untracked(resolverPage) !== "about:blank") continue;
    try {
      hostRef?.injectJavaScript(`try{if(location.protocol==='about:')document.title=${JSON.stringify(RESOLVER_TITLE)};}catch(e){}`);
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
    try {
      const res = (await host.call("sys.webGuard", {
        markResolver: RESOLVER_TITLE,
        resolverRules: JSON.stringify(resolverRules()),
      })) as { marked?: number } | null;
      if (res && typeof res.marked === "number" && res.marked > 0) {
        marked = true;
        log(`resolver view marked (${res.marked})`);
      }
    } catch {
      return;
    }
  }
}

/** ResolverHost's web view went away (unmounted): forget it; it is made
 * again only while the app is active. */
export function resolverHostGone() {
  hostRef = null;
  marked = false;
  if (untracked(resolverHostOn)) resolverHostOn.set(false);
  if (untracked(resolverPage) !== null) resolverPage.set(null);
}

/** The app is in front (desktop): creating a web view now cannot pull it
 * forward. Phones cannot activate themselves, so there it always may. */
function mayCreateView(): boolean {
  if (!platform.desktop) return true;
  try {
    const f = lifecycle as unknown as (() => string) | undefined;
    return typeof f !== "function" || f() === "active";
  } catch {
    return true;
  }
}

/** Asks ResolverHost for the hidden web view if it does not exist yet
 * and the app is active. True once its ref is there. */
export function ensureResolverHost(): boolean {
  if (!untracked(resolverHostOn)) {
    if (!mayCreateView()) return false;
    resolverHostOn.set(true);
    resolverPage.set("about:blank");
  }
  return !!hostRef;
}

/** Navigates the built view through its ref: a command NSH applies at
 * once (no repaint, no rebuild). */
function navigateHidden(url: string) {
  resolverPage.set(url);
  try {
    hostRef?.injectJavaScript(`try{window.location.replace(${JSON.stringify(url)});}catch(e){}`);
  } catch {}
}

type HostEvent = "loadStart" | "load" | "error" | "message";
let onHostEvent: ((kind: HostEvent, e: unknown) => void) | null = null;
/** ResolverHost's event callbacks. */
export function resolverEvent(kind: HostEvent, e: unknown) {
  try {
    onHostEvent?.(kind, e);
  } catch {}
}

/** Page documents of earlier resolves: their late messages are ignored. */
const retiredDocs = new Set<string>();

// --- Queue --------------------------------------------------------------------

type Job = { req: ResolveRequest; done: (r: ResolveResult) => void; prio: number; seq: number; restarts: number };
const jobs: Job[] = [];
let jobSeq = 0;
let running: Job | null = null;
/** Ends the resolve in progress: "cancelled" or "preempted". */
let abortCurrent: ((why: "cancelled" | "preempted") => void) | null = null;

let warmed = false;
/** Warms the hidden web view once, at idle after boot (TS core): a first
 * real navigation (`url`, a tiny page of a source's origin) starts the web
 * content process, the networking stack and the injected guard/sniffer, so
 * the first resolve does not pay for them (~8 s on a cold Android
 * emulator). Back to about:blank after 4 s. False while busy or while the
 * view cannot be made yet (call again later). */
export function warmResolver(url: string): boolean {
  if (warmed) return true;
  if (running || jobs.length) return false;
  if (!ensureResolverHost() || !hostRef) return false;
  warmed = true;
  log(`warm: ${url}`);
  navigateHidden(url);
  setTimeout(() => {
    if (!running && !jobs.length) navigateHidden("about:blank");
  }, 4000);
  return true;
}

/** Resolves a stream link in the hidden web view. One at a time, highest
 * `priority` first; never rejects. */
export function resolveStream(req: ResolveRequest): Promise<ResolveResult> {
  return new Promise((done) => {
    const job: Job = { req, done, prio: req.priority ?? 0, seq: ++jobSeq, restarts: 0 };
    jobs.push(job);
    if (running && job.prio > running.prio && abortCurrent) {
      log(`preempting ${running.req.tag ?? "?"} (prio ${running.prio}) for ${req.tag ?? "?"} (prio ${job.prio})`);
      abortCurrent("preempted");
    }
    void pump();
  });
}

/** Whether a resolve is running or waiting. */
export function resolveBusy(): boolean {
  return !!running || jobs.length > 0;
}

/** Cancels resolves; each ends with `{ ok: false, cancelled: true }`.
 * With a `tag`: only that caller's (running or waiting); without: all. */
export function cancelResolve(tag?: string) {
  const hit = (j: Job) => tag === undefined || j.req.tag === tag;
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if (!hit(j)) continue;
    jobs.splice(i, 1);
    j.done({ ok: false, cancelled: true, error: "cancelled", source: j.req.source ?? "", mode: "opacity", ms: 0, steps: [] });
  }
  if (running && hit(running)) abortCurrent?.("cancelled");
}

function nextJob(): Job | undefined {
  if (!jobs.length) return undefined;
  let best = 0;
  for (let i = 1; i < jobs.length; i++) {
    const a = jobs[i], b = jobs[best];
    if (a.prio > b.prio || (a.prio === b.prio && a.seq < b.seq)) best = i;
  }
  return jobs.splice(best, 1)[0];
}

async function pump() {
  if (running) return;
  const job = nextJob();
  if (!job) return;
  running = job;
  let res: ResolveResult;
  let delivered = false;
  // The answer goes out at once; the page may run a little longer for late
  // subtitles before the next resolve starts (runOne resolves then).
  const deliver = (r: ResolveResult) => {
    if (delivered || r.error === "preempted") return;
    delivered = true;
    try {
      job.done(r);
    } catch {}
  };
  try {
    res = await runOne(job.req, deliver);
  } catch (e) {
    res = { ok: false, error: String(e), source: job.req.source ?? "", mode: "opacity", ms: 0, steps: [] };
  }
  running = null;
  abortCurrent = null;
  onHostEvent = null;
  if (!delivered && res.error === "preempted" && job.restarts < 3) {
    // Retried after the higher-priority one (keeps its place in its tier).
    job.restarts++;
    jobs.push(job);
  } else if (!delivered) {
    delivered = true;
    try {
      job.done(res.error === "preempted" ? { ...res, cancelled: true } : res);
    } catch {}
  }
  if (jobs.length) void pump();
}

// --- One resolve ---------------------------------------------------------------------

/** WebKit's cookie store for `url` (HttpOnly included), on Apple hosts. */
async function nativeCookies(url: string): Promise<string> {
  try {
    if (!host.available()) return "";
    const res = (await Promise.race([
      host.call("sys.webCookies", { url }),
      new Promise((r) => setTimeout(() => r(null), 400)),
    ])) as { ok?: boolean; cookie?: string } | null;
    return res && res.ok && typeof res.cookie === "string" ? res.cookie : "";
  } catch {
    return "";
  }
}

async function runOne(req: ResolveRequest, deliver: (r: ResolveResult) => void = () => {}): Promise<ResolveResult> {
  const t0 = Date.now();
  const source = pickSourceId(req);
  const timeoutMs = req.timeoutMs ?? SOURCE_TIMEOUT[source] ?? 30000;
  const steps: string[] = [];
  const step = (s: string, data?: unknown) => {
    const line = `+${Date.now() - t0}ms ${s}`;
    if (steps.length < 80) steps.push(line);
    log(line, data);
  };
  const result = (r: Partial<ResolveResult> & { ok: boolean }, src = source): ResolveResult => ({
    ...r,
    source: src,
    mode: "opacity",
    ms: Date.now() - t0,
    steps,
  });
  const what =
    req.type === "tv"
      ? `tv:${req.id} S${req.season ?? 1}E${req.episode ?? 1}`
      : req.type === "anime"
        ? `anime:${req.id} E${req.episode ?? 1} ${req.lang ?? "sub"}`
        : `movie:${req.id}`;
  step(`start ${what} source=${source} timeout=${timeoutMs} prio=${req.priority ?? 0} tag=${req.tag ?? ""}`);

  // The player already exposes this episode's link: no hidden page.
  const live = req.fresh ? null : untracked(() => currentStreamLink());
  if (live && playerShows(req, live.route)) {
    step("using the playing page's link");
    return result(
      { ok: true, url: live.url, kind: live.kind, headers: live.headers, ua: live.ua, format: live.kind === "hls" ? "hls" : "mp4", native: true },
      "player",
    );
  }

  let stop: "cancelled" | "preempted" | null = null;
  abortCurrent = (why) => {
    stop = why;
  };
  let url: string | null = null;
  try {
    url = await embedUrl(req, source, step);
  } catch (e) {
    step(`url build threw: ${String(e)}`);
  }
  if (stop) return result({ ok: false, cancelled: stop === "cancelled", error: stop });
  if (!url) return result({ ok: false, error: "no embed URL for this source/title" });
  const pageUrl = url;

  // The hidden view must exist (it is only made while the app is active).
  let waited = false;
  while (!ensureResolverHost()) {
    if (stop) return result({ ok: false, cancelled: stop === "cancelled", error: stop });
    if (!waited) step("waiting for the hidden web view (app not active)");
    waited = true;
    try {
      req.onWaiting?.();
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (stop) return result({ ok: false, cancelled: stop === "cancelled", error: stop });
  const tLoad = Date.now();

  return new Promise<ResolveResult>((resolve) => {
    let finished = false;
    let started = false;
    let loaded = false;
    let videoSeen = false;
    let nudged = false;
    let polls = 0;
    let lastOther: string[] = [];
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let muteTimer: ReturnType<typeof setInterval> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const docs = new Set<string>();
    const cands = new CandidateSet();
    const subs = new SubtitleSet();
    const subKey = pageSubKey(req.type, req.id, req.season, req.episode);
    let subTimer: ReturnType<typeof setTimeout> | undefined;
    let subsSent = -1;
    let answered = false;
    let notesLogged = 0;
    const subList = () => pageSubtitleResults(subs.list());
    /** Publishes the page's subtitles (debounced): to the engine, and to
     * the caller once it has its answer. */
    const publishSubs = (now = false) => {
      const go = () => {
        subTimer = undefined;
        if (subs.size() === subsSent) return;
        subsSent = subs.size();
        const list = subList();
        setPageSubtitles(subKey, list);
        if (answered) {
          try {
            req.onSubtitles?.(list);
          } catch {}
        }
      };
      if (now) {
        if (subTimer) clearTimeout(subTimer);
        go();
      } else if (!subTimer) subTimer = setTimeout(go, 200);
    };

    const post = (msg: Record<string, unknown>) => {
      try {
        hostRef?.postMessage(JSON.stringify(msg));
      } catch (e) {
        step(`postMessage threw: ${String(e)}`);
      }
    };
    const inject = (js: string) => {
      try {
        hostRef?.injectJavaScript(js);
      } catch (e) {
        step(`injectJavaScript threw: ${String(e)}`);
      }
    };

    /** Stops the page: paused, muted, back to about:blank. */
    let tornDown = false;
    const teardown = (out: ResolveResult) => {
      if (tornDown) return;
      tornDown = true;
      if (subTimer) clearTimeout(subTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (muteTimer) clearInterval(muteTimer);
      post({ t: "pause" });
      inject(PAUSE_JS);
      inject(MUTE_JS);
      for (const d of docs) retiredDocs.add(d);
      if (retiredDocs.size > 200) retiredDocs.clear();
      onHostEvent = null;
      // Back to about:blank: stops every request and the media.
      navigateHidden("about:blank");
      if (subs.size() !== subsSent) publishSubs(true);
      resolve(out);
    };
    const finish = (r: Partial<ResolveResult> & { ok: boolean }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
      // Silence the page at once, whatever the outcome.
      post({ t: "pause" });
      inject(PAUSE_JS);
      inject(MUTE_JS);
      publishSubs(true);
      for (const n of cands.notes.slice(notesLogged)) step(`page: ${n}`);
      step(`end: polls=${polls} loaded=${loaded} video=${videoSeen} candidates=${cands.size()} subtitles=${subs.size()}`);
      if (!r.ok && lastOther.length) step(`non-playable stream urls seen: ${lastOther.join(" | ")}`);
      const out = result({ ...r, subtitles: subList() });
      log(`result ok=${out.ok} ${out.format ?? ""} ${out.url ?? out.error ?? ""}`);
      answered = true;
      deliver(out);
      // A found stream: the page may still list subtitles for a moment.
      if (r.ok && !stop) setTimeout(() => teardown(out), SUB_GRACE_MS);
      else teardown(out);
    };
    abortCurrent = (why) => {
      step(why);
      if (finished) {
        // In the subtitle grace: just stop the page now.
        const out = result({ ok: true });
        teardown(out);
        return;
      }
      finish({ ok: false, cancelled: why === "cancelled", error: why });
    };

    /** Picks the best candidate and answers. */
    const decide = async () => {
      if (finished) return;
      const ranked = cands.ranked();
      const best = ranked.find((c) => c.format !== "dash");
      const list: ResolveCandidate[] = ranked.slice(0, 12).map((c) => ({
        url: c.url,
        format: c.format,
        role: c.role,
        via: c.via,
        frameOrigin: c.frameOrigin,
        ...(c.inner ? { inner: c.inner } : {}),
      }));
      if (!best) {
        const dash = ranked[0];
        finish({
          ok: false,
          error: "only a DASH manifest (not playable natively)",
          format: "dash",
          native: false,
          url: dash?.url,
          frameOrigin: dash?.frameOrigin,
          candidates: list,
        });
        return;
      }
      const headers = headersFor(best, RESOLVER_UA);
      const referer = Object.entries(headers).find(([k]) => k.toLowerCase() === "referer")?.[1];
      let cookies = await nativeCookies(best.url);
      if (!cookies && best.frameCookies && best.frameUrl && sameSite(best.url, best.frameUrl)) cookies = best.frameCookies;
      step(
        `chose ${best.format}/${best.role || "?"} via ${best.via} from ${best.frameOrigin || "?"} among ${ranked.length}` +
          (cookies ? ` (cookies: ${cookies.split(";").length})` : ""),
      );
      finish({
        ok: true,
        url: best.url,
        kind: best.format === "hls" ? "hls" : "file",
        headers,
        ua: headers["User-Agent"] ?? best.ua ?? RESOLVER_UA,
        format: best.format,
        native: true,
        frameOrigin: best.frameOrigin || undefined,
        referer,
        cookies: cookies || undefined,
        wrapper: best.inner ? best.url : undefined,
        inner: best.inner,
        candidates: list,
      });
    };

    /** A new candidate: settle briefly for a better one (a master ends it). */
    const consider = (c: StreamCandidate | null | StreamCandidate[]) => {
      const list = Array.isArray(c) ? c : c ? [c] : [];
      for (const x of list) {
        step(`stream ${x.format}/${x.role || "?"} via ${x.via} from ${x.frameOrigin || "?"}: ${x.url.slice(0, 140)}`);
      }
      if (!list.length || finished) return;
      if (cands.hasMaster()) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => void decide(), 50);
        return;
      }
      if (!settleTimer) settleTimer = setTimeout(() => void decide(), SETTLE_MS);
    };

    const begin = (why: string) => {
      if (started || finished) return;
      started = true;
      step(`start muting + polling (${why})`);
      inject(MUTE_JS);
      muteTimer = setInterval(() => inject(MUTE_JS), MUTE_MS);
      const poll = () => {
        polls++;
        post({ t: "streams" });
      };
      poll();
      pollTimer = setInterval(poll, POLL_MS);
    };

    /** A message of this resolve's page (not of an earlier one). */
    const ours = (doc: unknown): boolean => {
      if (typeof doc !== "string" || !doc) return true;
      if (retiredDocs.has(doc)) return false;
      docs.add(doc);
      return true;
    };

    const onMessage = (e: { data: unknown }) => {
      const raw = typeof e?.data === "string" ? e.data : JSON.stringify(e?.data);
      if (!raw) return;
      let v: { t?: unknown; [k: string]: unknown };
      try {
        v = JSON.parse(raw);
      } catch {
        return;
      }
      if (!v || typeof v.t !== "number") return;
      const t = v.t;
      if (t === -6) {
        step(`bridge threw: ${String(v.err).slice(0, 200)}`);
        return;
      }
      if (t === -8) {
        if (typeof v.msg === "string" && /threw/.test(v.msg)) step(`page: ${v.msg.slice(0, 200)}`);
        return;
      }
      if (t === -11) {
        // The all-frames sniffer (pushed as it happens).
        const m = v.m && typeof v.m === "object" ? (v.m as Record<string, unknown>) : null;
        if (!m) return;
        if (m.k === "sub") {
          if (subs.add(m, RESOLVER_UA)) publishSubs();
          return;
        }
        begin("sniffer");
        const c = cands.addSniff(m);
        if (!c) {
          while (notesLogged < cands.notes.length && notesLogged < 12) step(`page: ${cands.notes[notesLogged++]}`);
          return;
        }
        consider(c);
        return;
      }
      if (t === -3 || t === -1) {
        if (!ours(v.doc)) return;
        begin(t === -3 ? "bridge boot" : "heartbeat");
        return;
      }
      if (t === -2) {
        if (v.src !== "android" && !ours(v.doc)) return;
        const list: string[] = Array.isArray(v.streams)
          ? (v.streams as unknown[]).filter((s): s is string => typeof s === "string")
          : [];
        const got = cands.addStreams(v, pageUrl);
        if (!got.length) {
          if (list.length) lastOther = list.slice(0, 3);
          return;
        }
        consider(got);
        return;
      }
      if (t >= 0) {
        // A state report: the top document has a video element.
        if (typeof v.vid === "string" && !ours(v.vid.split(":")[0])) return;
        begin("video state");
        if (!videoSeen) {
          videoSeen = true;
          step(`video seen (ev=${String(v.ev ?? "hb")} rs=${String(v.rs ?? "?")} muted=${String(v.m ?? "?")})`);
        }
        if (v.m === false) inject(MUTE_JS);
        if (!nudged) {
          nudged = true;
          // Muted first, then the bridge's own `play` (some embeds only
          // request the stream on play).
          inject(MUTE_JS);
          post({ t: "play" });
        }
      }
    };

    const onLateMessage = (e: { data: unknown }) => {
      const raw = typeof e?.data === "string" ? e.data : "";
      if (!raw || raw.indexOf('"sub"') < 0) return;
      try {
        const v = JSON.parse(raw);
        if (v && v.t === -11 && v.m && v.m.k === "sub" && subs.add(v.m, RESOLVER_UA)) publishSubs();
      } catch {}
    };

    onHostEvent = (kind, e) => {
      if (finished) {
        // The subtitle grace: only subtitle records count now.
        if (kind === "message" && !tornDown) onLateMessage(e as { data: unknown });
        return;
      }
      if (kind === "message") onMessage(e as { data: unknown });
      else if (kind === "load") {
        // The about:blank load of the previous resolve does not count.
        const o = ((e as { nativeEvent?: unknown } | null)?.nativeEvent ?? e ?? {}) as { url?: unknown };
        if (typeof o.url === "string" && o.url.startsWith("about:")) return;
        loaded = true;
        inject(MUTE_JS);
        begin("onLoad");
      } else if (kind === "error") {
        step(`wv:error ${JSON.stringify(e)?.slice(0, 160) ?? ""}`);
      }
    };

    const timeout = setTimeout(() => {
      step("timeout");
      if (cands.size()) {
        void decide();
        return;
      }
      finish({ ok: false, error: `no link within ${Math.round(timeoutMs / 1000)} s` });
    }, Math.max(0, timeoutMs - (Date.now() - tLoad)));

    if (stop) {
      finish({ ok: false, cancelled: stop === "cancelled", error: stop });
      return;
    }
    step(`page load: ${pageUrl}`);
    navigateHidden(pageUrl);
  });
}

const TEST_KEY = "rustflix.resolvetest";
const RESULT_KEY = "rustflix.resolvetest.result";

/** Boot hook: runs the requests in `rustflix.resolvetest` (a JSON array of
 * ResolveRequest), once, writing ResolveResult[] to
 * `rustflix.resolvetest.result` after each entry. */
export async function runResolveTest() {
  let raw: string | null = null;
  try {
    raw = await Storage.getItem(TEST_KEY);
  } catch {}
  if (!raw) return;
  try {
    await Storage.removeItem(TEST_KEY);
  } catch {}
  let reqs: ResolveRequest[] = [];
  try {
    const parsed = JSON.parse(raw);
    reqs = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    log(`test: bad JSON in ${TEST_KEY}: ${String(e)}`);
    await Storage.setItem(RESULT_KEY, JSON.stringify({ error: `bad JSON: ${String(e)}` })).catch(() => {});
    return;
  }
  log(`test: ${reqs.length} request(s), starting in 3 s`);
  await new Promise((r) => setTimeout(r, 3000));
  const results: ResolveResult[] = [];
  for (const req of reqs) {
    const res = await resolveStream({ fresh: true, ...req });
    results.push(res);
    await Storage.setItem(RESULT_KEY, JSON.stringify(results)).catch(() => {});
    log(`test: ${results.length}/${reqs.length} done`);
  }
  log("test: finished");
}
