// Player controller: everything the player screen, the title bar and the
// keybinds share — the WebView ref and its message bridge, playback
// commands, episode lists, the command palette's state, progress saving
// and resume-on-open.
//
// The WebView is a native view above all GPUI content, so nothing drawn
// over it is visible: every player UI element lives in-flow around it,
// and the palette replaces the video area while open.
//
// Page communication goes through NSH's WebView bridge: the app calls
// `ref.postMessage(json)` which dispatches a `message` event in the
// page, and the injected bridge script answers state reports through
// `window.nsh.postMessage`, which arrives as the WebView's `onMessage`.
// There is no evaluate()-with-return on this platform.

import { computed, keymap, signal, Storage } from "nsh";
import type { WebViewRef } from "nsh";
import process from "process";
import { aniDetails } from "./anilist";
import { navigate, route, setLeaveHook, type Route } from "./router";
import { getSourceUrl, PLAYER_SOURCES, type MediaType } from "./sources";
import { itemKey, progress, saveProgress, settings } from "./store";
import { externalIds, seasonDetails, tvDetails, type Episode } from "./tmdb";

export type PlayerRoute = Extract<Route, { name: "player" }>;

export const webview = signal<WebViewRef | null>(null);
export const sourceId = signal(settings().defaultSource);
export const showSources = signal(false);
export const showPalette = signal(false);
export const paletteView = signal<"root" | "speed" | "subs">("root");
export const paletteQuery = signal("");
export const episodes = signal<{ n: number; name: string }[]>([]);
export const seasons = signal<number[]>([]);
export const subTracks = signal<{ i: number; label: string; mode: string }[]>([]);
export const position = signal(0);
export const duration = signal(0);
export const mediaPaused = signal(false);
export const mediaRate = signal(1);
/** Media URLs the embed page has fetched (m3u8/mp4/…), newest first. */
export const streamUrls = signal<string[]>([]);
/** Request headers the page used per stream URL (for the downloader). */
export const streamHeaders = signal<Record<string, Record<string, string>>>({});
export const streamUA = signal("");

export interface DownloadItem {
  id: number;
  name: string;
  status: "running" | "done" | "error";
  /** 0–100 when the downloader reports a percentage, else null. */
  progress: number | null;
  message: string;
  /** Live child handle for cancellation (not persisted). */
  proc?: { kill?: () => void };
}

export const downloads = signal<DownloadItem[]>([]);

// --- Page bridge ------------------------------------------------------------
//
// Injected into every page the WebView loads (after content). It:
//  - listens for `message` events carrying JSON commands
//    ({t:'play'|'pause'|'toggle'|'seekby'|'seek'|'rate'|'track'})
//  - polls the top document's <video> every 1.5s and reports
//    {t,d,p,r,tracks} through window.nsh.postMessage
//  - applies a pending absolute seek as soon as a video element exists
//  - snaps unexpected playback rates back to 1x (embed players sometimes
//    leave video at 2x after a space-bar toggle)

