// Library persistence: watchlist, watch progress and settings, kept in
// `nsh/storage` (Storage), the app's own key-value store on disk.

import { reduceMotion, signal } from "nsh";
import { Storage } from "nsh";
import type { MediaType } from "./sources";

export interface LibraryItem {
  type: MediaType;
  /** TMDB id for movie/tv, AniList id for anime. */
  id: number;
  title: string;
  poster: string;
  year?: string;
  addedAt: number;
}

export interface Progress {
  key: string;
  type: MediaType;
  id: number;
  title: string;
  poster: string;
  season?: number;
  episode?: number;
  /** Anime audio the user was watching, so a resume keeps it. */
  lang?: "sub" | "dub";
  position: number;
  duration: number;
  source: string;
  updatedAt: number;
}

export interface Settings {
  defaultSource: string;
  accent: string;
  subtitleLang: string;
  /** Ignored: the vid-dl binary of older builds (downloads are built in
   * now). Kept so old saved settings still parse. */
  downloaderPath?: string;
  /** Desktop: the download folder in effect, mirrored from the downloader
   * (read-only in practice: lib/downloads.ts puts back any other value;
   * change it with `changeDownloadDir`, which moves the downloads). */
  downloadDir: string;
  /** Remembered playback speed, applied when each video becomes playable. */
  playbackRate: number;
  /** Legacy on/off (before `subtitleChoice`); kept in sync for old callers. */
  subtitlesOn: boolean;
  /** "My languages": ordered ISO 639-1 codes; the first match is picked. */
  myLanguages: string[];
  /** The last explicit subtitle choice: "auto" (none yet), "off", or a
   * language code. Followed on every title when available. */
  subtitleChoice: string;
  /** Turn subtitles on by themselves when the title's original language
   * is not one of `myLanguages`. */
  subtitleAuto: boolean;
  subtitleSize: "s" | "m" | "l";
  /** Optional Wyzie Subs API key (online subtitle search). */
  subtitleKey: string;
  /** Optional SubDL API key (online subtitle search). */
  subdlKey: string;
  /** Queue the next episode by itself after a downloaded episode was watched. */
  downloadAutoNext: boolean;
  /** iPhone: downloads only transfer on Wi-Fi. */
  downloadWifiOnly: boolean;
  /** Keep `playbackRate` between videos; off: every video starts at 1×. */
  rememberSpeed: boolean;
  /** Seconds the keyboard arrows and the seek buttons skip. */
  seekStep: 5 | 10 | 15 | 30;
  /** Play the next episode by itself when one ends. */
  autoplayNext: boolean;
  /** Seconds of the countdown before the next episode plays. */
  autoplayCountdown: 5 | 10 | 15;
  /** Intros and credits (AniSkip): a Skip button, or skipped by themselves. */
  skipSegments: "button" | "auto";
  /** Audio picked first: "" = the original / follow `myLanguages`; else
   * an ISO 639-1 code of `LANGUAGES`. */
  preferredAudio: string;
  /** Ask before a download is deleted or removed. */
  confirmDeleteDownload: boolean;
  /** Plain cuts and short fades instead of the poster flight and the page
   * animations (also on when the system asks for less motion:
   * `motionReduced()`). */
  reduceMotion: boolean;
}

const WATCHLIST_KEY = "rustflix.watchlist.v1";
const PROGRESS_KEY = "rustflix.progress.v1";
const SETTINGS_KEY = "rustflix.settings.v1";

export const watchlist = signal<LibraryItem[]>([]);
export const progress = signal<Progress[]>([]);
export const settings = signal<Settings>({
  defaultSource: "vidfast",
  accent: "#e50914",
  subtitleLang: "en",
  downloadDir: "",
  playbackRate: 1,
  subtitlesOn: true,
  myLanguages: ["en"],
  subtitleChoice: "auto",
  subtitleAuto: true,
  subtitleSize: "m",
  subtitleKey: "",
  subdlKey: "",
  downloadAutoNext: true,
  downloadWifiOnly: true,
  rememberSpeed: true,
  seekStep: 10,
  autoplayNext: true,
  autoplayCountdown: 10,
  skipSegments: "button",
  preferredAudio: "",
  confirmDeleteDownload: true,
  reduceMotion: false,
});
export const libraryReady = signal(false);

// Settings observers (the player follows `defaultSource`): called after
// settings are restored at boot and after every save, with the previous
// value for comparison.
type SettingsListener = (next: Settings, prev: Settings) => void;
const settingsListeners: SettingsListener[] = [];
export function onSettingsChange(fn: SettingsListener) {
  settingsListeners.push(fn);
}
function notifySettings(prev: Settings) {
  const next = settings();
  for (const fn of settingsListeners) {
    try {
      fn(next, prev);
    } catch {}
  }
}

