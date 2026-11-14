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

import { Clipboard, computed, host, keymap, platform, signal, Storage, untracked } from "nsh";
// @ts-expect-error: in the runtime (nsh-js env.rs `lifecycle`), not in its typings yet.
import { lifecycle } from "nsh";
import type { Accessor, WebViewRef } from "nsh";
import process from "process";
import { aniDetails, aniEpisodeCount, aniEpisodes, aniMalId } from "./anilist";
import { skipTimes, type SkipSegment } from "./aniskip";
import { navigate, route, setLeaveHook, type Route } from "./router";
import {
  getSourceUrl,
  NEEDS_INTERCEPT,
  PLAYER_SOURCES,
  sourceSupports,
  sourcesFor,
  type MediaType,
} from "./sources";
import {
  itemKey,
  languageName,
  onSettingsChange,
  progress,
  saveProgress,
  saveSettings,
  settings,
} from "./store";
import {
  cleanLangLabel,
  loadCues,
  onPageSubtitles,
  pageSubKey,
  parseLang,
  searchSubtitles,
  withPageSubtitles,
  setSubtitleDebug,
  setSubtitleNotify,
  type Cue,
  type SubResult,
} from "./subtitles";
import { externalIds, imgUrl, movieDetails, seasonDetails, tvDetails, type Episode } from "./tmdb";
import { togglePlayerFullscreen } from "./system";
import { adblockOn, adblockSkip, GUARD_JS, initWebGuard, onAdblockChange, onGuardReport, setAdblockDiag } from "./adblock";
import type { MediaReport, PlaybackBackend } from "./playback/backend";
import { createWebBackend } from "./playback/webBackend";
import {
  captionConfig,
  nativeBackend,
  nativeDoc,
  nativePipActive,
  setNativeListener,
  setNativeSource,
} from "./playback/nativeBackend";
import { PlaySession, preResolve, type SessionDeps, type SessionState } from "./playback/session";
import { getLink, type CachedLink } from "./playback/linkcache";
import { CandidateSet, headersFor, sameSite, type StreamCandidate } from "./resolvecore";
import {
  initNativePlayer,
  nativeEnabled,
  nativeInfo,
  nativeMode,
  noteNativeResult,
  overrideNativeMode,
  markNotNative,
  sourcePlayback,
} from "./playback/caps";

export type PlayerRoute = Extract<Route, { name: "player" }>;

export const webview = signal<WebViewRef | null>(null);
/** The user's selected source. It may not support the current title's
 * type — `sourceFor(type)` / `activeSource` give the one actually used. */
export const sourceId = signal(settings().defaultSource);
// Follow the saved default: restored settings arrive after this module
// loads, and Settings can change it later.
onSettingsChange((next, prev) => {
  if (next.defaultSource && next.defaultSource !== prev.defaultSource) {
    sourceId.set(next.defaultSource);
  }
});
export const showSources = signal(false);
export const showPalette = signal(false);
export const paletteView = signal<"root" | "speed" | "subs">("root");
export const paletteQuery = signal("");

// --- Player settings (lib/store.ts Settings), read with their defaults ------------
//
// One source for every caller: the controls, the page overlay, the key
// bindings, PiP actions. Older saves (or a store without the field) get the
// default.

type PlayerSettings = {
  seekStep?: unknown;
  autoplayNext?: unknown;
  autoplayCountdown?: unknown;
  skipSegments?: unknown;
  preferredAudio?: unknown;
  rememberSpeed?: unknown;
};
const playerSettings = () => (settings() ?? {}) as PlayerSettings;

/** Seconds of one seek step (the ± buttons, arrow keys, double tap): 5, 10, 15 or 30. */
export function seekStep(): number {
  const v = Number(playerSettings().seekStep);
  return v === 5 || v === 10 || v === 15 || v === 30 ? v : 10;
}
/** Plays the next episode by itself (with a countdown) when one ends. */
export function autoplayNext(): boolean {
  const v = playerSettings().autoplayNext;
  return typeof v === "boolean" ? v : true;
}
/** Seconds of the Up next countdown: 5, 10 or 15. */
export function autoplayCountdown(): number {
  const v = Number(playerSettings().autoplayCountdown);
  return v === 5 || v === 10 || v === 15 ? v : 10;
}
/** Intro / recap segments: "button" (the Skip pill) or "auto" (skipped once). */
export function skipSegmentsMode(): "button" | "auto" {
  return playerSettings().skipSegments === "auto" ? "auto" : "button";
}
/** The preferred audio language (ISO 639-1), "" for none. */
export function preferredAudio(): string {
  const v = playerSettings().preferredAudio;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}
/** The playback speed carries over to the next videos (else every video starts at 1×). */
export function rememberSpeed(): boolean {
  const v = playerSettings().rememberSpeed;
  return typeof v === "boolean" ? v : true;
}
/** One seek step back (−seekStep() s). */
export function seekBack() {
  seekBy(-seekStep());
}
/** One seek step forward (+seekStep() s). */
export function seekForward() {
  seekBy(seekStep());
}

/** One episode for lists and the episode carousel. `still` is an image
 * URL (TMDB; never for anime), `runtime` in minutes. */
export type EpisodeInfo = {
  season?: number;
  n: number;
  name: string;
  still?: string;
  overview?: string;
  runtime?: number;
  airDate?: string;
};
/** Episodes of the player's current season (anime: the whole list). */
export const episodes = signal<EpisodeInfo[]>([]);
export const seasons = signal<number[]>([]);
/** The page video's text tracks as reported (all kinds). `label` falls
 * back to the language or "Track n"; `raw` is the track's own label. */
export type PageTrack = { i: number; label: string; mode: string; lang?: string; kind?: string; raw?: string };
export const subTracks = signal<PageTrack[]>([]);
export const position = signal(0);
export const duration = signal(0);
export const mediaPaused = signal(false);
export const mediaMuted = signal(false);
export const mediaRate = signal(1);
export const mediaFullscreen = signal(false);
/** `video.volume` (0..1) as the page reports it. */
export const mediaVolume = signal(1);
/** true: object-fit cover (fills the screen, crops); false: contain. */
export const mediaFill = signal(false);
/** Whether the page's video supports picture-in-picture. */
export const pipSupported = signal(false);
/** true while holdRate(true) has the video at 2x. */
export const rateHeld = signal(false);

export type PlayerPhase = "loading" | "playing" | "paused" | "stalled" | "failed" | "blind";
/**
 * loading: new src, not yet playable. stalled: buffering while playing.
 * failed: nothing left to try (see failState). blind: the page loaded but
 * its <video> is out of reach (inner frame) — show minimal chrome and let
 * touches through to the page.
 */
export const playerPhase = signal<PlayerPhase>("loading");
/** Set in the "failed" phase — the one terminal state, reached only when
 * nothing is left to try: every source tried ("exhausted"), the device is
 * offline ("offline"), or the source the user picked on this play failed
 * ("picked": their choice is not swapped behind their back). `reason` is
 * the plain-words line under "Couldn't play this right now". While other
 * sources are left a failing source is not a state at all: the player
 * moves on by itself and says so in `switchNotice`. */
export const failState = signal<{
  kind: "exhausted" | "offline" | "picked";
  reason: string;
} | null>(null);
/** One line while the player moves on from a failing source by itself
 * ("Vidlove didn't respond — trying Vidfast…"); "" otherwise. Cleared
 * once a source plays. */
export const switchNotice = signal("");
/** Media URLs the embed page has fetched (m3u8/mp4/…), newest first. */
export const streamUrls = signal<string[]>([]);
/** Request headers the page used per stream URL (for the downloader). */
export const streamHeaders = signal<Record<string, Record<string, string>>>({});
export const streamUA = signal("");

/** Legacy download row (deprecated: use `DlEntry` from lib/downloads.ts).
 * `downloads` below mirrors the engine's entries in this shape so screens
 * written against it keep working. */
export interface DownloadItem {
  id: number;
  name: string;
  status: "running" | "done" | "error";
  /** 0–100 when the downloader reports a percentage, else null. */
  progress: number | null;
  message: string;
  key?: string;
  type?: MediaType;
  mediaId?: number;
  season?: number;
  episode?: number;
  title?: string;
  dir?: string;
  file?: string;
  kind?: string;
  createdAt?: number;
}

/** Deprecated mirror of lib/downloads.ts's entries (written by the engine). */
export const downloads = signal<DownloadItem[]>([]);

/** A stream link the playing page exposed (bridge `{t:-2}` reply). */
export type StreamLink = {
  url: string;
  kind: "hls" | "file";
  /** Request headers for the downloader (page headers + Referer + UA). */
  headers: Record<string, string>;
  ua: string;
  /** itemKey of the route the page was showing, and that route. */
  key: string;
  route: { type: MediaType; id: number; season?: number; episode?: number; lang?: "sub" | "dub" };
  /** Bridge document id of the page that reported it. */
  doc: string;
  /** Source id the page belongs to. */
  source: string;
  at: number;
};

/** What lib/downloads.ts plugs into the player (it imports this module, so
 * the player reaches it through this registration instead of an import). */
export interface DownloadEngineHooks {
  init(): Promise<void>;
  downloadCurrent(): unknown;
  cancel(id: number): void;
  remove(id: number): Promise<void>;
  play(id: number): void;
  reveal(id: number): void;
  /** Local page URL for a finished download of `r`; "" while its local
   * server/page is being prepared; null when there is none. */
  localPage(r: PlayerRoute): string | null;
  /** Downloaded episodes of `r`'s title (for offline episode lists). */
  offlineEpisodes(r: PlayerRoute): { seasons: number[]; episodes: EpisodeInfo[] } | null;
  /** Subtitles saved with the download of `r`, if any. */
  offlineSubtitles(r: PlayerRoute): Promise<{ lang: string; cues: Cue[] } | null>;
}

let dlHooks: DownloadEngineHooks | null = null;
export function registerDownloadEngine(h: DownloadEngineHooks) {
  dlHooks = h;
}

const streamLinkFns: ((l: StreamLink) => void)[] = [];
/** Called with every usable link the playing page reports. */
export function onStreamLink(fn: (l: StreamLink) => void): () => void {
  streamLinkFns.push(fn);
  return () => {
    const i = streamLinkFns.indexOf(fn);
    if (i >= 0) streamLinkFns.splice(i, 1);
  };
}

const watchedFns: ((r: PlayerRoute) => void)[] = [];
/** Called once per player session and title/episode when the saved
 * position reaches 95% of the duration. */
export function onEpisodeWatched(fn: (r: PlayerRoute) => void): () => void {
  watchedFns.push(fn);
  return () => {
    const i = watchedFns.indexOf(fn);
    if (i >= 0) watchedFns.splice(i, 1);
  };
}

/** Boot: restores the download queue (lib/downloads.ts). */
export async function loadDownloads() {
  await dlHooks?.init();
}

// --- Page bridge ------------------------------------------------------------
//
// Injected into every page the WebView loads (after content). It:
//  - listens for `message` events carrying JSON commands
//    ({t:'play'|'pause'|'toggle'|'seekby'|'seek'|'rate'|'hold'|'track'|
//      'mute'|'vol'|'fill'|'pip'|'fs'|'fsx'|'fst'|'ctl'|'chrome'|'keys'|…})
//  - desktop ('ctl' on): draws the Cinema controls over the video in a
//    shadow root and handles the player keys page-side
//  - reports the picked <video>'s state {t,d,p,r,f,m,vo,rs,pip,vid,tracks,ev}
//    through window.nsh.postMessage on its media events (timeupdate
//    throttled to ~4/s) and on a 1.5s heartbeat ({t:-1,n} when there is
//    no video in the top document)
//  - applies an absolute seek at once when the video can seek, else as
//    soon as it can
//  - snaps unexpected playback rates back to the app's rate (embed
//    players sometimes leave video at 2x after a space-bar toggle)