export const PLAYER_BRIDGE = `(function () {
  var __rep = function (s) {
    try { if (window.nsh && window.nsh.postMessage) { window.nsh.postMessage(s); return; } } catch (e) {}
    try { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(s); } catch (e) {}
  };
  if (window.__rf_bridge) return;
  window.__rf_bridge = true;
  try {
  // Rates the embed may use on its own; anything else is snapped back.
  // A rate the app picked through the palette ('rate' command) is also
  // allowed, so embeds can't get stuck at e.g. 2x while 2x stays
  // selectable for the user.
  var stdRates = { 0.5: 1, 0.75: 1, 1: 1, 1.25: 1, 1.5: 1 };
  var allowedRate = null;
  var pendingSeek = null;
  var keyBlock = null;
  // The real player is usually the video with the most readyState +
  // duration; pages can carry preview/hover videos too.
  var pickVideo = function () {
    var vs;
    try { vs = document.querySelectorAll('video'); } catch (e) { return null; }
    var best = null, score = -1;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i], d = 0;
      try { d = v.duration || 0; } catch (e) {}
      var s = (v.readyState || 0) * 100000 + d;
      if (s > score) { score = s; best = v; }
    }
    return best;
  };
  var fixRate = function (v) {
    if (!v || !v.playbackRate) return;
    var r = v.playbackRate;
    // A rate the app picked is allowed exactly once: the ratechange it
    // causes clears the allowance, so a later spontaneous jump to the
    // same value by the embed is snapped back.
    if (r === allowedRate) { allowedRate = null; return; }
    if (stdRates[r]) return;
    try { v.playbackRate = allowedRate || 1; } catch (e) {}
  };
  document.addEventListener('play', function (e) { fixRate(e.target); }, true);
  document.addEventListener('ratechange', function (e) { fixRate(e.target); }, true);
  // Stream sniffing: the resource-timing buffer is small and hls.js floods
  // it with segment requests, evicting the playlist URL. Record media
  // requests as they happen instead, and grow the buffer as a backup.
  var seenStreams = {}, streamCount = 0, streamSeq = 0;
  var hdrs = {};
  var note = function (u) {
    try {
      if (typeof u !== 'string' || !u || u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return;
      if (!/\\.(m3u8|mp4|mpd|ism|m4s|ts)(\\?|#|$)/i.test(u) && !/\\.ism\\//i.test(u)) return;
      if (streamCount > 900) { seenStreams = {}; hdrs = {}; streamCount = 0; }
      // Recency-ordered: signed playlist URLs expire, newest must win.
      seenStreams[u] = ++streamSeq; streamCount++;
    } catch (e) {}
  };
  var grabHeaders = function (h, u) {
    try {
      if (!h || typeof u !== 'string' || !u) return;
      var o = hdrs[u] = hdrs[u] || {};
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (v, k) { o[k] = v; });
      } else if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) o[h[i][0]] = h[i][1];
      } else if (typeof h === 'object') {
        for (var k2 in h) o[k2] = h[k2];
      }
    } catch (e) {}
  };
  try {
    var of = window.fetch;
    if (of) window.fetch = function () {
      try {
        var a = arguments[0], init = arguments[1];
        var u = typeof a === 'string' ? a : (a && a.url) || '';
        note(u);
        grabHeaders(a && a.headers !== undefined ? a.headers : (init && init.headers), u);
      } catch (e) {}
      return of.apply(this, arguments);
    };
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      try { this.__rfu = arguments[1]; note(this.__rfu); } catch (e) {}
      return oo.apply(this, arguments);
    };
    var osr = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        var u = this.__rfu;
        if (typeof u === 'string' && u) (hdrs[u] = hdrs[u] || {})[k] = v;
      } catch (e) {}
      return osr.apply(this, arguments);
    };
    if (performance.setResourceTimingBufferSize) {
      try { performance.setResourceTimingBufferSize(4000); } catch (e) {}
      if (performance.addEventListener) {
        performance.addEventListener('resourcetimingbufferfull', function () {
          try { performance.clearResourceTimings(); } catch (e) {}
        });
      }
    }
  } catch (e) {}
  window.addEventListener('message', function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (!m) return;
    if (m.t === 'seek' && typeof m.p === 'number') { pendingSeek = m.p; return; }
    if (m.t === 'keys') {
      // While an app overlay (palette / source picker) owns the keyboard,
      // swallow every key in the page so the embed can't also act on it -
      // ViewRef.blur() cannot resign the native web view's first
      // responder, so without this space toggles playback AND filters.
      if (m.on && !keyBlock) {
        keyBlock = function (e) {
          e.stopImmediatePropagation();
          e.preventDefault();
        };
        window.addEventListener('keydown', keyBlock, true);
        window.addEventListener('keyup', keyBlock, true);
        window.addEventListener('keypress', keyBlock, true);
        document.addEventListener('keydown', keyBlock, true);
        document.addEventListener('keyup', keyBlock, true);
        document.addEventListener('keypress', keyBlock, true);
      } else if (!m.on && keyBlock) {
        window.removeEventListener('keydown', keyBlock, true);
        window.removeEventListener('keyup', keyBlock, true);
        window.removeEventListener('keypress', keyBlock, true);
        document.removeEventListener('keydown', keyBlock, true);
        document.removeEventListener('keyup', keyBlock, true);
        document.removeEventListener('keypress', keyBlock, true);
        keyBlock = null;
      }
      return;
    }
    if (m.t === 'streams') {
      // On-demand: playlists/progressive files first (what the downloader
      // wants), then a few segment URLs as fallback. Sources: URLs seen
      // at request time, the picked video's own src, and resource timing.
      var seen = {}, good = [], segs = [], cand = [];
      try {
        var skeys = [];
        for (var sk in seenStreams) skeys.push(sk);
        skeys.sort(function (a, b) { return seenStreams[b] - seenStreams[a]; });
        for (var x = 0; x < skeys.length; x++) cand.push(skeys[x]);
        var sv = pickVideo();
        if (sv) cand.push(sv.currentSrc || sv.src || '');
        var es = performance.getEntriesByType('resource');
        for (var i = es.length - 1; i >= 0 && cand.length < 4000; i--) {
          cand.push(es[i].name || '');
        }
      } catch (err) {}
      for (var j = 0; j < cand.length; j++) {
        var u = cand[j];
        if (!u || u.indexOf('blob:') === 0 || u.indexOf('data:') === 0 || seen[u]) continue;
        if (!/\\.(m3u8|mp4|mpd|ism|m4s|ts)(\\?|#|$)/i.test(u) && !/\\.ism\\//i.test(u)) continue;
        seen[u] = 1;
        if (/\\.m4s(\\?|#|$)/i.test(u) || /\\.ts(\\?|#|$)/i.test(u)) {
          if (segs.length < 8) segs.push(u);
        } else if (good.length < 10) {
          good.push(u);
        }
      }
      var out = good.concat(segs), hm = {};
      for (var y = 0; y < out.length && y < 10; y++) {
        if (hdrs[out[y]]) hm[out[y]] = hdrs[out[y]];
      }
      report(JSON.stringify({ t: -2, streams: out, hdrs: hm, ua: navigator.userAgent || '' }));
      return;
    }
    var v = pickVideo();
    if (!v) return;
    try {
      if (m.t === 'play') v.play();
      else if (m.t === 'pause') v.pause();
      else if (m.t === 'toggle') { v.paused ? v.play() : v.pause(); }
      else if (m.t === 'seekby') v.currentTime = Math.max(0, (v.currentTime || 0) + m.s);
      else if (m.t === 'rate' && m.r) { allowedRate = m.r; v.playbackRate = m.r; }
      else if (m.t === 'track' && v.textTracks) {
        var ts = v.textTracks;
        for (var k = 0; k < ts.length; k++) {
          ts[k].mode = (k === m.i) ? 'showing' : (ts[k].mode === 'showing' ? 'hidden' : 'disabled');
        }
      }
    } catch (err) {}
  });
  var report = function (payload) {
    try { if (window.nsh && window.nsh.postMessage) { window.nsh.postMessage(payload); return; } } catch (e) {}
    try { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(payload); } catch (e) {}
  };
  setInterval(function () {
    var v = pickVideo();
    if (!v) {
      var nv = 0;
      try { nv = document.querySelectorAll('video').length; } catch (e) {}
      report(JSON.stringify({ t: -1, n: nv }));
      return;
    }
    if (pendingSeek != null) {
      // Clear BEFORE assigning: if currentTime throws (video has no src
      // yet), a stale pendingSeek must not re-fire every tick forever.
      var p = pendingSeek;
      pendingSeek = null;
      try { v.currentTime = p; } catch (e) {}
    }
    var tracks = [];
    try {
      var ts = v.textTracks;
      if (ts) for (var k = 0; k < ts.length; k++) {
        var tr = ts[k];
        tracks.push({ i: k, label: tr.label || tr.language || ('Track ' + (k + 1)), mode: tr.mode });
      }
    } catch (e) {}
    var t = 0, d = 0, r = 1;
    try { t = v.currentTime || 0; } catch (e) {}
    try { d = v.duration || 0; } catch (e) {}
    try { r = v.playbackRate || 1; } catch (e) {}
    report(JSON.stringify({
      t: t, d: d, p: !!v.paused, r: r, tracks: tracks,
    }));
  }, 1500);
  // Boot beacon: proves the injected script ran at all, even if the
  // interval is later throttled into silence.
  report(JSON.stringify({ t: -3, boot: 1 }));
  } catch (err) {
    __rep(JSON.stringify({ t: -6, err: String(err && err.stack || err) }));
  }
})();`;