export function itemKey(type: MediaType, id: number, season = 0, episode = 0): string {
  return `${type}:${id}:${season}:${episode}`;
}

function readJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function loadLibrary() {
  const [w, p, s] = await Promise.all([
    Storage.getItem(WATCHLIST_KEY),
    Storage.getItem(PROGRESS_KEY),
    Storage.getItem(SETTINGS_KEY),
  ]);
  watchlist.set(readJson<LibraryItem[]>(w, []));
  progress.set(readJson<Progress[]>(p, []));
  const prev = settings();
  settings.set(migrateSettings(prev, readJson<Partial<Settings>>(s, {})));
  libraryReady.set(true);
  notifySettings(prev);
}

/** Saved settings over the defaults. Older saves lack the subtitle
 * fields: `subtitleLang` seeds `myLanguages`, `subtitlesOn: false`
 * becomes the remembered "off". Malformed fields fall back to defaults. */
export function migrateSettings(defaults: Settings, saved: Partial<Settings>): Settings {
  const raw = (saved && typeof saved === "object" ? saved : {}) as Partial<Settings>;
  const out: Settings = { ...defaults, ...raw };
  const langs = Array.isArray(raw.myLanguages)
    ? raw.myLanguages
        .filter((c): c is string => typeof c === "string" && !!c.trim())
        .map((c) => c.trim().toLowerCase())
    : null;
  if (langs) {
    out.myLanguages = [...new Set(langs)];
  } else {
    const old = typeof raw.subtitleLang === "string" ? raw.subtitleLang.trim().toLowerCase() : "";
    out.myLanguages = old && old !== "none" ? [old.split(/[-_]/)[0]] : [...defaults.myLanguages];
  }
  if (typeof raw.subtitleChoice !== "string" || !raw.subtitleChoice) {
    out.subtitleChoice = raw.subtitlesOn === false ? "off" : defaults.subtitleChoice;
  }
  if (typeof out.subtitleAuto !== "boolean") out.subtitleAuto = defaults.subtitleAuto;
  if (out.subtitleSize !== "s" && out.subtitleSize !== "m" && out.subtitleSize !== "l") {
    out.subtitleSize = defaults.subtitleSize;
  }
  if (typeof out.subtitleKey !== "string") out.subtitleKey = defaults.subtitleKey;
  if (typeof out.subdlKey !== "string") out.subdlKey = defaults.subdlKey;
  if (typeof out.downloadAutoNext !== "boolean") out.downloadAutoNext = defaults.downloadAutoNext;
  if (typeof out.downloadWifiOnly !== "boolean") out.downloadWifiOnly = defaults.downloadWifiOnly;
  if (typeof out.rememberSpeed !== "boolean") out.rememberSpeed = defaults.rememberSpeed;
  if (![5, 10, 15, 30].includes(out.seekStep as number)) out.seekStep = defaults.seekStep;
  if (typeof out.autoplayNext !== "boolean") out.autoplayNext = defaults.autoplayNext;
  if (![5, 10, 15].includes(out.autoplayCountdown as number)) {
    out.autoplayCountdown = defaults.autoplayCountdown;
  }
  if (out.skipSegments !== "button" && out.skipSegments !== "auto") {
    out.skipSegments = defaults.skipSegments;
  }
  const audio = typeof out.preferredAudio === "string" ? out.preferredAudio.trim().toLowerCase() : null;
  out.preferredAudio =
    audio !== null && (audio === "" || LANGUAGES.some((l) => l.code === audio))
      ? audio
      : defaults.preferredAudio;
  if (typeof out.confirmDeleteDownload !== "boolean") {
    out.confirmDeleteDownload = defaults.confirmDeleteDownload;
  }
  if (typeof out.reduceMotion !== "boolean") out.reduceMotion = defaults.reduceMotion;
  // The vid-dl path of older builds: ignored (downloads are built in).
  delete out.downloaderPath;
  return out;
}

// --- Languages ----------------------------------------------------------------