// The ad guard (lib/adblock.ts) runs first: a no-op where the native host
// already installed it in every frame at document start.
export const PLAYER_BRIDGE = GUARD_JS + `(function () {
  var __rep = function (s) {
    try { if (window.nsh && window.nsh.postMessage) { window.nsh.postMessage(s); return; } } catch (e) {}
    try { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(s); } catch (e) {}
  };
  if (window.__rf_bridge) return;
  window.__rf_bridge = true;
  try {
  // --- Pointer interception (window capture, registered first) -----------
  // Embed pages (ad / pop-under scripts) register window-capture mouse
  // listeners that stop propagation, so nothing reaches document or our
  // shadow root. This runs at document start, before any page script:
  // same-target capture listeners run in registration order, so ours
  // always run first. It counts real presses, and while the Cinema
  // overlay is up it drives the overlay itself (cinPtr - the same path as
  // app-forwarded input) and stops the event so neither the embed nor
  // its click-jacking scripts see it. Overlay off / no video (blind):
  // counting only, the embed's own controls keep working. Phones never
  // intercept (the native-view overlay takes touches there).
  var clkN = 0, mdN = 0, pdN = 0, pressLogged = false;
  var PTR_KIND = { mousedown: 'down', mouseup: 'up', mousemove: 'move', click: 'click', dblclick: 'dblclick' };
  var onWinPtr = function (e) {
    var ty = e.type;
    if (ty === 'click') clkN++;
    else if (ty === 'mousedown') mdN++;
    else if (ty === 'pointerdown') pdN++;
    if ((ty === 'mousedown' || ty === 'pointerdown') && e.isTrusted && !pressLogged) {
      pressLogged = true;
      __rep(JSON.stringify({ t: -8, msg: 'page: first real mouse press reached the page (window capture)' }));
    }
    if (MOBILE || !ctlOn || !cin || !cin.host.isConnected) return;
    // No native context menu anywhere while the overlay is up.
    if (ty === 'contextmenu') { try { if (e.cancelable) e.preventDefault(); } catch (err) {} }
    // Only events aimed at the overlay (it covers the viewport); the
    // in-page source picker or anything stacked above stays reachable.
    if (e.target !== cin.host) {
      if (ty === 'mouseout' && !e.relatedTarget) cinPtr('leave', e.clientX || 0, e.clientY || 0, true);
      return;
    }
    if (ty === 'mouseout') {
      if (!e.relatedTarget) cinPtr('leave', e.clientX || 0, e.clientY || 0, true);
    } else if (e.isTrusted) {
      var k = PTR_KIND[ty];
      if (k) cinPtr(k, e.clientX, e.clientY, true);
      else if (ty === 'wheel') cinPtr('wheel', e.clientX, e.clientY, true, e.deltaY || 0);
      else if (ty === 'contextmenu') cinPtr('ctx', e.clientX, e.clientY, true);
    }
    // Pointer events are not cancelled: that would suppress the mouse
    // events that drive the overlay.
    if (ty.indexOf('pointer') !== 0 && ty !== 'contextmenu') {
      try { if (e.cancelable) e.preventDefault(); } catch (err) {}
    }
    e.stopImmediatePropagation();
  };
  var WIN_PTR = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'mouseout',
    'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchend'];
  for (var wpi = 0; wpi < WIN_PTR.length; wpi++) {
    try { window.addEventListener(WIN_PTR[wpi], onWinPtr, { capture: true, passive: false }); }
    catch (e) { try { window.addEventListener(WIN_PTR[wpi], onWinPtr, true); } catch (e2) {} }
  }
  // Rates the embed may use on its own; anything else is snapped back.
  // A rate the app picked through the palette ('rate' command) is also
  // allowed, so embeds can't get stuck at e.g. 2x while 2x stays
  // selectable for the user.
  var stdRates = { 0.5: 1, 0.75: 1, 1: 1, 1.25: 1, 1.5: 1 };
  var allowedRate = null;
  // The last rate the app chose ('rate' command / in-page bar): it stays
  // allowed, so a remembered 2x is not snapped back on the next play.
  var appRate = null;
  // Hold-to-speed (holdRate): while on, 2x is exempt from snapping and
  // holdPrev is restored on release.
  var holdOn = false, holdPrev = 1;
  var fillMode = false;
  var pendingSeek = null;
  var fittedVideo = null;
  var keyBlock = null;
  // Per-document id + per-element sequence: the app keys "first canplay
  // of each video" on {docId}:{element}:{load generation}.
  var docId = Math.random().toString(36).slice(2, 8);
  var vidSeq = 0;
  // Cinema overlay + key forwarding are on (desktop; 'ctl' command).
  var ctlOn = false;
  // In-page source picker (desktop): a real modal inside the page —
  // GPUI cannot draw over the web view, and the in-flow card used to
  // shrink the video.
  var srcmEl = null;
  // Inline playback (phones/tablets): without playsinline, iOS takes a
  // playing <video> into its native fullscreen player. The app's own
  // overlay is the phone player, so every video in the top document is
  // marked inline before it can start: at document start, on its first
  // media events, on play() itself (also catches detached elements), on
  // insertion (MutationObserver) and on every heartbeat.
  var MOBILE = false;
  try {
    var uaS = navigator.userAgent || '';
    MOBILE = /iPhone|iPad|iPod|Android/i.test(uaS) ||
      (/Macintosh/.test(uaS) && (navigator.maxTouchPoints || 0) > 1);
  } catch (e) {}
  var inl = function (v) {
    try {
      if (v.__rfinl && v.playsInline) return;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.__rfinl = true;
    } catch (e) {}
  };
  var inlAll = function () {
    if (!MOBILE) return;
    try {
      var vs = document.getElementsByTagName('video');
      for (var i = 0; i < vs.length; i++) inl(vs[i]);
    } catch (e) {}
  };
  // Never a grey/white page behind the controls.
  try {
    var bgCss = document.createElement('style');
    bgCss.textContent = 'html,body{background:#000 !important}';
    (document.head || document.documentElement).appendChild(bgCss);
  } catch (e) {}
  // Desktop: the Cinema overlay (and page-side keys) start on.
  if (!MOBILE) ctlOn = true;
  if (MOBILE) {
    inlAll();
    var inlEv = function (e) {
      var t = e.target;
      if (t && t.tagName === 'VIDEO') inl(t);
    };
    document.addEventListener('loadstart', inlEv, true);
    document.addEventListener('loadedmetadata', inlEv, true);
    document.addEventListener('play', inlEv, true);
    try {
      var op = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this && this.tagName === 'VIDEO') inl(this);
        return op.apply(this, arguments);
      };
    } catch (e) {}
    try {
      if (window.MutationObserver) {
        new MutationObserver(function (ms) {
          for (var i = 0; i < ms.length; i++) {
            var a = ms[i].addedNodes;
            for (var j = 0; j < a.length; j++) {
              var n = a[j];
              if (!n || n.nodeType !== 1) continue;
              if (n.tagName === 'VIDEO') inl(n);
              else if (n.firstElementChild && n.getElementsByTagName) {
                var vs = n.getElementsByTagName('video');
                for (var k = 0; k < vs.length; k++) inl(vs[k]);
              }
            }
          }
        }).observe(document.documentElement || document, { childList: true, subtree: true });
      }
    } catch (e) {}
  }
  // The real player is the longest video whose duration is known (a
  // short pre-roll ad that is "more ready" must not win over the main
  // video once both exist); before any has metadata, the most ready one.
  // Pages can carry preview/hover videos too.
  var pickVideo = function () {
    var vs;
    try { vs = document.querySelectorAll('video'); } catch (e) { return null; }
    var best = null, score = -1;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i], d = 0, rs = 0;
      try { d = v.duration || 0; } catch (e) {}
      try { rs = v.readyState || 0; } catch (e) {}
      if (d === Infinity) d = 1e7;
      var s = rs >= 1 && d > 0 ? 1e9 + d * 10 + rs : rs;
      if (s > score) { score = s; best = v; }
    }
    return best;
  };
  var fixRate = function (v) {
    if (!v || !v.playbackRate) return;
    // Native fullscreen (AVPlayerViewController on iOS) owns the rate:
    // its speed control fires ratechange on the element, and snapping
    // it back here is what made 2x etc. appear dead.
    try {
      if (v.webkitDisplayingFullscreen || document.fullscreenElement === v) return;
    } catch (e) {}
    if (holdOn) return;
    var r = v.playbackRate;
    // allowedRate covers the ratechange the app's own command causes;
    // appRate keeps the app's latest choice allowed afterwards (a play
    // event re-checks the rate). Other unexpected rates snap back to it.
    if (r === allowedRate) { allowedRate = null; return; }
    if (stdRates[r] || r === appRate) return;
    try { v.playbackRate = allowedRate || appRate || 1; } catch (e) {}
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
    if (m.t === 'seek' && typeof m.p === 'number') {
      // Apply at once when the video can seek (the slider must not snap
      // back to the old position until the next tick); otherwise keep it
      // for loadedmetadata/canplay or the heartbeat.
      pendingSeek = m.p;
      var sv0 = pickVideo();
      if (sv0 && (sv0.readyState || 0) >= 1) {
        wire(sv0);
        pendingSeek = null;
        try { sv0.currentTime = m.p; } catch (err) { pendingSeek = m.p; }
        report(snap(sv0, 'seeking'));
      }
      return;
    }
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
    if (m.t === 'ctl') {
      ctlOn = !!m.on;
      var cv0 = pickVideo();
      if (ctlOn) { cinEnsure(); cinSync(cv0); }
      else cinRemove();
      if (cv0) report(snap(cv0, 'ctl'));
      else report(JSON.stringify({ t: -1, n: 0, doc: docId, ctl: ctlStatus(), clk: clkN, md: mdN, pd: pdN }));
      return;
    }
    if (m.t === 'blind') {
      // The video is out of reach (inner frame): get out of the way.
      cinBlind = !!m.on;
      if (cinBlind) cinRemove(); else { cinEnsure(); cinSync(pickVideo()); }
      report(JSON.stringify({ t: -1, n: 0, doc: docId, ctl: ctlStatus(), clk: clkN, md: mdN, pd: pdN }));
      return;
    }
    if (m.t === 'sync') {
      // One immediate state report (e.g. after a picker hid the view).
      var cvs = pickVideo();
      if (cvs) { if (cin) cinSync(cvs); report(snap(cvs, 'sync')); }
      else report(JSON.stringify({ t: -1, n: 0, doc: docId, ctl: ctlStatus(), clk: clkN, md: mdN, pd: pdN }));
      return;
    }
    if (m.t === 'ptr') {
      if (typeof m.x === 'number' && typeof m.y === 'number') {
        var pk = String(m.k || '');
        cinPtr(pk === 'context' ? 'ctx' : pk, m.x, m.y, false, typeof m.dy === 'number' ? m.dy : 0);
      }
      return;
    }
    if (m.t === 'toast') {
      toast(m.text, m.kind);
      return;
    }
    if (m.t === 'chrome') {
      if (typeof m.step === 'number' && m.step > 0) seekStep = m.step;
      chrome = {
        title: String(m.title || ''),
        sub: String(m.sub || ''),
        series: !!m.series,
        hasNext: !!m.hasNext,
        skip: m.skip && m.skip.label ? { kind: m.skip.kind, label: String(m.skip.label) } : null,
        pipOk: m.pipOk !== false,
        phase: typeof m.phase === 'string' ? m.phase : '',
        art: typeof m.art === 'string' ? m.art : '',
        up: m.up && typeof m.up === 'object' ? m.up : null,
      };
      var cv1 = pickVideo();
      if (cv1) cinSync(cv1);
      else if (cin) cinSync(null);
      return;
    }
    if (m.t === 'cap' || m.t === 'capx' || m.t === 'capc') {
      capCmd(m);
      return;
    }
    if (m.t === 'avs') {
      avs = m;
      pnlRender();
      return;
    }
    if (m.t === 'srcm') {
      srcBuild();
      if (m.on) {
        srcFill(m.items || [], m.active || '');
        srcmEl.style.display = 'flex';
      } else if (srcmEl) {
        srcmEl.style.display = 'none';
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
      report(JSON.stringify({ t: -2, streams: out, hdrs: hm, ua: navigator.userAgent || '', doc: docId }));
      return;
    }
    var v = pickVideo();
    // Hold and fill are remembered states: kept even with no video yet,
    // and applied to every video that gets wired later.
    if (m.t === 'hold') {
      if (m.on && !holdOn) {
        holdOn = true;
        if (v) { try { holdPrev = v.playbackRate || appRate || 1; v.playbackRate = 2; } catch (e) {} }
        else holdPrev = appRate || 1;
      } else if (!m.on && holdOn) {
        holdOn = false;
        if (v) { try { allowedRate = holdPrev; v.playbackRate = holdPrev; } catch (e) {} }
      }
      return;
    }
    if (m.t === 'fill') {
      fillMode = !!m.on;
      if (v) {
        try { v.style.setProperty('object-fit', fillMode ? 'cover' : 'contain', 'important'); } catch (e) {}
        report(snap(v, 'fill'));
      }
      return;
    }
    if (!v) return;
    try {
      if (m.t === 'play') v.play();
      else if (m.t === 'pause') v.pause();
      else if (m.t === 'toggle') { v.paused ? v.play() : v.pause(); }
      else if (m.t === 'seekby') {
        var to = Math.max(0, (v.currentTime || 0) + m.s);
        var dd = v.duration;
        if (dd && isFinite(dd) && dd > 0) to = Math.min(to, dd);
        v.currentTime = to;
        report(snap(v, 'seeking'));
      }
      else if (m.t === 'rate' && m.r) {
        appRate = m.r;
        if (holdOn) { holdPrev = m.r; return; }
        allowedRate = m.r; v.playbackRate = m.r;
      }
      else if (m.t === 'mute') { try { v.muted = !v.muted; } catch (e) {} }
      else if (m.t === 'vol') {
        // Absolute target from the app (v), or a relative step (d).
        var nv = typeof m.v === 'number' ? m.v : (v.volume || 0) + (typeof m.d === 'number' ? m.d : 0);
        v.volume = Math.max(0, Math.min(1, nv));
      }
      else if (m.t === 'pip') pipTry(v);
      else if (m.t === 'track' && v.textTracks) {
        // Legacy: our own renderer draws the track; nothing is 'showing'.
        var ts = v.textTracks, tk = ts[m.i];
        if (m.i >= 0 && tk) capCmd({ t: 'cap', mode: 'track', i: m.i, label: tk.label || '', lang: tk.language || '' });
        else capCmd({ t: 'cap', mode: 'off' });
        report(snap(v, 'track'));
      } else if (m.t === 'aud') {
        try {
          var at = v.audioTracks;
          if (at) for (var ai = 0; ai < at.length; ai++) at[ai].enabled = ai === m.i;
        } catch (err) {}
        report(snap(v, 'audio'));
      } else if (m.t === 'fs') {
        // Native fullscreen: on iOS this is AVPlayerViewController —
        // landscape, system controls, rotation handled by the OS.
        try {
          if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
          else if (v.requestFullscreen) v.requestFullscreen();
        } catch (err) {}
      } else if (m.t === 'fsx') {
        try {
          if (v.webkitExitFullscreen) v.webkitExitFullscreen();
          else if (document.exitFullscreen) document.exitFullscreen();
        } catch (err) {}
      } else if (m.t === 'fst' && ctlOn) {
        cinFullscreen();
      } else if (m.t === 'fst') {
        try {
          if (v.webkitDisplayingFullscreen || document.fullscreenElement === v) {
            if (v.webkitExitFullscreen) v.webkitExitFullscreen();
            else if (document.exitFullscreen) document.exitFullscreen();
          } else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
          else if (v.requestFullscreen) v.requestFullscreen();
        } catch (err) {}
      }
    } catch (err) {}
  });
  var report = function (payload) {
    try { if (window.nsh && window.nsh.postMessage) { window.nsh.postMessage(payload); return; } } catch (e) {}
    try { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(payload); } catch (e) {}
  };
  // --- In-page source picker ---------------------------------------------
  var srcUi = function (a) { report(JSON.stringify({ t: -7, a: a })); };
  var srcBuild = function () {
    if (srcmEl && srcmEl.isConnected) return;
    var wrap = document.createElement('div');
    wrap.id = 'rf-srcm';
    wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
      'display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);';
    var card = document.createElement('div');
    card.style.cssText = 'width:min(420px,86vw);max-height:70vh;overflow-y:auto;' +
      'background:#18181b;border:1px solid #27272a;border-radius:12px;color:#fff;' +
      'font:14px system-ui,-apple-system,sans-serif;';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;' +
      'padding:14px 16px;border-bottom:1px solid #27272a;font-weight:700;';
    var h = document.createElement('span');
    h.textContent = 'Sources';
    head.appendChild(h);
    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '\u2715';
    x.style.cssText = 'cursor:pointer;border:0;background:none;color:#a1a1aa;font-size:16px;padding:2px 6px;';
    x.onclick = function () { srcUi('srcx'); };
    head.appendChild(x);
    var list = document.createElement('div');
    list.id = 'rf-srcm-list';
    list.style.cssText = 'padding:8px;';
    card.appendChild(head);
    card.appendChild(list);
    wrap.appendChild(card);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) srcUi('srcx'); });
    (document.body || document.documentElement).appendChild(wrap);
    srcmEl = wrap;
  };
  var srcFill = function (items, active) {
    if (!srcmEl) return;
    var list = srcmEl.querySelector('#rf-srcm-list');
    if (!list) return;
    list.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      (function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.style.cssText = 'display:block;width:100%;text-align:left;cursor:pointer;border:0;' +
          'border-radius:8px;background:' + (it.id === active ? 'rgba(229,9,20,.18)' : 'transparent') + ';' +
          'color:#fff;padding:10px 12px;margin:2px 0;font:500 14px system-ui,-apple-system,sans-serif;';
        var name = document.createElement('div');
        name.textContent = it.label + (it.id === active ? '  \u2713' : '');
        b.appendChild(name);
        if (it.note || it.warn) {
          var sub = document.createElement('div');
          sub.style.cssText = 'font-size:11px;color:' + (it.warn ? '#f59e0b' : '#71717a') + ';margin-top:2px;';
          sub.textContent = it.warn ? 'may not load' : (it.note || '');
          b.appendChild(sub);
        }
        b.onmouseenter = function () { b.style.background = 'rgba(255,255,255,.08)'; };
        b.onmouseleave = function () { b.style.background = it.id === active ? 'rgba(229,9,20,.18)' : 'transparent'; };
        b.onclick = function () { srcUi('src:' + it.id); };
        list.appendChild(b);
      })(items[i]);
    }
  };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && srcmEl && srcmEl.style.display !== 'none') {
      e.stopPropagation();
      srcUi('srcx');
    }
  }, true);
  // --- Cinema overlay (desktop) -------------------------------------------
  // The desktop player's controls, drawn by the page over the video (the
  // web view gets the mouse). A closed shadow root on a fixed,
  // full-viewport host: the embed's CSS cannot reach it, it sits above
  // the pinned video, and it takes every pointer event so the embed's
  // own controls underneath stay unusable. The app supplies the title,
  // episode line, series/next flags and the skip segment ('chrome'), and
  // gets app-level actions back as {t:-7,a:…}. Icons are the same SVG
  // paths as app/screens/PlayerControls.tsx ICONS.
  var cin = null;
  var cinHideT = null, cinOver = false, cinDrag = false, cinClickT = null;
  var cinVolDrag = false, cinHov = null, cinLastX = 0;
  // Native GPUI shells deliver no mouse events to the page: the app
  // forwards the pointer ('ptr' command) and that is the trusted path.
  // lastFwd de-duplicates any native event that also arrives.
  var lastFwd = { t: 0, x: -1, y: -1 }, lastNat = { t: 0, x: -1, y: -1 }, fwdLogged = false;
  var cinActs = {};
  var pipFailed = false, pipMiss = 0;
  // cinFrame: a video showed its first frame (the backdrop fades out).
  // cinBlind: the app called the page blind (no reachable video).
  var cinFrame = false, cinBlind = false;
  var cinState = {};
  var chrome = { title: '', sub: '', series: false, hasNext: false, skip: null, pipOk: true, art: '', up: null };
  // Seconds of one seek step (the app's seekStep(), pushed with 'chrome').
  var seekStep = 10;
  // Audio & Subtitles panel state pushed by the app ('avs'), and which
  // in-page panel is open: '' | 'av' | 'spl' | 'cm'.
  var avs = null, pnlOpen = '', lsDrag = null, lsDragAt = 0, lastCtx = { t: 0, x: -1, y: -1 };
  var act = function (a, h) { report(JSON.stringify(h ? { t: -7, a: a, h: 1 } : { t: -7, a: a })); };
  var SV = 'fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"';
  var CCP = 'M11 10.2C9.6 8.8 7 9.6 7 12C7 14.4 9.6 15.2 11 13.8M17.5 10.2C16.1 8.8 13.5 9.6 13.5 12C13.5 14.4 16.1 15.2 17.5 13.8';
  var IC = {
    back: '<path d="M14.5 5.5 8 12l6.5 6.5" ' + SV + ' stroke-width="2.4"/>',
    play: '<path d="M8.5 5.5v13l10.5-6.5z" fill="#fff"/>',
    pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1.3" fill="#fff"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.3" fill="#fff"/>',
    vol: '<path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5H4z" fill="#fff"/><path d="M15 9.6a3.8 3.8 0 0 1 0 4.8M17.6 7.4a7.2 7.2 0 0 1 0 9.2" ' + SV + ' stroke-width="1.7"/>',
    mute: '<path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5H4z" fill="#fff"/><path d="M15.5 9.8l5 4.4m0-4.4-5 4.4" ' + SV + ' stroke-width="1.8"/>',
    sources: '<path d="M8.5 7h10m0 0-3.2-3.2M18.5 7l-3.2 3.2M15.5 17H5.5m0 0 3.2-3.2M5.5 17l3.2 3.2" ' + SV + ' stroke-width="1.9"/>',
    fullscreen: '<path d="M9.5 4.5H4.5v5M14.5 4.5h5v5M9.5 19.5h-5v-5M14.5 19.5h5v-5" ' + SV + ' stroke-width="2"/>',
    pip: '<rect x="3" y="5" width="18" height="14" rx="2" ' + SV + ' stroke-width="1.8"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="#fff"/>',
    nextEp: '<rect x="16.4" y="5" width="2.8" height="14" rx="1" fill="#fff"/><path d="M5.4 5.8v12.4L13.6 12z" fill="#fff"/>',
    arrowBack: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" ' + SV + ' stroke-width="1.9"/><path d="M3.5 3.8v5.4h5.4" ' + SV + ' stroke-width="1.9"/>',
    arrowFwd: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" ' + SV + ' stroke-width="1.9"/><path d="M20.5 3.8v5.4h-5.4" ' + SV + ' stroke-width="1.9"/>',
    episodes: '<rect x="3.5" y="8" width="17" height="11.5" rx="2" ' + SV + ' stroke-width="1.8"/><path d="M6.5 5h11" ' + SV + ' stroke-width="1.8"/><path d="M10.5 11.2v5.1l4.2-2.55z" fill="#fff"/>',
    ccOn: '<rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="#fff"/><path d="' + CCP + '" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round"/>',
    ccOff: '<rect x="3" y="5.5" width="18" height="13" rx="2.5" ' + SV + ' stroke-width="1.6"/><path d="' + CCP + '" ' + SV + ' stroke-width="1.6"/>',
    spinner: '<circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-opacity="0.25" stroke-width="2.4"/><path d="M12 3a9 9 0 0 1 9 9" ' + SV + ' stroke-width="2.4"/>'
  };
  var svg = function (n, s) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + s + '" height="' + s + '">' + IC[n] + '</svg>';
  };
  var fmt = function (s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    var sss = (ss < 10 ? '0' : '') + ss;
    return h > 0 ? h + ':' + (m < 10 ? '0' : '') + m + ':' + sss : m + ':' + sss;
  };
  var FONT = '-apple-system,BlinkMacSystemFont,system-ui,sans-serif';
  var CIN_CSS =
    ':host{all:initial}*{box-sizing:border-box}' +
    '#w{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;justify-content:space-between;' +
      'font-family:' + FONT + ';color:#fff;opacity:1;transition:opacity .25s ease}' +
    '#w.hide{opacity:0;cursor:none}' +
    '#w.hide .b,#w.hide #seek,#w.hide #vol{pointer-events:none}' +
    // Until the first frame: an opaque backdrop hides whatever the embed
    // draws while loading (its text, spinner, logo, poster).
    '#bd{position:absolute;top:0;left:0;right:0;bottom:0;background:#000;opacity:1;transition:opacity .45s ease;pointer-events:none}' +
    '#bd.off{opacity:0}' +
    '#w{justify-content:flex-end}' +
    '.sp{flex:1}' +
    '.b{all:unset;box-sizing:border-box;min-width:36px;min-height:36px;padding:0 6px;display:flex;align-items:center;' +
      'justify-content:center;border-radius:999px;cursor:pointer;position:relative;color:#fff;font:700 13px ' + FONT + '}' +
    '.b:hover,.b.hov{background:rgba(255,255,255,.18)}' +
    '.b.off{display:none}' +
    '#mid{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);display:flex;align-items:center;' +
      'justify-content:center;gap:28px;pointer-events:none}' +
    '#mid .b{pointer-events:auto}#w.hide #mid .b{pointer-events:none}' +
    // The circles' look is the app's own controls' too (PlayerControls GLASS:
    // GPUI draws no backdrop blur, so neither surface uses one).
    '.c{background:rgba(20,20,23,.55);border:1px solid rgba(255,255,255,.18);box-shadow:0 2px 10px rgba(0,0,0,.35)}' +
    '.c:hover,.c.hov{background:rgba(44,44,50,.72)}' +
    '.m{width:56px;height:56px}.l{width:80px;height:80px}' +
    '.ar{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center}' +
    '.n{position:relative;font:700 10px ' + FONT + ';margin-top:3px}' +
    '.spl{animation:rfl .3s ease-out}.spr{animation:rfr .3s ease-out}' +
    '@keyframes rfl{from{transform:rotate(0deg)}to{transform:rotate(-360deg)}}' +
    '@keyframes rfr{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
    '.rot{animation:rfr .9s linear infinite}' +
    '.b.dis{opacity:.35;cursor:default}.b.dis:hover,.b.dis.hov{background:transparent}' +
    '.c.dis:hover,.c.dis.hov{background:rgba(20,20,23,.55)}' +
    '#vol.dis{opacity:.35;cursor:default}' +
    '#bot{padding:44px 16px 12px;background:linear-gradient(to top,rgba(0,0,0,.8),rgba(0,0,0,0))}' +
    '#sr{display:flex;align-items:center;gap:10px}' +
    '#seek{position:relative;flex:1;height:22px;display:flex;align-items:center;cursor:pointer}' +
    '#trk{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.28)}' +
    '#seek:hover #trk,#seek.hov #trk{height:6px}' +
    '#fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:2px;background:#e50914}' +
    '#thumb{position:absolute;top:50%;left:0;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;background:#fff}' +
    '#bub{position:absolute;bottom:24px;left:0;transform:translateX(-50%);padding:3px 7px;border-radius:6px;' +
      'background:rgba(0,0,0,.85);font:600 12px ' + FONT + ';display:none;white-space:nowrap;pointer-events:none}' +
    '#rem{font:500 12px ' + FONT + ';color:#e4e4e7;min-width:56px;text-align:right}' +
    '#row{display:flex;align-items:center;gap:4px;margin-top:6px}' +
    '#vol{-webkit-appearance:none;appearance:none;width:80px;height:4px;border-radius:2px;background:rgba(255,255,255,.3);' +
      'outline:none;cursor:pointer;margin:0 6px 0 0}' +
    '#vol::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#fff;cursor:pointer}' +
    '#skip{all:unset;position:absolute;right:20px;bottom:112px;padding:10px 18px;border-radius:999px;' +
      'background:rgba(24,24,27,.85);border:1px solid rgba(255,255,255,.35);font:700 14px ' + FONT + ';color:#fff;' +
      'cursor:pointer;display:none}' +
    '#skip:hover,#skip.hov{background:rgba(63,63,70,.95)}#skip.on{display:block}' +
    // Up next / end of episode / Still watching? (the app's upNextCard()).
    '#un{position:absolute;right:20px;bottom:112px;width:300px;max-width:calc(100% - 40px);display:none;flex-direction:column;' +
      'gap:8px;padding:12px;border-radius:14px;background:rgba(20,20,23,.94);border:1px solid rgba(255,255,255,.18);' +
      'box-shadow:0 12px 40px rgba(0,0,0,.55);font:500 13px ' + FONT + ';color:#fff}#un.on{display:flex}' +
    '#uni{width:100%;height:150px;object-fit:cover;border-radius:8px;background:#27272a;display:none}#uni.on{display:block}' +
    '#unt{font:700 15px ' + FONT + '}#uns{color:#d4d4d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#unb{height:3px;border-radius:2px;background:rgba(255,255,255,.2);overflow:hidden;display:none}#unb.on{display:block}' +
    '#unf{height:100%;width:0;background:#e50914;transition:width 1s linear}' +
    '#unr{display:flex;gap:8px;margin-top:2px}' +
    '.ub{padding:0 14px;min-height:34px;border-radius:999px;border:1px solid rgba(255,255,255,.3)}' +
    '.ub.pr{background:#fff;color:#000}.ub.pr:hover,.ub.pr.hov{background:#e4e4e7}' +
    '#toasts{position:absolute;left:0;right:0;bottom:112px;display:flex;flex-direction:column;align-items:center;' +
      'gap:8px;pointer-events:none}' +
    '.tst{padding:9px 16px;border-radius:999px;background:rgba(24,24,27,.92);border:1px solid rgba(255,255,255,.22);' +
      'font:600 13px ' + FONT + ';color:#fff;max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'transition:opacity .3s ease}' +
    '.tst.success{border-color:rgba(34,197,94,.7)}.tst.error{border-color:rgba(229,9,20,.85)}' +
    // Loading artwork: the title's backdrop under a dark dim, title at the lower left.
    '#bdi{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .4s ease}' +
    '#bdi.on{opacity:1}' +
    '#bdd{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7)}' +
    '#bdt{position:absolute;left:32px;bottom:120px;right:32px;text-shadow:0 1px 6px rgba(0,0,0,.8)}' +
    '#bdtt{font:800 28px ' + FONT + ';color:#fff}#bdts{font:500 15px ' + FONT + ';color:#d4d4d8;margin-top:4px}' +
    // In-page panels (Audio & Subtitles, speed list, right-click menu).
    '.pnl{position:absolute;display:none;background:rgba(20,20,23,.94);-webkit-backdrop-filter:blur(18px);' +
      'backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.14);border-radius:14px;color:#fff;' +
      'font:500 13px ' + FONT + ';box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden}' +
    '.pnl.on{display:flex}' +
    '#av{right:16px;bottom:96px;width:420px;height:300px;max-width:calc(100% - 32px);max-height:calc(100% - 112px);' +
      'flex-direction:column}' +
    '#av .cols{flex:1;display:flex;min-height:0}' +
    '#av .col{display:flex;flex-direction:column;min-height:0;min-width:0}' +
    '#av .ca{width:40%;border-right:1px solid rgba(255,255,255,.1)}#av .cs{flex:1}' +
    '.hd{font:700 11px ' + FONT + ';letter-spacing:.08em;color:#a1a1aa;padding:12px 14px 6px}' +
    '.ls{flex:1;overflow-y:auto;overflow-x:hidden;padding:0 6px 8px}' +
    '.pi{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;white-space:nowrap}' +
    '.pi:hover,.pi.hov{background:rgba(255,255,255,.12)}' +
    '.ck{width:14px;flex:none;color:#e50914;font-weight:800}' +
    '.tx{flex:1;overflow:hidden;text-overflow:ellipsis}' +
    '.tag{font:600 10px ' + FONT + ';color:#a1a1aa;border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:0 4px}' +
    '.gh{font:700 10px ' + FONT + ';letter-spacing:.08em;color:#71717a;padding:8px 8px 4px}' +
    '.nt{color:#a1a1aa;padding:6px 8px;white-space:normal;font-size:12px;line-height:1.35}' +
    '.pi.lnk{color:#fff;text-decoration:underline}' +
    '#av .ft{display:flex;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid rgba(255,255,255,.1);' +
      'white-space:nowrap;font-size:12px;color:#d4d4d8}' +
    '.ft .pi{padding:4px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.2);font:600 12px ' + FONT + ';color:#fff}' +
    '.ft .pi.sel{background:#fff;color:#000}.ft .lb{color:#a1a1aa;margin-left:6px}.ft .ov{min-width:44px;text-align:center}' +
    '#spl{right:150px;bottom:96px;flex-direction:column;padding:6px;min-width:130px}' +
    '#cm{flex-direction:column;padding:6px;min-width:200px}';
  var cinHtml = function () {
    // No top row on desktop: back, title and the top-right buttons live in
    // the app's window title bar.
    return '<div id="bd"><img id="bdi" alt=""><div id="bdd" style="display:none"></div>' +
      '<div id="bdt"><div id="bdtt"></div><div id="bdts"></div></div></div>' +
    '<div id="w">' +
      '<div id="mid">' +
        '<button class="b c m" id="rw" title="Back ' + seekStep + ' seconds"><span class="ar" id="rwa">' + svg('arrowBack', 34) + '</span><span class="n" id="rwn">' + seekStep + '</span></button>' +
        '<button class="b c l" id="pp" title="Play/Pause">' + svg('play', 34) + '</button>' +
        '<button class="b c m" id="ff" title="Forward ' + seekStep + ' seconds"><span class="ar" id="ffa">' + svg('arrowFwd', 34) + '</span><span class="n" id="ffn">' + seekStep + '</span></button>' +
      '</div>' +
      '<div id="bot">' +
        '<div id="sr"><div id="seek"><div id="trk"><div id="fill"></div><div id="thumb"></div></div><div id="bub"></div></div><div id="rem"></div></div>' +
        '<div id="row"><div class="sp"></div>' +
          '<button class="b" id="spd" title="Playback speed">1×</button>' +
          '<button class="b" id="cc" title="Subtitles">' + svg('ccOff', 24) + '</button>' +
          '<button class="b off" id="eps" title="Episodes">' + svg('episodes', 22) + '</button>' +
          '<button class="b off" id="nx" title="Next episode">' + svg('nextEp', 22) + '</button>' +
          '<button class="b" id="src" title="Sources">' + svg('sources', 22) + '</button>' +
          '<button class="b" id="mu" title="Mute">' + svg('vol', 22) + '</button>' +
          '<input id="vol" type="range" min="0" max="100" value="100">' +
          '<button class="b off" id="pip" title="Picture in picture">' + svg('pip', 22) + '</button>' +
          '<button class="b" id="fs" title="Fullscreen">' + svg('fullscreen', 22) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div id="toasts"></div>' +
    '<button id="skip"></button>' +
    '<div id="un"><img id="uni" alt=""><div id="unt"></div><div id="uns"></div><div id="unb"><div id="unf"></div></div>' +
      '<div id="unr"><button class="b ub pr" id="unp"></button><button class="b ub" id="unc"></button></div></div>' +
    '<div id="av" class="pnl"></div><div id="spl" class="pnl"></div><div id="cm" class="pnl"></div>';
  };
  var fsEl = function () {
    try { return document.fullscreenElement || document.webkitFullscreenElement || null; } catch (e) { return null; }
  };
  // Page-side actions run inside the click/key handler: fullscreen and
  // picture-in-picture need that user gesture (a round trip through the
  // app would lose it). h:1 tells the app it was already done.
  // trusted: called from a real page event (a user gesture). Forwarded
  // pointer input is not one, so entering fullscreen is left to the app.
  var cinFullscreen = function (untrusted) {
    var d = document, de = d.documentElement;
    try {
      if (fsEl()) {
        var ex = d.exitFullscreen || d.webkitExitFullscreen;
        if (ex) { ex.call(d); act('fullscreen', 1); return; }
      }
      if (untrusted === true) { act('fullscreen'); return; }
      var req = de.requestFullscreen || de.webkitRequestFullscreen;
      if (req && (d.fullscreenEnabled || d.webkitFullscreenEnabled)) {
        // The whole document goes fullscreen so the overlay stays on top.
        var pr = req.call(de);
        if (pr && pr.catch) pr.catch(function () { act('fullscreen'); });
        act('fullscreen', 1);
        return;
      }
    } catch (e) {}
    act('fullscreen');
  };
  var inPip = function (v) {
    try {
      return v.webkitPresentationMode === 'picture-in-picture' || document.pictureInPictureElement === v;
    } catch (e) { return false; }
  };
  // PiP can only work on a playable video in a live phase: anything else
  // is ignored (no request, no refusal check), so a click on a dead or
  // loading video can't count as a refusal.
  var pipPlayable = function (v) {
    var rs = 0;
    try { rs = v.readyState || 0; } catch (e) {}
    var ph = chrome.phase;
    return rs >= 2 && (!ph || ph === 'playing' || ph === 'paused' || ph === 'stalled');
  };
  // Already in PiP: exit (no refusal check). Otherwise request it; a
  // moment later, if a still-playable video is not in PiP, that is one
  // miss — two misses on this document hide the button (one can be
  // timing). Per document only: a new page starts fresh.
  var pipTry = function (v) {
    if (!v) return;
    if (inPip(v)) {
      try {
        if (v.webkitSetPresentationMode && v.webkitPresentationMode === 'picture-in-picture') v.webkitSetPresentationMode('inline');
        else if (document.exitPictureInPicture) {
          var px = document.exitPictureInPicture();
          if (px && px.catch) px.catch(function () {});
        }
      } catch (e) {}
      return;
    }
    if (!pipPlayable(v)) return;
    try {
      if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) {
        v.webkitSetPresentationMode('picture-in-picture');
      } else if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
        var pr = v.requestPictureInPicture();
        if (pr && pr.catch) pr.catch(function () {});
      }
    } catch (e) {}
    setTimeout(function () {
      if (inPip(v)) { pipMiss = 0; return; }
      if (!pipPlayable(v)) return;
      pipMiss++;
      if (pipMiss >= 2) {
        pipFailed = true;
        act('pipfail');
        if (cin) cinSync(v);
      }
    }, 900);
  };
  var cinPip = function () {
    var v = pickVideo();
    if (!v) return;
    pipTry(v);
    act('pip', 1);
  };
  var cinToggle = function () {
    var v = pickVideo();
    if (!v) return;
    try {
      if (v.paused) {
        var pr = v.play();
        if (pr && pr.catch) pr.catch(function () {});
        act('userplay');
      } else {
        v.pause();
        act('userpause');
      }
    } catch (e) {}
  };
  var cinSpin = function (dir) {
    if (!cin) return;
    var a = dir < 0 ? cin.el.rwa : cin.el.ffa, cls = dir < 0 ? 'spl' : 'spr';
    try { a.classList.remove(cls); void a.offsetWidth; a.classList.add(cls); } catch (e) {}
  };
  var cinSeekTo = function (p) {
    var v = pickVideo();
    if (!v) return;
    try {
      var d = v.duration;
      if (d && isFinite(d) && d > 0) p = Math.min(p, d);
      v.currentTime = Math.max(0, p);
    } catch (e) {}
    act('userseek');
    report(snap(v, 'seeking'));
  };
  var cinSeekBy = function (s) {
    var v = pickVideo();
    if (!v) return;
    cinSpin(s);
    cinSeekTo((v.currentTime || 0) + s);
  };
  var cinVolBy = function (dv) {
    var v = pickVideo();
    if (!v) return;
    try {
      v.volume = Math.max(0, Math.min(1, (v.volume || 0) + dv));
      if (dv > 0 && v.muted) v.muted = false;
    } catch (e) {}
  };
  var cinSetVis = function (vis) {
    if (!cin || cin.vis === vis) return;
    cin.vis = vis;
    cin.el.w.className = vis ? '' : 'hide';
    try { cin.host.style.setProperty('cursor', vis ? 'auto' : 'none', 'important'); } catch (e) {}
    capLayout();
  };
  var cinMaybeHide = function () {
    cinHideT = null;
    if (!cin) return;
    var v = pickVideo();
    // Stays while paused, while the pointer is over a control, while
    // scrubbing; the next sync re-arms the timer once it plays.
    if (!v || v.paused || !v.__rfready || cinOver || cinDrag || pnlOpen) return;
    cinSetVis(false);
  };
  var cinShow = function () {
    if (!cin) return;
    cinSetVis(true);
    if (cinHideT) clearTimeout(cinHideT);
    cinHideT = setTimeout(cinMaybeHide, 3000);
  };
  var cinFrac = function (x) {
    if (!cin) return 0;
    var r = cin.el.trk.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (x - r.left) / r.width)) : 0;
  };
  var cinBubble = function (x) {
    if (!cin) return;
    var v = pickVideo(), d = 0;
    try { d = v ? v.duration || 0 : 0; } catch (e) {}
    if (!(d > 0) || !isFinite(d)) { cin.el.bub.style.display = 'none'; return; }
    var f = cinFrac(x);
    cin.el.bub.textContent = fmt(f * d);
    cin.el.bub.style.left = (f * 100) + '%';
    cin.el.bub.style.display = 'block';
    if (cinDrag) {
      cin.el.fill.style.width = (f * 100) + '%';
      cin.el.thumb.style.left = (f * 100) + '%';
    }
  };
  var cinRemove = function () {
    if (cinHideT) { clearTimeout(cinHideT); cinHideT = null; }
    if (cinClickT) { clearTimeout(cinClickT); cinClickT = null; }
    if (cin && cin.host.parentNode) cin.host.parentNode.removeChild(cin.host);
    cin = null;
    cinOver = false;
    cinDrag = false;
    pnlOpen = '';
    lsDrag = null;
    capLayout();
  };
  var cinBuild = function () {
    if (cin && cin.host.isConnected) return;
    cinRemove();
    var host = document.createElement('div');
    host.id = 'rf-cinema';
    var hs = [['position', 'fixed'], ['top', '0'], ['left', '0'], ['right', '0'], ['bottom', '0'],
      ['width', '100%'], ['height', '100%'], ['z-index', '2147483647'], ['display', 'block'],
      ['pointer-events', 'auto'], ['margin', '0'], ['padding', '0'], ['border', '0'],
      ['background', 'transparent'], ['opacity', '1'], ['visibility', 'visible'], ['transform', 'none']];
    for (var i = 0; i < hs.length; i++) host.style.setProperty(hs[i][0], hs[i][1], 'important');
    var root = host;
    try { if (host.attachShadow) root = host.attachShadow({ mode: 'closed' }); } catch (e) { root = host; }
    root.innerHTML = '<style>' + CIN_CSS + '</style>' + cinHtml();
    (document.body || document.documentElement).appendChild(host);
    var ids = ['bd', 'w', 'pip', 'src', 'rw', 'rwa', 'pp', 'ff', 'ffa', 'seek', 'trk', 'fill',
      'thumb', 'bub', 'rem', 'spd', 'cc', 'eps', 'nx', 'mu', 'vol', 'fs', 'toasts', 'skip',
      'bdi', 'bdd', 'bdtt', 'bdts', 'av', 'spl', 'cm', 'rwn', 'ffn', 'un', 'uni', 'unt', 'uns', 'unb', 'unf', 'unp', 'unc'];
    var el = {};
    for (var j = 0; j < ids.length; j++) el[ids[j]] = root.querySelector('#' + ids[j]);
    cin = { host: host, root: root, el: el, vis: false };
    cinState = {};
    pnlOpen = '';
    artSrc = '';
    artBind();
    // Control actions, run directly by the pointer handler (cinPtr) for
    // both real page events and app-forwarded input. No listeners live
    // inside the shadow root: the window-capture interceptor is the one
    // input path. fn(true) = forwarded (not a user gesture).
    cinActs = {
      back: function () { act('back'); },
      src: function () { act('sources'); },
      pip: cinPip,
      pp: cinToggle,
      rw: function () { cinSeekBy(-seekStep); },
      ff: function () { cinSeekBy(seekStep); },
      unp: function () { var u = chrome.up; if (u && u.a) act('up:' + u.a[1]); },
      unc: function () { var u = chrome.up; if (u && u.b) act('up:' + u.b[1]); },
      spd: function () { pnlToggle('spl'); },
      cc: function () { pnlToggle('av'); },
      eps: function () { act('episodes'); },
      nx: function () { act('next'); },
      mu: function () { var v = pickVideo(); if (v) { try { v.muted = !v.muted; } catch (e) {} } },
      fs: function (untrusted) { cinFullscreen(untrusted === true); },
      skip: function () { act('skip'); }
    };
    cinShow();
    cinSync(pickVideo());
  };
  var cinDragEnd = function (x, commit) {
    if (!cinDrag) return;
    cinDrag = false;
    var f = cinFrac(x), v = pickVideo(), d = 0;
    try { d = v ? v.duration || 0 : 0; } catch (err) {}
    if (cin) cin.el.bub.style.display = 'none';
    if (commit && d > 0 && isFinite(d)) cinSeekTo(f * d);
    else cinState.f = -1;
    if (v) cinSync(v);
    cinShow();
  };
  // A press from one source (real page event / app-forwarded) at about
  // the spot and time of one from the other is the same press twice.
  var near = function (a, x, y) {
    return Date.now() - a.t < 400 && Math.abs(x - a.x) < 24 && Math.abs(y - a.y) < 24;
  };
  var cinVolAt = function (x) {
    if (!cin) return;
    var v = pickVideo();
    if (!v) return;
    var r = cin.el.vol.getBoundingClientRect();
    var f = r.width > 0 ? Math.max(0, Math.min(1, (x - r.left) / r.width)) : 0;
    try { v.volume = f; if (f > 0 && v.muted) v.muted = false; } catch (e) {}
    cin.el.vol.value = String(Math.round(f * 100));
  };
  var setHov = function (c) {
    if (cinHov === c) return;
    try { if (cinHov) cinHov.classList.remove('hov'); } catch (e) {}
    cinHov = c;
    try { if (c) c.classList.add('hov'); } catch (e) {}
  };
  // Forwarded pointer input: x/y in viewport CSS pixels. Hit-testing goes
  // through the (closed) shadow root; controls run their actions directly.
  var cinPtr = function (k, x, y, native, dy) {
    if (!cin) return;
    if (k === 'ctx') {
      // The native contextmenu and the app-forwarded one are one press;
      // a right click must not swallow the next (left) click nearby.
      if (near(lastCtx, x, y)) return;
      lastCtx = { t: Date.now(), x: x, y: y };
    } else if (k !== 'move' && k !== 'leave' && k !== 'wheel') {
      if (native) {
        if (near(lastFwd, x, y)) return;
        lastNat = { t: Date.now(), x: x, y: y };
      } else {
        if (near(lastNat, x, y)) return;
        lastFwd = { t: Date.now(), x: x, y: y };
      }
    }
    var root = cin.root, hit = null;
    try { hit = root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y); } catch (e) {}
    if (hit === cin.host) hit = null;
    var ctl = null;
    try { ctl = hit && hit.closest ? hit.closest('.b,#seek,#vol,#skip,#un,.pi,.pnl') : null; } catch (e) {}
    var id = ctl ? ctl.id : '';
    var isPi = false, inPnl = false;
    try { isPi = !!(ctl && ctl.classList.contains('pi')); inPnl = !!(ctl && (isPi || ctl.classList.contains('pnl'))); } catch (e) {}
    if ((k === 'down' || k === 'click') && !native && !fwdLogged) {
      fwdLogged = true;
      report(JSON.stringify({ t: -8, msg: 'page: first forwarded press handled: ' + (id || (isPi ? 'panel item' : 'picture')) }));
    }
    cinLastX = x;
    if (k === 'wheel') {
      var wl = null;
      try { wl = hit && hit.closest ? hit.closest('.ls') : null; } catch (e) {}
      if (wl) { try { wl.scrollTop = (wl.scrollTop || 0) + (dy || 0); } catch (e) {} }
      cinShow();
      return;
    }
    if (k === 'ctx') {
      // Right click: a menu on the empty picture; nothing over controls.
      if (ctl) return;
      pnlOpenAt('cm', x, y);
      cinShow();
      return;
    }
    if (k === 'leave') {
      setHov(null);
      cinOver = false;
      cin.el.bub.style.display = 'none';
      cinVolDrag = false;
      lsDrag = null;
      cinDragEnd(x, false);
      return;
    }
    if (k === 'move') {
      setHov(ctl && !(ctl.classList && ctl.classList.contains('pnl')) ? ctl : null);
      cinOver = !!ctl;
      if (lsDrag) {
        var ddy = y - lsDrag.y0;
        if (Math.abs(ddy) > 4) lsDrag.moved = true;
        if (lsDrag.moved) { try { lsDrag.el.scrollTop = lsDrag.top0 - ddy; } catch (e) {} }
      }
      if (cinDrag) cinBubble(x);
      else if (id === 'seek') cinBubble(x);
      else cin.el.bub.style.display = 'none';
      if (cinVolDrag) cinVolAt(x);
      cinShow();
      return;
    }
    if (k === 'down') {
      if (inPnl) {
        // Drag-to-scroll the panel lists (forwarded input has no wheel).
        var dl = null;
        try { dl = hit && hit.closest ? hit.closest('.ls') : null; } catch (e) {}
        lsDrag = dl ? { el: dl, y0: y, top0: dl.scrollTop || 0, moved: false } : null;
      } else if (id === 'seek') { cinDrag = true; cinBubble(x); }
      else if (id === 'vol') { cinVolDrag = true; cinVolAt(x); }
      cinShow();
      return;
    }
    if (k === 'up') {
      if (cinDrag) cinDragEnd(x, true);
      cinVolDrag = false;
      if (lsDrag) { if (lsDrag.moved) lsDragAt = Date.now(); lsDrag = null; }
      return;
    }
    var dis = false;
    try { dis = !!(ctl && ctl.classList.contains('dis')); } catch (e) {}
    if (dis && k !== 'move') return;
    if (k === 'click') {
      if (inPnl) {
        // The click that ends a list drag is not a pick.
        if (Date.now() - lsDragAt < 350) return;
        if (isPi) { pnlAct(ctl.getAttribute('data-a') || ''); cinShow(); }
        return;
      }
      if (pnlOpen) {
        // Outside an open panel: close it. On the picture that is all;
        // a control still runs (CC / speed toggle their own panel).
        var own = (id === 'cc' && pnlOpen === 'av') || (id === 'spd' && pnlOpen === 'spl');
        if (!own) pnlClose();
        if (!ctl) { cinShow(); return; }
      }
      if (id === 'seek' || id === 'vol') return;
      if (ctl) {
        var fn = cinActs[id];
        if (fn) { fn(!native); cinShow(); }
        return;
      }
      if (cinClickT) clearTimeout(cinClickT);
      cinClickT = setTimeout(function () { cinClickT = null; cinToggle(); cinShow(); }, 250);
      return;
    }
    if (k === 'dblclick') {
      if (ctl || pnlOpen) return;
      if (cinClickT) { clearTimeout(cinClickT); cinClickT = null; }
      // A real double click is a user gesture: the page may go fullscreen.
      cinFullscreen(!native);
    }
  };
  // --- In-page panels (desktop) ---------------------------------------------
  // Built with createElement/textContent only (labels are app data).
  // Items carry their action in data-a; cinPtr runs them (pnlAct).
  var SPEEDS_P = [0.5, 0.75, 1, 1.25, 1.5, 2];
  var mk = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  };
  var item = function (a, text, checked, tag) {
    var r = mk('div', 'pi');
    r.setAttribute('data-a', a);
    r.appendChild(mk('span', 'ck', checked ? '✓' : ''));
    r.appendChild(mk('span', 'tx', text));
    if (tag) r.appendChild(mk('span', 'tag', tag));
    return r;
  };
  var clear = function (e) { while (e.firstChild) e.removeChild(e.firstChild); };
  var curRate = function () {
    var v = pickVideo(), r = appRate || 1;
    try { if (v && v.playbackRate) r = v.playbackRate; } catch (e) {}
    return r;
  };
  var pnlRender = function () {
    if (!cin || MOBILE) return;
    var el = cin.el;
    if (pnlOpen === 'av') {
      var st = avs || {};
      var keep = null;
      try { keep = el.av.querySelector('.cs .ls'); } catch (e) {}
      var top = keep ? keep.scrollTop || 0 : 0;
      clear(el.av);
      var cols = mk('div', 'cols');
      var ca = mk('div', 'col ca'), cs = mk('div', 'col cs');
      ca.appendChild(mk('div', 'hd', 'AUDIO'));
      var al = mk('div', 'ls');
      var aud = st.aud || [];
      for (var i = 0; i < aud.length; i++) al.appendChild(item('aud:' + aud[i].id, aud[i].label, aud[i].id === st.ca));
      if (aud.length <= 1) {
        if (st.hint) al.appendChild(mk('div', 'nt', st.hint));
        var fs = item('findsrc', 'Find another source', false);
        fs.className = 'pi lnk';
        al.appendChild(fs);
      }
      ca.appendChild(al);
      cs.appendChild(mk('div', 'hd', 'SUBTITLES'));
      var sl = mk('div', 'ls');
      sl.appendChild(item('sub:off', 'Off', st.cs == null));
      var subs = st.subs || [], mine = [], more = [];
      for (var j = 0; j < subs.length; j++) (subs[j].mine ? mine : more).push(subs[j]);
      var group = function (name, list) {
        if (!list.length) return;
        sl.appendChild(mk('div', 'gh', name));
        for (var g = 0; g < list.length; g++) {
          sl.appendChild(item('sub:' + list[g].id, list[g].label, list[g].id === st.cs, list[g].online ? 'online' : ''));
        }
      };
      group('MY LANGUAGES', mine);
      group('MORE', more);
      if (st.srch === 'searching') sl.appendChild(mk('div', 'nt', 'Searching…'));
      else if (st.srch === 'error') sl.appendChild(mk('div', 'nt', 'Online search failed.'));
      else if (!subs.length && st.srch === 'done') sl.appendChild(mk('div', 'nt', 'No subtitles found.'));
      cs.appendChild(sl);
      cols.appendChild(ca);
      cols.appendChild(cs);
      el.av.appendChild(cols);
      var ft = mk('div', 'ft');
      ft.appendChild(mk('span', 'lb', 'Size'));
      var sizes = [['s', 'S'], ['m', 'M'], ['l', 'L']];
      for (var z = 0; z < sizes.length; z++) {
        var sb = mk('div', 'pi' + (cap.size === sizes[z][0] ? ' sel' : ''), sizes[z][1]);
        sb.setAttribute('data-a', 'size:' + sizes[z][0]);
        ft.appendChild(sb);
      }
      ft.appendChild(mk('span', 'lb', 'Timing'));
      var mi = mk('div', 'pi', '− 0.5 s'); mi.setAttribute('data-a', 'nudge:-0.5'); ft.appendChild(mi);
      var o = Math.round(cap.off * 10) / 10;
      ft.appendChild(mk('span', 'ov', (o > 0 ? '+' : '') + o.toFixed(1) + ' s'));
      var pl = mk('div', 'pi', '+ 0.5 s'); pl.setAttribute('data-a', 'nudge:0.5'); ft.appendChild(pl);
      var rs = mk('div', 'pi', 'Reset'); rs.setAttribute('data-a', 'reset'); ft.appendChild(rs);
      el.av.appendChild(ft);
      try { sl.scrollTop = top; } catch (e) {}
    } else if (pnlOpen === 'spl') {
      clear(el.spl);
      var cr = curRate();
      for (var k2 = 0; k2 < SPEEDS_P.length; k2++) {
        var sp = SPEEDS_P[k2];
        el.spl.appendChild(item('rate:' + sp, sp === 1 ? 'Normal' : sp + '×', Math.abs(sp - cr) < 0.01));
      }
    } else if (pnlOpen === 'cm') {
      clear(el.cm);
      el.cm.appendChild(item('m:speed', 'Speed ▸', false));
      el.cm.appendChild(item('m:av', 'Audio & Subtitles', false));
      if (chrome.series) el.cm.appendChild(item('m:eps', 'Episodes', false));
      el.cm.appendChild(item('m:src', 'Source', false));
    }
  };
  var pnlClose = function () {
    if (!cin) { pnlOpen = ''; return; }
    var el = cin.el;
    try { el.av.className = 'pnl'; el.spl.className = 'pnl'; el.cm.className = 'pnl'; } catch (e) {}
    pnlOpen = '';
    lsDrag = null;
    setHov(null);
  };
  var pnlShow = function (which) {
    if (!cin || MOBILE) return;
    pnlClose();
    pnlOpen = which;
    pnlRender();
    try { cin.el[which].className = 'pnl on'; } catch (e) {}
    cinShow();
    if (which === 'av') act('avopen');
  };
  var pnlToggle = function (which) {
    if (pnlOpen === which) { pnlClose(); return; }
    pnlAnchor();
    pnlShow(which);
  };
  // The right-click menu (or the speed list from it) at the pointer,
  // kept inside the viewport.
  var pnlOpenAt = function (which, x, y) {
    pnlShow(which);
    var e = cin && cin.el[which];
    if (!e) return;
    var w = 210, h = which === 'cm' ? 170 : 240;
    try { var r = e.getBoundingClientRect(); if (r.width) { w = r.width; h = r.height; } } catch (err) {}
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600;
    var lx = Math.max(8, Math.min(x, vw - w - 8)), ly = Math.max(8, Math.min(y, vh - h - 8));
    e.style.left = lx + 'px';
    e.style.top = ly + 'px';
    e.style.right = 'auto';
    e.style.bottom = 'auto';
  };
  var pnlAct = function (a) {
    if (!a) return;
    var st = avs || (avs = {});
    if (a.indexOf('sub:') === 0) {
      var sid = a.slice(4);
      st.cs = sid === 'off' ? null : sid;
      if (sid === 'off') capCmd({ t: 'cap', mode: 'off' });
      act(sid === 'off' ? 'sub:off' : 'sub:' + sid);
      pnlRender();
    } else if (a.indexOf('aud:') === 0) {
      st.ca = a.slice(4);
      act(a);
      pnlRender();
    } else if (a.indexOf('size:') === 0) {
      capCmd({ t: 'capc', size: a.slice(5) });
      act('subsize:' + a.slice(5));
      pnlRender();
    } else if (a.indexOf('nudge:') === 0) {
      var d = Number(a.slice(6)) || 0;
      capCmd({ t: 'capc', o: Math.max(-15, Math.min(15, Math.round((cap.off + d) * 10) / 10)) });
      act('subnudge:' + d);
      pnlRender();
    } else if (a === 'reset') {
      capCmd({ t: 'capc', o: 0 });
      act('subreset');
      pnlRender();
    } else if (a === 'findsrc') {
      pnlClose();
      act('findsrc');
    } else if (a.indexOf('rate:') === 0) {
      var r = Number(a.slice(5));
      pnlClose();
      if (r > 0) act('rate:' + r);
    } else if (a === 'm:speed') {
      var cmx = 0, cmy = 0;
      try { var cr = cin.el.cm.getBoundingClientRect(); cmx = cr.left; cmy = cr.top; } catch (e) {}
      pnlOpenAt('spl', cmx, cmy);
    } else if (a === 'm:av') {
      pnlShow('av');
      try { var av = cin.el.av; av.style.left = ''; av.style.top = ''; av.style.right = ''; av.style.bottom = ''; } catch (e) {}
    } else if (a === 'm:eps') {
      pnlClose();
      act('episodes');
    } else if (a === 'm:src') {
      pnlClose();
      act('sources');
    }
  };
  // Panels opened from the bottom row sit at their CSS anchor; only the
  // context menu path places them at the pointer.
  var pnlAnchor = function () {
    if (!cin) return;
    var ids = ['av', 'spl'];
    for (var i = 0; i < ids.length; i++) {
      try { var e = cin.el[ids[i]]; e.style.left = ''; e.style.top = ''; e.style.right = ''; e.style.bottom = ''; } catch (err) {}
    }
  };
  // --- Loading artwork ------------------------------------------------------
  // The app's backdrop URL loads in the page; a page CSP may refuse it:
  // without a load within 3 s it is dropped and the backdrop stays black.
  var artSrc = '', artT = null;
  var artBind = function () {
    if (!cin) return;
    var img = cin.el.bdi;
    if (!img) return;
    img.onload = function () {
      if (!cin || img !== cin.el.bdi || !artSrc) return;
      if (artT) { clearTimeout(artT); artT = null; }
      img.className = 'on';
      cin.el.bdd.style.display = '';
    };
    img.onerror = function () {
      if (artT) { clearTimeout(artT); artT = null; }
      report(JSON.stringify({ t: -8, msg: 'page: loading artwork failed to load (CSP or network)' }));
    };
  };
  var artApply = function () {
    if (!cin) return;
    var el = cin.el;
    try {
      el.bdtt.textContent = chrome.title || '';
      el.bdts.textContent = chrome.sub || '';
    } catch (e) {}
    var u = ''; /* loading is black: no artwork is fetched or shown */
    if (u === artSrc || cinFrame) return;
    artSrc = u;
    if (artT) { clearTimeout(artT); artT = null; }
    try {
      el.bdi.className = '';
      el.bdd.style.display = 'none';
      if (!u) { el.bdi.removeAttribute('src'); return; }
      el.bdi.src = u;
      artT = setTimeout(function () {
        artT = null;
        if (!cin || cin.el.bdi.className === 'on') return;
        try { cin.el.bdi.removeAttribute('src'); } catch (e) {}
        report(JSON.stringify({ t: -8, msg: 'page: loading artwork not loaded within 3s, staying black' }));
      }, 3000);
    } catch (e) {}
  };
  var toast = function (text, kind) {
    if (!cin) return;
    var box = cin.el.toasts;
    try {
      while (box.children.length >= 2) box.removeChild(box.firstChild);
      var t = document.createElement('div');
      t.className = 'tst ' + (kind === 'success' || kind === 'error' ? kind : 'info');
      t.textContent = String(text || '');
      box.appendChild(t);
      setTimeout(function () { t.style.opacity = '0'; }, 3200);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3550);
    } catch (e) {}
  };
  // One layout in every state. No video / not ready yet: a spinner in
  // the play button's place, -10/+10 and the video-only buttons dimmed
  // and inert, an empty seek bar; episodes/next/sources stay usable.
  var cinSync = function (v) {
    if (!cin) return;
    var el = cin.el, st = cinState;
    var set = function (k, val, fn) { if (st[k] !== val) { st[k] = val; try { fn(val); } catch (e) {} } };
    if (!v) v = { __rfnone: true, paused: true, textTracks: null };
    try { if (v.controls) v.controls = false; } catch (e) {}
    var t = 0, d = 0, p = true, r = 1, mu = false, vo = 1, rs = 0, cc = false, pip = false;
    try { t = v.currentTime || 0; } catch (e) {}
    try { d = v.duration || 0; } catch (e) {}
    try { p = !!v.paused; } catch (e) {}
    try { r = v.playbackRate || 1; } catch (e) {}
    try { mu = !!v.muted; } catch (e) {}
    try { vo = typeof v.volume === 'number' ? v.volume : 1; } catch (e) {}
    try { rs = v.readyState || 0; } catch (e) {}
    cc = cap.mode !== 'off';
    try {
      pip = !!((v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) ||
        document.pictureInPictureEnabled);
    } catch (e) {}
    var none = !!v.__rfnone;
    if (!none && rs >= 3) v.__rfready = true;
    /* The black backdrop stays until a video actually plays: nothing of
       the embed page (its poster, its own controls) shows before. */
    if (!none && rs >= 2 && !p) cinFrame = true;
    var loading = none || !v.__rfready;
    var buffering = !loading && !p && (rs < 3 || !!v.__rfwait);
    // The play button itself turns into the spinner (same size and spot).
    set('pp', loading || buffering ? 'spin' : (p ? 'play' : 'pause'), function (n) {
      el.pp.innerHTML = n === 'spin'
        ? '<span class="rot" style="display:flex">' + svg('spinner', 40) + '</span>'
        : svg(n, 34);
    });
    set('bd', cinFrame, function (f) { el.bd.className = f ? 'off' : ''; });
    if (!cinFrame) artApply();
    set('dis', loading, function (x) {
      var ds = ['rw', 'ff', 'spd', 'cc', 'mu', 'fs', 'pip'];
      for (var di = 0; di < ds.length; di++) {
        try { el[ds[di]].classList[x ? 'add' : 'remove']('dis'); } catch (e) {}
      }
      try { el.vol.classList[x ? 'add' : 'remove']('dis'); } catch (e) {}
      try { el.seek.style.pointerEvents = x ? 'none' : ''; } catch (e) {}
    });
    if (!cinDrag) {
      var f = d > 0 && isFinite(d) ? Math.min(1, t / d) : 0;
      set('f', Math.round(f * 1000), function (x) {
        el.fill.style.width = (x / 10) + '%';
        el.thumb.style.left = (x / 10) + '%';
      });
    }
    set('rem', d > 0 && isFinite(d) ? '−' + fmt(Math.max(0, d - t)) : '', function (s) { el.rem.textContent = s; });
    set('spd', (Math.round(r * 100) / 100) + '×', function (s) { el.spd.textContent = s; });
    set('cc', cc, function (o) { el.cc.innerHTML = svg(o ? 'ccOn' : 'ccOff', 24); });
    set('mu', mu || vo === 0, function (m) { el.mu.innerHTML = svg(m ? 'mute' : 'vol', 22); });
    set('vol', Math.round((mu ? 0 : vo) * 100), function (x) { el.vol.value = String(x); });
    set('pip', pip && !pipFailed && chrome.pipOk !== false, function (o) {
      el.pip.classList[o ? 'remove' : 'add']('off');
    });
    // Dimmed (inert) whenever PiP cannot work: not playable, or failed.
    var pipDis = loading || none || !pipPlayable(v);
    set('pipdis', pipDis, function (x) { el.pip.classList[x ? 'add' : 'remove']('dis'); });
    set('eps', !!chrome.series, function (o) { el.eps.className = o ? 'b' : 'b off'; });
    set('nx', !!chrome.hasNext, function (o) { el.nx.className = o ? 'b' : 'b off'; });
    var sk = chrome.skip && chrome.skip.label ? String(chrome.skip.label) : '';
    set('skip', sk, function (s) { el.skip.textContent = s; el.skip.className = s ? 'on' : ''; });
    set('step', seekStep, function (n) {
      el.rwn.textContent = String(n);
      el.ffn.textContent = String(n);
      el.rw.setAttribute('title', 'Back ' + n + ' seconds');
      el.ff.setAttribute('title', 'Forward ' + n + ' seconds');
    });
    var up = chrome.up;
    set('up', up ? JSON.stringify([up.t, up.s, up.img, up.a, up.b, typeof up.f === 'number']) : '', function () {
      el.un.className = up ? 'on' : '';
      if (!up) return;
      el.unt.textContent = String(up.t || '');
      el.uns.textContent = String(up.s || '');
      if (up.img) {
        el.uni.onerror = function () { el.uni.className = ''; };
        if (el.uni.getAttribute('src') !== String(up.img)) el.uni.src = String(up.img);
        el.uni.className = 'on';
      } else { el.uni.className = ''; el.uni.removeAttribute('src'); }
      el.unb.className = typeof up.f === 'number' ? 'on' : '';
      el.unp.textContent = up.a ? String(up.a[0]) : '';
      el.unp.className = up.a ? 'b ub pr' : 'b ub pr off';
      el.unc.textContent = up.b ? String(up.b[0]) : '';
      el.unc.className = up.b ? 'b ub' : 'b ub off';
    });
    set('upf', up && typeof up.f === 'number' ? Math.round(up.f * 1000) : -1, function (x) {
      if (x >= 0) el.unf.style.width = (x / 10) + '%';
    });
    if (p || loading) {
      cinSetVis(true);
      if (cinHideT) { clearTimeout(cinHideT); cinHideT = null; }
    } else if (cin.vis && !cinHideT) {
      cinHideT = setTimeout(cinMaybeHide, 3000);
    }
  };
  // --- Captions (both platforms) ---------------------------------------------
  // Our own renderer: page text tracks stay 'hidden' (cues still load)
  // and are never 'showing'; the words are drawn in a fixed layer above
  // the pinned video and below the controls. One source at a time: an
  // embedded track ('track': read from track.cues) or cues the app
  // pushed ('ext', {s,e,t} in seconds, in chunks). The offset shifts
  // both when rendering (cues are never mutated).
  var cap = { mode: 'off', ti: -1, tl: '', tg: '', ext: [], xid: '', off: 0, size: 'm', lift: false };
  var capHost = null, capBox = null, capSig = null, capTimer = null, capLay = '';
  var CAP_VH = { s: 3.3, m: 4.2, l: 5.4 };
  var CAP_CSS = ':host{all:initial}' +
    '#cb{position:absolute;left:10%;right:10%;bottom:7%;display:flex;flex-direction:column;align-items:center;' +
      'text-align:center;font-family:' + FONT + ';font-weight:600;color:#fff;line-height:1.22;' +
      'text-shadow:0 0 3px rgba(0,0,0,.9),0 1px 2px rgba(0,0,0,.95),0 0 12px rgba(0,0,0,.55);' +
      'transition:bottom .2s ease;white-space:pre-wrap;overflow-wrap:break-word}' +
    '#cb .l{display:block;max-width:100%}#cb i{font-style:italic}';
  var capBuild = function () {
    if (capHost && capHost.isConnected) return;
    var h = document.createElement('div');
    h.id = 'rf-cap';
    var hs = [['position', 'fixed'], ['top', '0'], ['left', '0'], ['right', '0'], ['bottom', '0'],
      ['width', '100%'], ['height', '100%'], ['z-index', '2147483600'], ['display', 'block'],
      ['pointer-events', 'none'], ['margin', '0'], ['padding', '0'], ['border', '0'],
      ['background', 'transparent'], ['opacity', '1'], ['visibility', 'visible'], ['transform', 'none']];
    for (var i = 0; i < hs.length; i++) h.style.setProperty(hs[i][0], hs[i][1], 'important');
    var root = h;
    try { if (h.attachShadow) root = h.attachShadow({ mode: 'closed' }); } catch (e) { root = h; }
    var st = document.createElement('style');
    st.textContent = CAP_CSS;
    root.appendChild(st);
    var box = document.createElement('div');
    box.id = 'cb';
    root.appendChild(box);
    (document.body || document.documentElement).appendChild(h);
    capHost = h;
    capBox = box;
    capSig = null;
    capLay = '';
    capLayout();
  };
  // Size scales with the viewport height; the bottom offset rises while
  // the controls show (desktop: the overlay; phones: 'capc' lift).
  var capLayout = function () {
    if (!capBox) return;
    var vh = window.innerHeight || 600;
    var lifted = MOBILE ? !!cap.lift : !!(cin && cin.vis && cin.host.isConnected);
    // From the picture's short side, as the native captions
    // (screens/Captions.tsx): a portrait phone shows a 16:9 picture across
    // its width; the height would make lines ~3x too big. Landscape and
    // desktop: unchanged (the height is the short side).
    var vw = window.innerWidth || 0;
    var base = vw > 0 && vw < vh ? vw : vh;
    var fs = Math.max(13, Math.round(base * (CAP_VH[cap.size] || CAP_VH.m) / 100));
    var bot = lifted ? Math.round(MOBILE ? vh * 0.18 + 24 : 96 + vh * 0.02) : Math.round(vh * 0.07);
    var sig = fs + ':' + bot;
    if (sig === capLay) return;
    capLay = sig;
    capBox.style.fontSize = fs + 'px';
    capBox.style.bottom = bot + 'px';
  };
  try { window.addEventListener('resize', function () { capLay = ''; capLayout(); }); } catch (e) {}
  // Raw cue text (VTT/SRT markup) -> plain lines; italics as \\u0001/\\u0002.
  var capClean = function (raw) {
    var s = String(raw || '').replace(/[\\u0001\\u0002]/g, '');
    s = s.replace(/\\{\\\\[^}]*\\}/g, '').replace(/<br\\s*\\/?>/gi, '\\n');
    s = s.replace(/<(\\/?)([a-z][a-z0-9]*)?[^>]*>/gi, function (m, c, n) {
      return (n || '').toLowerCase() === 'i' ? (c ? '\\u0002' : '\\u0001') : '';
    });
    s = s.replace(/&(#x[0-9a-f]+|#\\d+|[a-z]+);/gi, function (m, e) {
      if (e.charAt(0) === '#') {
        var n = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return n > 2 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch (err) { return ''; }
      }
      var ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\\u00a0', lrm: '', rlm: '' }[e.toLowerCase()];
      return ent !== undefined ? ent : m;
    });
    var ls = s.split('\\n'), out = [];
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i].replace(/[ \\t]+/g, ' ').replace(/^ | $/g, '');
      if (l.replace(/[\\u0001\\u0002 ]/g, '') !== '') out.push(l);
    }
    return out.join('\\n');
  };
  // Draws the text (lines; italics markers) as DOM nodes: never innerHTML.
  var capShow = function (text) {
    if (text === capSig) return;
    capSig = text;
    if (!capBox) return;
    while (capBox.firstChild) capBox.removeChild(capBox.firstChild);
    if (!text) return;
    var lines = text.split('\\n').slice(0, 3), ital = false;
    for (var i = 0; i < lines.length; i++) {
      var row = document.createElement('span');
      row.className = 'l';
      var segs = lines[i].split(/([\\u0001\\u0002])/);
      for (var j = 0; j < segs.length; j++) {
        var sg = segs[j];
        if (sg === '\\u0001') { ital = true; continue; }
        if (sg === '\\u0002') { ital = false; continue; }
        if (!sg) continue;
        if (ital) { var it = document.createElement('i'); it.textContent = sg; row.appendChild(it); }
        else row.appendChild(document.createTextNode(sg));
      }
      capBox.appendChild(row);
    }
  };
  // The selected embedded track on this video: by index when its label
  // and language still match, else by label+language (a replaced video).
  var capTrack = function (v) {
    var ts = null;
    try { ts = v.textTracks; } catch (e) {}
    if (!ts) return null;
    var t = cap.ti >= 0 && cap.ti < ts.length ? ts[cap.ti] : null;
    if (t && (t.label || '') === cap.tl && (t.language || '') === cap.tg) return t;
    for (var k = 0; k < ts.length; k++) {
      if ((ts[k].label || '') === cap.tl && (ts[k].language || '') === cap.tg) { cap.ti = k; return ts[k]; }
    }
    return t;
  };
  // Nothing native is ever 'showing' (it would double our captions, or
  // show captions the user turned off) - except in the OS fullscreen
  // player, which owns the tracks and cannot see our layer.
  var capGuard = function (v, sel) {
    var ts = null;
    try { if (v.webkitDisplayingFullscreen) return; ts = v.textTracks; } catch (e) {}
    if (!ts) return;
    for (var k = 0; k < ts.length; k++) {
      try {
        if (ts[k].mode === 'showing') ts[k].mode = 'hidden';
        if (ts[k] === sel && ts[k].mode === 'disabled') ts[k].mode = 'hidden';
      } catch (e) {}
    }
  };
  var capTick = function () {
    var v = pickVideo();
    if (!v) { capShow(''); return; }
    var sel = cap.mode === 'track' ? capTrack(v) : null;
    capGuard(v, sel);
    if (cap.mode === 'off') { capShow(''); return; }
    if (capHost && !capHost.isConnected) capBuild();
    var t = 0;
    try { t = v.currentTime || 0; } catch (e) {}
    var tt = t - cap.off, parts = [];
    if (cap.mode === 'ext') {
      var cs = cap.ext;
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (c.s > tt) break;
        if (tt < c.e) parts.push(c.t);
      }
    } else if (sel) {
      var cues = null;
      try { cues = sel.cues; } catch (e) {}
      if (cues) for (var k = 0; k < cues.length; k++) {
        var q = cues[k];
        if (q.startTime <= tt && tt < q.endTime) parts.push(capClean(q.text || ''));
      }
    }
    capShow(parts.join('\\n'));
  };
  var capRun = function () {
    if (cap.mode !== 'off') {
      capBuild();
      capLayout();
      if (!capTimer) capTimer = setInterval(capTick, 100);
    } else if (capTimer) {
      clearInterval(capTimer);
      capTimer = null;
    }
    capTick();
    if (cin) cinSync(pickVideo());
  };
  var capCmd = function (m) {
    if (m.t === 'capc') {
      if (typeof m.o === 'number' && isFinite(m.o)) cap.off = Math.max(-15, Math.min(15, m.o));
      if (m.size === 's' || m.size === 'm' || m.size === 'l') cap.size = m.size;
      if (typeof m.lift === 'boolean') cap.lift = m.lift;
      capLay = '';
      capLayout();
      capSig = null;
      capTick();
      if (pnlOpen === 'av') pnlRender();
      return;
    }
    if (m.t === 'capx') {
      if (m.id !== cap.xid || !m.c || !m.c.length) return;
      for (var i = 0; i < m.c.length; i++) {
        var c = m.c[i];
        if (c && typeof c.s === 'number' && typeof c.e === 'number' && typeof c.t === 'string') {
          cap.ext.push({ s: c.s, e: c.e, t: c.t });
        }
      }
      capSig = null;
      capTick();
      return;
    }
    if (m.mode === 'track' && typeof m.i === 'number') {
      cap.mode = 'track';
      cap.ti = m.i;
      cap.tl = String(m.label || '');
      cap.tg = String(m.lang || '');
    } else if (m.mode === 'ext') {
      cap.mode = 'ext';
      cap.xid = String(m.id || '');
      cap.ext = [];
    } else {
      cap.mode = 'off';
    }
    capSig = null;
    capRun();
  };
  var ctlStatus = function () {
    return ctlOn ? (cin && cin.host.isConnected ? (cin.vis ? 2 : 1) : 0) : -1;
  };
  // Builds the overlay if it is missing (SPA navigations can drop the
  // node) and keeps it the last child of <body>: elements the page
  // appends later at the same z-index would otherwise cover it.
  var cinEnsure = function () {
    if (!ctlOn || cinBlind || !document.documentElement) return;
    if (!cin || !cin.host.isConnected) { cinBuild(); return; }
    var bd = document.body;
    if (bd && !(srcmEl && srcmEl.style.display !== 'none') &&
      (cin.host.parentNode !== bd || bd.lastElementChild !== cin.host)) {
      bd.appendChild(cin.host);
    }
  };
  // --- Key forwarding (desktop) ---------------------------------------------
  // Once a click lands in the page, the web view holds the keyboard and
  // the app's shortcuts never fire. While the overlay is on, the player
  // keys are handled here (the embed doesn't also act on them); F and
  // Escape go to the app as actions. An app overlay's keyBlock wins.
  var FWD_KEYS = { ' ': 1, Spacebar: 1, ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1,
    m: 1, M: 1, f: 1, F: 1, Escape: 1, Esc: 1 };
  var editable = function (t) {
    try {
      if (!t) return false;
      var n = (t.tagName || '').toLowerCase();
      if (n === 'input' || n === 'textarea' || n === 'select') return true;
      return !!t.isContentEditable;
    } catch (e) { return false; }
  };
  var keyFwd = function (e) {
    if (!ctlOn || keyBlock) return;
    var k = e.key;
    if (!FWD_KEYS[k] || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (editable(e.target)) return;
    var esc = k === 'Escape' || k === 'Esc';
    if (esc && srcmEl && srcmEl.style.display !== 'none') return;
    var v = pickVideo();
    if (!v && !esc && k !== 'f' && k !== 'F') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    if (k === ' ' || k === 'Spacebar') { if (!e.repeat) cinToggle(); }
    else if (k === 'ArrowLeft') cinSeekBy(-seekStep);
    else if (k === 'ArrowRight') cinSeekBy(seekStep);
    else if (k === 'ArrowUp') cinVolBy(0.1);
    else if (k === 'ArrowDown') cinVolBy(-0.1);
    else if (k === 'm' || k === 'M') { if (!e.repeat && v) { try { v.muted = !v.muted; } catch (err) {} } }
    else if (k === 'f' || k === 'F') { if (!e.repeat) cinFullscreen(); }
    else if (esc && pnlOpen) { pnlClose(); cinShow(); }
    else if (esc) {
      var x = fsEl() ? (document.exitFullscreen || document.webkitExitFullscreen) : null;
      if (x) { try { x.call(document); } catch (err) {} } else act('escape');
    }
    if (!esc) cinShow();
  };
  window.addEventListener('keydown', keyFwd, true);
  window.addEventListener('keyup', keyFwd, true);
  window.addEventListener('keypress', keyFwd, true);
  // State payload for the app: the same shape from the heartbeat and
  // from media events ('ev' names the event that caused it).
  var snap = function (v, ev) {
    var tracks = [];
    try {
      var ts = v.textTracks;
      if (ts) for (var k = 0; k < ts.length; k++) {
        var tr = ts[k];
        tracks.push({ i: k, label: tr.label || tr.language || ('Track ' + (k + 1)), mode: tr.mode,
          lang: tr.language || '', kind: tr.kind || '', raw: tr.label || '' });
      }
    } catch (e) {}
    var aud = [];
    try {
      var ats = v.audioTracks;
      if (ats) for (var ak = 0; ak < ats.length; ak++) {
        aud.push({ i: ak, label: ats[ak].label || '', lang: ats[ak].language || '', on: !!ats[ak].enabled });
      }
    } catch (e) {}
    var t = 0, d = 0, r = 1, f = false, mu = false, vo = 1, rs = 0, pip = false, vid = docId;
    try { t = v.currentTime || 0; } catch (e) {}
    try { d = v.duration || 0; } catch (e) {}
    try { r = v.playbackRate || 1; } catch (e) {}
    try { mu = !!v.muted; } catch (e) {}
    try { vo = typeof v.volume === 'number' ? v.volume : 1; } catch (e) {}
    try { rs = v.readyState || 0; } catch (e) {}
    try { f = !!(v.webkitDisplayingFullscreen || (document.fullscreenElement === v) || fsEl()); } catch (e) {}
    try {
      pip = !!((v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) ||
        document.pictureInPictureEnabled);
    } catch (e) {}
    try {
      if (!v.__rfid) v.__rfid = ++vidSeq;
      vid = docId + ':' + v.__rfid + ':' + (v.__rfgen || 0);
    } catch (e) {}
    var o = {
      t: t, d: d, p: !!v.paused, r: r, f: f, m: mu, vo: vo, rs: rs, pip: pip, vid: vid,
      fill: fillMode, hold: holdOn, tracks: tracks, aud: aud, cap: cap.mode,
      ctl: ctlStatus(),
      clk: clkN, md: mdN, pd: pdN,
    };
    if (ev) o.ev = ev;
    // Out of sight: a hidden document, or the video in picture in picture.
    try {
      if (document.hidden || document.pictureInPictureElement === v || v.webkitPresentationMode === 'picture-in-picture') o.hid = true;
    } catch (e) {}
    if (ev === 'error') { try { o.err = v.error ? v.error.code : 0; } catch (e) {} }
    return JSON.stringify(o);
  };
  // Event-driven reports: listeners on the picked <video>, re-wired when
  // the pick changes, so the app's buttons and seek bar follow at once
  // instead of waiting for the heartbeat. timeupdate is throttled.
  var MEDIA_EVS = ['loadstart', 'loadedmetadata', 'play', 'pause', 'playing', 'waiting', 'stalled',
    'canplay', 'seeked', 'ratechange', 'volumechange', 'ended', 'error', 'timeupdate',
    'webkitbeginfullscreen', 'webkitendfullscreen', 'loadeddata'];
  var wiredVideo = null, lastTu = 0, audLogged = false;
  // Track lists change late (HLS subtitles, audio renditions): report.
  var onTrackEv = function () { if (wiredVideo) report(snap(wiredVideo, 'tracks')); };
  var trackLists = function (v) {
    var l = [];
    try { if (v.textTracks && v.textTracks.addEventListener) l.push(v.textTracks); } catch (e) {}
    try { if (v.audioTracks && v.audioTracks.addEventListener) l.push(v.audioTracks); } catch (e) {}
    return l;
  };
  // One line per document answering what the page exposes for audio.
  var audProbe = function (v) {
    if (audLogged) return;
    audLogged = true;
    var has = false, n = -1, tn = -1;
    try { has = 'audioTracks' in v; n = v.audioTracks ? v.audioTracks.length : -1; } catch (e) {}
    try { tn = v.textTracks ? v.textTracks.length : -1; } catch (e) {}
    report(JSON.stringify({ t: -8, msg: 'page: video ready; audioTracks in video: ' + has + ', count: ' + n + ', textTracks: ' + tn }));
  };
  var onMediaEv = function (e) {
    var v = e.currentTarget || e.target;
    if (v !== wiredVideo) return;
    var n = e.type;
    if (n === 'waiting' || n === 'stalled') v.__rfwait = true;
    else if (n === 'playing' || n === 'pause' || n === 'timeupdate' || n === 'seeked') v.__rfwait = false;
    if (n === 'canplay' || n === 'playing') { v.__rfready = true; audProbe(v); }
    else if (n === 'loadstart') v.__rfready = false;
    if (ctlOn && cin) cinSync(v);
    if (n === 'timeupdate') {
      var now = Date.now();
      if (now - lastTu < 250) return;
      lastTu = now;
    }
    if (n === 'loadstart') { try { v.__rfgen = (v.__rfgen || 0) + 1; } catch (err) {} }
    if ((n === 'loadedmetadata' || n === 'canplay') && pendingSeek != null) {
      var p0 = pendingSeek;
      pendingSeek = null;
      try { v.currentTime = p0; } catch (err) {}
    }
    report(snap(v, n));
  };
  var wire = function (v) {
    if (v === wiredVideo) return;
    var i;
    if (wiredVideo) {
      for (i = 0; i < MEDIA_EVS.length; i++) {
        try { wiredVideo.removeEventListener(MEDIA_EVS[i], onMediaEv); } catch (e) {}
      }
      var ol = trackLists(wiredVideo);
      for (i = 0; i < ol.length; i++) {
        try { ol[i].removeEventListener('addtrack', onTrackEv); ol[i].removeEventListener('removetrack', onTrackEv); ol[i].removeEventListener('change', onTrackEv); } catch (e) {}
      }
    }
    wiredVideo = v;
    if (v) {
      for (i = 0; i < MEDIA_EVS.length; i++) {
        try { v.addEventListener(MEDIA_EVS[i], onMediaEv); } catch (e) {}
      }
      var nl = trackLists(v);
      for (i = 0; i < nl.length; i++) {
        try { nl[i].addEventListener('addtrack', onTrackEv); nl[i].addEventListener('removetrack', onTrackEv); nl[i].addEventListener('change', onTrackEv); } catch (e) {}
      }
      // A replaced video picks up the current caption source at once.
      if (cap.mode !== 'off') { capSig = null; setTimeout(capTick, 0); }
      // A replaced element inherits the remembered hold and fill.
      if (holdOn) { try { if (v.playbackRate !== 2) v.playbackRate = 2; } catch (e) {} }
      if (fillMode) { try { v.style.setProperty('object-fit', 'cover', 'important'); } catch (e) {} }
    }
  };
  // A new or newly-best <video> gets wired as soon as any video starts
  // loading or playing (media events don't bubble, but they do pass
  // document capture). Listeners added here still see this same event.
  var rewire = function () { wire(pickVideo()); };
  document.addEventListener('loadstart', rewire, true);
  document.addEventListener('loadedmetadata', rewire, true);
  document.addEventListener('canplay', rewire, true);
  document.addEventListener('play', rewire, true);
  // Fullscreen changes are reported at once: leaving iOS's native player
  // pauses the video, and the app's overlay must show its controls then.
  var fsChanged = function () {
    var v = pickVideo();
    if (v) report(snap(v, 'fullscreenchange'));
  };
  document.addEventListener('fullscreenchange', fsChanged, true);
  document.addEventListener('webkitfullscreenchange', fsChanged, true);
  // Slow heartbeat: catches anything the events missed, pins the video
  // to the viewport, keeps the desktop bar in sync, reports "no video".
  setInterval(function () {
    inlAll();
    var v = pickVideo();
    wire(v);
    if (!v) {
      // No video yet: the overlay stays (loading layout) until the app
      // calls the page blind.
      cinEnsure();
      if (cin) cinSync(null);
      var nv = 0;
      try { nv = document.querySelectorAll('video').length; } catch (e) {}
      report(JSON.stringify({ t: -1, n: nv, doc: docId, ctl: ctlStatus(), clk: clkN, md: mdN, pd: pdN }));
      return;
    }
    if (ctlOn) {
      cinEnsure();
      cinSync(v);
    }
    // Fill: embed players often size the <video> to a fixed aspect or
    // leave page chrome around it, producing black bars. Once per video
    // element, pin it to the viewport so the picture uses the whole
    // WebView; object-fit is "contain" (whole picture) unless the app
    // asked for "cover" through the 'fill' command.
    if (fittedVideo !== v) {
      fittedVideo = v;
      try {
        var r = v.getBoundingClientRect();
        if (r.width < window.innerWidth * 0.98 || r.height < window.innerHeight * 0.98) {
          v.style.setProperty('position', 'fixed', 'important');
          v.style.setProperty('top', '0', 'important');
          v.style.setProperty('left', '0', 'important');
          v.style.setProperty('right', '0', 'important');
          v.style.setProperty('bottom', '0', 'important');
          v.style.setProperty('width', '100%', 'important');
          v.style.setProperty('height', '100%', 'important');
          v.style.setProperty('object-fit', fillMode ? 'cover' : 'contain', 'important');
          v.style.setProperty('background', '#000', 'important');
          v.style.setProperty('z-index', '2147483000', 'important');
        } else if (fillMode) {
          v.style.setProperty('object-fit', 'cover', 'important');
        }
      } catch (e) {}
    }
    if (pendingSeek != null) {
      // Clear BEFORE assigning: if currentTime throws (video has no src
      // yet), a stale pendingSeek must not re-fire every tick forever.
      var p = pendingSeek;
      pendingSeek = null;
      try { v.currentTime = p; } catch (e) {}
    }
    report(snap(v));
  }, 1500);
  // Boot beacon: proves the injected script ran at all, even if the
  // interval is later throttled into silence.
  // Desktop: the overlay is the only control surface from the first
  // moment (built at document start, before any video exists).
  cinEnsure();
  document.addEventListener('DOMContentLoaded', function () { cinEnsure(); if (cin) cinSync(pickVideo()); });
  report(JSON.stringify({ t: -3, boot: 1, doc: docId, ctl: ctlStatus() }));
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
  setAdblockDiag(on);
  debugOn = on;
  void Storage.setItem(DEBUG_KEY, on ? "1" : "0").catch(() => {});
  if (on) debugLog.length = 0;
}
const debugLog: { t: number; e: string; d?: unknown }[] = [];
/** Service keys can ride along inside URLs (SubDL puts `api_key=` in its
 * download links): never let one reach the debug log. */
function scrubKeys(data: unknown): unknown {
  if (data == null) return data;
  try {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    const clean = text.replace(/((?:api_)?key=)[^&"'\\\s]+/gi, "$1…");
    return typeof data === "string" ? clean : JSON.parse(clean);
  } catch {
    return "[unprintable]";
  }
}

/** An entry's data is kept to this many characters. */
const DEBUG_DATA_MAX = 1500;
/** The log is written at most this often. */
const DEBUG_FLUSH_MS = 2000;
let debugTimer: ReturnType<typeof setTimeout> | undefined;

/** Long data as a clipped string (the bridge's reports run to 6 KB). */
function clipData(data: unknown): unknown {
  if (data == null) return data;
  if (typeof data === "string") return data.length > DEBUG_DATA_MAX ? `${data.slice(0, DEBUG_DATA_MAX)}…` : data;
  if (typeof data !== "object") return data;
  try {
    const text = JSON.stringify(data);
    return text.length > DEBUG_DATA_MAX ? `${text.slice(0, DEBUG_DATA_MAX)}…` : data;
  } catch {
    return "[unprintable]";
  }
}

function flushDebug() {
  debugTimer = undefined;
  void Storage.setItem("rustflix.debug.log", JSON.stringify(debugLog)).catch(() => {});
}

/** Appends to the diagnostics log (while Diagnostics is on). Buffered: the
 * log is written at most every 2 s, not on every entry — the bridge alone
 * logs ~4 reports a second, and each write was the whole 80-entry log
 * stringified (up to ~0.5 MB) and the app's whole storage file rewritten
 * and synced to disk. */
export function debug(event: string, data?: unknown) {
  if (!debugOn) return;
  debugLog.push({ t: Date.now(), e: event, d: scrubKeys(clipData(data)) });
  if (debugLog.length > 80) debugLog.shift();
  debugTimer ??= setTimeout(flushDebug, DEBUG_FLUSH_MS);
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

// Ad blocking (lib/adblock.ts): the native hosts get the lists at boot; a
// switch change reaches the open page at once.
void initWebGuard();
onAdblockChange((on) => web.guard(on));

// Every page command goes through the web backend (lib/playback/webBackend.ts);
// media commands go to whichever backend plays this epoch (`be()`).
const web = createWebBackend({ ref: () => webview(), debug });

/** A state report (the bridge's, or the native backend's in the same shape). */
type BridgeState = MediaReport;

/** Page → app: the bridge's state reports — one per media event on the
 * page's <video> (timeupdate ~4/s) plus a 1.5s heartbeat. */
export function onPlayerMessage(e: { data: unknown }) {
  (globalThis as { __rfPerfMark?: (l: string) => void }).__rfPerfMark?.("player: bridge message");
  const raw = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
  debug("msg", raw?.slice(0, 6000));
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
      // "Block ads in player" off: the page's guard stands down.
      if (!adblockOn()) web.guard(false);
      else if (adblockSkip().length) web.guard(true, adblockSkip());
      const fresh =
        typeof v.doc === "string" && !!v.doc && !epochDocs.has(v.doc) && !staleDocs.has(v.doc);
      if (noteBridge(v.doc)) {
        // A new page document: links of the one before must never be used.
        if (fresh) clearStreams();
        if (typeof v.ctl === "number") pageControlsActive.set(v.ctl >= 1);
      }
      return;
    }
    if (v.t === -2) {
      onStreamsReply(v);
      return;
    }
    if (v.t === -11) {
      // The all-frames sniffer: a media request of any frame of the page
      // (inner frames the top bridge never sees) — links for downloads.
      onSniff(v);
      return;
    }
    if (v.t === -10) {
      // The ad guard's per-page summary (lib/adblock.ts).
      onGuardReport(v, debug);
      return;
    }
    if (v.t === -8) {
      // A one-off diagnostic line from the page.
      debug(String(v.msg ?? ""));
      try {
        console.log(`[rustflix] ${String(v.msg ?? "")}`);
      } catch {}
      return;
    }
    if (v.t === -7) {
      // A control or key in the page asked for an app action.
      if (typeof v.a === "string") onPageMessage(v.a, !!v.h);
      return;
    }
    if (v.t === -1) {
      // Heartbeat: bridge alive, no video element in the top document
      // (so no overlay either).
      if (noteBridge(v.doc)) {
        if (typeof v.ctl === "number") pageControlsActive.set(v.ctl >= 1);
        noteClicks(v.clk);
      }
      return;
    }
    if (v.t < 0) return;
    onVideoState(v as BridgeState);
  } catch {}
}

let lastTracksSig = "";
/** When the app last asked the page for fullscreen. */
let fsAskedAt = 0;

function onVideoState(v: BridgeState) {
  if (!playerRoute()) return;
  syncSrc();
  const doc = typeof v.vid === "string" ? v.vid.split(":")[0] : "";
  // A late report from the page of an earlier epoch (the outgoing
  // episode or source) must not land in this one.
  if (doc && isStaleDoc(doc)) return;
  if (doc && !epochDocs.has(doc)) {
    epochDocs.add(doc);
    // A new page document: PiP refusals of the last one don't count.
    if (!pipWorks()) pipWorks.set(true);
  }
  if (typeof v.rs === "number") lastRs = v.rs;
  if (typeof v.ctl === "number") pageControlsActive.set(v.ctl >= 1);
  noteClicks(v.clk);
  // Desktop: the page draws the controls over the video. Turn the overlay
  // on once per page document as soon as it has a video.
  if (DESKTOP && doc && v.ctl === -1 && !ctlSentDocs.has(doc)) {
    if (ctlSentDocs.size > 50) ctlSentDocs.clear();
    ctlSentDocs.add(doc);
    setPageControls(true);
  }
  const now = Date.now();
  if (!bridgeAt) bridgeAt = now;
  if (!videoSeenAt) videoSeenAt = now;
  const ev = typeof v.ev === "string" ? v.ev : "";
  const paused = !!v.p;
  position.set(v.t);
  if (typeof v.d === "number" && v.d > 0) duration.set(v.d);
  if (ANDROID_PIP && paused !== untracked(mediaPaused)) androidPipState(paused);
  mediaPaused.set(paused);
  if (typeof v.m === "boolean") mediaMuted.set(v.m);
  // Native fullscreen the app did not ask for (iOS taking a video that
  // lacks inline playback) is not fought — mediaFullscreen tells the UI.
  if (!!v.f && !mediaFullscreen() && now - fsAskedAt > 5000) {
    debug("fullscreen entered without an app request", { ev: v.ev });
  }
  mediaFullscreen.set(!!v.f);
  if (typeof v.r === "number" && v.r > 0) mediaRate.set(v.r);
  // Right after volumeBy the page may still report the old volume.
  if (typeof v.vo === "number" && now - volSetAt > 800) mediaVolume.set(v.vo);
  if (typeof v.pip === "boolean") pipSupported.set(ANDROID_PIP || (v.pip && pipWorks()));
  if (Array.isArray(v.tracks)) {
    const tracks = v.tracks.map((t) => ({
      i: t.i,
      label: t.label,
      mode: t.mode,
      lang: t.lang ?? "",
      kind: t.kind ?? "",
      raw: t.raw ?? t.label,
    }));
    // Reports now arrive several times a second: only write on change.
    const sig = JSON.stringify(tracks);
    if (sig !== lastTracksSig) {
      lastTracksSig = sig;
      subTracks.set(tracks);
      remapSubtitle();
    }
  }
  if (Array.isArray(v.aud)) {
    const sig = JSON.stringify(v.aud);
    if (sig !== lastAudSig) {
      lastAudSig = sig;
      pageAudio.set(v.aud.map((a) => ({ i: a.i, label: a.label ?? "", lang: a.lang ?? "", on: !!a.on })));
    }
  }
  reportHidden = !!v.hid;
  if (ev === "playing") userPaused = false;
  if (playerPhase() === "blind") web.blind(false);
  updatePhase(v, ev, paused, now);
  applyVideoPrefs(v, paused);
  driveResume(v, ev, now);
  // Save every 10s and on pause (persist() itself refuses until this
  // epoch is playable and its resume/carry-over seek has landed).
  if ((ev === "pause" || now - lastSaved > 10_000) && canPersist()) {
    lastSaved = now;
    persist();
  }
  maybeLoadSkips();
  maybePreferAudio(doc);
  driveAutoSkip(v.t, paused);
  driveUpNext(ev === "ended");
  if (epochBackend === "native") maybePrefetchNext();
  if (doc) ensureCaptionDoc(doc);
  if (epochReady && !subsReadyAt) subsReadyAt = now;
  subtitleReconcile();
  pushPageChrome();
}

// --- Desktop page overlay: actions + chrome --------------------------------------

/** Desktop: the controls are drawn by the page over the video. */
const DESKTOP = (() => {
  try {
    return !!platform.desktop;
  } catch {
    return false;
  }
})();

/** True only while the page reports its Cinema overlay as built. The
 * screen shows its own control bar whenever this is false. */
export const pageControlsActive = signal(false);

/** Page actions the screen/router must carry out. ("next", "pip" and
 * "fullscreen" are handled here; "fullscreen" reaches listeners only
 * when the page could not go fullscreen itself.) */
export type PageAction = "back" | "sources" | "episodes" | "next" | "fullscreen" | "pip" | "escape";

const pageActionFns: ((a: PageAction) => void)[] = [];

/** Registers a handler for page actions that need the UI: "back",
 * "sources", "episodes", "escape", and "fullscreen" when the page could
 * not do it. Returns an unsubscribe function. */
export function onPageAction(fn: (a: PageAction) => void): () => void {
  pageActionFns.push(fn);
  return () => {
    const i = pageActionFns.indexOf(fn);
    if (i >= 0) pageActionFns.splice(i, 1);
  };
}

function emitPageAction(a: PageAction) {
  debug("page action", a);
  for (const fn of pageActionFns.slice()) {
    try {
      fn(a);
    } catch {}
  }
}

/** `a` from the page ({t:-7,a,h}); `handled`: the page already did it. */
function onPageMessage(a: string, handled: boolean) {
  if (a.startsWith("src:")) pickSource(a.slice(4));
  else if (a === "srcx") showSources.set(false);
  else if (a === "prev") void prevEpisode();
  else if (a === "next") void nextEpisode();
  else if (a === "skip") skipPillPress();
  else if (a.startsWith("up:")) upNextAction(a.slice(3) as UpAction);
  else if (a === "subs") toggleSubs();
  else if (a === "sub:off") selectSubtitle(null);
  else if (a.startsWith("sub:")) selectSubtitle(a.slice(4));
  else if (a.startsWith("aud:")) selectAudio(a.slice(4));
  else if (a.startsWith("subsize:")) {
    const z = a.slice(8);
    if (z === "s" || z === "m" || z === "l") setSubtitleSize(z);
  } else if (a.startsWith("subnudge:")) nudgeSubtitle(Number(a.slice(9)) || 0);
  else if (a === "subreset") resetSubtitleOffset();
  else if (a === "avopen") ensureSubtitleSearch();
  else if (a === "findsrc") emitPageAction("sources");
  else if (a.startsWith("rate:")) {
    const r = Number(a.slice(5));
    if (r > 0) setRate(r);
  }
  else if (a === "speed") {
    const cur = mediaRate();
    const i = SPEEDS.findIndex((x) => Math.abs(x - cur) < 0.01);
    setRate(SPEEDS[(i + 1) % SPEEDS.length]);
  } else if (a === "userseek") {
    // The user moved the position in the page: a pending resume yields.
    resumeTarget = null;
    resumeFloor = null;
    noteUserInput();
    // The page does not say which way: any seek there yields Up next.
    upNextInteract(true);
  } else if (a === "userplay") {
    userPaused = false;
    noteUserInput();
    upNextInteract(true);
  } else if (a === "userpause") {
    userPaused = true;
    noteUserInput();
    upNextInteract(true);
  }
  else if (a === "pip") {
    if (!handled) enterPip();
  } else if (a === "pipfail") {
    // Refused twice on a playable video: hide PiP for this page document
    // (reset on the next document / URL / title).
    debug("pip: refused by the page");
    pipWorks.set(false);
    pipSupported.set(false);
  } else if (a === "fullscreen") {
    if (!handled) emitPageAction("fullscreen");
  } else if (a === "back" || a === "sources" || a === "episodes" || a === "escape") {
    emitPageAction(a);
  }
}

let clicksLogged = false;
/** Logs once that a click reached the page (proves mouse delivery). */
function noteClicks(clk: unknown) {
  if (clicksLogged || typeof clk !== "number" || clk <= 0) return;
  clicksLogged = true;
  debug("page: first click reached the web page", { clk });
  try {
    console.log(`[rustflix] page: first click reached the web page (clk=${clk})`);
  } catch {}
}

/** False once the current page document refused picture-in-picture
 * (twice, on a playable video); true again on the next document, URL or
 * title. Folded into `pipSupported` (false whenever this is). */
export const pipWorks = signal(true);
/** Last readyState the page reported for its video. */
let lastRs = 0;

const PTR_MOVE_MS = 33;
let lastMoveAt = 0;
let pendingMove: { x: number; y: number } | null = null;
let moveTimer: ReturnType<typeof setTimeout> | undefined;
let pointerLogged = false;

/** Desktop: forwards real mouse input from the app's pointer layer over
 * the web view to the page overlay (the page itself gets no mouse
 * events). x/y are CSS pixels in the page viewport. Moves are throttled
 * to ~30/s (the latest wins); presses are never dropped. */
export function pagePointer(
  kind: "move" | "down" | "up" | "click" | "dblclick" | "leave",
  x: number,
  y: number,
) {
  if (!pointerLogged) {
    pointerLogged = true;
    debug("app: first forwarded pointer event", { kind, x, y });
    try {
      console.log(`[rustflix] app: first forwarded pointer event (${kind} ${Math.round(x)},${Math.round(y)})`);
    } catch {}
  }
  if (kind === "move") {
    const now = Date.now();
    if (now - lastMoveAt >= PTR_MOVE_MS) {
      lastMoveAt = now;
      pendingMove = null;
      web.pointer("move", x, y);
    } else {
      pendingMove = { x, y };
      if (!moveTimer) {
        moveTimer = setTimeout(() => {
          moveTimer = undefined;
          const m = pendingMove;
          pendingMove = null;
          if (m) {
            lastMoveAt = Date.now();
            web.pointer("move", m.x, m.y);
          }
        }, PTR_MOVE_MS - (now - lastMoveAt));
      }
    }
    return;
  }
  // A press goes after the latest position, so hover/hit-test agree.
  if (pendingMove) {
    const m = pendingMove;
    pendingMove = null;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = undefined;
    web.pointer("move", m.x, m.y);
  }
  web.pointer(kind, x, y);
}

// --- Notifications ---------------------------------------------------------------

export type Notice = { text: string; kind: "info" | "success" | "error" };

const noticeFns: ((n: Notice) => void)[] = [];

/** Registers the shell's toast stack. Returns an unsubscribe function. */
export function onNotify(fn: (n: Notice) => void): () => void {
  noticeFns.push(fn);
  return () => {
    const i = noticeFns.indexOf(fn);
    if (i >= 0) noticeFns.splice(i, 1);
  };
}

/** Shows a toast: inside the page overlay on desktop while it is built
 * (GPUI cannot draw over the web view), else through `onNotify`
 * listeners. Never both. */
export function notify(text: string, kind: Notice["kind"] = "info") {
  debug("notify", { text, kind });
  if (DESKTOP && pageControlsActive() && epochBackend === "web") {
    web.toast(text, kind);
    return;
  }
  const n: Notice = { text, kind };
  for (const fn of noticeFns.slice()) {
    try {
      fn(n);
    } catch {}
  }
}

/** Page documents the overlay was switched on for. */
const ctlSentDocs = new Set<string>();
let lastChromeSig = "";

/** Whether a next episode exists (same rule as the Next button). */
export function hasNextEpisode(): boolean {
  const p = playerRoute();
  if (!p || p.type === "movie") return false;
  const cur = p.episode ?? 1;
  const eps = episodes();
  const i = eps.findIndex((e) => e.n === cur);
  if (i >= 0 && i + 1 < eps.length) return true;
  if (p.type === "anime") return false;
  const ss = seasons();
  const si = ss.indexOf(p.season ?? 1);
  return si >= 0 && si + 1 < ss.length;
}

/** Pushes the overlay's app-supplied state (title, episode line, series
 * and next flags, skip segment, speed label) when any of it changed. */
function pushPageChrome() {
  if (!DESKTOP || epochBackend !== "web") return;
  const r = playerRoute();
  if (!r) return;
  let sub = "";
  if (r.type === "tv") {
    const ep = r.episode ?? 1;
    const name = episodes().find((x) => x.n === ep)?.name;
    sub = `S${r.season ?? 1} E${ep}${name ? ` · ${name}` : ""}`;
  } else if (r.type === "anime") {
    sub = `Episode ${r.episode ?? 1}`;
  }
  const sk = skipPill();
  const up = upNextCard();
  const chrome = {
    title: playerTitle(),
    sub,
    series: r.type !== "movie",
    hasNext: hasNextEpisode(),
    skip: sk ? { kind: sk.kind, label: sk.label } : null,
    step: seekStep(),
    up: up
      ? {
          t: up.title,
          s: up.line,
          img: up.still ?? "",
          f: up.frac ?? undefined,
          a: [up.primary.label, up.primary.id],
          b: up.secondary ? [up.secondary.label, up.secondary.id] : null,
        }
      : null,
    speed: `${Math.round(mediaRate() * 100) / 100}×`,
    pipOk: pipWorks(),
    phase: playerPhase(),
    art: loadingArt() ?? "",
  };
  pushPanel();
  const sig = JSON.stringify(chrome);
  if (sig === lastChromeSig) return;
  lastChromeSig = sig;
  web.chrome(chrome);
}

// --- Playback phase + automatic source fallback --------------------------------
//
// One rule: while the app chose the source, a source that fails is left
// at once for the next one, with one line saying so (`switchNotice`); no
// dialog, no countdown, no buttons. The failed phase (`failState`) is the
// only terminal state: every source tried, the device offline, or the
// source the user picked on this play failing (their choice is honoured,
// not swapped behind their back).
//
// Per-phase limits (each counted from the start of the page's epoch, time
// in a picker not counted):
//   - no response: the page never reported in → NO_RESPONSE_MS;
//   - page up, video found but never playable → START_MS of play time (a
//     user pause does not count) and at least 4 s after the video showed;
//   - page up, no reachable video → "blind" after BLIND_MS (the embed's
//     own controls take over; not a failure);
//   - mid-playback stall: the spinner only, for STALL_SWITCH_MS (it is
//     usually buffering), then the next source from the same position.

/** No word from the page at all. Pages report within 1–4 s on a good
 * connection; 15 s is well past a slow start. */
const NO_RESPONSE_MS = 15_000;
/** A video that never becomes playable (play time). */
const START_MS = 12_000;
/** Page up but no reachable video: the embed's own controls. */
const BLIND_MS = 8_000;
/** Mid-playback buffering before giving up on the source. */
const STALL_SWITCH_MS = 45_000;
/** Debug-forced failures fail this long after the page starts. */
const FORCED_FAIL_MS = 3_000;
/** A native start (resolve + proxy) that never handed the player a URL. */
const NATIVE_OPEN_MS = 75_000;

/** Sources that played in real runs (the downloads engine's
 * KNOWN_GOOD_SOURCES, lib/downloads.ts, which imports this module). */
const KNOWN_GOOD_PLAY = ["vidfast", "vidrift", "aether"];
/** This device's sources that reached playback, most recent first. */
const PLAY_SOURCES_KEY = "rustflix.playsources.v1";
let goodSources: string[] = [];
void Storage.getItem(PLAY_SOURCES_KEY)
  .then((raw) => {
    const v = raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) goodSources = v.filter((x) => typeof x === "string").slice(0, 12);
  })
  .catch(() => {});

function recordGoodSource(id: string) {
  if (epochBackend === "native") noteNativeResult(id, true);
  if (goodSources[0] === id) return;
  goodSources = [id, ...goodSources.filter((x) => x !== id)].slice(0, 12);
  void Storage.setItem(PLAY_SOURCES_KEY, JSON.stringify(goodSources)).catch(() => {});
}

/** A source for one language (its note is a language code: DE, FR, RU):
 * never chosen automatically. */
function languageSource(id: string): boolean {
  const n = PLAYER_SOURCES.find((s) => s.id === id)?.note ?? "";
  return /^[A-Z]{2}$/.test(n);
}

// Debug keys (read when a play starts): `rustflix.failsources` = "all" or
// "vidlove,vidfast" — those sources load nothing and fail after 3 s;
// `rustflix.offline` = "1" — every source fails and the device counts as
// offline.
let debugFail: Set<string> | "all" = new Set();
let debugOffline = false;
async function loadDebugFlags() {
  try {
    const f = (await Storage.getItem("rustflix.failsources")) ?? "";
    debugFail =
      f.trim() === "all"
        ? "all"
        : new Set(f.split(",").map((x) => x.trim()).filter(Boolean));
    debugOffline = (await Storage.getItem("rustflix.offline")) === "1";
  } catch {}
}
void loadDebugFlags();

function forcedFail(id: string): boolean {
  return debugOffline || debugFail === "all" || (debugFail instanceof Set && debugFail.has(id));
}

/** Whether the internet answers (TMDB's API host, allowed for the app):
 * any HTTP answer counts; none within 4 s means offline. */
async function online(): Promise<boolean> {
  if (debugOffline) return false;
  try {
    const res = await Promise.race([
      fetch("https://api.themoviedb.org/3/configuration", { method: "GET" }),
      new Promise<null>((done) => setTimeout(() => done(null), 4000)),
    ]);
    return res !== null;
  } catch {
    return false;
  }
}

/** The URL the current phase epoch belongs to; undefined = none yet. */
let epochUrl: string | null | undefined = undefined;
/** The backend the current epoch plays with. */
let epochBackend: "web" | "native" = "web";
let epochAt = 0;
/** First sign of the page's bridge (or the page load) this epoch. */
let bridgeAt = 0;
/** First report with a <video> this epoch. */
let videoSeenAt = 0;
/** A canplay/playing (or readyState ≥ 3) was seen this epoch. */
let epochReady = false;
let stalledAt = 0;
let stalledPos = 0;
let autoPlayed = false;
/** Time counted toward the start budget (a user pause doesn't count). */
let startBudgetMs = 0;
let lastTickAt = 0;
/** The user paused through the app (cleared on play). */
let userPaused = false;
let volSetAt = 0;
/** A failure is being decided (the online check): nothing else fails. */
let deciding = false;
/** Videos (bridge `vid`) whose rate/fill were applied. */
const prefsApplied = new Set<string>();
/** Page documents (bridge docId) that reported this epoch / earlier. */
const epochDocs = new Set<string>();
const staleDocs = new Set<string>();
let watchdog: ReturnType<typeof setInterval> | undefined;
/** Sources tried for the current route (title/episode), with how each
 * failed ("didn't respond", "didn't start", …). */
const triedSources = new Map<string, string>();
/** Automatic fallback for the current route only; null = the user's
 * choice (`sourceId`) applies. */
const sourceOverride = signal<string | null>(null);
/** The source the user picked in the picker on this play (honoured: not
 * left automatically when it fails). */
let pickedSource: string | null = null;
/** The page is taken away for a moment so the same URL loads again
 * (Try again on a single remaining source). */
const reloadBlank = signal(false);
/** Sources whose play in the app's player failed on this route: they play
 * in their page next (lib/playback/caps.ts decides who tries first). */
const nativeTried = signal<string[]>([]);
/** A finished download that failed in the app's player: its local page. */
const localWeb = signal(false);
/** The next native failure counts toward learning (false: a cold-start
 * timeout / a resolve still progressing, see PlaySession). */
let failLearn = true;

// Resume / carry-over: the position this route should continue from.
// It stays pending until a video of the current epoch is playable, then
// is sought once and confirmed (re-sent at most twice more). Saving is
// held off while it is pending.
let resumeTarget: number | null = null;
let resumeSends = 0;
let resumeSentAt = 0;
/** After a resume seek the page refused: no save below this point until
 * the user seeks or playback passes it. */
let resumeFloor: number | null = null;
let lastSaved = 0;

function sourceLabel(id: string): string {
  return PLAYER_SOURCES.find((s) => s.id === id)?.label ?? id;
}

function isLocalUrl(u: string | null | undefined): boolean {
  return !!u && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(u);
}

/** A document of an earlier epoch — unless this epoch has heard from no
 * page for 6s (the same document survived the epoch change; adopt it). */
function isStaleDoc(doc: string): boolean {
  if (!staleDocs.has(doc)) return false;
  if (epochDocs.size === 0 && pickerDepth === 0 && Date.now() - epochAt > 6000) {
    staleDocs.delete(doc);
    return false;
  }
  return true;
}

/** Notes a bridge message from page document `doc`; false when it
 * belongs to an earlier epoch (or there is no player route). */
function noteBridge(doc?: unknown): boolean {
  const r = playerRoute();
  if (!r) return false;
  syncSrc();
  // Debug: a forced failure hears nothing from its page.
  if (!isLocalUrl(epochUrl) && forcedFail(sourceFor(r.type))) return false;
  if (typeof doc === "string" && doc) {
    if (isStaleDoc(doc)) return false;
    if (!epochDocs.has(doc)) {
      epochDocs.add(doc);
      if (!pipWorks()) pipWorks.set(true);
    }
  }
  if (!bridgeAt) {
    bridgeAt = Date.now();
    debug("phase: page answered", { src: sourceFor(r.type), ms: bridgeAt - epochAt });
  }
  return true;
}

/** Starts a new phase epoch when the player URL changed; fails at once
 * when there is no URL and nothing is still resolving. */
function syncSrc() {
  if (!playerRoute()) return;
  // The mode / the platform's answer is not in yet: nothing loads (a page
  // shown now could be replaced by the app's player a moment later).
  const be = playBackend();
  if (be === "pending") {
    // The watchdog asks again every second.
    if (!watchdog) watchdog = setInterval(watchdogTick, 1000);
    return;
  }
  const url = playerUrl();
  if (url !== epochUrl || be !== epochBackend) {
    epochUrl = url;
    epochBackend = be;
    newEpoch();
  }
  if (reloadBlank()) return;
  // A downloaded file whose local page is still being prepared is not
  // a failure (playerUrl() is null until it is ready).
  const r = playerRoute();
  const localPending = !!r && localPageFor(r) === "";
  if (!url && !extLoading() && !localPending && playerPhase() === "loading") {
    fail("start", "doesn't have this title");
  }
}

function newEpoch() {
  closeNative();
  if (playerPhase() === "failed") return;
  clearStreams();
  playerPhase.set("loading");
  epochAt = Date.now();
  bridgeAt = 0;
  videoSeenAt = 0;
  epochReady = false;
  stalledAt = 0;
  autoPlayed = false;
  startBudgetMs = 0;
  lastTickAt = 0;
  userPaused = false;
  prefsApplied.clear();
  subsReadyAt = 0;
  pageControlsActive.set(false);
  lastChromeSig = "";
  lastPanelSig = "";
  lastRs = 0;
  if (!pipWorks()) pipWorks.set(true);
  if (staleDocs.size > 50) staleDocs.clear();
  for (const d of epochDocs) staleDocs.add(d);
  epochDocs.clear();
  // The new page needs its own resume seek.
  resumeSends = 0;
  resumeSentAt = 0;
  if (!watchdog) watchdog = setInterval(watchdogTick, 1000);
  if (epochBackend === "native" && epochUrl) openNative();
}

function watchdogTick() {
  const r = playerRoute();
  if (!r) {
    stopTimers();
    return;
  }
  syncSrc();
  // A picker has the player paused (and maybe hidden): no timer runs.
  if (pickerDepth > 0 || deciding) return;
  // The end of an episode needs no report (an ended video sends few).
  driveUpNext(false);
  const now = Date.now();
  const dt = lastTickAt ? now - lastTickAt : 0;
  lastTickAt = now;
  const ph = playerPhase();
  if (ph === "loading") {
    if (epochUrl && !isLocalUrl(epochUrl) && forcedFail(sourceFor(r.type)) && now - epochAt > FORCED_FAIL_MS) {
      fail("start", "didn't respond");
      return;
    }
    // iOS loads no media data until play(): nudge a video that sits
    // unready and paused (the old 9s timer's job, minus fullscreen).
    if (!autoPlayed && !userPaused && videoSeenAt && !epochReady && mediaPaused() && now - videoSeenAt > 3000) {
      autoPlayed = true;
      playPlayback();
    }
    if (!(userPaused && mediaPaused())) startBudgetMs += dt;
    if (epochUrl && !bridgeAt && now - epochAt > NO_RESPONSE_MS) {
      fail("start", "didn't respond");
    } else if (videoSeenAt && !epochReady && startBudgetMs > START_MS && now - videoSeenAt > 4000) {
      fail("start", "didn't start");
    } else if (epochBackend === "native") {
      // Resolving / opening the stream: the resolver has its own timeout;
      // this only catches a step that never answers.
      if (!videoSeenAt && now - epochAt > NATIVE_OPEN_MS) fail("start", "didn't respond");
    } else if (!videoSeenAt && bridgeAt && now - bridgeAt > BLIND_MS) {
      debug("phase: blind");
      playerPhase.set("blind");
      // The page drops its overlay so the embed's own controls work.
      web.blind(true);
    }
  } else if (ph === "stalled" && now - stalledAt > STALL_SWITCH_MS) {
    // Buffering this long mid-play: the next source, from here.
    fail("stall", "stopped loading");
  }
}

function updatePhase(v: BridgeState, ev: string, paused: boolean, now: number) {
  if (playerPhase() === "failed") return;
  if (ev === "error") {
    fail("start", "couldn't play this");
    return;
  }
  if (!epochReady && (ev === "canplay" || ev === "playing" || (v.rs ?? 0) >= 3)) {
    epochReady = true;
    const r = playerRoute();
    if (r && !isLocalUrl(epochUrl)) {
      const src = sourceFor(r.type);
      recordGoodSource(src);
      debug("phase: ready", { src, ms: now - epochAt, pageMs: bridgeAt ? bridgeAt - epochAt : null });
    }
    if (switchNotice()) switchNotice.set("");
  }
  const ph = playerPhase();
  if (!epochReady) {
    if (ph !== "loading") playerPhase.set("loading");
    return;
  }
  if (ev === "waiting" || ev === "stalled") {
    if (paused) {
      playerPhase.set("paused");
    } else if (ph !== "stalled") {
      stalledAt = now;
      stalledPos = v.t;
      playerPhase.set("stalled");
    }
    return;
  }
  if (paused) {
    playerPhase.set("paused");
    return;
  }
  // Stalled ends on `playing`, or when the position moves again.
  if (ph === "stalled" && ev !== "playing" && !(v.t > stalledPos + 0.5)) return;
  playerPhase.set("playing");
}

/** The current source failed (`why` in plain words: "didn't respond",
 * "didn't start", "stopped loading", …): on to the next source by itself,
 * else the terminal state. Offline is checked first: no point running
 * through every source without a connection. */
function fail(kind: "start" | "stall", why: string) {
  if (playerPhase() === "failed" || deciding) return;
  const r = playerRoute();
  if (!r) return;
  const cur = sourceFor(r.type);
  const wasNative = epochBackend === "native";
  // Whether this native failure counts toward the source's page fallback.
  const learnThis = failLearn;
  failLearn = true;
  debug("phase: source failed", { src: cur, kind, why, backend: epochBackend, ms: Date.now() - epochAt });
  if (wasNative) {
    closeNative();
    // A download that the app's player could not play: its local page.
    if (isLocalUrl(epochUrl)) {
      debug("native: download falls back to its page");
      localWeb.set(true);
      syncSrc();
      return;
    }
    nativeTried.set([...nativeTried().filter((x) => x !== cur), cur]);
  } else {
    triedSources.set(cur, why);
    // A downloaded file plays whatever the source: switching can't help.
    if (isLocalUrl(epochUrl)) {
      terminal("exhausted", "This download couldn't be played");
      return;
    }
  }
  deciding = true;
  const key = `${routeKey(r)}:${r.lang ?? ""}`;
  void online().then((up) => {
    deciding = false;
    const now = playerRoute();
    if (!now || `${routeKey(now)}:${now.lang ?? ""}` !== key || playerPhase() === "failed") return;
    if (!up) {
      terminal("offline", "You're offline");
      return;
    }
    // Online, and the app's player could not play it: counts toward the
    // source going back to its page on this device (lib/playback/caps.ts).
    if (wasNative && learnThis) noteNativeResult(cur, false);
    // The source the user picked (or one for a language) failed in the
    // app's player: its own page next — never another source.
    if (wasNative && (pickedSource === cur || languageSource(cur))) {
      switchNotice.set(`${sourceLabel(cur)} ${why} — trying its site player…`);
      carryPosition();
      syncSrc();
      return;
    }
    if (pickedSource === cur) {
      terminal("picked", `${sourceLabel(cur)}, the source you picked, ${why}`);
      return;
    }
    const next = nextSource(r.type);
    if (!next) {
      terminal("exhausted", exhaustedReason());
      return;
    }
    switchNotice.set(
      next === cur
        ? `${sourceLabel(cur)} ${why} — trying its site player…`
        : `${sourceLabel(cur)} ${why} — trying ${sourceLabel(next)}…`,
    );
    switchSource(next);
  });
}

/** "None of the 6 sources responded" / "… could play it". */
function exhaustedReason(): string {
  const n = new Set([...triedSources.keys(), ...nativeTried()]).size;
  const all = [...triedSources.values()];
  const what = all.length > 0 && all.every((w) => w === "didn't respond") ? "responded" : "could play it";
  return n === 1 ? `The only source ${all[0] === "didn't respond" ? "didn't respond" : "couldn't play it"}` : `None of the ${n} sources ${what}`;
}

/** The one terminal state: the page goes (nothing keeps loading behind
 * it), the controls show "Couldn't play this right now", `reason` and
 * Try again. */
function terminal(kind: "exhausted" | "offline" | "picked", reason: string) {
  const r = playerRoute();
  if (kind === "exhausted" && r && r.lang === "dub" && autoDubKey && autoDubKey === routeKey(r)) {
    // The dub the preferred audio chose has no source: the original, at
    // once, and no automatic dub for this title again this session.
    debug("audio: no source has the dub, back to sub", { id: r.id });
    autoDubKey = "";
    animeLangPicked.add(r.id);
    navigate({ ...r, lang: "sub", next: undefined }, { replace: true });
    origLang.set("ja");
    triedSources.clear();
    nativeTried.set([]);
    localWeb.set(false);
    sourceOverride.set(null);
    pickedSource = null;
    failState.set(null);
    switchNotice.set("No English dub found — playing the original audio…");
    playerPhase.set("loading");
    epochUrl = undefined;
    const cur = playerRoute();
    if (cur) void ensureExtId(cur).then(syncSrc).catch(() => {});
    syncSrc();
    return;
  }
  debug("phase: failed", { kind, reason, tried: [...triedSources.keys()] });
  switchNotice.set("");
  failState.set({ kind, reason });
  playerPhase.set("failed");
}

/** The next source to try: this device's sources that played before,
 * then the known good ones, then the rest (those that needed request
 * interception last); never one already tried, never a language-specific
 * one the user did not choose. */
function nextSource(type: MediaType): string | null {
  const ids = sourcesFor(type)
    .map((s) => s.id)
    .filter((id) => !triedSources.has(id) && (!languageSource(id) || id === sourceId()));
  const rank = (id: string) => {
    const g = goodSources.indexOf(id);
    if (g >= 0) return g;
    const k = KNOWN_GOOD_PLAY.indexOf(id);
    if (k >= 0) return 100 + k;
    return NEEDS_INTERCEPT.includes(id) ? 300 : 200;
  };
  const byRank = (a: string, b: string) => rank(a) - rank(b);
  // 1. Sources the app's player can still try (not the page on screen).
  const tried = nativeTried();
  const native = nativeEnabled() === true ? ids.filter((id) => !tried.includes(id) && nativeCapable(id)) : [];
  if (native.length) return [...native].sort(byRank)[0];
  // 2. The chosen source's own page, then 3. every other page.
  const chosen = sourceSupports(sourceId(), type) ? sourceId() : null;
  if (chosen && ids.includes(chosen) && tried.includes(chosen)) return chosen;
  return [...ids].sort(byRank)[0] ?? null;
}

/** Before any source change on the same route: continue from where the
 * old source was (or from the still-pending resume point). */
function carryPosition() {
  const pos = Math.max(resumeTarget ?? position(), resumeFloor ?? 0);
  resumeFloor = null;
  resumeTarget = pos > 5 ? Math.floor(pos) : null;
  resumeSends = 0;
}

/** Automatic switch: a per-route override; `sourceId` (the user's
 * choice) stays as it is. */
function switchSource(id: string) {
  const r = playerRoute();
  if (!r) return;
  debug("phase: switching source", id);
  carryPosition();
  sourceOverride.set(id);
  void ensureExtId(r).then(syncSrc);
  syncSrc();
}

/** "Try again" in the terminal state: every source is worth trying again,
 * from the user's preferred source (or the one they picked), with the
 * page loaded afresh even when the URL is the same. */
export function tryAgain() {
  const r = playerRoute();
  if (!r || playerPhase() !== "failed") return;
  void loadDebugFlags();
  const picked = failState()?.kind === "picked" ? pickedSource : null;
  triedSources.clear();
  nativeTried.set([]);
  localWeb.set(false);
  failState.set(null);
  switchNotice.set("");
  carryPosition();
  sourceOverride.set(picked);
  if (!picked) pickedSource = null;
  playerPhase.set("loading");
  epochUrl = undefined;
  reloadBlank.set(true);
  setTimeout(() => {
    reloadBlank.set(false);
    const cur = playerRoute();
    if (cur) void ensureExtId(cur).then(syncSrc);
    syncSrc();
  }, 80);
}

/** Per-video setup on its first playable report: autoplay (first video
 * of a src only, never fullscreen), remembered speed, fill mode, hold,
 * and the remembered subtitle choice once the video has tracks. */
function applyVideoPrefs(v: BridgeState, paused: boolean) {
  const vid = v.vid;
  if (!vid || !epochReady) return;
  if (!prefsApplied.has(vid)) {
    prefsApplied.add(vid);
    if (!autoPlayed) {
      autoPlayed = true;
      // A picker is open: start it when the picker closes instead.
      if (pickerDepth > 0) pickerResume = true;
      else if (paused && !userPaused) playPlayback();
    }
    // Remember speed off: every video starts at 1× (a change lasts for
    // that video only).
    const want = rememberSpeed() ? settings().playbackRate : 1;
    if (rateHeld()) be().hold(true);
    else if (typeof want === "number" && want > 0 && Math.abs(want - (v.r ?? 1)) > 0.01) {
      be().setRate(want);
    }
    if (mediaFill()) be().fit(true);
  }
  // Subtitles: subtitleReconcile() (after every report) picks them.
}

// --- Pickers (sources / episodes) ------------------------------------------------

let pickerDepth = 0;
/** Resume playback when the last picker closes. */
let pickerResume = false;
let pickerAt = 0;
let pickerKey = "";

function pickerContext(): string {
  const r = playerRoute();
  if (!r) return "";
  return `${r.type}:${r.id}:${r.season ?? 0}:${r.episode ?? 0}|${sourceFor(r.type)}|${epochBackend}|${epochUrl ?? ""}`;
}

/** A picker (sources, episodes) opens over the player: remembers whether
 * the video was playing, pauses it, and suspends the start/stall
 * watchdogs and the auto-switch countdown (a paused, possibly hidden
 * player is never treated as failed). Nesting-safe. */
export function beginPicker() {
  pickerDepth++;
  if (pickerDepth > 1) return;
  noteUserInput();
  upNextInteract(true);
  pickerAt = Date.now();
  pickerKey = pickerContext();
  const ph = playerPhase();
  pickerResume = !mediaPaused() && (ph === "playing" || ph === "stalled" || ph === "loading");
  if (!mediaPaused()) be().pause();
}

/** The last open picker closed: re-arms the timers (time spent in the
 * picker does not count), asks the page for one immediate report, and
 * resumes playback if it was playing and the title, episode and source
 * are unchanged. */
export function endPicker() {
  if (pickerDepth === 0) return;
  pickerDepth--;
  if (pickerDepth > 0) return;
  const gap = Date.now() - pickerAt;
  // Shift every clock by the time spent in the picker.
  if (epochAt) epochAt += gap;
  if (bridgeAt) bridgeAt += gap;
  if (videoSeenAt) videoSeenAt += gap;
  if (stalledAt) stalledAt += gap;
  if (resumeSentAt) resumeSentAt += gap;
  lastTickAt = 0;
  be().sync();
  const same = pickerKey === pickerContext();
  if (pickerResume && same && playerRoute()) {
    userPaused = false;
    be().play();
  }
  pickerResume = false;
}

/** Seeks this epoch's video to the pending resume point once it is
 * playable; confirms on a later report near the target. */
function driveResume(v: BridgeState, ev: string, now: number) {
  if (resumeTarget === null || !epochReady) return;
  const target = resumeTarget;
  if (ev !== "seeking" && Math.abs(v.t - target) < 10) {
    debug("resume: landed", { target, sends: resumeSends });
    resumeTarget = null;
    return;
  }
  if (resumeSends > 0 && now - resumeSentAt < 3000) return;
  if (resumeSends >= 3) {
    debug("resume: gave up", { target, t: v.t });
    resumeTarget = null;
    resumeFloor = target;
    return;
  }
  resumeSends++;
  resumeSentAt = now;
  be().seek(target);
}

/** Saving is allowed once this epoch's video is playable and its
 * resume/carry-over seek has landed — never 0/0 over a saved point. */
function canPersist(): boolean {
  return (
    !!playerRoute() &&
    epochReady &&
    resumeTarget === null &&
    (resumeFloor === null || position() >= resumeFloor - 10) &&
    duration() > 0
  );
}

/** WebView onLoad: re-arms the bridge and starts the "blind" clock. */
export function onPlayerLoad(e?: unknown) {
  debug("wv:load", e);
  armBridge();
  if (!playerRoute()) return;
  syncSrc();
  if (!bridgeAt) bridgeAt = Date.now();
}

/** WebView onError: a failed page load fails the source. Ad pop-ups the
 * capability refuses and cancelled/interrupted navigations are ignored,
 * and so is anything once the video is playable. */
export function onPlayerError(e?: unknown) {
  debug("wv:error", e);
  if (!playerRoute()) return;
  const o = ((e as { nativeEvent?: unknown } | null)?.nativeEvent ?? e ?? {}) as {
    message?: unknown;
    code?: unknown;
  };
  const msg = String(o.message ?? "");
  if (o.code === "ERR_ACCESS_DENIED" || /not granted|cancel|interrupt/i.test(msg)) return;
  if (epochReady) return;
  fail("start", `webview: ${msg}`);
}

// --- Skip intro (anime, AniSkip) ------------------------------------------------

const skipSegs = signal<SkipSegment[]>([]);
let skipKey = "";
let skipRetried = "";
let skipRetryTimer: ReturnType<typeof setTimeout> | undefined;

function maybeLoadSkips() {
  const r = playerRoute();
  if (!r || r.type !== "anime") return;
  const dur = duration();
  if (!(dur > 0) || !isFinite(dur)) return;
  const ep = r.episode ?? 1;
  const key = `${r.id}:${ep}`;
  if (key === skipKey) return;
  skipKey = key;
  void (async () => {
    try {
      const mal = await aniMalId(r.id);
      if (!mal) return;
      const segs = await skipTimes(mal, ep, dur);
      if (skipKey === key) skipSegs.set(segs);
    } catch {
      // Network/server failure: one more try later in this episode.
      if (skipKey !== key || skipRetried === key) return;
      skipRetried = key;
      if (skipRetryTimer) clearTimeout(skipRetryTimer);
      skipRetryTimer = setTimeout(() => {
        if (skipKey === key) skipKey = "";
      }, 30_000);
    }
  })();
}

/** Non-null while the position is inside a known opening/ending/recap. */
export const skipSegment = computed<{ kind: SkipSegment["kind"]; end: number } | null>(() => {
  const r = playerRoute();
  if (!r || r.type !== "anime") return null;
  const t = position();
  for (const s of skipSegs()) {
    if (t >= s.start && t < s.end - 1) return { kind: s.kind, end: s.end };
  }
  return null;
});

/** Seeks past the current opening/ending/recap. */
export function skipNow() {
  const s = skipSegment();
  if (s) seekTo(s.end);
}

/** The Skip pill's words for a segment. */
export function skipLabel(kind: SkipSegment["kind"]): string {
  return kind === "ed" ? "Skip Credits" : kind === "recap" ? "Skip Recap" : "Skip Intro";
}

// Automatic skipping (`skipSegmentsMode() === "auto"`): an intro or recap
// is skipped once when playback enters it — never again on this play once
// the user seeks back into it. For ~4 s the pill says "Skipped intro ·
// Undo"; Undo seeks back to where the skip happened (and the segment
// keeps its Skip button). Credits are never skipped: with a next episode
// they start the Up next countdown (below). TV has no segment data.

/** `${routeKey}:${kind}:${start}` of the segments skipped automatically. */
const autoSkipped = new Set<string>();
const skipUndo = signal<{ kind: SkipSegment["kind"]; from: number } | null>(null);
let skipUndoTimer: ReturnType<typeof setTimeout> | undefined;
/** How long the "Skipped intro · Undo" pill stays. */
const SKIP_UNDO_MS = 4000;

function clearSkipUndo() {
  if (skipUndoTimer) clearTimeout(skipUndoTimer);
  skipUndoTimer = undefined;
  if (untracked(skipUndo)) skipUndo.set(null);
}

function driveAutoSkip(t: number, paused: boolean) {
  if (skipSegmentsMode() !== "auto" || paused || !epochReady || resumeTarget !== null) return;
  const r = playerRoute();
  if (!r || r.type !== "anime" || playerPhase() === "failed") return;
  for (const s of skipSegs()) {
    if (s.kind === "ed" || !(t >= s.start && t < s.end - 1)) continue;
    const key = `${routeKey(r)}:${s.kind}:${Math.round(s.start)}`;
    if (autoSkipped.has(key)) return;
    autoSkipped.add(key);
    debug("skip: automatic", { kind: s.kind, from: t, to: s.end });
    seekAbs(s.end);
    clearSkipUndo();
    skipUndo.set({ kind: s.kind, from: t });
    skipUndoTimer = setTimeout(() => {
      skipUndoTimer = undefined;
      skipUndo.set(null);
      pushPageChrome();
    }, SKIP_UNDO_MS);
    pushPageChrome();
    return;
  }
}

/** Undo of an automatic skip: back to where it skipped from; that segment
 * is not skipped by itself again on this play. */
export function undoAutoSkip() {
  const u = untracked(skipUndo);
  if (!u) return;
  clearSkipUndo();
  noteUserInput();
  seekAbs(u.from);
  pushPageChrome();
}

/** The Skip pill (both control sets, the page overlay): a segment's Skip
 * button, or the Undo of an automatic skip. Hidden for the credits while
 * the Up next card shows. */
export const skipPill = computed<{ kind: SkipSegment["kind"]; label: string; undo: boolean } | null>(() => {
  const u = skipUndo();
  if (u) {
    const what = u.kind === "recap" ? "recap" : "intro";
    return { kind: u.kind, label: `Skipped ${what} · Undo`, undo: true };
  }
  const s = skipSegment();
  if (!s) return null;
  if (s.kind === "ed" && upNextCard()) return null;
  return { kind: s.kind, label: skipLabel(s.kind), undo: false };
});

/** The pill was pressed. */
export function skipPillPress() {
  if (untracked(skipUndo)) undoAutoSkip();
  else skipNow();
}

// --- Up next: the end of an episode -----------------------------------------------
//
// When an episode ends — or reaches its credits (AniSkip's "ed" segment in
// the second half) — and there is a next one:
//   autoplayNext on:  the Up next card counts autoplayCountdown() seconds,
//                     then plays it through nextEpisode()'s path (native: the
//                     link resolved ahead). Play now / Cancel; a pause, a seek
//                     back, a picker cancel it (→ the end card once it ended).
//   autoplayNext off: no countdown — once it ended, the end card (Next
//                     episode / Replay).
// Out of sight (the app in the background, picture in picture): it goes on
// at the end without a card. After AUTOPLAY_CHAIN_MAX autoplays in a row
// with no input in between, "Still watching?" (Continue) instead.
// Movies: nothing. Drawn by the controls (upNextCard) and, for desktop
// pages, by the page overlay (pushPageChrome).

export type UpAction = "now" | "cancel" | "replay" | "continue";
export type UpNextCardData = {
  mode: "count" | "end" | "still";
  title: string;
  /** "Next: S1 · E3 · Name" */
  line: string;
  still?: string;
  /** count: the part of the countdown gone (0..1); else null. */
  frac: number | null;
  /** count: seconds left. */
  left: number;
  primary: { label: string; id: UpAction };
  secondary: { label: string; id: UpAction } | null;
};
type NextInfo = { season?: number; episode: number; name?: string; still?: string };

/** Autoplays in a row without input before "Still watching?". */
export const AUTOPLAY_CHAIN_MAX = 3;
const upState = signal<{ mode: "count" | "end" | "still"; next: NextInfo; endsAt: number; total: number } | null>(null);
const upClock = signal(0);
let upTimer: ReturnType<typeof setInterval> | undefined;
/** The episode the flags below belong to. */
let upKey = "";
/** This episode's video ended (until it plays again). */
let upEnded = false;
/** The user cancelled (or interacted with) the countdown: none again for this episode. */
let upDismissed = false;
let upPending = false;
/** Autoplays since the last user input. */
let autoChain = 0;
/** The last report said the page is out of sight (web). */
let reportHidden = false;

/** The card for the controls / the page; null when none. */
export const upNextCard = computed<UpNextCardData | null>(() => {
  const s = upState();
  if (!s) return null;
  upClock();
  const r = playerRoute();
  if (!r) return null;
  const n = s.next;
  const parts = [r.type === "tv" ? `S${n.season ?? r.season ?? 1}` : "", `E${n.episode}`, n.name ?? ""];
  const line = `Next: ${parts.filter(Boolean).join(" · ")}`;
  const still = n.still || undefined;
  if (s.mode === "still") {
    return { mode: "still", title: "Still watching?", line, still, frac: null, left: 0, primary: { label: "Continue", id: "continue" }, secondary: null };
  }
  if (s.mode === "end") {
    return {
      mode: "end",
      title: "Up next",
      line,
      still,
      frac: null,
      left: 0,
      primary: { label: "Next episode", id: "now" },
      secondary: { label: "Replay", id: "replay" },
    };
  }
  const ms = Math.max(0, s.endsAt - Date.now());
  const left = Math.ceil(ms / 1000);
  return {
    mode: "count",
    title: `Up next in ${left}`,
    line,
    still,
    frac: Math.max(0, Math.min(1, 1 - ms / (s.total * 1000))),
    left,
    primary: { label: "Play now", id: "now" },
    secondary: { label: "Cancel", id: "cancel" },
  };
});

/** In sight: the app is not in the background and the video not in PiP. */
function appVisible(): boolean {
  try {
    const f = lifecycle as unknown as (() => string) | undefined;
    if (typeof f === "function" && f() === "background") return false;
  } catch {}
  if (epochBackend === "native") return !untracked(nativePipActive);
  return !reportHidden;
}

/** Credits start (AniSkip "ed" in the second half), else null. */
function creditsStart(): number | null {
  const d = duration();
  if (!(d > 0)) return null;
  for (const s of skipSegs()) if (s.kind === "ed" && s.start > d * 0.5 && s.start < d) return s.start;
  return null;
}

function stopUpTimer() {
  if (upTimer) clearInterval(upTimer);
  upTimer = undefined;
}

function upClear() {
  stopUpTimer();
  if (untracked(upState)) upState.set(null);
  pushPageChrome();
}

/** A new episode (or leaving): no card, no flags. */
function upReset() {
  stopUpTimer();
  if (untracked(upState)) upState.set(null);
  upKey = "";
  upEnded = false;
  upDismissed = false;
  upPending = false;
  reportHidden = false;
}

function upShow(mode: "count" | "end" | "still", next: NextInfo) {
  const total = autoplayCountdown();
  stopUpTimer();
  upState.set({ mode, next, endsAt: Date.now() + total * 1000, total });
  debug("up next: card", { mode, next });
  if (mode === "count") {
    upTimer = setInterval(() => {
      const s = untracked(upState);
      if (!s || s.mode !== "count") return stopUpTimer();
      upClock.set(Date.now());
      if (Date.now() >= s.endsAt) advanceAuto();
      else pushPageChrome();
    }, 500);
  }
  pushPageChrome();
}

/** The next episode played by itself. */
function advanceAuto() {
  autoChain++;
  debug("up next: autoplay", { chain: autoChain });
  upClear();
  void nextEpisodeInner();
}

/** After every report and every second: the card's state for this episode. */
function driveUpNext(ended: boolean) {
  const r = playerRoute();
  if (!r || r.type === "movie" || !epochReady || playerPhase() === "failed") return;
  const key = routeKey(r);
  if (upKey !== key) {
    upReset();
    upKey = key;
  }
  const d = duration();
  const t = position();
  if (ended) upEnded = true;
  else if (upEnded && !mediaPaused() && d > 0 && t < d - 2) {
    // Playing again (Replay, a seek back): the end is over.
    upEnded = false;
    if (untracked(upState)?.mode !== "count") upClear();
  }
  const cs = creditsStart();
  const inCredits = cs !== null && t >= cs;
  const s = untracked(upState);
  if (!upEnded && !inCredits) {
    if (s) upClear();
    return;
  }
  if (s || upPending || !hasNextEpisode()) return;
  const want = (): "count" | "end" | "still" | "advance" | null => {
    if (autoplayNext() && !upDismissed) {
      if (autoChain >= AUTOPLAY_CHAIN_MAX) return upEnded ? "still" : null;
      if (!appVisible()) return upEnded ? "advance" : null;
      return "count";
    }
    return upEnded ? "end" : null;
  };
  const w = want();
  if (!w) return;
  if (w === "advance") {
    advanceAuto();
    return;
  }
  upPending = true;
  void nextEpisodeOf({ type: r.type, id: r.id, season: r.season, episode: r.episode }).then((n) => {
    upPending = false;
    const cur = playerRoute();
    if (!n || !cur || routeKey(cur) !== key || untracked(upState)) return;
    const w2 = want();
    if (w2 === "advance") advanceAuto();
    else if (w2) upShow(w2, n);
  });
}

/** A button of the card (the controls, or the page's `up:` action). */
export function upNextAction(a: UpAction) {
  const s = untracked(upState);
  debug("up next: action", a);
  if (a === "now") {
    noteUserInput();
    upClear();
    void nextEpisodeInner();
  } else if (a === "continue") {
    autoChain = 0;
    upClear();
    void nextEpisodeInner();
  } else if (a === "cancel") {
    noteUserInput();
    upDismissed = true;
    if (s && upEnded) upShow("end", s.next);
    else upClear();
  } else if (a === "replay") {
    noteUserInput();
    upDismissed = true;
    upEnded = false;
    upClear();
    seekAbs(0);
    playPlayback();
  }
}

/** The user paused, played, sought back or opened a picker: a running
 * countdown stops (the end card stays once the video ended). */
function upNextInteract(cancels: boolean) {
  if (!cancels) return;
  const s = untracked(upState);
  if (!s || s.mode !== "count") return;
  debug("up next: cancelled by input");
  upDismissed = true;
  if (upEnded) upShow("end", s.next);
  else upClear();
}

/** Any explicit input: the autoplay chain starts over. */
function noteUserInput() {
  autoChain = 0;
}

// --- Route helpers ------------------------------------------------------------

export function playerRoute(): PlayerRoute | null {
  const r = route();
  return r.name === "player" ? r : null;
}

/** Saves this title/episode's position — only once the current page's
 * video is playable and its resume/carry-over seek has landed. */
export function persist() {
  const r = playerRoute();
  if (!r || !canPersist()) return;
  noteWatched(r);
  void saveProgress({
    key: itemKey(r.type, r.id, r.season ?? 0, r.episode ?? 0),
    type: r.type,
    id: r.id,
    // Never a placeholder: the title the details gave when the route had
    // none, else what this entry was saved with before.
    title:
      playerTitle() ||
      realTitle(progress().find((p) => p.key === itemKey(r.type, r.id, r.season ?? 0, r.episode ?? 0))?.title),
    poster: r.poster ?? "",
    season: r.season,
    episode: r.episode,
    lang: r.lang,
    position: position(),
    duration: duration(),
    source: sourceFor(r.type),
  });
}

/** Title/episode keys announced as watched (≥ 95%) this session. */
const watchedKeys = new Set<string>();

function noteWatched(r: PlayerRoute) {
  const d = duration();
  if (!(d > 0) || position() / d < 0.95) return;
  const key = routeKey(r);
  if (watchedKeys.has(key)) return;
  watchedKeys.add(key);
  for (const fn of [...watchedFns]) {
    try {
      fn(r);
    } catch (e) {
      debug("watched listener threw", String(e));
    }
  }
}

/** The source actually used for `type`: this route's automatic fallback
 * if one is active, else the selected one when it supports the type,
 * else the first source that does (e.g. anime). */
export function sourceFor(type: MediaType): string {
  const o = sourceOverride();
  if (o && sourceSupports(o, type)) return o;
  const sel = sourceId();
  if (sourceSupports(sel, type)) return sel;
  return sourcesFor(type)[0]?.id ?? sel;
}

/** The source in use on the player route (the picker's checkmark). */
export const activeSource = computed(() => {
  const r = playerRoute();
  return r ? sourceFor(r.type) : sourceId();
});

export function playerUrl(): string | null {
  const r = playerRoute();
  if (!r) return null;
  // The terminal state shows no page (nothing keeps loading behind it);
  // Try again takes the page away for a moment to load it afresh.
  if (reloadBlank() || failState()) return null;
  // A completed download for this exact title/episode plays the local
  // file — no stream resolution, no network.
  const local = localPageFor(r);
  if (local) return local;
  // Local page being prepared (localhost server starting): no network
  // URL meanwhile — playback of a download must not need the network.
  if (local === "") return null;
  const sid = sourceFor(r.type);
  // Debug (`rustflix.failsources` / `rustflix.offline`): a forced failure
  // loads nothing.
  if (forcedFail(sid)) return `about:blank#${sid}`;
  const src = PLAYER_SOURCES.find((s) => s.id === sid);
  // Sources keyed on IMDb need the external id resolved first; until it
  // is, there is no URL (the screen shows a loading state).
  const overrideId =
    src?.idType === "imdb" && extKey() === `${r.type}:${r.id}` ? extId() : undefined;
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
    // Embeds that take a subtitle language preload that track for us.
    settings().myLanguages?.[0] || settings().subtitleLang || null,
  );
}