// --- Debug ring buffer (readable in storage.json while testing) -------------

const DEBUG_KEY = "rustflix.debug";
// Diagnostics are opt-in: set `rustflix.debug` to "1" in storage to record.
let debugOn = false;
void Storage.getItem(DEBUG_KEY)
  .then((v) => {
    debugOn = v === "1";
  })
  .catch(() => {});
export function setDebugEnabled(on: boolean) {
  debugOn = on;
  void Storage.setItem(DEBUG_KEY, on ? "1" : "0").catch(() => {});
  if (on) debugLog.length = 0;
}
const debugLog: { t: number; e: string; d?: unknown }[] = [];
export function debug(event: string, data?: unknown) {
  if (!debugOn) return;
  debugLog.push({ t: Date.now(), e: event, d: data });
  if (debugLog.length > 80) debugLog.shift();
  void Storage.setItem("rustflix.debug.log", JSON.stringify(debugLog)).catch(() => {});
}

/**
 * Installs the page bridge via runtime script evaluation as a backup to
 * the `injectedJavaScriptBeforeContentLoaded` prop (which runs it at
 * document start on every navigation). The bridge guards itself with
 * `window.__rf_bridge`, so repeats are safe.
 */
export function armBridge() {
  const ref = webview();
  if (!ref || typeof ref.injectJavaScript !== "function") {
    debug("bridge: no ref/injectJavaScript");
    return;
  }
  try {
    ref.injectJavaScript(PLAYER_BRIDGE);
    debug("bridge: injected");
  } catch (e) {
    debug("bridge: inject threw", String(e));
  }
}

/** App → page: JSON command for the bridge's message listener. */
function send(msg: Record<string, unknown>) {
  const ref = webview();
  debug("send", msg);
  if (!ref) {
    debug("send: no webview ref");
    return;
  }
  try {
    if (typeof ref.postMessage === "function") {
      ref.postMessage(JSON.stringify(msg));
      return;
    }
  } catch (e) {
    debug("send: postMessage threw", String(e));
  }
  try {
    if (typeof ref.injectJavaScript === "function") {
      const data = JSON.stringify(JSON.stringify(msg));
      ref.injectJavaScript(
        `window.dispatchEvent(new MessageEvent('message',{data:${data}}));`,
      );
      debug("send: used injectJavaScript fallback");
    } else {
      debug("send: no postMessage/injectJavaScript on ref");
    }
  } catch (e) {
    debug("send: injectJavaScript threw", String(e));
  }
}

/** Page → app: the bridge's 1.5s state report. */
export function onPlayerMessage(e: { data: unknown }) {
  const raw = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
  debug("msg", raw?.slice(0, 2000));
  if (!raw) return;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.t !== "number") return;
    if (v.t === -6) {
      debug("bridge: threw", v.err);
      return;
    }
    if (v.t === -3) {
      debug("bridge: boot");
      return;
    }
    if (v.t === -2) {
      if (Array.isArray(v.streams)) {
        streamUrls.set(
          v.streams.filter((s: unknown) => typeof s === "string"),
        );
      }
      if (v.hdrs && typeof v.hdrs === "object") {
        streamHeaders.set(v.hdrs as Record<string, Record<string, string>>);
      }
      if (typeof v.ua === "string" && v.ua) streamUA.set(v.ua);
      return;
    }
    if (v.t < 0) return; // heartbeat: bridge alive, no video element yet
    position.set(v.t);
    if (typeof v.d === "number" && v.d > 0) duration.set(v.d);
    mediaPaused.set(!!v.p);
    if (typeof v.r === "number" && v.r > 0) mediaRate.set(v.r);
    if (Array.isArray(v.tracks)) {
      subTracks.set(
        v.tracks.map((t: { i: number; label: string; mode: string }) => ({
          i: t.i,
          label: t.label,
          mode: t.mode,
        })),
      );
    }
    const now = Date.now();
    if (now - lastSaved > 30_000 && duration() > 0) {
      lastSaved = now;
      persist();
    }
  } catch {}
}

