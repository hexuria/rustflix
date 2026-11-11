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
  status?: string;
  seasonYear?: number | null;
  averageScore?: number | null;
  genres?: string[];
  format?: string;
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
  episodes status seasonYear averageScore format
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