// --- External ids (IMDb for sources that key on it) ----------------------------

/** `${type}:${id}` → resolved IMDb id ("tt…"). */
const extIds = new Map<string, string>();
const extPending = new Map<string, Promise<void>>();
export const extId = signal("");
/** `${type}:${id}` the current extId belongs to. */
const extKey = signal("");
export const extLoading = signal(false);

/** Fetches the IMDb id for the current title when the chosen source
 * needs it. Safe to call on every player open — cached per title. */
export async function ensureExtId(r: PlayerRoute) {
  const src = PLAYER_SOURCES.find((s) => s.id === sourceFor(r.type));
  if (src?.idType !== "imdb" || r.type === "anime") {
    extId.set("");
    extLoading.set(false);
    return;
  }
  const key = `${r.type}:${r.id}`;
  const cached = extIds.get(key);
  if (cached) {
    extKey.set(key);
    extId.set(cached);
    extLoading.set(false);
    return;
  }
  extLoading.set(true);
  extKey.set(key);
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
  // The user may have moved on to another title while this resolved.
  const cur = playerRoute();
  if (!cur || `${cur.type}:${cur.id}` !== key) return;
  extKey.set(key);
  extId.set(extIds.get(key) ?? "");
  extLoading.set(false);
}

/** The user picks a source: it becomes the selection (`sourceId`), any
 * automatic override for this route is dropped, and playback continues
 * from the current position. */
