// Library persistence: watchlist, watch progress and settings, kept in
// `nsh/storage` (Storage), the app's own key-value store on disk.

import { signal } from "nsh";
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
  position: number;
  duration: number;
  source: string;
  updatedAt: number;
}

export interface Settings {
  defaultSource: string;
  accent: string;
  subtitleLang: string;
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
});
export const libraryReady = signal(false);

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
  settings.set({ ...settings(), ...readJson<Partial<Settings>>(s, {}) });
  libraryReady.set(true);
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
  settings.set({ ...settings(), ...patch });
  await persist(SETTINGS_KEY, settings());
}

/** Items worth "continue watching": started but not finished. */
export function continueWatching(): Progress[] {
  return progress().filter(
    (p) => p.duration > 0 && p.position > 30 && p.position < p.duration * 0.95,
  );
}
