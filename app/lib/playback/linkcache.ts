// Resolved stream links, shared by the player (lib/playback/session.ts)
// and the download queue (lib/downloads.ts `takeLink`): one hidden-page
// resolve serves both, and a next episode resolved ahead of time starts in
// about a second.
//
// Key: `type:id:season:episode:lang:source` (`linkKey`). A link lives until
// min(its URL's own expiry − 60 s, 10 min after it was resolved). Nothing
// is persisted: signed links are short-lived and bound to this session.
//
// No imports from the player (lib/player.ts imports this module).

/** A link as the resolver found it, plus when it was taken. */
export interface CachedLink {
  url: string;
  kind: "hls" | "file";
  /** Request headers for the stream (Referer, Origin, User-Agent, …). */
  headers: Record<string, string>;
  ua: string;
  /** A `Cookie` header value, when the resolver captured one. */
  cookies?: string;
  /** Origin of the frame that fetched the stream, when known. */
  frameOrigin?: string;
  source: string;
  /** When it was resolved (ms). */
  at: number;
  /** When it stops being used (ms): see `linkDeadline`. */
  until: number;
}

export interface LinkRoute {
  type: string;
  id: number;
  season?: number;
  episode?: number;
  lang?: string;
}

/** Most a link is kept, whatever its URL says. */
export const LINK_MAX_MS = 10 * 60_000;
/** A link with a known expiry is dropped this long before it. */
const EXPIRY_MARGIN_MS = 60_000;
const MAX_ENTRIES = 40;

/** `type:id:season:episode:lang:source` — movies 0:0, anime season 0. */
export function linkKey(r: LinkRoute, source: string): string {
  const season = r.type === "tv" ? (r.season ?? 1) : 0;
  const episode = r.type === "movie" ? 0 : (r.episode ?? 1);
  const lang = r.type === "anime" ? (r.lang ?? "sub") : "";
  return `${r.type}:${r.id}:${season}:${episode}:${lang}:${source}`;
}

/** Query parameters CDNs put a unix expiry in. */
const EXPIRY_PARAMS = ["expires", "expire", "expiry", "exp", "e", "expiration", "validto", "valid_to", "deadline", "token_expires", "x-expires"];

/** The expiry a signed URL carries (ms), when one of the usual query
 * parameters holds a plausible unix time (seconds or ms, within a week
 * from `now`); null otherwise. Path-embedded expiries are not guessed. */
export function urlExpiry(url: string, now = Date.now()): number | null {
  // Parsed by hand: only the query string, no URL object needed.
  const qs = url.split("#")[0].split("?").slice(1).join("?");
  const keys = new Map<string, string>();
  for (const part of qs.split("&")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).toLowerCase();
    if (!keys.has(k)) keys.set(k, part.slice(i + 1));
  }
  for (const name of EXPIRY_PARAMS) {
    const raw = keys.get(name);
    if (!raw || !/^\d{9,13}$/.test(raw)) continue;
    let ms = Number(raw);
    if (raw.length <= 10) ms *= 1000;
    if (ms > now - 5 * 60_000 && ms < now + 7 * 24 * 3600_000) return ms;
  }
  return null;
}

/** When a link resolved at `at` stops being used. */
export function linkDeadline(url: string, at: number): number {
  const exp = urlExpiry(url, at);
  const cap = at + LINK_MAX_MS;
  return exp === null ? cap : Math.min(cap, exp - EXPIRY_MARGIN_MS);
}

const links = new Map<string, CachedLink>();

/** Stores a fresh link under `key` (its deadline computed here). */
export function putLink(key: string, link: Omit<CachedLink, "until"> & { until?: number }): CachedLink {
  const full: CachedLink = { ...link, until: link.until ?? linkDeadline(link.url, link.at) };
  links.delete(key);
  links.set(key, full);
  while (links.size > MAX_ENTRIES) {
    const first = links.keys().next().value;
    if (first === undefined) break;
    links.delete(first);
  }
  return full;
}

/** The link stored under `key` while it is fresh; drops a stale one. */
export function getLink(key: string, now = Date.now()): CachedLink | null {
  const l = links.get(key);
  if (!l) return null;
  if (now >= l.until) {
    links.delete(key);
    return null;
  }
  return l;
}

/** Forgets `key` (an expired or refused link: never handed out again). */
export function dropLink(key: string): void {
  links.delete(key);
}

/** A fresh link of this episode from any of `sources` (in their order),
 * else from any source at all when `sources` is omitted. */
export function findLink(r: LinkRoute, sources?: string[], now = Date.now()): CachedLink | null {
  if (sources) {
    for (const s of sources) {
      const l = getLink(linkKey(r, s), now);
      if (l) return l;
    }
    return null;
  }
  const prefix = linkKey(r, "");
  for (const k of [...links.keys()].reverse()) {
    if (!k.startsWith(prefix)) continue;
    const l = getLink(k, now);
    if (l) return l;
  }
  return null;
}

/** Tests only. */
export function __clearLinks(): void {
  links.clear();
}