export function pickSource(id: string) {
  const r = playerRoute();
  if (r && id !== sourceFor(r.type)) carryPosition();
  sourceOverride.set(null);
  // Picked on this play: honoured (not left automatically if it fails).
  pickedSource = id;
  triedSources.delete(id);
  if (nativeTried().includes(id)) nativeTried.set(nativeTried().filter((x) => x !== id));
  switchNotice.set("");
  if (playerPhase() === "failed") {
    failState.set(null);
    playerPhase.set("loading");
    epochUrl = undefined;
  }
  sourceId.set(id);
  showSources.set(false);
  if (!r) return;
  void ensureExtId(r).then(syncSrc);
  syncSrc();
}

// --- Media commands (messages into the page's bridge) -------------------------

export function togglePlay() {
  // A pause the user asked for does not count against any timer.
  userPaused = !mediaPaused();
  noteUserInput();
  upNextInteract(true);
  be().toggle();
}

export function pausePlayback() {
  userPaused = true;
  upNextInteract(true);
  be().pause();
}

export function playPlayback() {
  userPaused = false;
  be().play();
}

export function toggleMute() {
  be().toggleMute();
}

/** Relative seek, clamped to 0..duration (page-side too). The seek step
 * of the buttons and keys is `seekStep()` (`seekBack()` / `seekForward()`). */