/** Languages the subtitle/audio matching knows, sorted by name. `code`
 * is ISO 639-1 (Filipino and Tagalog share "tl"). */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: "ar", name: "Arabic" },
  { code: "bg", name: "Bulgarian" },
  { code: "bn", name: "Bengali" },
  { code: "bs", name: "Bosnian" },
  { code: "ca", name: "Catalan" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "et", name: "Estonian" },
  { code: "fa", name: "Persian" },
  { code: "fi", name: "Finnish" },
  { code: "tl", name: "Filipino (Tagalog)" },
  { code: "gl", name: "Galician" },
  { code: "fr", name: "French" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hr", name: "Croatian" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "is", name: "Icelandic" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "kn", name: "Kannada" },
  { code: "ko", name: "Korean" },
  { code: "lt", name: "Lithuanian" },
  { code: "lv", name: "Latvian" },
  { code: "mk", name: "Macedonian" },
  { code: "ml", name: "Malayalam" },
  { code: "ms", name: "Malay" },
  { code: "nl", name: "Dutch" },
  { code: "no", name: "Norwegian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "sq", name: "Albanian" },
  { code: "sr", name: "Serbian" },
  { code: "sv", name: "Swedish" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "vi", name: "Vietnamese" },
  { code: "zh", name: "Chinese" },
].sort((a, b) => a.name.localeCompare(b.name));

/** The English name of ISO 639-1 `code` ("pt-BR" → "Portuguese"); the
 * code itself, upper-cased, when unknown; "" for "". */
export function languageName(code: string): string {
  const c = String(code || "").trim().toLowerCase().split(/[-_]/)[0];
  if (!c) return "";
  return LANGUAGES.find((l) => l.code === c)?.name ?? c.toUpperCase();
}

async function persist(key: string, value: unknown) {
  await Storage.setItem(key, JSON.stringify(value));
}

export function inWatchlist(type: MediaType, id: number): boolean {
  return watchlist().some((i) => i.type === type && i.id === id);
}

export async function toggleWatchlist(item: Omit<LibraryItem, "addedAt">) {
  const list = watchlist();
  const at = list.findIndex((i) => i.type === item.type && i.id === item.id);
  if (at >= 0) {
    watchlist.set(list.filter((_, i) => i !== at));
    await persist(WATCHLIST_KEY, watchlist());
  } else {
    watchlist.set([{ ...item, addedAt: Date.now() }, ...list]);
    await persist(WATCHLIST_KEY, watchlist());
  }
}

export async function saveProgress(p: Omit<Progress, "updatedAt">) {
  const list = progress().filter((x) => x.key !== p.key);
  const entry = { ...p, updatedAt: Date.now() };
  // Keep the list bounded; drop the oldest beyond 200.
  const next = [entry, ...list].slice(0, 200);
  progress.set(next);
  await persist(PROGRESS_KEY, next);
}

export async function removeProgress(key: string) {
  const next = progress().filter((x) => x.key !== key);
  progress.set(next);
  await persist(PROGRESS_KEY, next);
}

export async function saveSettings(patch: Partial<Settings>) {
  const prev = settings();
  settings.set({ ...prev, ...patch });
  notifySettings(prev);
  await persist(SETTINGS_KEY, settings());
}

/** Clears the watch history: every progress entry (Continue Watching and
 * resume points); My List stays. Everything reading `progress()` follows
 * at once. */
export async function clearProgress() {
  progress.set([]);
  await persist(PROGRESS_KEY, []);
}

/** Motion is to be kept to plain cuts and short fades: the user's Reduce
 * motion setting, or the system's (reactive). */
export function motionReduced(): boolean {
  if (settings().reduceMotion) return true;
  try {
    return reduceMotion();
  } catch {
    return false;
  }
}

/** Items worth "continue watching": started but not finished. */
export function continueWatching(): Progress[] {
  return progress().filter(
    (p) => p.duration > 0 && p.position > 30 && p.position < p.duration * 0.95,
  );
}

/** Continue watching with one entry per title: for a series, its most
 * recently watched unfinished episode (by `updatedAt`); newest first. */
export function continueWatchingByTitle(): Progress[] {
  const best = new Map<string, Progress>();
  for (const p of continueWatching()) {
    const k = `${p.type}:${p.id}`;
    const cur = best.get(k);
    if (!cur || p.updatedAt > cur.updatedAt) best.set(k, p);
  }
  return [...best.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Drops a title from continue watching: every unfinished entry of it
 * (all its episodes); finished episodes keep their progress. */
export async function removeProgressForTitle(type: MediaType, id: number) {
  const unfinished = new Set(
    continueWatching()
      .filter((p) => p.type === type && p.id === id)
      .map((p) => p.key),
  );
  const next = progress().filter((x) => !unfinished.has(x.key));
  progress.set(next);
  await persist(PROGRESS_KEY, next);
}