// --- Route helpers ------------------------------------------------------------

export function playerRoute(): PlayerRoute | null {
  const r = route();
  return r.name === "player" ? r : null;
}

export function persist() {
  const r = playerRoute();
  if (!r) return;
  void saveProgress({
    key: itemKey(r.type, r.id, r.season ?? 0, r.episode ?? 0),
    type: r.type,
    id: r.id,
    title: r.title ?? "Untitled",
    poster: r.poster ?? "",
    season: r.season,
    episode: r.episode,
    position: position(),
    duration: duration(),
    source: sourceId(),
  });
}

export function playerUrl(): string | null {
  const r = playerRoute();
  if (!r) return null;
  const sid = sourceId();
  const src = PLAYER_SOURCES.find((s) => s.id === sid);
  // Sources keyed on IMDb need the external id resolved first; until it
  // is, there is no URL (the screen shows a loading state).
  const overrideId = src?.idType === "imdb" ? extId() : undefined;
  if (src?.idType === "imdb" && !overrideId) return null;
  return getSourceUrl(
    sid,
    {
      type: r.type as MediaType,
      id: r.id,
      season: r.season,
      episode: r.episode,
      lang: r.lang,
      overrideId,
    },
    {},
    settings().accent,
    settings().subtitleLang || null,
  );
}

// --- External ids (IMDb for sources that key on it) ----------------------------

/** `${type}:${id}` → resolved IMDb id ("tt…"). */
const extIds = new Map<string, string>();
const extPending = new Map<string, Promise<void>>();
export const extId = signal("");
export const extLoading = signal(false);

/** Fetches the IMDb id for the current title when the chosen source
 * needs it. Safe to call on every player open — cached per title. */
export async function ensureExtId(r: PlayerRoute) {
  const src = PLAYER_SOURCES.find((s) => s.id === sourceId());
  if (src?.idType !== "imdb" || r.type === "anime") {
    extId.set("");
    extLoading.set(false);
    return;
  }
  const key = `${r.type}:${r.id}`;
  const cached = extIds.get(key);
  if (cached) {
    extId.set(cached);
    extLoading.set(false);
    return;
  }
  extLoading.set(true);
  extId.set("");
  let p = extPending.get(key);
  if (!p) {
    p = (async () => {
      try {
        const ids = await externalIds(r.type === "tv" ? "tv" : "movie", r.id);
        if (ids.imdb_id) extIds.set(key, ids.imdb_id);
      } catch {}
    })().finally(() => extPending.delete(key));
    extPending.set(key, p);
  }
  await p;
  extId.set(extIds.get(key) ?? "");
  extLoading.set(false);
}

export function pickSource(id: string) {
  sourceId.set(id);
  showSources.set(false);
  const r = playerRoute();
  if (r) void ensureExtId(r);
}

// --- Media commands (messages into the page's bridge) -------------------------

export function togglePlay() {
  send({ t: "toggle" });
}

export function pausePlayback() {
  send({ t: "pause" });
}

export function seekBy(sec: number) {
  send({ t: "seekby", s: sec });
}

export function setRate(rate: number) {
  mediaRate.set(rate);
  send({ t: "rate", r: rate });
}

/** `i` -1 turns subtitles off, else shows track `i` and hides the rest. */
export function setTrack(i: number) {
  send({ t: "track", i });
}

// --- Downloads -----------------------------------------------------------------
//
// Streambert captures the HLS URL through Electron request interception;
// the GPUI WebView has none, so the page bridge sniffs the media URLs it
// fetched (resource timing) and hands them to the app on demand. The
// actual download is delegated to the vid-dl CLI release the user installs
// — the app only spawns it with the stream URL and watches its output.

let dlSeq = 0;

function patchDownload(id: number, patch: Partial<DownloadItem>) {
  downloads.set(downloads().map((d) => (d.id === id ? { ...d, ...patch } : d)));
}

function failDownload(name: string, message: string) {
  debug("download: fail", { name, message });
  downloads.set(
    [{ id: ++dlSeq, name, status: "error", progress: null, message }, ...downloads()].slice(0, 20),
  );
}

/** Asks the page for its fetched media URLs and stores the answer. */
export function refreshStreams() {
  send({ t: "streams" });
}

/** Blocks (or unblocks) every key inside the player page while an app
 * overlay owns the keyboard — the native web view keeps first responder
 * and would otherwise act on the same keystrokes. */
export function setPageKeysBlocked(on: boolean) {
  send({ t: "keys", on });
}