export function seekBy(sec: number) {
  noteUserInput();
  upNextInteract(sec < 0);
  const d = duration();
  const to = Math.max(0, position() + sec);
  position.set(d > 0 ? Math.min(d, to) : to);
  // The user chose a position: a pending resume must not override it.
  resumeTarget = null;
  resumeFloor = null;
  be().seekBy(sec);
}

/** Native fullscreen (iOS: AVPlayerViewController — landscape + system
 * controls). Reports keep arriving through `mediaFullscreen`. */
export function enterFullscreen() {
  // Android: the player's window goes landscape + immersive (and back):
  // sys.playerWindow. NSH's WebView shows no custom (fullscreen) view, so
  // the page's own full screen would turn the video black.
  if (process.platform === "android") return togglePlayerFullscreen();
  if (epochBackend === "native") return nativeFullscreen("enter");
  fsAskedAt = Date.now();
  web.fullscreen("enter");
}

export function exitFullscreen() {
  if (epochBackend === "native") return nativeFullscreen("exit");
  web.fullscreen("exit");
}

/** The app's player: the desktop window goes full screen (Player.tsx,
 * the "fullscreen" page action); a phone component with its own full
 * screen (iOS, when it reports one) takes the command. */
function nativeFullscreen(mode: "enter" | "exit" | "toggle") {
  if (DESKTOP) {
    emitPageAction("fullscreen");
    return;
  }
  nativeBackend.fullscreen(mode);
}

