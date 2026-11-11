// Player controller: everything the player screen, the title bar and the
// keybinds share — the WebView ref and its evaluate() probes, playback
// commands, episode lists, the command palette's state, progress saving
// and resume-on-open.
//
// The WebView is a native view above all GPUI content, so nothing drawn
// over it is visible: every player UI element lives in-flow around it.

import { signal } from "nsh";
import type { WebViewRef } from "nsh";
import { aniDetails } from "./anilist";
import { navigate, route, type Route } from "./router";
import { getSourceUrl, type MediaType } from "./sources";
import { itemKey, progress, saveProgress, settings } from "./store";
import { seasonDetails, tvDetails, type Episode } from "./tmdb";

export type PlayerRoute = Extract<Route, { name: "player" }>;

export const webview = signal<WebViewRef | null>(null);
export const sourceId = signal(settings().defaultSource);
export const showSources = signal(false);
export const showPalette = signal(false);
export const paletteView = signal<"root" | "speed" | "subs">("root");
export const episodes = signal<{ n: number; name: string }[]>([]);
export const seasons = signal<number[]>([]);
export const subTracks = signal<{ i: number; label: string; mode: string }[]>([]);
export const position = signal(0);
export const duration = signal(0);
export const mediaPaused = signal(false);
export const mediaRate = signal(1);

const POLL_MS = 10_000;
let progressTimer: ReturnType<typeof setInterval> | undefined;
let resumeTimer: ReturnType<typeof setInterval> | undefined;
let lastSaved = 0;
let loadedKey = "";

export function playerRoute(): PlayerRoute | null {
  const r = route();
  return r.name === "player" ? r : null;
}

/** Runs JS in the top document of the player page and returns its value.
 * Videos inside cross-origin iframes cannot be reached — best effort. */
function evalJs(js: string): Promise<unknown> {
  const ref = webview();
  if (!ref || typeof ref.evaluate !== "function") return Promise.resolve(null);
  return Promise.resolve(ref.evaluate(js)).catch(() => null);
}

const PROBE = `(() => {
  try {
    const v = document.querySelector('video');
    if (!v) return null;
    return JSON.stringify({ t: v.currentTime || 0, d: v.duration || 0, p: !!v.paused, r: v.playbackRate || 1 });
  } catch (e) { return null; }
})()`;

function probe() {
  void evalJs(PROBE).then((raw) => {
    const s = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (!s || s === "null") return;
    try {
      const v = JSON.parse(s);
      if (v && typeof v.t === "number") {
        position.set(v.t);
        if (typeof v.d === "number" && v.d > 0) duration.set(v.d);
        mediaPaused.set(!!v.p);
        if (typeof v.r === "number" && v.r > 0) mediaRate.set(v.r);
        const now = Date.now();
        if (now - lastSaved > 30_000 && v.d > 0) {
          lastSaved = now;
          persist();
        }
      }
    } catch {}
  });
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

// --- Media commands (evaluate into the page's <video>) --------------------

export function togglePlay() {
  void evalJs(
    `(()=>{const v=document.querySelector('video');if(v){v.paused?v.play():v.pause();}return 1})()`,
  );
}

export function seekBy(sec: number) {
  void evalJs(
    `(()=>{const v=document.querySelector('video');if(v)v.currentTime=Math.max(0,(v.currentTime||0)+(${sec}));return 1})()`,
  );
}

export function setRate(rate: number) {
  mediaRate.set(rate);
  void evalJs(
    `(()=>{const v=document.querySelector('video');if(v)v.playbackRate=${rate};return 1})()`,
  );
}

const TRACKS = `(() => {
  try {
    const v = document.querySelector('video');
    if (!v || !v.textTracks) return '[]';
    const ts = Array.from(v.textTracks);
    return JSON.stringify(ts.map((t, i) => ({
      i, label: t.label || t.language || ('Track ' + (i + 1)), mode: t.mode,
    })));
  } catch (e) { return '[]'; }
})()`;

export async function loadTracks() {
  const raw = await evalJs(TRACKS);
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    subTracks.set(JSON.parse(s ?? "[]"));
  } catch {
    subTracks.set([]);
  }
}

/** `i` -1 turns subtitles off, else shows track `i` and hides the rest. */
export function setTrack(i: number) {
  void evalJs(
    `(()=>{const v=document.querySelector('video');if(!v||!v.textTracks)return 1;const ts=v.textTracks;for(let k=0;k<ts.length;k++){ts[k].mode=(k===${i})?'showing':(ts[k].mode==='showing'?'hidden':'disabled');}return 1})()`,
  );
}

// --- Episodes ---------------------------------------------------------------

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

// --- Palette -----------------------------------------------------------------

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function openPalette() {
  paletteView.set("root");
  showSources.set(false);
  showPalette.set(true);
}

export function closePalette() {
  showPalette.set(false);
  paletteView.set("root");
}

export function togglePalette() {
  if (showPalette()) closePalette();
  else openPalette();
}

// --- Session: progress probe + resume ----------------------------------------

/** Arms the resume seek: finds this title/episode's saved position and
 * retries until the page's <video> exists (embeds load it late). */
function armResume() {
  if (resumeTimer) clearInterval(resumeTimer);
  const r = playerRoute();
  if (!r) return;
  const key = itemKey(r.type, r.id, r.season ?? 0, r.episode ?? 0);
  const saved = progress().find((p) => p.key === key);
  const pos =
    saved && saved.duration > 0 && saved.position > 30 && saved.position < saved.duration * 0.95
      ? Math.floor(saved.position)
      : 0;
  if (!pos) return;
  let tries = 0;
  resumeTimer = setInterval(() => {
    tries++;
    if (tries > 60) {
      if (resumeTimer) clearInterval(resumeTimer);
      return;
    }
    void evalJs(
      `(()=>{const v=document.querySelector('video');if(!v)return null;try{v.currentTime=${pos};}catch(e){}return JSON.stringify({ok:true})})()`,
    ).then((raw) => {
      const s = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (s && s.includes('"ok":true')) {
        if (resumeTimer) clearInterval(resumeTimer);
      }
    });
  }, 2500);
}

/** Called when the player route opens: resets probes and arms resume. */
export function startPlayer() {
  stopPlayer();
  position.set(0);
  duration.set(0);
  mediaPaused.set(false);
  mediaRate.set(1);
  lastSaved = 0;
  progressTimer = setInterval(probe, POLL_MS);
  armResume();
}

export function stopPlayer() {
  if (progressTimer) clearInterval(progressTimer);
  if (resumeTimer) clearInterval(resumeTimer);
  progressTimer = undefined;
  resumeTimer = undefined;
}