/** Best download candidate: prefer HLS playlists, then progressive mp4. */
export function bestStreamUrl(): string | null {
  const list = streamUrls();
  if (!list.length) return null;
  return (
    list.find((u) => /\.m3u8(\?|#|$)/i.test(u)) ??
    list.find((u) => /\.mp4(\?|#|$)/i.test(u)) ??
    list[0]
  );
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Filename-safe title for the downloaded file. */
function downloadName(): string {
  const r = playerRoute();
  if (!r) return "video";
  const ep =
    r.type !== "movie" && r.season
      ? ` S${r.season}E${r.episode ?? 1}`
      : r.type !== "movie"
        ? ` E${r.episode ?? 1}`
        : "";
  const base = `${r.title ?? "video"}${ep}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
  return base || "video";
}

/** Progress parsing for the downloader's stdout/stderr lines. */
function parseDownloadLine(d: DownloadItem, line: string): Partial<DownloadItem> {
  const frag = line.match(/\(frag\s+(\d+)\s*\/\s*(\d+)\)/i);
  if (frag) {
    const n = Number(frag[1]);
    const total = Number(frag[2]);
    if (total > 0) {
      return { progress: Math.min(99, Math.round((n / total) * 100)), message: line.trim().slice(0, 140) };
    }
  }
  const pct = line.match(/\[download\]\s+([\d.]+)%/i);
  if (pct) {
    return { progress: Math.min(99, Math.round(Number(pct[1]))), message: line.trim().slice(0, 140) };
  }
  const t = line.match(/time=(\d+):(\d+):([\d.]+)/);
  if (t) {
    const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
    return { progress: null, message: `encoding ${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}` };
  }
  if (/error|failed|exception/i.test(line)) {
    return { progress: null, message: line.trim().slice(0, 140) };
  }
  return {};
}

/** Spawns the configured vid-dl binary against the current stream URL. */
export function startDownload() {
  if (!canDownload()) {
    failDownload(downloadName(), "Downloads aren't available on this platform.");
    return;
  }
  try {
    startDownloadInner();
  } catch (e) {
    failDownload(downloadName(), `Download failed: ${String(e).slice(0, 140)}`);
  }
}

/** Subprocess downloads need a desktop OS (iOS/Android can't spawn). */
export function canDownload(): boolean {
  const p = process.platform;
  return p !== "ios" && p !== "android";
}

function startDownloadInner() {
  const name = downloadName();
  const url = bestStreamUrl();
  if (!url) {
    refreshStreams();
    failDownload(name, "No stream detected yet — let the video play a few seconds, then try again.");
    return;
  }
  let bin = (settings().downloaderPath || "").trim();
  if (bin === "~" || bin.startsWith("~/")) {
    bin = `${process.env.HOME ?? ""}${bin.slice(1)}`;
  }
  if (!bin) {
    failDownload(name, "Set the downloader path in Settings first.");
    return;
  }
  let dir = (
    (settings().downloadDir || "").trim() ||
    `${process.env.HOME ?? ""}/Downloads/rustflix`
  ).replace(/\/+$/, "");
  // `~` doesn't expand inside the single-quoted shell argument.
  if (dir === "~" || dir.startsWith("~/")) {
    dir = `${process.env.HOME ?? ""}${dir.slice(1)}`;
  }

  // The downloader path is user-configured at runtime, so it cannot be
  // named in capabilities.process.execute: launch it through the shell
  // (granted) with every argument single-quoted.
  const inner = [
    shq(bin), "--cli", shq(url),
    "-f", shq("mp4 (with Audio)"), "-r", "best", "-b", "320",
    "-n", shq(name), "-d", shq(dir),
  ];
  // Stream CDNs reject bare yt-dlp requests; forward the headers the page
  // itself used (captured by the bridge), plus the embed origin as
  // Referer when the page didn't set one explicitly.
  const extra: string[] = [];
  const rawHdrs = streamHeaders()[url] || {};
  for (const k in rawHdrs) {
    const v = String(rawHdrs[k]);
    if (v && !/[\r\n]/.test(v)) {
      extra.push(`--add-header "${k}: ${v.replace(/"/g, "")}"`);
    }
  }
  try {
    const page = playerUrl();
    const origin = page ? new URL(page).origin : "";
    const hasRef = Object.keys(rawHdrs).some((k) => k.toLowerCase() === "referer");
    // vid-dl's header fallback rebuilds http_headers per retry domain, so
    // --referer/--user-agent opts get overridden — --add-header survives as
    // the "default headers" attempt that runs before domain retries.
    if (origin && !hasRef) extra.push(`--add-header "Referer: ${origin}/"`);
    // Stream CDNs 403 anything that doesn't look like the browser that
    // fetched the playlist — yt-dlp's default UA gets rejected outright.
    const ua = streamUA() ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    extra.push(`--add-header "User-Agent: ${ua.replace(/"/g, "")}"`);
  } catch {}
  if (extra.length) inner.push("-a", shq(extra.join(" ")));
  const innerCmd = inner.join(" ");
  const isWin = process.platform === "windows";
  const command = isWin ? "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/c", innerCmd] : ["-c", innerCmd];

  let proc: ReturnType<typeof process.spawn>;
  try {
    proc = process.spawn(command, args, { lines: true });
  } catch (e) {
    failDownload(name, `Could not start the downloader: ${String(e).slice(0, 140)}`);
    return;
  }
  const id = ++dlSeq;
  debug("download: start", { name, url: url.slice(0, 120), bin, dir });
  downloads.set(
    [{ id, name, status: "running", progress: null, message: "starting…", proc: proc as { kill?: () => void } }, ...downloads()].slice(0, 20),
  );
  const onLine = (line: string) => {
    const d = downloads().find((x) => x.id === id);
    if (!d || d.status !== "running") return;
    patchDownload(id, parseDownloadLine(d, line));
  };
  try {
    proc.on("stdout", onLine);
    proc.on("stderr", onLine);
    proc.on("exit", (res: { code: number | null; signal?: string | null; error?: string }) => {
      if (res.code === 0) {
        patchDownload(id, { status: "done", progress: 100, message: "finished" });
      } else {
        patchDownload(id, {
          status: "error",
          message: res.error || `exited with code ${res.code ?? res.signal ?? "?"}`,
        });
      }
    });
  } catch {}
}