/** Enters native fullscreen, or leaves it when the video is in it. */
export function toggleFullscreen() {
  if (process.platform === "android") return togglePlayerFullscreen(); // see enterFullscreen
  if (epochBackend === "native") return nativeFullscreen("toggle");
  fsAskedAt = Date.now();
  web.fullscreen("toggle");
}

/** Absolute seek to `sec` seconds — applied at once when the video can
 * seek, else as soon as it can, so it is safe before playback starts. */
export function seekTo(sec: number) {
  noteUserInput();
  upNextInteract(sec < position() - 1);
  seekAbs(sec);
}

/** seekTo without counting as user input (automatic skips, Replay). */
function seekAbs(sec: number) {
  const p = Math.max(0, sec);
  position.set(p);
  resumeTarget = null;
  resumeFloor = null;
  be().seek(p);
}

/** Sets `video.volume` to `v`, clamped to 0..1. (iPhone pages cannot
 * change volume; the hardware buttons own it.) */
export function setVolumeTo(v: number) {
  const nv = Math.max(0, Math.min(1, v));
  mediaVolume.set(nv);
  volSetAt = Date.now();
  be().setVolume(nv);
}

/** Changes the volume by `delta` from the last value set or reported. */
export function volumeBy(delta: number) {
  setVolumeTo(mediaVolume() + delta);
}

/** true: the picture covers the whole view (cropping); false: contain. */
export function setFill(fill: boolean) {
  mediaFill.set(fill);
  be().fit(fill);
}

export function toggleFill() {
  setFill(!mediaFill());
}

/** Picture-in-picture, where `pipSupported()` — or leaves it if the
 * video is already in PiP. Ignored unless the video is playable
 * (readyState ≥ 2) and the phase is playing/paused/stalled. */
export function enterPip() {
  const ph = playerPhase();
  if (!(ph === "playing" || ph === "paused" || ph === "stalled") || lastRs < 2) {
    debug("pip: ignored, video not playable", { phase: ph, rs: lastRs });
    return;
  }
  // Android: WebView has no element PiP; the activity goes into PiP
  // (android/…/Pip.java), the player's video filling its window.
  if (ANDROID_PIP) {
    void host.call("sys.pip", {}).catch(() => {});
    return;
  }
  be().pip();
}

// --- Android picture-in-picture (activity-level, Pip.java) -------------------
//
// WebView reports no element PiP, so the button is driven by the host: it
// is shown whenever the player can play; the host is told play/pause (its
// remote actions, auto-enter on Home) and sends the actions back.

const ANDROID_PIP = (() => {
  try {
    return process.platform === "android" && host.available();
  } catch {
    return false;
  }
})();

function androidPipState(paused: boolean) {
  void host.call("sys.pipState", { paused }).catch(() => {});
}

if (ANDROID_PIP) {
  try {
    host.on("sys.pipAction", (d: unknown) => {
      const a = (d as { a?: unknown } | null)?.a;
      if (a === "toggle") togglePlay();
      else if (a === "pause") pausePlayback();
      else if (a === "back") seekBack();
      else if (a === "fwd") seekForward();
    });
  } catch {}
}

/** While on, plays at 2x (exempt from the bridge's rate snapping); off
 * restores the previous rate. Not remembered as the saved speed. */
export function holdRate(on: boolean) {
  if (on === rateHeld()) return;
  rateHeld.set(on);
  be().hold(on);
}

/** Turns the in-page Cinema overlay (and the page-side key handling)
 * on or off. On desktop it is turned on automatically once the page has
 * a video and off on leave; `pageControlsActive` says whether the page
 * has actually built it. Not for phones (they have the native overlay). */
export function setPageControls(on: boolean) {
  web.pageControls(on);
  if (on) {
    lastChromeSig = "";
    lastPanelSig = "";
    pushPageChrome();
  } else {
    pageControlsActive.set(false);
  }
}

/** Shows or hides the in-page source picker modal (desktop: GPUI cannot
 * draw over the web view, so the picker lives in the page like the
 * control bar). `items` are the sources for the current title type. */
export function setSourcesModal(
  on: boolean,
  items: { id: string; label: string; note?: string; warn?: boolean }[],
  active?: string,
) {
  web.sourcesModal(on, items, active);
}

/** Sets the speed and remembers it for the next videos (`remember`
 * false — the autotest's `rate:` action — or `rememberSpeed()` off: this
 * video only). */
export function setRate(rate: number, remember = true) {
  mediaRate.set(rate);
  be().setRate(rate);
  if (remember && rememberSpeed() && settings().playbackRate !== rate) void saveSettings({ playbackRate: rate });
}

// --- Subtitles + audio ----------------------------------------------------------
//
// The page never draws captions natively: the bridge renders them in
// its own layer from either an embedded text track (kept "hidden") or
// cues downloaded here (online providers, app/lib/subtitles.ts). The
// app owns the model: options, the current pick, auto-pick, offset.

setSubtitleDebug(debug);
setSubtitleNotify((text) => notify(text, "error"));

/** One subtitle choice. `lang`: lowercase ISO 639-1 ("" unknown). */
export type SubOption = { id: string; label: string; lang: string; origin: "video" | "online"; mine: boolean };
/** One audio choice. */
export type AudioOption = { id: string; label: string; lang: string };

const pageAudio = signal<{ i: number; label: string; lang: string; on: boolean }[]>([]);
let lastAudSig = "";
const onlineResults = signal<SubResult[]>([]);
const subSearch = signal<"idle" | "searching" | "done" | "error">("idle");
const curSub = signal<string | null>(null);
const subOffset = signal(0);
const artUrl = signal<string | null>(null);
/** The title's original language; null until known ("" = unknown). */
const origLang = signal<string | null>(null);

/** "idle" | "searching" (online search or a download in progress) |
 * "done" | "error". */
export const subtitleSearch: Accessor<"idle" | "searching" | "done" | "error"> = subSearch;
/** The current subtitle option id; null = Off. */
export const currentSubtitle: Accessor<string | null> = curSub;
/** Caption timing shift in seconds (+ = later), per title/episode. */
export const subtitleOffset: Accessor<number> = subOffset;
/** A wide backdrop for the title in the player (loading screen). */
export const loadingArt: Accessor<string | null> = artUrl;

/** What the current pick is, to find it again when the list changes. */
let curMeta: { origin: "video" | "online"; lang: string; label: string; url?: string } | null = null;
/** The user picked explicitly on this title/episode: no auto-pick. */
let userPicked = false;
/** toggleSubs found nothing yet: turn the best match on once found. */
let wantSubsOn = false;
/** Title/episode key the online results / search belong to. */
let searchKey = "";
const searchCache = new Map<string, SubResult[]>();
/** Online files that failed to load (never auto-picked again). */
const failedOnline = new Set<string>();
/** Cues loaded for the current online pick. */
let extCues: { url: string; cues: Cue[] } | null = null;
let selToken = 0;
let captionLift = false;
/** Page documents that got the caption state. */
const capDocs = new Set<string>();
/** When this epoch's video first became playable (auto-search waits ~3 s
 * for late text tracks). */
let subsReadyAt = 0;
let lastPanelSig = "";
/** Anime audio switch: the position to continue from on the new route. */
let audioCarry: { key: string; pos: number } | null = null;
/** Subtitles saved with the download being played (an "online" option
 * whose cues are already here), and its cues. */
let offlineSub: SubResult | null = null;
let offlineCues: Cue[] | null = null;

/** Sets the online options: the downloaded subtitle (if any) first. The
 * current online pick keeps pointing at the same file. */
function setOnlineResults(list: SubResult[]) {
  const off = offlineSub;
  const full = off ? [off, ...list.filter((x) => x.url !== off.url)] : list;
  const cur = curSub();
  const curUrl = cur && cur.startsWith("o:") ? onlineResults()[Number(cur.slice(2))]?.url : null;
  onlineResults.set(full);
  if (curUrl) {
    const i = full.findIndex((x) => x.url === curUrl);
    if (i >= 0 && `o:${i}` !== cur) curSub.set(`o:${i}`);
  }
}

/** Local playback: offer the subtitle saved with the download
 * ("English · downloaded"); auto-pick then follows the usual rules. */
function loadOfflineSubtitle(r: PlayerRoute) {
  const hooks = dlHooks;
  if (!hooks) return;
  const key = routeKey(r);
  let p: Promise<{ lang: string; cues: Cue[] } | null>;
  try {
    p = hooks.offlineSubtitles(r);
  } catch {
    return;
  }
  void p.then(
    (sub) => {
      const cur = playerRoute();
      if (!sub || !sub.cues.length || !cur || routeKey(cur) !== key) return;
      offlineCues = sub.cues;
      offlineSub = {
        lang: sub.lang,
        label: `${languageName(sub.lang) || "Subtitles"} · downloaded`,
        url: `downloaded:${key}`,
        format: "srt",
        provider: "downloaded",
      };
      setOnlineResults(onlineResults().filter((x) => x.provider !== "downloaded"));
      subtitleReconcile();
      pushPanel();
    },
    () => {},
  );
}

function routeKey(r: PlayerRoute): string {
  return itemKey(r.type, r.id, r.season ?? 0, r.episode ?? 0);
}

/** Subtitle-like tracks of the page video (not chapters/metadata). */
function videoSubTracks(): PageTrack[] {
  // A platform whose player cannot draw the stream's own subtitles (macOS
  // for now, `sys.nativeVideoInfo {embeddedSubtitles:false}`): none offered.
  if (epochBackend === "native" && nativeInfo().embeddedSubtitles === false) return [];
  return subTracks().filter((t) => !t.kind || t.kind === "subtitles" || t.kind === "captions");
}

/** Options from page tracks + online results: "my languages" first in
 * the user's order, then the rest A–Z; embedded before online within a
 * language; repeated labels of one origin suffixed ("English 2"). */
export function buildSubOptions(tracks: PageTrack[], online: SubResult[], mine: string[]): SubOption[] {
  type Row = SubOption & { ord: number };
  const rows: Row[] = [];
  const counts = new Map<string, number>();
  const suffix = (origin: string, label: string) => {
    const k = `${origin}|${label}`;
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    return n > 1 ? `${label} ${n}` : label;
  };
  tracks.forEach((t, ord) => {
    const raw = t.raw ?? t.label ?? "";
    const pl = parseLang(raw);
    const pa = parseLang(t.lang ?? "");
    const code = pa.code || pl.code;
    const region = pl.region || pa.region;
    const base = cleanLangLabel(raw || t.lang || t.label || "", code, region);
    rows.push({
      id: `v:${t.i}`,
      label: suffix("video", base === "Unknown" ? t.label || "Unknown" : base),
      lang: code,
      origin: "video",
      mine: !!code && mine.includes(code),
      ord,
    });
  });
  const seen = new Set<string>();
  online.forEach((r, i) => {
    if (seen.has(r.url)) return;
    seen.add(r.url);
    rows.push({
      id: `o:${i}`,
      label: suffix("online", r.label.replace(/\s+\d+$/, "")),
      lang: r.lang,
      origin: "online",
      mine: !!r.lang && mine.includes(r.lang),
      ord: tracks.length + i,
    });
  });
  const groupKey = (o: Row) => o.lang || `?${o.label}`;
  const groupName = new Map<string, string>();
  for (const o of rows) if (!groupName.has(groupKey(o))) groupName.set(groupKey(o), o.lang ? languageName(o.lang) : o.label);
  const rank = (o: Row) => (o.mine ? mine.indexOf(o.lang) : mine.length);
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.mine ? 0 : groupName.get(groupKey(a))!.localeCompare(groupName.get(groupKey(b))!)) ||
      (a.origin === b.origin ? 0 : a.origin === "video" ? -1 : 1) ||
      a.ord - b.ord,
  );
  return rows.map(({ ord: _o, ...o }) => o);
}

/** Every subtitle choice for the video in the player (Off is implied). */
export const subtitleOptions: Accessor<SubOption[]> = computed<SubOption[]>(() =>
  buildSubOptions(videoSubTracks(), onlineResults(), settings().myLanguages ?? []),
);

function bestFor(code: string, opts: SubOption[]): SubOption | undefined {
  return opts.find(
    (o) => o.lang === code && !(o.origin === "online" && failedOnline.has(onlineResults()[Number(o.id.slice(2))]?.url ?? "")),
  );
}

/** The best option in the user's languages, else the first one. */
function bestSubtitle(): SubOption | undefined {
  const opts = subtitleOptions();
  for (const c of settings().myLanguages ?? []) {
    const o = bestFor(c, opts);
    if (o) return o;
  }
  return opts[0];
}

/** What auto-pick wants now: an option id / null (Off), or "wait"
 * (original language unknown yet, or an online search should run first). */
export function autoSubtitleTarget(): { id: string | null } | { wait: true; search: boolean } {
  const st = settings();
  const opts = subtitleOptions();
  const r = playerRoute();
  const searched = !!r && searchKey === routeKey(r) && (subSearch() === "done" || subSearch() === "error");
  const mine = st.myLanguages ?? [];
  const choice = st.subtitleChoice || "auto";
  if (choice === "off") return { id: null };
  if (choice !== "auto") {
    const o = bestFor(choice, opts);
    if (o) return { id: o.id };
    if (!searched) return { wait: true, search: true };
  }
  if (!st.subtitleAuto) return { id: null };
  const orig = origLang();
  if (orig === null) return { wait: true, search: false };
  if (!orig || mine.includes(orig)) return { id: null };
  for (const c of mine) {
    const o = bestFor(c, opts);
    if (o && o.origin === "video") return { id: o.id };
  }
  if (!searched) return { wait: true, search: true };
  for (const c of mine) {
    const o = bestFor(c, opts);
    if (o) return { id: o.id };
  }
  return { id: null };
}

/** After each report / option change: auto-pick (until the user picks
 * on this title), and the online search when auto-pick needs it. */
function subtitleReconcile() {
  const r = playerRoute();
  if (!r) return;
  if (wantSubsOn && !curSub()) {
    const o = bestSubtitle();
    if (o) {
      wantSubsOn = false;
      selectSubtitle(o.id);
      return;
    }
  }
  if (userPicked) return;
  const t = autoSubtitleTarget();
  if ("wait" in t) {
    if (t.search && subsReadyAt && Date.now() - subsReadyAt >= 3000) ensureSubtitleSearch();
    return;
  }
  if (t.id !== curSub()) applySubtitle(t.id);
}

/** The video's track list changed: keep the current embedded pick on
 * the same track (its id may have moved). */
function remapSubtitle() {
  const m = curMeta;
  if (!m || m.origin !== "video") return;
  const opts = subtitleOptions();
  const cur = opts.find((o) => o.id === curSub());
  if (cur && cur.label === m.label && cur.lang === m.lang) return;
  const o = opts.find((x) => x.origin === "video" && x.label === m.label && x.lang === m.lang);
  if (o) curSub.set(o.id);
}

/** Pushes the loaded online cues in chunks (message-size limits). */
function pushExtCues() {
  const x = extCues;
  if (!x) return;
  be().captions.cues(x.url, x.cues);
}

function sendTrackPick(id: string) {
  const i = Number(id.slice(2));
  const t = videoSubTracks().find((x) => x.i === i);
  if (!t) return;
  be().captions.track(i, t.raw ?? t.label ?? "", t.lang ?? "");
}

/** Applies `id` (null = Off) without remembering it. */
function applySubtitle(id: string | null) {
  if (id === null) {
    selToken++;
    curSub.set(null);
    curMeta = null;
    extCues = null;
    be().captions.off();
    pushPanel();
    return;
  }
  const o = subtitleOptions().find((x) => x.id === id);
  if (!o) return;
  if (o.origin === "video") {
    selToken++;
    curSub.set(id);
    curMeta = { origin: "video", lang: o.lang, label: o.label };
    extCues = null;
    sendTrackPick(id);
    pushPanel();
    return;
  }
  const res = onlineResults()[Number(id.slice(2))];
  if (!res) return;
  const prev = curSub();
  const prevMeta = curMeta;
  const token = ++selToken;
  curSub.set(id);
  curMeta = { origin: "online", lang: o.lang, label: o.label, url: res.url };
  subSearch.set("searching");
  pushPanel();
  const cuesFor =
    res.provider === "downloaded" && offlineCues ? Promise.resolve(offlineCues) : loadCues(res);
  void cuesFor.then(
    (cues) => {
      if (token !== selToken) return;
      extCues = { url: res.url, cues };
      debug("subs: online cues loaded", { provider: res.provider, n: cues.length });
      pushExtCues();
      subSearch.set("done");
      pushPanel();
    },
    (e) => {
      if (token !== selToken) return;
      failedOnline.add(res.url);
      debug("subs: online load failed", { provider: res.provider, err: String(e instanceof Error ? e.message : e) });
      notify(`Couldn't load ${o.label} subtitles`, "error");
      subSearch.set("error");
      // Back to what was on before (an embedded track or Off).
      if (prevMeta && prevMeta.origin === "video" && prev) applySubtitle(prev);
      else applySubtitle(null);
    },
  );
}

/** The user picks a subtitle (null = Off). Remembered across titles as
 * "off" or the option's language. */
export function selectSubtitle(id: string | null): void {
  userPicked = true;
  wantSubsOn = false;
  const o = id === null ? null : subtitleOptions().find((x) => x.id === id);
  if (id !== null && !o) return;
  applySubtitle(id);
  const choice = id === null ? "off" : o!.lang || settings().subtitleChoice;
  const on = id !== null;
  if (settings().subtitleChoice !== choice || settings().subtitlesOn !== on) {
    void saveSettings({ subtitleChoice: choice, subtitlesOn: on });
  }
}

/** The user's subtitle languages, best first (search order). */
function subLangs(): string[] {
  const st = settings();
  return [...new Set([...(st.myLanguages ?? []), ...(/^[a-z]{2}$/.test(st.subtitleChoice) ? [st.subtitleChoice] : [])])];
}

/** Online results plus, on a native play, the subtitles the source's page
 * offered (captured by the resolver); the page player lists the page's
 * own text tracks instead, so nothing is doubled there. */
function withPage(list: SubResult[], r: PlayerRoute): SubResult[] {
  if (epochBackend !== "native") return list;
  return withPageSubtitles(list, pageSubKey(r.type, r.id, r.season, r.episode), subLangs());
}

// Late arrivals from the resolver (the page kept listing after the link).
onPageSubtitles((key) => {
  const r = playerRoute();
  if (!r || epochBackend !== "native" || pageSubKey(r.type, r.id, r.season, r.episode) !== key) return;
  if (searchKey !== routeKey(r) || subSearch() === "searching") return;
  setOnlineResults(withPage(searchCache.get(routeKey(r)) ?? onlineResults(), r));
  if (subSearch() !== "done") subSearch.set("done");
  subtitleReconcile();
  pushPanel();
});

/** Runs the online search for the title/episode in the player, once
 * (cached per title/episode); the user's languages are searched first.
 * Called when a subtitles panel opens and by auto-pick. */
