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

import { computed, signal } from "nsh";
import type { WebViewRef } from "nsh";
import { aniDetails } from "./anilist";
import { navigate, route, setLeaveHook, type Route } from "./router";
import { getSourceUrl, type MediaType } from "./sources";
import { itemKey, progress, saveProgress, settings } from "./store";
import { seasonDetails, tvDetails, type Episode } from "./tmdb";

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
  if (window.__rf_bridge) return;
  window.__rf_bridge = true;
  // Rates the embed may use on its own; anything else is snapped back.
  // A rate the app picked through the palette ('rate' command) is also
  // allowed, so embeds can't get stuck at e.g. 2x while 2x stays
  // selectable for the user.
  var stdRates = { 0.5: 1, 0.75: 1, 1: 1, 1.25: 1, 1.5: 1 };
  var allowedRate = null;
  var pendingSeek = null;
  var fixRate = function (v) {
    if (!v || !v.playbackRate) return;
    var r = v.playbackRate;
    if (r === allowedRate || stdRates[r]) return;
    try { v.playbackRate = allowedRate || 1; } catch (e) {}
  };
  document.addEventListener('play', function (e) { fixRate(e.target); }, true);
  document.addEventListener('ratechange', function (e) { fixRate(e.target); }, true);
  window.addEventListener('message', function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (!m) return;
    var v = document.querySelector('video');
    if (m.t === 'seek' && typeof m.p === 'number') { pendingSeek = m.p; return; }
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
  setInterval(function () {
    var v;
    try { v = document.querySelector('video'); } catch (e) { return; }
    if (!v) return;
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
    try {
      window.nsh && window.nsh.postMessage(JSON.stringify({
        t: v.currentTime || 0, d: v.duration || 0,
        p: !!v.paused, r: v.playbackRate || 1, tracks: tracks,
      }));
    } catch (e) {}
  }, 1500);
})();`;

/** App → page: JSON command for the bridge's message listener. */
function send(msg: Record<string, unknown>) {
  const ref = webview();
  if (!ref || typeof ref.postMessage !== "function") return;
  try {
    ref.postMessage(JSON.stringify(msg));
  } catch {}
}

/** Page → app: the bridge's 1.5s state report. */
export function onPlayerMessage(e: { data: unknown }) {
  const raw = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
  if (!raw) return;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.t !== "number") return;
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
  return getSourceUrl(
    sourceId(),
    {
      type: r.type as MediaType,
      id: r.id,
      season: r.season,
      episode: r.episode,
      lang: r.lang,
    },
    {},
    settings().accent,
    settings().subtitleLang || null,
  );
}

export function pickSource(id: string) {
  sourceId.set(id);
  showSources.set(false);
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
    { id: "ctl:source", label: "Choose source…", group: "Playback" },
  );
  return items;
});

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
    paletteView.set("root");
    paletteQuery.set("");
    return;
  }
  if (id === "sub:off") {
    setTrack(-1);
    paletteView.set("root");
    paletteQuery.set("");
    return;
  }
  if (id.startsWith("sub:")) {
    setTrack(Number(id.slice(4)));
    paletteView.set("root");
    paletteQuery.set("");
    return;
  }
  switch (id) {
    case "ctl:toggle":
      togglePlay();
      break;
    case "ctl:back10":
      seekBy(-10);
      break;
    case "ctl:fwd10":
      seekBy(10);
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
  }
}

/** ⌘1–⌘9: activate the nth visible item. */
export function choosePaletteIndex(i: number) {
  const items = visibleItems();
  const it = items[i];
  if (it) paletteSelect(it.id);
}

export function openPalette() {
  paletteView.set("root");
  paletteQuery.set("");
  showSources.set(false);
  showPalette.set(true);
}

export function closePalette() {
  showPalette.set(false);
  paletteView.set("root");
  paletteQuery.set("");
}

export function togglePalette() {
  if (showPalette()) closePalette();
  else openPalette();
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
  if (!pos) return;
  let tries = 0;
  send({ t: "seek", p: pos });
  resumeTimer = setInterval(() => {
    tries++;
    const t = position();
    // Done when the page reports we're at the saved spot, or clearly
    // past it. Give up quickly if the embed keeps resetting to ~0 —
    // fighting it forever makes the video unusable.
    if (
      tries > 5 ||
      Math.abs(t - pos) < 10 ||
      t > pos + 30 ||
      (tries >= 3 && t < 10)
    ) {
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
  armResume();
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
