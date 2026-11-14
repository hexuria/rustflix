// The app's caches for Settings → Storage: how much each takes and
// clearing it.
//
// The calls go through `nsh/host` to the embedding app (CacheControls.swift
// on iOS, `mod cache` in src/main.rs on the desktop), gated by
// capabilities.host "cache.*". Where there is no host every function is a
// safe no-op, and none of them ever throws into UI code.

import { host, signal } from "nsh";
import { clearCache as clearApiCache } from "./tmdb";

export type CacheKind = "images" | "web" | "site";
export type CacheSizes = { images: number; web: number; site: number };

const ZERO: CacheSizes = { images: 0, web: 0, site: 0 };

let hostUp = false;
try {
  hostUp = host.available();
} catch {}

/** False once the host turned out not to handle `cache.*` (an older shell). */
const handled = signal(true);

/** True where the embedding app reports and clears the caches. Reactive. */
export function cacheAvailable(): boolean {
  return hostUp && handled();
}

const bytes = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The bytes each cache takes on this device; zeros when unavailable. */
export async function cacheInfo(): Promise<CacheSizes> {
  if (!cacheAvailable()) return ZERO;
  try {
    const r = (await host.call("cache.info")) as Partial<Record<CacheKind, unknown>> | null;
    return { images: bytes(r?.images), web: bytes(r?.web), site: bytes(r?.site) };
  } catch (e) {
    // "the embedding app handles no cache.info": hide the feature.
    if (String(e).includes("handles no")) handled.set(false);
    return ZERO;
  }
}

/** Clears one cache; resolves to the bytes freed (0 when unavailable). */
export async function clearCache(what: CacheKind): Promise<number> {
  if (!cacheAvailable()) return 0;
  let freed = 0;
  try {
    const r = (await host.call("cache.clear", { what })) as { freed?: unknown } | null;
    freed = bytes(r?.freed);
  } catch {}
  // Lists refetch, so their posters load (and cache) again.
  if (what === "images") clearApiCache();
  return freed;
}

/** "0 KB", "640 KB", "4.2 MB", "184 MB", "2.8 GB" (decimal units, as the
 * system shows sizes). */
export function formatBytes(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  const fmt = (x: number, unit: string) =>
    `${x < 10 && x > 0 && Math.round(x * 10) % 10 !== 0 ? x.toFixed(1) : Math.round(x)} ${unit}`;
  if (v >= 1e9) return fmt(v / 1e9, "GB");
  if (v >= 1e6) return fmt(v / 1e6, "MB");
  if (v === 0) return "0 KB";
  return `${Math.max(1, Math.round(v / 1e3))} KB`;
}