export function ensureSubtitleSearch(): void {
  const r = playerRoute();
  if (!r) return;
  const key = routeKey(r);
  if (searchKey === key && subSearch() !== "idle") return;
  searchKey = key;
  const hit = searchCache.get(key);
  if (hit) {
    setOnlineResults(withPage(hit, r));
    subSearch.set("done");
    subtitleReconcile();
    pushPanel();
    return;
  }
  subSearch.set("searching");
  pushPanel();
  const st = settings();
  const langs = [...new Set([...(st.myLanguages ?? []), ...(/^[a-z]{2}$/.test(st.subtitleChoice) ? [st.subtitleChoice] : [])])];
  void searchSubtitles({
    type: r.type,
    tmdbId: r.id,
    imdbId: r.type === "anime" ? undefined : extIds.get(`${r.type}:${r.id}`),
    season: r.type === "tv" ? (r.season ?? 1) : undefined,
    episode: r.type === "movie" ? undefined : (r.episode ?? 1),
    langs,
  }).then(
    (list) => {
      searchCache.set(key, list);
      const cur = playerRoute();
      if (!cur || routeKey(cur) !== key || searchKey !== key) return;
      debug("subs: search done", { n: list.length, langs: [...new Set(list.map((x) => x.lang))].slice(0, 40) });
      setOnlineResults(withPage(list, cur));
      subSearch.set("done");
      subtitleReconcile();
      pushPanel();
    },
    (e) => {
      const cur = playerRoute();
      if (!cur || routeKey(cur) !== key || searchKey !== key) return;
      debug("subs: search failed", String(e instanceof Error ? e.message : e));
      // The source's own subtitles still count (native plays).
      const own = withPage([], cur);
      if (own.length) {
        setOnlineResults(own);
        subSearch.set("done");
        subtitleReconcile();
        pushPanel();
        return;
      }
      subSearch.set("error");
      subtitleReconcile();
      pushPanel();
    },
  );
}

/** Shifts the captions by `deltaSec` (+ = later), clamped to ±15 s. */
export function nudgeSubtitle(deltaSec: number): void {
  const v = Math.max(-15, Math.min(15, Math.round((subOffset() + deltaSec) * 10) / 10));
  subOffset.set(v);
  be().captions.config({ offset: v });
  pushPanel();
}

export function resetSubtitleOffset(): void {
  subOffset.set(0);
  be().captions.config({ offset: 0 });
  pushPanel();
}

/** Caption size; remembered (`settings().subtitleSize`). */
export function setSubtitleSize(size: "s" | "m" | "l"): void {
  be().captions.config({ size });
  if (settings().subtitleSize !== size) void saveSettings({ subtitleSize: size });
  pushPanel();
}

/** Phones: the native controls showed/hid — captions rise above them. */
export function setCaptionLift(controlsVisible: boolean): void {
  if (captionLift === controlsVisible) return;
  captionLift = controlsVisible;
  be().captions.config({ lift: controlsVisible });
}

/** A page document reported for the first time: give it the caption
 * state (size, offset, lift, the current pick). */
function ensureCaptionDoc(doc: string) {
  if (capDocs.has(doc)) return;
  if (capDocs.size > 50) capDocs.clear();
  capDocs.add(doc);
  be().captions.config({ size: settings().subtitleSize ?? "m", offset: subOffset(), lift: captionLift });
  const id = curSub();
  if (!id) return;
  if (id.startsWith("v:")) sendTrackPick(id);
  else if (extCues) pushExtCues();
}

/** Subtitles on: something is picked (embedded or online). */
export const subsOn = computed(() => curSub() !== null);

/** CC toggle for existing callers: Off ↔ the best match. */
export function toggleSubs() {
  if (curSub() !== null) {
    selectSubtitle(null);
    return;
  }
  const o = bestSubtitle();
  if (o) selectSubtitle(o.id);
  else {
    wantSubsOn = true;
    ensureSubtitleSearch();
  }
}

/** Legacy: `i` -1 = Off, else embedded track `i`. */
export function setTrack(i: number) {
  selectSubtitle(i < 0 ? null : `v:${i}`);
}

// Audio.

/** Audio choices: anime sub/dub (re-opens the episode), else the tracks
 * the page video exposes (`video.audioTracks`). */
export const audioOptions: Accessor<AudioOption[]> = computed<AudioOption[]>(() => {
  const r = playerRoute();
  if (r?.type === "anime") {
    return [
      { id: "sub", label: "Japanese (original)", lang: "ja" },
      { id: "dub", label: "English (dub)", lang: "en" },
    ];
  }
  const counts = new Map<string, number>();
  return pageAudio().map((a) => {
    const pl = parseLang(a.label);
    const pa = parseLang(a.lang);
    const code = pa.code || pl.code;
    let label = a.label || a.lang ? cleanLangLabel(a.label || a.lang, code, pl.region || pa.region) : `Track ${a.i + 1}`;
    const n = (counts.get(label) ?? 0) + 1;
    counts.set(label, n);
    if (n > 1) label = `${label} ${n}`;
    return { id: `a:${a.i}`, label, lang: code };
  });
});

export const currentAudio: Accessor<string | null> = computed<string | null>(() => {
  const r = playerRoute();
  if (r?.type === "anime") return r.lang ?? "sub";
  const on = pageAudio().find((a) => a.on);
  return on ? `a:${on.i}` : null;
});

/** A sentence for the panel when there is nothing to choose. */
export const audioHint: Accessor<string | null> = computed<string | null>(() => {
  const o = audioOptions();
  if (o.length > 1) return null;
  const l = o[0]?.lang;
  return l ? `This source has one audio track (${languageName(l)}).` : "This source has one audio track.";
});

export function selectAudio(id: string): void {
  const r = playerRoute();
  if (!r) return;
  // A pick by hand: the preferred language leaves this title alone for
  // the rest of the session.
  manualAudio.add(`${r.type}:${r.id}`);
  noteUserInput();
  if (r.type === "anime") {
    if ((id !== "sub" && id !== "dub") || id === (r.lang ?? "sub")) return;
    animeLangPicked.add(r.id);
    audioCarry = { key: routeKey(r), pos: Math.max(resumeTarget ?? position(), resumeFloor ?? 0) };
    persist();
    // Same rule as playEpisode: the player entry is replaced.
    navigate({ ...r, lang: id, next: undefined }, { replace: true });
    return;
  }
  const m = /^a:(\d+)$/.exec(id);
  if (!m) return;
  applyAudio(Number(m[1]));
}

function applyAudio(i: number) {
  pageAudio.set(pageAudio().map((a) => ({ ...a, on: a.i === i })));
  be().selectAudio(i);
  pushPanel();
}

// Preferred audio language (`preferredAudio()`): once per video, the
// track in that language when the video has several — unless the user
// picked a track by hand for this title in this session. Anime picks its
// Sub/Dub route instead (animeLangFor, at the start of a play).

/** `${type}:${id}` of titles whose audio the user picked by hand. */
const manualAudio = new Set<string>();
/** `${routeKey}|${doc}` the preference was applied to. */
let audioPrefDone = "";

/** The preferred language as an ISO 639-1 code ("" for none). */
function preferredAudioCode(): string {
  const p = preferredAudio();
  if (!p) return "";
  return parseLang(p).code || p;
}

/** A reported audio track's language code ("" unknown). */
function audioLangCode(a: { label: string; lang: string }): string {
  return parseLang(a.lang).code || parseLang(a.label).code;
}

function maybePreferAudio(doc: string) {
  const pref = preferredAudioCode();
  if (!pref) return;
  const r = playerRoute();
  if (!r || r.type === "anime" || manualAudio.has(`${r.type}:${r.id}`)) return;
  const list = pageAudio();
  if (list.length < 2) return;
  const key = `${routeKey(r)}|${doc}`;
  if (audioPrefDone === key) return;
  audioPrefDone = key;
  const hit = list.find((a) => audioLangCode(a) === pref);
  debug("audio: preferred", { pref, hit: hit?.i ?? null, tracks: list.length });
  if (hit && !hit.on) applyAudio(hit.i);
}

/** Anime titles the user switched Sub/Dub for in this session, and those
 * whose automatic dub found no source. */
const animeLangPicked = new Set<number>();

/** The Sub/Dub the preferred audio asks for: "ja" → sub, "en" → dub (the
 * only dub the sources carry); null for no preference or another language. */
export function preferredAnimeLang(): "sub" | "dub" | null {
  const p = preferredAudioCode();
  return p === "ja" ? "sub" : p === "en" ? "dub" : null;
}

/** The dub route a play should switch to by itself, else null. Only from
 * the default ("sub" / none, what the title page passes untouched) to the
 * dub — a dub route is always someone's choice — and never when the
 * user switched this title in the player this session or watched it with
 * a saved Sub/Dub before (Continue Watching carries that). */
function animeLangFor(r: PlayerRoute): "dub" | null {
  if (r.type !== "anime" || (r.lang ?? "sub") !== "sub" || preferredAnimeLang() !== "dub") return null;
  if (animeLangPicked.has(r.id)) return null;
  if (progress().some((p) => p.type === "anime" && p.id === r.id && p.lang)) return null;
  return "dub";
}
/** The route of this play was switched to the dub by itself. */
let autoDubKey = "";

/** "Find another source": opens the sources picker. */
export function findAudioSource(): void {
  showSources.set(true);
}

// Title metadata: original language (auto-pick) and the loading artwork.

const titleMeta = new Map<string, { orig: string; art: string; name: string }>();

/** A title the route did not carry (or carried as an old placeholder),
 * from the title's details: `${type}:${id}` → name. */
const metaName = signal<{ key: string; name: string } | null>(null);

/** A real title, not a placeholder an older build saved ("Untitled"). */
function realTitle(t: string | null | undefined): string {
  const v = (t ?? "").trim();
  return v && v !== "Untitled" && v !== "Unknown" ? v : "";
}

/** The playing title's name: the route's, else the one its details gave;
 * "" until known (never a placeholder). */
export const playerTitle = computed(() => {
  const r = playerRoute();
  if (!r) return "";
  const own = realTitle(r.title);
  if (own) return own;
  const m = metaName();
  return m && m.key === `${r.type}:${r.id}` ? m.name : "";
});

function ensureTitleMeta(r: PlayerRoute) {
  const mk = `${r.type}:${r.id}`;
  if (r.type === "anime") origLang.set(r.lang === "dub" ? "en" : "ja");
  const hit = titleMeta.get(mk);
  if (hit) {
    if (r.type !== "anime") origLang.set(hit.orig);
    artUrl.set(hit.art || r.poster || null);
    if (hit.name) metaName.set({ key: mk, name: hit.name });
    return;
  }
  artUrl.set(r.poster || null);
  void (async () => {
    let orig = "";
    let art = "";
    let name = "";
    try {
      if (r.type === "anime") {
        const m = await aniDetails(r.id);
        art = m.bannerImage || m.coverImage?.extraLarge || m.coverImage?.large || "";
        name = m.title?.english || m.title?.romaji || "";
      } else {
        const d = r.type === "movie" ? await movieDetails(r.id) : await tvDetails(r.id);
        orig = (d.original_language || "").toLowerCase();
        art = imgUrl(d.backdrop_path, "w1280");
        name = d.title || d.name || d.original_title || d.original_name || "";
      }
      titleMeta.set(mk, { orig, art, name });
    } catch (e) {
      debug("subs: title details failed", String(e instanceof Error ? e.message : e));
    }
    const cur = playerRoute();
    if (!cur || `${cur.type}:${cur.id}` !== mk) return;
    if (name) metaName.set({ key: mk, name });
    if (cur.type !== "anime") origLang.set(orig);
    if (art) artUrl.set(art);
    subtitleReconcile();
    pushPageChrome();
  })();
}

function resetSubtitleState() {
  selToken++;
  curSub.set(null);
  curMeta = null;
  extCues = null;
  userPicked = false;
  wantSubsOn = false;
  offlineSub = null;
  offlineCues = null;
  onlineResults.set([]);
  subSearch.set("idle");
  searchKey = "";
  subOffset.set(0);
  pageAudio.set([]);
  lastAudSig = "";
  capDocs.clear();
  subsReadyAt = 0;
  origLang.set(null);
  lastPanelSig = "";
}

/** Desktop: the in-page Audio & Subtitles panel's data, when it changed. */
function pushPanel() {
  if (!DESKTOP || !playerRoute() || epochBackend !== "web") return;
  const st = {
    aud: audioOptions().map((a) => ({ id: a.id, label: a.label })),
    ca: currentAudio(),
    hint: audioOptions().length <= 1 ? audioHint() : null,
    subs: subtitleOptions().map((o) => ({ id: o.id, label: o.label, mine: o.mine, online: o.origin === "online" })),
    cs: curSub(),
    srch: subSearch(),
  };
  const sig = JSON.stringify(st);
  if (sig === lastPanelSig) return;
  lastPanelSig = sig;
  web.panel(st);
}

// --- Downloads: the playing page's links + legacy entry points ---------------
//
// The queue lives in lib/downloads.ts (registered through
// registerDownloadEngine). The player keeps what only it knows: the media
// URLs the playing page fetched. The GPUI WebView has no request
// interception, so the bridge records m3u8/mp4 URLs and their headers
// from fetch/XHR/resource timing and hands them over on demand
// (`{t:"streams"}` -> `{t:-2, streams, hdrs, ua, doc}`).

/** The embedding app's channel is up: its native downloader (`dl.*`) is
 * there (the iPhone app, the desktop shell). */
let dlHostUp = false;
try {
  dlHostUp = host.available();
} catch {}

/** Route key, page document and time of the stored stream links. */
let streamKey = "";
let streamDoc = "";
let streamAt = 0;

/** Forgets the playing page's links: on every new page document and
 * every new epoch (episode/source change), so a link of the page before
 * can never be downloaded under the new name. */
function clearStreams() {
  sniffed = new CandidateSet();
  sniffKey = "";
  sniffAt = 0;
  streamKey = "";
  streamDoc = "";
  streamAt = 0;
  if (streamUrls().length) streamUrls.set([]);
  if (Object.keys(streamHeaders()).length) streamHeaders.set({});
}

function onStreamsReply(v: { streams?: unknown; hdrs?: unknown; ua?: unknown; doc?: unknown }) {
  const r = playerRoute();
  if (!r) return;
  const doc = typeof v.doc === "string" ? v.doc : "";
  // A late answer from the page of an earlier epoch.
  if (doc && isStaleDoc(doc)) return;
  const list = Array.isArray(v.streams)
    ? v.streams.filter((s: unknown): s is string => typeof s === "string")
    : [];
  streamUrls.set(list);
  streamHeaders.set(
    v.hdrs && typeof v.hdrs === "object" ? (v.hdrs as Record<string, Record<string, string>>) : {},
  );
  if (typeof v.ua === "string" && v.ua) streamUA.set(v.ua);
  streamKey = routeKey(r);
  streamDoc = doc;
  streamAt = Date.now();
  const link = currentStreamLink();
  if (!link) return;
  // The page exposed its stream: the source resolves (the app's player
  // can take it next time).
  if (nativeEnabled() === true) noteNativeResult(link.source, true);
  emitStreamLink(link);
}

/** Media requests the page's frames made (`{t:-11}`), this epoch. */
let sniffed = new CandidateSet();
let sniffKey = "";
let sniffAt = 0;

function onSniff(v: { m?: unknown; doc?: unknown }) {
  const r = playerRoute();
  if (!r || epochBackend !== "web") return;
  if (typeof v.doc === "string" && v.doc && isStaleDoc(v.doc)) return;
  const m = v.m && typeof v.m === "object" ? (v.m as Record<string, unknown>) : null;
  if (!m) return;
  const c = sniffed.addSniff(m);
  if (!c || c.format === "dash") return;
  sniffKey = routeKey(r);
  sniffAt = Date.now();
  if (nativeEnabled() === true) noteNativeResult(sourceFor(r.type), true);
  const link = currentStreamLink();
  if (link) emitStreamLink(link);
}