/** Kills a running download's process tree. */
export function cancelDownload(id: number) {
  const d = downloads().find((x) => x.id === id);
  patchDownload(id, { status: "error", message: "cancelled" });
  try {
    d?.proc?.kill?.();
  } catch {}
}

// --- Episodes -----------------------------------------------------------------

let loadedKey = "";

/** Loads the episode list for the player's title/season (TV seasons and
 * episodes from TMDB, anime count from AniList). */
export async function loadEpisodes(r: PlayerRoute) {
  const key = `${r.type}:${r.id}:${r.season ?? 0}`;
  if (key === loadedKey) return;
  loadedKey = key;
  episodes.set([]);
  seasons.set([]);
  if (r.type === "movie") return;
  if (r.type === "anime") {
    try {
      const m = await aniDetails(r.id);
      const n = Math.min(m.episodes ?? 12, 300);
      episodes.set(
        Array.from({ length: n }, (_, i) => ({ n: i + 1, name: `Episode ${i + 1}` })),
      );
    } catch {
      episodes.set([]);
    }
    return;
  }
  try {
    const d = await tvDetails(r.id);
    seasons.set(
      (d.seasons ?? []).filter((s) => s.season_number > 0).map((s) => s.season_number),
    );
  } catch {}
  try {
    const d = await seasonDetails(r.id, r.season ?? 1);
    episodes.set(
      (d.episodes ?? []).map((e: Episode) => ({
        n: e.episode_number,
        name: e.name ?? "",
      })),
    );
  } catch {}
}

function goTo(season: number | undefined, episode: number) {
  const r = playerRoute();
  if (!r) return;
  persist();
  navigate({ ...r, season, episode, next: undefined });
}

export function goEpisode(n: number) {
  const r = playerRoute();
  if (!r) return;
  if (r.type === "anime") goTo(undefined, n);
  else if (r.type === "tv") goTo(r.season ?? 1, n);
}

/** Next episode across seasons; does nothing at the end. */
export async function nextEpisode() {
  const r = playerRoute();
  if (!r || r.type === "movie") return;
  const cur = r.episode ?? 1;
  const eps = episodes();
  const i = eps.findIndex((e) => e.n === cur);
  if (i >= 0 && i + 1 < eps.length) {
    goTo(r.season, eps[i + 1].n);
    return;
  }
  if (r.type !== "tv") return;
  const ss = seasons();
  const si = ss.indexOf(r.season ?? 1);
  if (si < 0 || si + 1 >= ss.length) return;
  const ns = ss[si + 1];
  try {
    const d = await seasonDetails(r.id, ns);
    const first = (d.episodes ?? [])[0];
    if (first) goTo(ns, first.episode_number);
  } catch {}
}

/** Previous episode across seasons; does nothing at the start. */
export async function prevEpisode() {
  const r = playerRoute();
  if (!r || r.type === "movie") return;
  const cur = r.episode ?? 1;
  const eps = episodes();
  const i = eps.findIndex((e) => e.n === cur);
  if (i > 0) {
    goTo(r.season, eps[i - 1].n);
    return;
  }
  if (r.type !== "tv") return;
  const ss = seasons();
  const si = ss.indexOf(r.season ?? 1);
  if (si <= 0) return;
  const ps = ss[si - 1];
  try {
    const d = await seasonDetails(r.id, ps);
    const list = d.episodes ?? [];
    const last = list[list.length - 1];
    if (last) goTo(ps, last.episode_number);
  } catch {}
}

// --- Command palette ------------------------------------------------------------

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface PaletteItem {
  id: string;
  label: string;
  group?: string;
  checked?: boolean;
}

export interface PaletteRow {
  kind: "header" | "item";
  key: string;
  label: string;
  id?: string;
  checked?: boolean;
  /** 1-based position among the visible items; badges show ⌘1–⌘9. */
  num?: number;
}

const paletteItems = computed<PaletteItem[]>(() => {
  const view = paletteView();
  const r = playerRoute();
  if (view === "speed") {
    return [
      { id: "nav:root", label: "‹ Playback", group: "Speed" },
      ...SPEEDS.map((s) => ({
        id: `speed:${s}`,
        label: `${s}×`,
        group: "Speed",
        checked: mediaRate() === s,
      })),
    ];
  }
  if (view === "subs") {
    const items: PaletteItem[] = [
      { id: "nav:root", label: "‹ Playback", group: "Subtitles" },
      {
        id: "sub:off",
        label: "Off",
        group: "Subtitles",
        checked: subTracks().every((t) => t.mode !== "showing"),
      },
    ];
    for (const t of subTracks()) {
      items.push({
        id: `sub:${t.i}`,
        label: t.label,
        group: "Subtitles",
        checked: t.mode === "showing",
      });
    }
    return items;
  }
  const items: PaletteItem[] = [];
  const eps = episodes();
  if (r && r.type !== "movie" && eps.length > 1) {
    for (const e of eps) {
      const tag = r.type === "tv" ? `S${r.season ?? 1}E${e.n}` : `Episode ${e.n}`;
      items.push({
        id: `ep:${e.n}`,
        label: `${tag}${e.name ? ` — ${e.name}` : ""}`,
        group: "Episodes",
        checked: e.n === (r.episode ?? 1),
      });
    }
  }
  items.push(
    {
      id: "ctl:toggle",
      label: mediaPaused() ? "Play" : "Pause",
      group: "Playback",
    },
    { id: "ctl:back10", label: "Back 10 seconds", group: "Playback" },
    { id: "ctl:fwd10", label: "Forward 10 seconds", group: "Playback" },
    {
      id: "ctl:speed",
      label: `Playback speed · ${mediaRate()}×`,
      group: "Playback",
    },
    { id: "ctl:subs", label: "Subtitles", group: "Playback" },
    ...(canDownload()
      ? [{
          id: "ctl:download",
          label: downloadLabel(),
          group: "Playback",
        }]
      : []),
    { id: "ctl:source", label: "Choose source…", group: "Playback" },
  );
  return items;
});

