// AniList GraphQL client, as Streambert uses AniList for anime metadata.
// One POST to graphql.anilist.co; no key needed.

const API = "https://graphql.anilist.co";

export interface AniMedia {
  id: number;
  idMal?: number;
  title: { romaji: string; english?: string | null; native?: string | null };
  coverImage: { large: string; extraLarge?: string };
  bannerImage?: string | null;
  description?: string | null;
  episodes?: number | null;
  /** Airing shows: the next episode to air (so `episode - 1` have aired). */
  nextAiringEpisode?: { episode: number } | null;
  status?: string;
  seasonYear?: number | null;
  averageScore?: number | null;
  genres?: string[];
  format?: string;
  /** Minutes per episode. */
  duration?: number | null;
  episodesCount?: never;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data as T;
}

const MEDIA_FIELDS = `
  id idMal
  title { romaji english native }
  coverImage { large extraLarge }
  bannerImage
  description(asHtml: false)
  episodes status seasonYear averageScore format duration
  nextAiringEpisode { episode }
  genres
`;

export function aniTitle(m: AniMedia): string {
  return m.title.english ?? m.title.romaji;
}

export async function aniSearch(q: string, page = 1): Promise<AniMedia[]> {
  const data = await gql<{ Page: { media: AniMedia[] } }>(
    `query ($q: String, $page: Int) {
      Page(page: $page, perPage: 24) {
        media(search: $q, type: ANIME, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_FIELDS} }
      }
    }`,
    { q, page },
  );
  return data.Page.media;
}

export async function aniTrending(page = 1): Promise<AniMedia[]> {
  const data = await gql<{ Page: { media: AniMedia[] } }>(
    `query ($page: Int) {
      Page(page: $page, perPage: 16) {
        media(type: ANIME, sort: TRENDING_DESC, isAdult: false) { ${MEDIA_FIELDS} }
      }
    }`,
    { page },
  );
  return data.Page.media;
}

export async function aniDetails(id: number): Promise<AniMedia> {
  const data = await gql<{ Media: AniMedia }>(
    `query ($id: Int) {
      Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} }
    }`,
    { id },
  );
  return data.Media;
}

const malIds = new Map<number, number | null>();

/** MyAnimeList id for an AniList id (AniSkip keys on it); null when
 * AniList has none. Cached per id. */
export async function aniMalId(id: number): Promise<number | null> {
  if (malIds.has(id)) return malIds.get(id) ?? null;
  const data = await gql<{ Media: { idMal?: number | null } | null }>(
    `query ($id: Int) {
      Media(id: $id, type: ANIME) { idMal }
    }`,
    { id },
  );
  const mal = data.Media?.idMal ?? null;
  malIds.set(id, mal);
  return mal;
}

// --- Episodes ----------------------------------------------------------------------
//
// Per-episode titles, stills, synopses, air dates and runtimes, merged from
// two sources (measured on the test shows, Nov 2026):
//   - ani.zip (`api.ani.zip/mappings?anilist_id=`), a free community
//     mapping service many anime apps use: TheTVDB's episodes by absolute
//     number — ONE PIECE 1180/1184 titles, 1171 stills and synopses; Mob
//     Psycho 100 12/12; Firefly Wedding 6 of 8 listed (the aired ones).
//     Optional: a timeout or an error just leaves it out.
//   - AniList's `streamingEpisodes` (licensed streams only): ONE PIECE 69,
//     Mob Psycho 100 12, Firefly Wedding 0 — a per-episode fallback.
// Both are fetched once per title per session (failures are not kept, so a
// later visit asks again); the page never waits on them.

export interface AniEpisode {
  /** Episode number (absolute, as the player and the sources count). */
  n: number;
  title: string;
  overview: string;
  /** Still (16:9 screencap), "" when none is known. */
  image: string;
  /** "2024-04-07", "" when unknown. */
  airDate: string;
  /** Minutes, null when unknown. */
  runtime: number | null;
}

export interface AniEpisodeData {
  /** By episode number. */
  episodes: Map<number, AniEpisode>;
  /** Episodes aired so far by the mapping's air dates (null: unknown). */
  aired: number | null;
}

const MAPPING_API = "https://api.ani.zip/mappings";
const MAPPING_TIMEOUT_MS = 10_000;