/** The best link the sniffer saw (when the top bridge has none). */
function sniffedLink(r: PlayerRoute, maxAgeMs: number): StreamLink | null {
  if (!sniffAt || sniffKey !== routeKey(r) || Date.now() - sniffAt > maxAgeMs) return null;
  const best: StreamCandidate | undefined = sniffed.ranked().find((c) => c.format !== "dash");
  if (!best) return null;
  const headers = headersFor(best, streamUA() || RESOLVER_FALLBACK_UA);
  if (best.frameCookies && sameSite(best.frameOrigin, best.url) && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers["Cookie"] = best.frameCookies;
  return {
    url: best.url,
    kind: best.format === "hls" ? "hls" : "file",
    headers,
    ua: headers["User-Agent"] ?? streamUA(),
    key: sniffKey,
    route: { type: r.type, id: r.id, season: r.season, episode: r.episode, lang: r.lang },
    doc: streamDoc,
    source: sourceFor(r.type),
    at: sniffAt,
  };
}
const RESOLVER_FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

function emitStreamLink(link: StreamLink) {
  for (const fn of [...streamLinkFns]) {
    try {
      fn(link);
    } catch (e) {
      debug("download: stream link listener threw", String(e));
    }
  }
}

/** The playing page's usable link (HLS playlist or mp4) for the route in
 * the player — never one of an earlier page or episode, never a local
 * file, never older than `maxAgeMs`. */
export function currentStreamLink(maxAgeMs = 10 * 60_000): StreamLink | null {
  const r = playerRoute();
  if (r && epochBackend === "native") return nativeStreamLink(r, maxAgeMs);
  if (!r) return null;
  if (isLocalUrl(epochUrl) || isLocalUrl(playerUrl())) return null;
  const bridgeOk =
    !!streamAt && streamKey === routeKey(r) && Date.now() - streamAt <= maxAgeMs && !(streamDoc && isStaleDoc(streamDoc));
  const url = bridgeOk ? bestStreamUrl() : null;
  if (!url) return sniffedLink(r, maxAgeMs);
  const headers = streamHeaderMap(url);
  const ua =
    Object.entries(headers).find(([k]) => k.toLowerCase() === "user-agent")?.[1] ?? streamUA();
  return {
    url,
    kind: /\.m3u8(\?|#|$)/i.test(url) ? "hls" : "file",
    headers,
    ua,
    key: streamKey,
    route: { type: r.type, id: r.id, season: r.season, episode: r.episode, lang: r.lang },
    doc: streamDoc,
    source: sourceFor(r.type),
    at: streamAt,
  };
}

/** Asks the page for its fetched media URLs and stores the answer. */
export function refreshStreams() {
  if (epochBackend === "native") {
    // The link is known: hand it to the listeners again.
    const l = currentStreamLink();
    if (l) emitStreamLink(l);
    return;
  }
  web.requestStreams();
}

/** Blocks (or unblocks) every key inside the player page while an app
 * overlay owns the keyboard — the native web view keeps first responder
 * and would otherwise act on the same keystrokes. */
export function setPageKeysBlocked(on: boolean) {
  web.keysBlocked(on);
}

/** Best download candidate among the page's links: an HLS playlist, else
 * a progressive mp4 (segments and local files never count). */
export function bestStreamUrl(): string | null {
  const list = streamUrls().filter((u) => /^https?:/i.test(u) && !isLocalUrl(u));
  return (
    list.find((u) => /\.m3u8(\?|#|$)/i.test(u)) ??
    list.find((u) => /\.mp4(\?|#|$)/i.test(u)) ??
    null
  );
}

/** Deprecated: use `downloadCurrent()` from lib/downloads.ts. */
export function startDownload() {
  if (!dlHooks) {
    notify("Downloads aren't ready yet", "error");
    return;
  }
  dlHooks.downloadCurrent();
}

/** Downloads go through the embedding app's native downloader (`dl.*`:
 * built into the desktop shell, DownloadManager on the iPhone, the
 * desktop's Rust downloader over JNI on Android), so they need that app —
 * not a bare NSH host. */
export function canDownload(): boolean {
  return dlHostUp;
}

/** HOME: `process.env` only exposes the variables capabilities.process.env
 * grants (HOME is not one), so lib/downloads.ts stores the one the host
 * reports (`dl.options`) here. */
let shellHome = "";
export function setHomeDir(home: string) {
  shellHome = home;
}

export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || shellHome || "";
}

/** Default download folder per OS — persistent, never a temp dir. */
export function defaultDownloadDir(): string {
  const sep = process.platform === "windows" ? "\\" : "/";
  return `${homeDir()}${sep}Downloads${sep}rustflix`;
}

/** Stream CDNs reject bare requests; the page bridge captured the headers
 * it used per stream URL. Forward them plus the embed origin as Referer
 * and a browser UA — the native downloader (`dl.start {headers}`) sends
 * them with every request. */
export function streamHeaderMap(
  url: string,
  hdrs: Record<string, Record<string, string>> = streamHeaders(),
  page: string | null = playerUrl(),
  ua: string = streamUA(),
  /** Origin of the frame that requested `url` (the resolver's sniffer
   * knows it); the Referer falls back to it, not to the top page's. */
  frameOrigin?: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  const rawHdrs = hdrs[url] || {};
  for (const k in rawHdrs) {
    const v = String(rawHdrs[k]);
    if (v && !/[\r\n]/.test(v)) map[k] = v;
  }
  try {
    const origin = frameOrigin || (page ? new URL(page).origin : "");
    const hasRef = Object.keys(map).some((k) => k.toLowerCase() === "referer");
    if (origin && !hasRef) map["Referer"] = `${origin}/`;
    // Stream CDNs 403 anything that doesn't look like the browser that
    // fetched the playlist — the downloader's default UA gets rejected.
    if (!Object.keys(map).some((k) => k.toLowerCase() === "user-agent")) {
      map["User-Agent"] =
        ua ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    }
  } catch {}
  return map;
}

/** The local page for this route's finished download (lib/downloads.ts):
 * a URL, "" while it is being prepared, null when there is none. */
function localPageFor(r: PlayerRoute): string | null {
  try {
    return dlHooks ? dlHooks.localPage(r) : null;
  } catch {
    return null;
  }
}

/** Deprecated: `revealDownload(dlId)` from lib/downloads.ts. */
export function revealDownload(d: DownloadItem) {
  dlHooks?.reveal(d.id);
}

/** Deprecated: `removeDownload(dlId)` from lib/downloads.ts. */
export function removeDownload(d: DownloadItem) {
  void dlHooks?.remove(d.id);
}

/** Deprecated: `playDownload(dlId)` from lib/downloads.ts. */
export function playDownload(d: DownloadItem) {
  dlHooks?.play(d.id);
}

/** Deprecated: `cancelDownload(dlId)` from lib/downloads.ts. */
export function cancelDownload(id: number) {
  dlHooks?.cancel(id);
}

// --- Episodes -----------------------------------------------------------------

let loadedKey = "";
/** The in-flight (or last) loadEpisodes run. */
let episodesLoad: Promise<void> = Promise.resolve();
/** `${tvId}:${season}` → that season's episodes (TMDB). */
const seasonCache = new Map<string, EpisodeInfo[]>();

function toEpisodeInfo(season: number, e: Episode): EpisodeInfo {
  return {
    season,
    n: e.episode_number,
    name: e.name ?? "",
    still: e.still_path ? imgUrl(e.still_path, "w300") : undefined,
    overview: e.overview || undefined,
    runtime: typeof e.runtime === "number" && e.runtime > 0 ? e.runtime : undefined,
    airDate: e.air_date || undefined,
  };
}

/** Loads the episode list for the player's title/season (TV seasons and
 * episodes from TMDB, anime count from AniList). */
export function loadEpisodes(r: PlayerRoute): Promise<void> {
  const key = `${r.type}:${r.id}:${r.season ?? 0}`;
  if (key === loadedKey) return episodesLoad;
  loadedKey = key;
  episodes.set([]);
  seasons.set([]);
  episodesLoad = loadEpisodesInner(r, key);
  return episodesLoad;
}

/** No network (or the lookup failed): the downloaded episodes of the
 * title stand in, so offline playback still has names and a Next. */
function offlineEpisodeFallback(r: PlayerRoute, key: string) {
  if (loadedKey !== key) return;
  let off: { seasons: number[]; episodes: EpisodeInfo[] } | null = null;
  try {
    off = dlHooks ? dlHooks.offlineEpisodes(r) : null;
  } catch {}
  if (!off) return;
  if (!episodes().length && off.episodes.length) episodes.set(off.episodes);
  if (!seasons().length && off.seasons.length) seasons.set(off.seasons);
}

async function loadEpisodesInner(r: PlayerRoute, key: string) {
  if (r.type === "movie") return;
  try {
    await loadEpisodesOnline(r, key);
  } catch {}
  offlineEpisodeFallback(r, key);
}

async function loadEpisodesOnline(r: PlayerRoute, key: string) {
  if (r.type === "anime") {
    try {
      // Every aired episode, with its title, still, synopsis, air date and
      // runtime where known (lib/anilist.ts: the same data as the title
      // page). Never shorter than the episode being played.
      const [m, data] = await Promise.all([aniDetails(r.id), aniEpisodes(r.id)]);
      const n = aniEpisodeCount(m, data, r.episode ?? 1);
      if (loadedKey !== key) return;
      episodes.set(
        Array.from({ length: n }, (_, i) => {
          const e = data.episodes.get(i + 1);
          return {
            n: i + 1,
            // "" when unknown: the picker says "Episode N" itself, and the
            // player's line stays "E4" rather than "E4 · Episode 4".
            name: e?.title || "",
            still: e?.image || undefined,
            overview: e?.overview || undefined,
            runtime: e?.runtime ?? m.duration ?? undefined,
            airDate: e?.airDate || undefined,
          };
        }),
      );
    } catch {
      if (loadedKey === key) episodes.set([]);
    }
    return;
  }
  try {
    const d = await tvDetails(r.id);
    if (loadedKey !== key) return;
    seasons.set(
      (d.seasons ?? []).filter((s) => s.season_number > 0).map((s) => s.season_number),
    );
  } catch {}
  try {
    const season = r.season ?? 1;
    const d = await seasonDetails(r.id, season);
    const list = (d.episodes ?? []).map((e: Episode) => toEpisodeInfo(season, e));
    seasonCache.set(`${r.id}:${season}`, list);
    if (loadedKey === key) episodes.set(list);
  } catch {}
}

/** Another season's episodes of the title in the player, without
 * navigating (cached per title+season). Anime has a single list: it
 * resolves `episodes()` whatever the argument; movies resolve []. */
export async function browseSeason(season: number): Promise<EpisodeInfo[]> {
  const r = playerRoute();
  if (!r) throw new Error("No title is playing.");
  if (r.type === "movie") return [];
  if (r.type === "anime") {
    await episodesLoad;
    return episodes();
  }
  const key = `${r.id}:${season}`;
  const hit = seasonCache.get(key);
  if (hit) return hit;
  try {
    const d = await seasonDetails(r.id, season);
    const list = (d.episodes ?? []).map((e: Episode) => toEpisodeInfo(season, e));
    seasonCache.set(key, list);
    return list;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`Couldn't load season ${season}: ${why}`);
  }
}

/** Fraction (0..1) of that episode of the current title watched, from
 * saved progress; 1 once finished (≥95%); null when never started. */
export function episodeProgress(season: number | undefined, n: number): number | null {
  const r = playerRoute();
  if (!r || r.type === "movie") return null;
  const list = progress();
  const find = (s: number) => list.find((p) => p.key === itemKey(r.type, r.id, s, n));
  // Saved keys use the route's season, which may be absent (anime, or a
  // TV route opened without one = season 1).
  const p =
    r.type === "anime"
      ? find(r.season ?? 0)
      : (find(season ?? r.season ?? 1) ?? ((season ?? 1) === 1 ? find(0) : undefined));
  if (!p || !(p.duration > 0)) return null;
  const f = p.position / p.duration;
  if (f >= 0.95) return 1;
  return Math.max(0, Math.min(1, f));
}

function goTo(season: number | undefined, episode: number) {
  const r = playerRoute();
  if (!r) return;
  persist();
  // Episode hops replace the history entry: Back leaves the player
  // instead of walking through every episode watched.
  navigate({ ...r, season, episode, next: undefined }, { replace: true });
}

/** Plays episode `n` (of `season` for TV) of the current title,
 * replacing the player entry; title/poster/lang carry over. */
export function playEpisode(season: number | undefined, n: number) {
  const r = playerRoute();
  if (!r) return;
  noteUserInput();
  if (r.type === "anime") goTo(undefined, n);
  else if (r.type === "tv") goTo(season ?? r.season ?? 1, n);
}

export function goEpisode(n: number) {
  const r = playerRoute();
  if (!r) return;
  playEpisode(r.type === "tv" ? (r.season ?? 1) : undefined, n);
}

/** Next episode across seasons; does nothing at the end. (The user's
 * Next; the Up next countdown goes through nextEpisodeInner.) */
export async function nextEpisode() {
  noteUserInput();
  upClear();
  return nextEpisodeInner();
}

async function nextEpisodeInner() {
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

/** The episode after `t` (next in its season, else the first of the next
 * season; anime: the next number while the count allows), from the
 * episode data the player already has, fetching only what is missing.
 * Null at the end, for movies, for an episode not aired yet, or when
 * the lookup fails. */
export async function nextEpisodeOf(t: {
  type: MediaType;
  id: number;
  season?: number;
  episode?: number;
}): Promise<{ season?: number; episode: number; name?: string; still?: string } | null> {
  if (t.type === "movie") return null;
  const cur = t.episode ?? 1;
  const pr = playerRoute();
  const inPlayer = !!pr && pr.type === t.type && pr.id === t.id;
  if (t.type === "anime") {
    let eps = inPlayer ? episodes() : [];
    if (!eps.length) {
      try {
        const [m, data] = await Promise.all([aniDetails(t.id), aniEpisodes(t.id)]);
        // Aired episodes only (no fallback count: an unknown next is none).
        const next = m.nextAiringEpisode?.episode;
        const n = next && next > 1 ? next - 1 : (m.episodes ?? data.aired ?? 0);
        eps = Array.from({ length: n }, (_, i) => {
          const e = data.episodes.get(i + 1);
          return { n: i + 1, name: e?.title || "", still: e?.image || undefined };
        });
      } catch {
        return null;
      }
    }
    const i = eps.findIndex((e) => e.n === cur);
    if (i < 0 || i + 1 >= eps.length) return null;
    const nx = eps[i + 1];
    return { episode: nx.n, name: nx.name || undefined, still: nx.still };
  }
  const aired = (e: EpisodeInfo) => !e.airDate || Date.parse(e.airDate) <= Date.now();
  const seasonList = async (s: number): Promise<EpisodeInfo[]> => {
    const hit = seasonCache.get(`${t.id}:${s}`);
    if (hit) return hit;
    if (inPlayer && (pr!.season ?? 1) === s && episodes().length) return episodes();
    const d = await seasonDetails(t.id, s);
    const list = (d.episodes ?? []).map((e: Episode) => toEpisodeInfo(s, e));
    seasonCache.set(`${t.id}:${s}`, list);
    return list;
  };
  try {
    const season = t.season ?? 1;
    const list = await seasonList(season);
    const i = list.findIndex((e) => e.n === cur);
    if (i >= 0 && i + 1 < list.length) {
      const e = list[i + 1];
      return aired(e) ? { season, episode: e.n, name: e.name || undefined, still: e.still } : null;
    }
    let ss = inPlayer ? seasons() : [];
    if (!ss.length) {
      const d = await tvDetails(t.id);
      ss = (d.seasons ?? []).filter((x) => x.season_number > 0).map((x) => x.season_number);
    }
    const si = ss.indexOf(season);
    if (si < 0 || si + 1 >= ss.length) return null;
    const ns = ss[si + 1];
    const first = (await seasonList(ns))[0];
    if (!first || !aired(first)) return null;
    return { season: ns, episode: first.n, name: first.name || undefined, still: first.still };
  } catch {
    return null;
  }
}

/** Previous episode across seasons; does nothing at the start. */
export async function prevEpisode() {
  const r = playerRoute();
  if (!r || r.type === "movie") return;
  noteUserInput();
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
        checked: currentSubtitle() === null,
      },
    ];
    for (const o of subtitleOptions()) {
      items.push({
        id: `sub:${o.id}`,
        label: o.origin === "online" ? `${o.label} (online)` : o.label,
        group: "Subtitles",
        checked: currentSubtitle() === o.id,
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
    // Ids kept from the 10 s days; the step is the setting.
    { id: "ctl:back10", label: `Back ${seekStep()} seconds`, group: "Playback" },
    { id: "ctl:fwd10", label: `Forward ${seekStep()} seconds`, group: "Playback" },
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
    selectSubtitle(null);
    closePalette();
    return;
  }
  if (id.startsWith("sub:")) {
    selectSubtitle(id.slice(4));
    closePalette();
    return;
  }
  switch (id) {
    case "ctl:toggle":
      togglePlay();
      closePalette();
      break;
    case "ctl:back10":
      seekBack();
      closePalette();
      break;
    case "ctl:fwd10":
      seekForward();
      closePalette();
      break;
    case "ctl:speed":
      paletteView.set("speed");
      paletteQuery.set("");
      break;
    case "ctl:subs":
      paletteView.set("subs");
      paletteQuery.set("");
      ensureSubtitleSearch();
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

// The bindings use `when: "always"`, so they fire even while a text field
// is editing: left bound after the palette is gone, they swallow every
// keystroke in the app. Each handler therefore checks that the palette
// is really open on the player and otherwise unbinds itself.
function paletteKey(fn: () => void): () => void {
  return () => {
    if (!playerRoute() || !showPalette()) {
      debug("palette: stray key binding removed");
      unbindPaletteKeys();
      return;
    }
    fn();
  };
}

/** The query is selected whole (⌘A): typing replaces it, deleting clears it. */
export const paletteAllSelected = signal(false);

/** Sets the query (the selection goes). */
function setPaletteQuery(q: string) {
  if (paletteAllSelected()) paletteAllSelected.set(false);
  paletteQuery.set(q);
}

/** The query without its last word (and the spaces after it): ⌥⌫. */
function dropLastWord(q: string): string {
  return q.replace(/\s+$/, "").replace(/\S+$/, "");
}

function bindPaletteKeys() {
  unbindPaletteKeys();
  const edit = (fn: (q: string) => string) =>
    paletteKey(() => setPaletteQuery(paletteAllSelected() ? fn("") : fn(paletteQuery())));
  const type = (text: string) => edit((q) => q + text);
  const map: Record<string, () => void> = {
    backspace: paletteKey(() => setPaletteQuery(paletteAllSelected() ? "" : paletteQuery().slice(0, -1))),
    // ⌘⌫ clears the query, ⌥⌫ deletes its last word, ⌘A selects it whole.
    "mod+backspace": paletteKey(() => setPaletteQuery("")),
    "alt+backspace": paletteKey(() =>
      setPaletteQuery(paletteAllSelected() ? "" : dropLastWord(paletteQuery())),
    ),
    "mod+a": paletteKey(() => {
      if (paletteQuery()) paletteAllSelected.set(true);
    }),
    // ⌘V: the clipboard's text, on one line (the filter is one line).
    "mod+v": paletteKey(() => {
      void Clipboard.readText()
        .then((t) => {
          const text = String(t ?? "").replace(/\s+/g, " ").slice(0, 200);
          if (text && showPalette()) type(text)();
        })
        .catch(() => {});
    }),
    enter: paletteKey(() => {
      const first = visibleItems()[0];
      if (first) paletteSelect(first.id);
    }),
    escape: paletteKey(() => closePalette()),
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

/** Removes the palette key bindings; safe when nothing is bound. If the
 * unbind throws, the handle is kept so a later call can retry (the
 * handlers also refuse to act while the palette is closed). */
function unbindPaletteKeys() {
  const unbind = paletteUnbind;
  if (!unbind) return;
  try {
    unbind();
    paletteUnbind = null;
  } catch (e) {
    debug("palette: unbind threw", String(e));
  }
}

export function openPalette() {
  paletteView.set("root");
  setPaletteQuery("");
  showSources.set(false);
  showPalette.set(true);
  bindPaletteKeys();
}

/** Closes the palette and removes its key bindings. Idempotent. */
export function closePalette() {
  unbindPaletteKeys();
  if (showPalette()) showPalette.set(false);
  if (paletteView() !== "root") paletteView.set("root");
  if (paletteQuery() !== "") paletteQuery.set("");
  if (paletteAllSelected()) paletteAllSelected.set(false);
  // Meant to hand the keyboard back to the WebView, but in NSH 0.4.0
  // focus() is a no-op for non-input views (the GPUI focus command
  // returns early): do not rely on it.
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
// Player settings: "setting:<key>=<value>" (this run only, not saved),
// "end" (5 s before the end), "up:now|cancel|replay|continue" (the Up next
// card), "skip" (the Skip pill, or its Undo), "audio:<id>" (a hand pick),
// "fwd"/"back" (one seek step), "seg:op|ed|recap" (1 s before a segment);
// "settings": {...} in the config applies before the play opens.

export interface AutotestConfig {
  type?: "movie" | "tv" | "anime";
  id?: number;
  season?: number;
  episode?: number;
  title?: string;
  source?: string;
  settleMs?: number;
  actions?: string[];
  // "home" | "search" | "library" | "settings" | "setup" | "title" |
  // "player" (default when type+id are given). For "title", type+id pick
  // the title page; for "player" they pick the video.
  screen?: string;
  /** "native": the app's player for this run (Storage mode "1", not
   * stored); "web": the source pages ("0"). Omitted: the stored mode. */
  backend?: "native" | "web";
  /** Settings for this run only (in memory, never saved), applied before
   * the play opens: {"preferredAudio":"en","rememberSpeed":false}. */
  settings?: Record<string, unknown>;
}

const AUTOTEST_RESULT = "rustflix.autotest.result";

const autotestUiFns: ((name: string) => void)[] = [];
/** The controls answer the autotest's `ui:<name>` actions (show the
 * controls, open the Audio & Subtitles panel, …): they live in screens/. */
export function onAutotestUi(fn: (name: string) => void): void {
  autotestUiFns.push(fn);
}

/** What the autotest records after the settle and after every action
 * (`rustflix.autotest.result`, an array, rewritten each time). */
export function playerSnapshot(label: string): Record<string, unknown> {
  const r = playerRoute();
  return {
    at: Date.now(),
    label,
    route: r ? { type: r.type, id: r.id, season: r.season, episode: r.episode, lang: r.lang } : null,
    backend: r ? epochBackend : null,
    planned: playBackend(),
    nativeMode: nativeMode(),
    nativeEnabled: nativeEnabled(),
    session: nativeState(),
    source: r ? sourceFor(r.type) : null,
    phase: playerPhase(),
    position: Math.round(position() * 10) / 10,
    duration: Math.round(duration() * 10) / 10,
    paused: mediaPaused(),
    rate: mediaRate(),
    volume: mediaVolume(),
    muted: mediaMuted(),
    pip: pipSupported(),
    webPage: webPageUrl() ? String(webPageUrl()).slice(0, 120) : null,
    switchNotice: switchNotice(),
    fail: failState(),
    tried: [...triedSources.keys()],
    nativeTried: nativeTried(),
    subtitle: currentSubtitle(),
    subtitles: subtitleOptions().length,
    audio: audioOptions().length,
    audioOn: currentAudio(),
    seekStep: seekStep(),
    upNext: upNextCard() ? { mode: upNextCard()!.mode, line: upNextCard()!.line, left: upNextCard()!.left } : null,
    skipPill: skipPill()?.label ?? null,
    segments: skipSegs().map((x) => ({ kind: x.kind, start: Math.round(x.start), end: Math.round(x.end) })),
    autoChain,
    link: currentStreamLink() ? { source: currentStreamLink()!.source, kind: currentStreamLink()!.kind } : null,
  };
}

const autotestWait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAutotest(cfg: AutotestConfig) {
  debug("autotest: start", cfg);
  if (cfg.backend === "native") overrideNativeMode("1");
  else if (cfg.backend === "web") overrideNativeMode("0");
  const shots: Record<string, unknown>[] = [];
  const shot = async (label: string) => {
    const s = playerSnapshot(label);
    // What the platform holds: live players, and every web view (a page
    // on screen would show here).
    const ask = async (name: string) => {
      try {
        return await Promise.race([host.call(name, {} as never), new Promise((d) => setTimeout(() => d(null), 1000))]);
      } catch {
        return null;
      }
    };
    s.players = await ask("sys.nativePlayers");
    const wv = (await ask("sys.webViews")) as { views?: { url?: string; hidden?: boolean; alpha?: number; onScreen?: boolean }[] } | null;
    s.webViews = Array.isArray(wv?.views)
      ? wv!.views.map((v) => ({ url: String(v.url ?? "").slice(0, 60), hidden: v.hidden, alpha: v.alpha, onScreen: v.onScreen }))
      : null;
    shots.push(s);
    void Storage.setItem(AUTOTEST_RESULT, JSON.stringify(shots)).catch(() => {});
  };
  if (cfg.source) sourceId.set(cfg.source);
  if (cfg.settings && typeof cfg.settings === "object") {
    settings.set({ ...settings(), ...cfg.settings } as ReturnType<typeof settings>);
  }
  const screen = cfg.screen ?? (cfg.type && cfg.id ? "player" : "home");
  if (screen === "title" && cfg.type && cfg.id) {
    navigate({ name: "title", type: cfg.type, id: cfg.id });
  } else if (screen === "search") {
    navigate({ name: "search" });
  } else if (screen === "library") {
    navigate({ name: "library" });
  } else if (screen === "settings") {
    navigate({ name: "settings" });
  } else if (screen === "setup") {
    navigate({ name: "setup" });
  } else if (screen === "downloads") {
    navigate({ name: "downloads" });
  } else if (screen === "player" && cfg.type && cfg.id) {
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
  await shot("settled");
  for (const a of cfg.actions ?? []) {
    debug("autotest: action", a);
    if (a === "openPalette") openPalette();
    else if (a === "closePalette") closePalette();
    else if (a === "togglePalette") togglePalette();
    else if (a.startsWith("choose:")) choosePaletteIndex(Number(a.slice(7)));
    else if (a === "toggle") togglePlay();
    else if (a.startsWith("pick:")) pickSource(a.slice(5));
    else if (a === "play") playPlayback();
    else if (a === "pause") pausePlayback();
    else if (a === "download") startDownload();
    else if (a.startsWith("playDownload:")) {
      const d = downloads().find((x) => x.id === Number(a.slice(13)));
      if (d) playDownload(d);
    }
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
    else if (a.startsWith("js:")) {
      const code = a.slice(3);
      try {
        webview()?.injectJavaScript?.(
          `(function(){try{var r=(${code});window.nsh&&window.nsh.postMessage(JSON.stringify({t:-9,r:String(r).slice(0,1500)}));}catch(e){window.nsh&&window.nsh.postMessage(JSON.stringify({t:-9,r:"ERR "+e}));}})();`,
        );
      } catch {}
    }
    else if (a.startsWith("seekby:")) seekBy(Number(a.slice(7)));
    // Not remembered: a test run must not change the user's speed.
    else if (a.startsWith("rate:")) setRate(Number(a.slice(5)), false);
    else if (a.startsWith("seek:")) seekTo(Number(a.slice(5)));
    else if (a === "next") void nextEpisode();
    // 5 s before the end (the Up next card, autoplay).
    else if (a === "end") {
      if (duration() > 0) seekAbs(Math.max(0, duration() - 5));
    }
    else if (a.startsWith("up:")) upNextAction(a.slice(3) as UpAction);
    else if (a === "fwd") seekForward();
    else if (a === "back") seekBack();
    // 1 s before the first segment of a kind ("seg:op", "seg:ed", "seg:recap").
    else if (a.startsWith("seg:")) {
      const sg = skipSegs().find((x) => x.kind === a.slice(4));
      if (sg) seekAbs(Math.max(0, sg.start - 1));
    }
    else if (a === "skip") skipPillPress();
    // A setting for this run only (in memory, not saved): "setting:seekStep=30".
    else if (a.startsWith("setting:")) {
      const [k, raw] = a.slice(8).split("=");
      const v = raw === "true" ? true : raw === "false" ? false : raw !== undefined && raw !== "" && !isNaN(Number(raw)) ? Number(raw) : (raw ?? "");
      if (k) settings.set({ ...settings(), [k]: v } as ReturnType<typeof settings>);
    }
    else if (a.startsWith("audio:")) selectAudio(a.slice(6));
    else if (a === "pip") enterPip();
    else if (a === "mute") toggleMute();
    else if (a === "fill") toggleFill();
    else if (a === "subs") toggleSubs();
    else if (a === "tryAgain") tryAgain();
    else if (a === "exit") navigate({ name: "home" });
    else if (a.startsWith("wait:")) await autotestWait(Number(a.slice(5)) || 0);
    else if (a === "fullscreen") toggleFullscreen();
    else if (a.startsWith("sub:")) {
      // The first online subtitle in this language (searching first).
      const lang = a.slice(4);
      ensureSubtitleSearch();
      for (let i = 0; i < 20 && subtitleSearch() === "searching"; i++) await autotestWait(500);
      const o = subtitleOptions().find((x) => x.lang === lang && x.origin === "online") ?? subtitleOptions().find((x) => x.lang === lang);
      if (o) selectSubtitle(o.id);
    } else if (a.startsWith("ui:")) {
      for (const fn of autotestUiFns.slice()) {
        try {
          fn(a.slice(3));
        } catch {}
      }
    }
    await autotestWait(1600);
    await shot(a);
  }
  debug("autotest: done");
}

// --- Session: resume + leave cleanup -------------------------------------------

/** One-shot timers startPlayer arms (stream sniffing, bridge re-arm). */
let sessionTimers: ReturnType<typeof setTimeout>[] = [];

/** Arms the resume point: this title/episode's saved position, sought
 * by driveResume once a video of the current page is playable. */
function armResume() {
  resumeTarget = null;
  resumeFloor = null;
  resumeSends = 0;
  resumeSentAt = 0;
  const r = playerRoute();
  if (!r) return;
  const key = itemKey(r.type, r.id, r.season ?? 0, r.episode ?? 0);
  // Same episode re-opened with the other anime audio: continue from
  // where it was, even before a save was allowed.
  const carry = audioCarry;
  audioCarry = null;
  if (carry && carry.key === key && carry.pos > 5) {
    debug("resume: carried over from the audio switch", { pos: carry.pos });
    resumeTarget = Math.floor(carry.pos);
    return;
  }
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
  resumeTarget = pos;
}

/** Called when the player route opens: resets state and arms resume.
 * Untracked: the screen calls it from an effect, which must not start
 * depending on the playback signals read and written here. */
export function startPlayer() {
  untracked(startPlayerInner);
}

function startPlayerInner() {
  stopTimers();
  // Preferred audio English on an anime played with its default (sub):
  // the dub, in place (the same play; see animeLangFor).
  const r0 = playerRoute();
  const dub = r0 ? animeLangFor(r0) : null;
  autoDubKey = "";
  if (r0 && dub) {
    debug("audio: preferred language → dub", { id: r0.id, episode: r0.episode });
    autoDubKey = routeKey(r0);
    navigate({ ...r0, lang: dub, next: undefined }, { replace: true });
  }
  upReset();
  clearSkipUndo();
  autoSkipped.clear();
  audioPrefDone = "";
  watchedKeys.clear();
  position.set(0);
  duration.set(0);
  mediaPaused.set(false);
  mediaRate.set(1);
  subTracks.set([]);
  lastTracksSig = "";
  resetSubtitleState();
  skipSegs.set([]);
  skipKey = "";
  skipRetried = "";
  lastSaved = 0;
  // New title/episode: every source is worth trying again, the user's
  // choice applies again, and the phase starts over even when the URL
  // happens to repeat.
  triedSources.clear();
  nativeTried.set([]);
  localWeb.set(false);
  closeNative();
  prefetchKey = "";
  sourceOverride.set(null);
  pickedSource = null;
  failState.set(null);
  switchNotice.set("");
  void loadDebugFlags();
  if (playerPhase() === "failed") playerPhase.set("loading");
  epochUrl = undefined;
  debug("startPlayer", { src: sourceFor(playerRoute()?.type ?? "movie"), url: playerUrl()?.slice(0, 140) });
  armResume();
  const r = playerRoute();
  if (r) void ensureExtId(r).then(syncSrc).catch(() => {});
  if (r) ensureTitleMeta(r);
  if (r) loadOfflineSubtitle(r);
  syncSrc();
  // Give the embed time to fetch its playlist, then sniff the media URLs
  // a few times so downloads have a stream to work with.
  for (const ms of [6000, 15000, 30000]) {
    sessionTimers.push(setTimeout(() => {
      if (epochBackend === "web") refreshStreams();
    }, ms));
  }
  // The page's own scripts may navigate/reload after `load`; re-arm the
  // bridge a few times so every document gets it (self-guarded).
  for (const ms of [800, 2500, 6000]) {
    sessionTimers.push(setTimeout(() => {
      if (epochBackend === "web") armBridge();
    }, ms));
  }
}

/** Cancels every timer and transient state the player owns: watchdog,
 * switch countdown, pending resume, skip retry, hold-to-speed and the
 * startup timers. Safe to call any number of times. */
function stopTimers() {
  pickerDepth = 0;
  pickerResume = false;
  if (watchdog) clearInterval(watchdog);
  watchdog = undefined;
  deciding = false;
  if (failState()) failState.set(null);
  if (switchNotice()) switchNotice.set("");
  resumeTarget = null;
  resumeSends = 0;
  if (skipRetryTimer) clearTimeout(skipRetryTimer);
  skipRetryTimer = undefined;
  for (const t of sessionTimers) clearTimeout(t);
  sessionTimers = [];
  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = undefined;
  pendingMove = null;
  if (rateHeld()) {
    rateHeld.set(false);
    be().hold(false);
  }
}

/** Leaving the player (route change or screen unmount). Idempotent. */
export function stopPlayer() {
  untracked(stopPlayerInner);
}

function stopPlayerInner() {
  // Second safety net for the palette's global key bindings (the leave
  // hook is the first): no overlay or key block outlives the player.
  try {
    closePalette();
  } catch {}
  try {
    if (showSources()) showSources.set(false);
    setPageKeysBlocked(false);
  } catch {}
  stopTimers();
  closeNative();
  upReset();
  clearSkipUndo();
  // Leaving the player is input: the autoplay chain starts over.
  autoChain = 0;
  pageControlsActive.set(false);
  web.pageControls(false);
  web.sourcesModal(false);
}

// Leaving the player (any navigation): save the last known position
// (persist() refuses until it is real), pause the page so nothing keeps
// playing behind the scenes, and stop every player timer.
// Every step is guarded on its own, and the palette goes first: its key
// bindings are global, so a throw that skipped closing it would leave
// every text field in the app unable to receive keys.
setLeaveHook(() => {
  const step = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      debug(`leave: ${name} threw`, String(e));
    }
  };
  step("closePalette", closePalette);
  step("sources", () => {
    if (showSources()) showSources.set(false);
  });
  step("pageKeys", () => setPageKeysBlocked(false));
  step("persist", persist);
  step("pause", pausePlayback);
  step("timers", () => untracked(stopTimers));
  // The app's player: the stream session closes, a resolve of ours ends.
  step("native", closeNative);
  // A suspended play keeps no next-episode resolve going.
  step("prefetch", () => sessionHost?.cancelPrefetch?.());
});

// --- The app's own player (lib/playback) ---------------------------------------
//
// Which backend a play uses (`playBackend`), the PlaySession of a native
// epoch, the native backend's reports, and the next episode resolved
// ahead of time. The failure flow above treats both backends alike: a
// native failure marks the source in `nativeTried` (its page is tried
// later, see nextSource), a page failure in `triedSources`.

/** The active backend for media commands. */
function be(): PlaybackBackend {
  return epochBackend === "native" ? nativeBackend : web;
}

/** Whether source `id` tries the app's player (the stored mode "1": all). */
function nativeCapable(id: string): boolean {
  if (PLAYER_SOURCES.find((s) => s.id === id)?.noNative) return false;
  return nativeMode() === "1" || sourcePlayback(id) === "native";
}

/** The backend the route in the player uses now; "pending" while the
 * mode / the platform's answer is not in (nothing loads meanwhile). */
export const playBackend = computed<"web" | "native" | "pending">(() => {
  const r = playerRoute();
  if (!r) return "web";
  const on = nativeEnabled();
  const local = localPageFor(r);
  if (local !== null) {
    if (on === null) return "pending";
    // A download plays in the app's player once the platform says it can
    // (`sys.nativeVideoInfo {local:true}`) or the mode forces it.
    if (!on || localWeb() || !(nativeMode() === "1" || nativeInfo().local === true)) return "web";
    return "native";
  }
  if (on === null) return "pending";
  if (!on) return "web";
  const src = sourceFor(r.type);
  if (!nativeCapable(src) || nativeTried().includes(src)) return "web";
  return "native";
});

/** The app's player plays this route (no page on screen). */
export const nativeActive = computed(() => playBackend() === "native");

/** The page the player's web view loads: null on native plays (the view
 * stays idle on about:blank) and while the backend is not decided. */
export const webPageUrl = computed<string | null>(() => (playBackend() === "web" ? playerUrl() : null));

/** The native session's state (diagnostics). */
export const nativeState = signal<SessionState | "none">("none");

/** The session host (lib/resolver.ts's resolveStream / cancelResolve),
 * registered by screens/Player.tsx: lib/resolver.ts imports this module,
 * so this module cannot import it. */
let sessionHost: (Pick<SessionDeps, "resolve" | "cancelResolve"> & { cancelPrefetch?: () => void }) | null = null;
export function registerPlaybackHost(h: Pick<SessionDeps, "resolve" | "cancelResolve"> & { cancelPrefetch?: () => void }) {
  sessionHost = h;
}

let session: PlaySession | null = null;

async function hostCall<T>(name: string, data: unknown): Promise<T | null> {
  try {
    return ((await host.call(name, data as never)) as T) ?? null;
  } catch (e) {
    debug(`native: ${name} threw`, String(e));
    return null;
  }
}

function sessionDeps(h: Pick<SessionDeps, "resolve" | "cancelResolve">): SessionDeps {
  return {
    resolve: h.resolve,
    cancelResolve: h.cancelResolve,
    open: (d) => hostCall("dl.stream.open", d),
    update: (d) => hostCall("dl.stream.update", d),
    close: (sid) => hostCall("dl.stream.close", { sid }),
    onEvent: (fn) => {
      try {
        return host.on("dl.stream.event", (d: unknown) => {
          try {
            fn(d as never);
          } catch {}
        });
      } catch {
        return () => {};
      }
    },
    log: (line, data) => debug(`native: ${line}`, data),
  };
}

/** A finished download's media URL from its local page's URL: the page
 * is `…/<id>/<page>?f=<file>`, the file is served next to it. */
export function localMediaUrl(page: string): string | null {
  const [base, query = ""] = page.split("#")[0].split("?");
  const m = /(?:^|&)f=([^&]*)/.exec(query);
  if (!m || !m[1]) return null;
  return base.slice(0, base.lastIndexOf("/") + 1) + m[1];
}

/** Starts the native epoch's session (newEpoch, native backend). */
function openNative() {
  const r = playerRoute();
  if (!r || !epochUrl) return;
  const source = sourceFor(r.type);
  const local = isLocalUrl(epochUrl) ? localMediaUrl(epochUrl) : undefined;
  // Debug-forced failures: nothing opens; the watchdog fails it.
  if (!local && forcedFail(source)) return;
  if (isLocalUrl(epochUrl) && !local) {
    debug("native: no media URL in the local page", epochUrl);
    return;
  }
  const h = sessionHost;
  if (!h && !local) {
    debug("native: no session host (screens/Player.tsx not loaded)");
    return;
  }
  // The backend answered (resolving counts): no "didn't respond" clock.
  bridgeAt = Date.now();
  const deps = sessionDeps(h ?? { resolve: async () => ({ ok: false, error: "no resolver" }), cancelResolve: () => {} });
  const s: PlaySession = new PlaySession(
    {
      type: r.type,
      id: r.id,
      season: r.season,
      episode: r.episode,
      lang: r.lang,
      source,
      local: local ?? undefined,
      startAt: resumeTarget ?? 0,
    },
    deps,
    {
      onState: (st) => {
        if (session === s) nativeState.set(st);
      },
      onSrc: (url, at) => {
        if (session !== s) return;
        if (!videoSeenAt) videoSeenAt = Date.now();
        nativeSrc(url, at);
      },
      onFail: (kind, why, learn) => {
        if (session !== s || why === "cancelled") return;
        // The server refused this platform's proxy: the page from now on.
        if (kind === "refused") markNotNative(source);
        failLearn = learn && kind !== "refused";
        fail(
          "start",
          kind === "drm"
            ? "is protected"
            : kind === "player"
              ? "couldn't play this"
              : kind === "open"
                ? "couldn't be streamed"
                : kind === "refused"
                  ? "was refused"
                  : "didn't respond",
        );
      },
      onLink: (l) => {
        if (session !== s) return;
        const link = nativeStreamLink(r, 10 * 60_000, l);
        if (link) emitStreamLink(link);
      },
      position: () => untracked(position),
    },
  );
  session = s;
  nativeState.set("idle");
  debug("native: open", { source, local: !!local, startAt: resumeTarget ?? 0 });
  void s.open();
}

/** Hands the player its URL (a rebuild of the same URL goes through
 * null: the component ignores the same src twice). */
let nativeSrcTimer: ReturnType<typeof setTimeout> | undefined;
/** The URL the native player was given last (the rebuild check). */
let lastNativeUrl: string | null = null;
function nativeSrc(url: string, at: number) {
  if (nativeSrcTimer) clearTimeout(nativeSrcTimer);
  nativeSrcTimer = undefined;
  // A picker is open: start paused, resume when it closes.
  const startPaused = pickerDepth > 0 || userPaused;
  if (pickerDepth > 0) pickerResume = true;
  const go = () => {
    nativeSrcTimer = undefined;
    lastNativeUrl = url;
    setNativeSource(url, at);
    if (startPaused) nativeBackend.pause();
    else nativeBackend.play();
  };
  if (lastNativeUrl === url) {
    setNativeSource(null);
    lastNativeUrl = null;
    nativeSrcTimer = setTimeout(go, 120);
  } else go();
}

/** Ends the native session of the epoch (if any) and silences the player. */
function closeNative() {
  if (nativeSrcTimer) clearTimeout(nativeSrcTimer);
  nativeSrcTimer = undefined;
  const s = session;
  session = null;
  if (s) {
    s.close();
    nativeBackend.destroy();
    lastNativeUrl = null;
  }
  if (untracked(nativeState) !== "none") nativeState.set("none");
}

/** The native session's link as the player's stream link (downloads). */
function nativeStreamLink(r: PlayerRoute, maxAgeMs: number, given?: CachedLink): StreamLink | null {
  const s = session;
  if (!s || s.target.local) return null;
  const l = given ?? s.link;
  if (!l || !getLink(s.key) || Date.now() - l.at > maxAgeMs) return null;
  const headers = { ...l.headers };
  if (l.cookies && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers["Cookie"] = l.cookies;
  return {
    url: l.url,
    kind: l.kind,
    headers,
    ua: l.ua,
    key: routeKey(r),
    route: { type: r.type, id: r.id, season: r.season, episode: r.episode, lang: r.lang },
    doc: nativeDoc(),
    source: l.source,
    at: l.at,
  };
}

// The native backend's reports go through the same path as the page's.
setNativeListener({
  report: (v) => {
    if (epochBackend !== "native" || !session) return;
    onVideoState(v);
  },
  fatal: (message, code) => {
    const s = session;
    if (epochBackend !== "native" || !s) return;
    debug("native: player error", { message, code });
    // A cached link that never played gets one fresh resolve first.
    s.playerFailed(message);
  },
  frame: (ms) => {
    session?.notePlayed();
    debug("native: first frame", { ms });
  },
});

/** Route key of the next episode resolved ahead of time this epoch. */
let prefetchKey = "";
/** Under this many seconds left, the next episode is resolved ahead. */
const PREFETCH_LEFT_S = 180;

/** Native plays: with < 3 min left, the next episode's link is resolved
 * in the (now idle) hidden page, so Next starts in about a second. */
function maybePrefetchNext() {
  const r = playerRoute();
  const h = sessionHost;
  if (!r || !h || r.type === "movie" || isLocalUrl(epochUrl)) return;
  const d = duration();
  if (!(d > 0) || d - position() > PREFETCH_LEFT_S || !epochReady) return;
  const key = `${routeKey(r)}:${r.lang ?? ""}`;
  if (prefetchKey === key) return;
  prefetchKey = key;
  if (!hasNextEpisode()) return;
  void nextEpisodeOf({ type: r.type, id: r.id, season: r.season, episode: r.episode }).then((n) => {
    const cur = playerRoute();
    if (!n || !cur || `${routeKey(cur)}:${cur.lang ?? ""}` !== key) return;
    // The source the next episode starts with (the user's choice).
    const src = sourceSupports(sourceId(), r.type) ? sourceId() : (sourcesFor(r.type)[0]?.id ?? "");
    if (!src || !nativeCapable(src) || nativeTried().includes(src)) return;
    debug("native: pre-resolving the next episode", { season: n.season, episode: n.episode, source: src });
    void preResolve(
      { type: r.type, id: r.id, season: n.season, episode: n.episode, lang: r.lang, source: src },
      { resolve: h.resolve, log: (line, data) => debug(`native: ${line}`, data) },
    );
  });
}

// Boot: the stored mode, the learned source capabilities (reset when the
// bundle's page code changes), and whether this platform has the player.
initNativePlayer(`0.1.0:${bridgeHash()}`);
function bridgeHash(): string {
  let h = 0;
  const s = PLAYER_BRIDGE;
  for (let i = 0; i < s.length; i += 7) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