/** Palette label for the download command: live progress while running. */
function downloadLabel(): string {
  const running = downloads().find((d) => d.status === "running");
  if (running) {
    const pct = running.progress != null ? ` ${running.progress}%` : "";
    return `Downloading ${running.name}${pct}…`;
  }
  const last = downloads()[0];
  if (last && last.status === "done") return "Download again";
  if (last && last.status === "error") return "Download video (retry)";
  return "Download video";
}

const visibleItems = computed<PaletteItem[]>(() => {
  const q = paletteQuery().trim().toLowerCase();
  const items = paletteItems();
  if (!q) return items;
  return items.filter((it) => it.label.toLowerCase().includes(q));
});

/** Items flattened into render rows: group headers where the group
 * changes (only when more than one group is present) and 1-based numbers
 * for the ⌘1–⌘9 badges. */
export const paletteRows = computed<PaletteRow[]>(() => {
  const items = visibleItems();
  const groups = new Set(items.map((i) => i.group ?? ""));
  const showHeaders = groups.size > 1;
  const rows: PaletteRow[] = [];
  let lastGroup: string | null = null;
  let num = 0;
  for (const it of items) {
    const g = it.group ?? "";
    if (showHeaders && g !== lastGroup) {
      rows.push({ kind: "header", key: `h:${g}`, label: g || "Commands" });
      lastGroup = g;
    }
    num++;
    rows.push({
      kind: "item",
      key: `i:${it.id}`,
      label: it.label,
      id: it.id,
      checked: it.checked,
      num,
    });
  }
  return rows;
});

export function paletteViewTitle(): string {
  const v = paletteView();
  if (v === "speed") return "Playback speed";
  if (v === "subs") return "Subtitles";
  return "Commands";
}

export function paletteSelect(id: string) {
  if (id === "nav:root") {
    paletteView.set("root");
    paletteQuery.set("");
    return;
  }
  if (id.startsWith("ep:")) {
    goEpisode(Number(id.slice(3)));
    closePalette();
    return;
  }
  if (id.startsWith("speed:")) {
    setRate(Number(id.slice(6)));
    closePalette();
    return;
  }
  if (id === "sub:off") {
    setTrack(-1);
    closePalette();
    return;
  }
  if (id.startsWith("sub:")) {
    setTrack(Number(id.slice(4)));
    closePalette();
    return;
  }
  switch (id) {
    case "ctl:toggle":
      togglePlay();
      closePalette();
      break;
    case "ctl:back10":
      seekBy(-10);
      closePalette();
      break;
    case "ctl:fwd10":
      seekBy(10);
      closePalette();
      break;
    case "ctl:speed":
      paletteView.set("speed");
      paletteQuery.set("");
      break;
    case "ctl:subs":
      paletteView.set("subs");
      paletteQuery.set("");
      break;
    case "ctl:source":
      closePalette();
      showSources.set(true);
      break;
    case "ctl:download":
      startDownload();
      closePalette();
      break;
  }
}

/** ⌘1–⌘9: activate the nth visible item. */
export function choosePaletteIndex(i: number) {
  const items = visibleItems();
  const it = items[i];
  if (it) paletteSelect(it.id);
}

// While the palette is open it owns the keyboard: printable keys are
// captured through keymap bindings (made on open, removed on close) so
// nothing — including the WebView or a native text field — can steal
// them. "always" makes them fire even if some view still holds focus.
let paletteUnbind: (() => void) | null = null;

function bindPaletteKeys() {
  unbindPaletteKeys();
  const type = (text: string) => () => paletteQuery.set(paletteQuery() + text);
  const map: Record<string, () => void> = {
    backspace: () => paletteQuery.set(paletteQuery().slice(0, -1)),
    enter: () => {
      const first = visibleItems()[0];
      if (first) paletteSelect(first.id);
    },
    escape: () => closePalette(),
    space: type(" "),
    minus: type("-"),
  };
  for (const c of "abcdefghijklmnopqrstuvwxyz") map[c] = type(c);
  for (const c of "0123456789") map[c] = type(c);
  try {
    paletteUnbind = keymap.bind(map, { when: "always" });
  } catch {
    // A keystroke above failed to parse: retry with the safe core set.
    const core: Record<string, () => void> = {};
    for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") core[c] = type(c);
    core["space"] = type(" ");
    core["backspace"] = map["backspace"];
    core["enter"] = map["enter"];
    core["escape"] = map["escape"];
    paletteUnbind = keymap.bind(core, { when: "always" });
  }
}

function unbindPaletteKeys() {
  const unbind = paletteUnbind;
  paletteUnbind = null;
  unbind?.();
}

export function openPalette() {
  paletteView.set("root");
  paletteQuery.set("");
  showSources.set(false);
  showPalette.set(true);
  bindPaletteKeys();
}

export function closePalette() {
  unbindPaletteKeys();
  showPalette.set(false);
  paletteView.set("root");
  paletteQuery.set("");
  // Hand the keyboard back to the WebView: without a focused view the
  // next keypress (including Cmd+K) can be dropped until a click.
  try {
    webview()?.focus();
  } catch {}
}