type ZipEpisode = {
  episode?: string;
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
  title?: Record<string, string | null> | null;
  overview?: string | null;
  summary?: string | null;
  image?: string | null;
  airDate?: string | null;
  airdate?: string | null;
  runtime?: number | null;
  length?: number | null;
};

async function zipEpisodes(id: number): Promise<Map<number, AniEpisode>> {
  const res = await Promise.race([
    fetch(`${MAPPING_API}?anilist_id=${id}`, { headers: { Accept: "application/json" } }),
    new Promise<null>((done) => setTimeout(() => done(null), MAPPING_TIMEOUT_MS)),
  ]);
  if (!res || !res.ok) throw new Error(`ani.zip ${res ? res.status : "timeout"}`);
  const body = (await res.json()) as { episodes?: Record<string, ZipEpisode> } | null;
  const out = new Map<number, AniEpisode>();
  for (const [k, e] of Object.entries(body?.episodes ?? {})) {
    // Specials ("S1") are not numbered episodes of the main list.
    if (!/^\d+$/.test(k)) continue;
    const n = Number(k);
    const t = e.title ?? {};
    out.set(n, {
      n,
      title: (t.en || t["x-jat"] || "").trim(),
      overview: (e.overview || e.summary || "").trim(),
      image: e.image || "",
      airDate: (e.airDate || e.airdate || "").slice(0, 10),
      runtime: e.runtime || e.length || null,
    });
  }
  return out;
}

async function streamingEpisodes(id: number): Promise<Map<number, AniEpisode>> {
  const data = await gql<{ Media: { streamingEpisodes?: { title?: string; thumbnail?: string }[] } | null }>(
    `query ($id: Int) { Media(id: $id, type: ANIME) { streamingEpisodes { title thumbnail } } }`,
    { id },
  );
  const out = new Map<number, AniEpisode>();
  for (const s of data.Media?.streamingEpisodes ?? []) {
    // "Episode 4 - The Title"
    const m = /^Episode\s+(\d+)\s*[-–:]\s*(.*)$/i.exec(s.title ?? "");
    if (!m) continue;
    const n = Number(m[1]);
    out.set(n, { n, title: m[2].trim(), overview: "", image: s.thumbnail || "", airDate: "", runtime: null });
  }
  return out;
}

const episodeCache = new Map<number, Promise<AniEpisodeData>>();

/** The title's per-episode data (both sources merged: the mapping first,
 * AniList's streams for what it lacks). Never rejects: a source that
 * fails is left out. */
export function aniEpisodes(id: number): Promise<AniEpisodeData> {
  const hit = episodeCache.get(id);
  if (hit) return hit;
  const p = (async () => {
    const [zip, streams] = await Promise.all([
      zipEpisodes(id).catch(() => null),
      streamingEpisodes(id).catch(() => null),
    ]);
    if (!zip && !streams) throw new Error("no episode data");
    const episodes = new Map<number, AniEpisode>(zip ?? []);
    for (const [n, s] of streams ?? []) {
      const z = episodes.get(n);
      if (!z) episodes.set(n, s);
      else {
        if (!z.title) z.title = s.title;
        if (!z.image) z.image = s.image;
      }
    }
    let aired: number | null = null;
    if (zip && zip.size > 0) {
      const today = new Date().toISOString().slice(0, 10);
      aired = 0;
      for (const e of zip.values()) if (e.airDate && e.airDate <= today && e.n > aired) aired = e.n;
      if (aired === 0) aired = null;
    }
    return { episodes, aired };
  })();
  episodeCache.set(id, p);
  // A failure is not kept: the next visit asks again.
  p.catch(() => episodeCache.delete(id));
  return p.catch(() => ({ episodes: new Map(), aired: null }));
}

/** How many episodes of `m` can be listed: AniList's count when finished,
 * the aired ones while airing (`nextAiringEpisode − 1`), else the
 * mapping's aired count, else the furthest episode watched, else 12. */
export function aniEpisodeCount(m: AniMedia, data?: AniEpisodeData | null, watchedMax = 0): number {
  const next = m.nextAiringEpisode?.episode;
  let n = 0;
  if (next && next > 1) n = next - 1;
  else if (m.episodes) n = m.episodes;
  else if (data?.aired) n = data.aired;
  else if (data && data.episodes.size > 0) n = Math.max(...data.episodes.keys());
  if (!n) n = 12;
  return Math.max(n, watchedMax, 1);
}
