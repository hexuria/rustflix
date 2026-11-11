// Client for the TMDB API (v3), as Streambert's `src/utils/api.js` does:
// one key (a v3 API key or a v4 read-access token), a small in-memory
// cache, and image URLs on image.tmdb.org.

import { signal, Storage } from "nsh";

export const API = "https://api.themoviedb.org/3";
export const IMG = "https://image.tmdb.org/t/p";

const KEY_STORAGE = "rustflix.tmdbKey";
const CACHE_TTL = 5 * 60 * 1000;

export interface Media {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  popularity?: number;
}

export interface Season {
  season_number: number;
  name: string;
  episode_count: number;
  air_date?: string;
  poster_path?: string | null;
}

export interface Episode {
  episode_number: number;
  name: string;
  overview?: string;
  still_path?: string | null;
  air_date?: string;
  runtime?: number;
}

export interface TitleDetails extends Media {
  tagline?: string;
  genres?: { id: number; name: string }[];
  seasons?: Season[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  episodes?: Episode[];
  runtime?: number;
  status?: string;
  original_language?: string;
}

export interface Genre {
  id: number;
  name: string;
}

const apiKey = signal("");
let bearer = false;
const cache = new Map<string, { data: unknown; expires: number }>();

export function imgUrl(path: string | null | undefined, size = "w500"): string {
  return path ? `${IMG}/${size}${path}` : "";
}

export async function loadKey(): Promise<string> {
  if (apiKey()) return apiKey();
  const saved = await Storage.getItem(KEY_STORAGE);
  if (saved) setKey(saved);
  return apiKey();
}

export function setKey(key: string) {
  apiKey.set(key.trim());
  // Read access tokens are JWTs (v4); anything else is treated as a v3 key.
  const k = apiKey();
  bearer = k.startsWith("eyJ") || k.length > 60;
}

export async function saveKey(key: string) {
  setKey(key);
  if (key.trim()) await Storage.setItem(KEY_STORAGE, key.trim());
  else await Storage.removeItem(KEY_STORAGE);
}

export function hasKey(): boolean {
  return apiKey().length > 0;
}

export function currentKey(): string {
  return apiKey();
}

async function tmdb<T>(path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const key = apiKey();
  const url = bearer
    ? `${API}${path}${sep}language=en-US`
    : `${API}${path}${sep}api_key=${encodeURIComponent(key)}&language=en-US`;
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data as T;
  const res = await fetch(url, {
    headers: bearer ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = (await res.json()) as T;
  cache.set(url, { data, expires: Date.now() + CACHE_TTL });
  return data;
}

export function clearCache() {
  cache.clear();
}

export const title = (m: Media) => m.title ?? m.name ?? m.original_title ?? m.original_name ?? "Untitled";
export const year = (m: Media) => (m.release_date ?? m.first_air_date ?? "").slice(0, 4);
export const isMovie = (m: Media) => (m.media_type ?? (m.release_date ? "movie" : "tv")) === "movie";

export const trending = (week = true) =>
  tmdb<{ results: Media[] }>(`/trending/all/${week ? "week" : "day"}`).then((r) => r.results);

export const popularMovies = () =>
  tmdb<{ results: Media[] }>("/movie/popular").then((r) => r.results);

export const popularTv = () =>
  tmdb<{ results: Media[] }>("/tv/popular").then((r) => r.results);

export const topRatedMovies = () =>
  tmdb<{ results: Media[] }>("/movie/top_rated").then((r) => r.results);

export const upcoming = () =>
  tmdb<{ results: Media[] }>("/movie/upcoming").then((r) => r.results);

export const nowPlaying = () =>
  tmdb<{ results: Media[] }>("/movie/now_playing").then((r) => r.results);

export const search = (q: string) =>
  tmdb<{ results: Media[] }>(
    `/search/multi?query=${encodeURIComponent(q)}&include_adult=false&page=1`,
  ).then((r) => r.results.filter((m) => m.media_type === "movie" || m.media_type === "tv"));

export const movieDetails = (id: number) => tmdb<TitleDetails>(`/movie/${id}`);
export const tvDetails = (id: number) => tmdb<TitleDetails>(`/tv/${id}`);

export const externalIds = (kind: "movie" | "tv", id: number) =>
  tmdb<{ imdb_id?: string | null }>(`/${kind}/${id}/external_ids`);

export const seasonDetails = (id: number, season: number) =>
  tmdb<{ episodes: Episode[] }>(`/tv/${id}/season/${season}`);

export const genres = () => tmdb<{ genres: Genre[] }>("/genre/movie/list").then((r) => r.genres);