export function togglePalette() {
  if (showPalette()) closePalette();
  else openPalette();
}

// --- Autotest ------------------------------------------------------------------
//
// `rustflix.autotest` in storage drives the player without a human:
// {"type":"movie","id":550,"title":"Fight Club","source":"vidfast",
//  "settleMs":12000,"actions":["openPalette","choose:1","closePalette",
//  "toggle","seekby:-10","download","streams"]}
// Used for headless verification of the bridge, palette and downloads.

export interface AutotestConfig {
  type?: "movie" | "tv" | "anime";
  id?: number;
  season?: number;
  episode?: number;
  title?: string;
  source?: string;
  settleMs?: number;
  actions?: string[];
}

const autotestWait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAutotest(cfg: AutotestConfig) {
  debug("autotest: start", cfg);
  if (cfg.source) sourceId.set(cfg.source);
  if (cfg.type && cfg.id) {
    navigate({
      name: "player",
      type: cfg.type,
      id: cfg.id,
      season: cfg.season,
      episode: cfg.episode,
      title: cfg.title,
    });
  }
  await autotestWait(cfg.settleMs ?? 12000);
  for (const a of cfg.actions ?? []) {
    debug("autotest: action", a);
    if (a === "openPalette") openPalette();
    else if (a === "closePalette") closePalette();
    else if (a === "togglePalette") togglePalette();
    else if (a.startsWith("choose:")) choosePaletteIndex(Number(a.slice(7)));
    else if (a === "toggle") togglePlay();
    else if (a === "play") send({ t: "play" });
    else if (a === "pause") pausePlayback();
    else if (a === "download") startDownload();
    else if (a === "streams") refreshStreams();
    else if (a === "space") {
      // GPUI's WebView has no sendInput; dispatch a synthetic keydown the
      // way the embed's own listener would see a real Space press.
      try {
        webview()?.injectJavaScript?.(
          "(function(){var e=new KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:32,which:32,bubbles:true,cancelable:true});window.dispatchEvent(e);document.dispatchEvent(e);var t=document.activeElement||document.body;if(t)t.dispatchEvent(e);})();",
        );
      } catch {}
    }
    else if (a.startsWith("seekby:")) seekBy(Number(a.slice(7)));
    else if (a.startsWith("rate:")) setRate(Number(a.slice(5)));
    await autotestWait(1600);
  }
  debug("autotest: done");
}

// --- Session: resume + leave cleanup -------------------------------------------

let lastSaved = 0;
let resumeTimer: ReturnType<typeof setInterval> | undefined;

/** Arms the resume seek: finds this title/episode's saved position and
 * re-sends the seek until the page's reported position reaches it (the
 * bridge applies it whenever the <video> appears; embed players may
 * override currentTime once, so it retries). */
function armResume() {
  if (resumeTimer) clearInterval(resumeTimer);
  const r = playerRoute();
  if (!r) return;
  const key = itemKey(r.type, r.id, r.season ?? 0, r.episode ?? 0);
  const saved = progress().find((p) => p.key === key);
  const pos =
    saved &&
    saved.duration > 0 &&
    saved.position > 30 &&
    saved.position < saved.duration * 0.95
      ? Math.floor(saved.position)
      : 0;
  if (!pos) {
    debug("resume: no saved position", { key, saved: saved?.position, dur: saved?.duration });
    return;
  }
  debug("resume: armed", { pos });
  let tries = 0;
  send({ t: "seek", p: pos });
  resumeTimer = setInterval(() => {
    tries++;
    const t = position();
    debug("resume: tick", { tries, t, pos });
    // Done when the page reports we're at the saved spot, or clearly
    // past it. Give up quickly if the embed keeps resetting to ~0 —
    // fighting it forever makes the video unusable.
    if (
      tries > 5 ||
      Math.abs(t - pos) < 10 ||
      t > pos + 30 ||
      (tries >= 3 && t < 10)
    ) {
      debug("resume: done", { tries, t, pos });
      if (resumeTimer) clearInterval(resumeTimer);
      return;
    }
    send({ t: "seek", p: pos });
  }, 2500);
}

/** Called when the player route opens: resets state and arms resume. */
export function startPlayer() {
  if (resumeTimer) clearInterval(resumeTimer);
  resumeTimer = undefined;
  position.set(0);
  duration.set(0);
  mediaPaused.set(false);
  mediaRate.set(1);
  subTracks.set([]);
  lastSaved = 0;
  debug("startPlayer", { src: sourceId(), url: playerUrl()?.slice(0, 140) });
  armResume();
  const r = playerRoute();
  if (r) void ensureExtId(r);
  // Give the embed time to fetch its playlist, then sniff the media URLs
  // a few times so downloads have a stream to work with.
  for (const ms of [6000, 15000, 30000]) {
    setTimeout(refreshStreams, ms);
  }
  // The page's own scripts may navigate/reload after `load`; re-arm the
  // bridge a few times so every document gets it (self-guarded).
  for (const ms of [800, 2500, 6000]) {
    setTimeout(armBridge, ms);
  }
}

export function stopPlayer() {
  if (resumeTimer) clearInterval(resumeTimer);
  resumeTimer = undefined;
}

// Leaving the player (any navigation): save the last known position and
// pause the page so nothing keeps playing behind the scenes.
setLeaveHook(() => {
  persist();
  pausePlayback();
});
