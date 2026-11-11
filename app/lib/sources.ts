// Player sources, ported from Streambert's `src/utils/api.js`
// (`PLAYER_SOURCES` / `getSourceUrl`). Each source is an embed page the
// app's WebView loads; `NEEDS_INTERCEPT` sources relied on Electron
// request interception in Streambert and may or may not load here.

export type MediaType = "movie" | "tv" | "anime";

export interface Source {
  id: string;
  label: string;
  tag: string | null;
  note: string | null;
  movieOnly?: boolean;
  supportsAnime?: boolean;
  colorParam: string | null;
  colorWithHash?: boolean;
  langParam: string | null;
  params: Record<string, string>;
  movieUrl: (id: string) => string;
  tvUrl?: (id: string, season: number, ep: number) => string;
  animeUrl?: (anilistId: number, ep: number, lang: "sub" | "dub") => string;
}

export const PLAYER_SOURCES: Source[] = [
  {
    id: "vidsrc",
    label: "VidSrc",
    tag: null,
    note: null,
    colorParam: null,
    langParam: "ds_lang",
    params: { autoplay: "1" },
    movieUrl: (id) => `https://vsembed.su/embed/movie/${id}`,
    tvUrl: (id, s, e) => `https://vsembed.su/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: "vidfast",
    label: "Vidfast",
    tag: null,
    note: null,
    colorParam: "theme",
    langParam: "sub",
    params: { autoPlay: "true", poster: "true", title: "true", pip: "hide" },
    movieUrl: (id) => `https://vidfast.vc/movie/${id}`,
    tvUrl: (id, s, e) => `https://vidfast.vc/tv/${id}/${s}/${e}`,
  },
  {
    id: "vidlove",
    label: "Vidlove",
    tag: null,
    note: null,
    colorParam: "primarycolor",
    langParam: null,
    params: {
      autoplay: "true",
      autonext: "false",
      tour: "true",
      showNextEpisode: "false",
      hideautonext: "true",
      hidenextbutton: "true",
    },
    movieUrl: (id) => `https://player.vidlove.cc/embed/movie/${id}`,
    tvUrl: (id, s, e) => `https://player.vidlove.cc/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: "aether",
    label: "Aether",
    tag: null,
    note: "Multi Lang",
    colorParam: null,
    langParam: null,
    params: {},
    movieUrl: (id) => `https://aether.ist/media/tmdb-movie-${id}`,
    tvUrl: (id, s, e) => `https://aether.ist/media/tmdb-tv-${id}/${s}/${e}`,
  },
  {
    id: "vidrift",
    label: "Vidrift",
    tag: null,
    note: "Multi Lang, Anime",
    colorParam: "brandColor",
    langParam: "sub",
    params: { title: "true", hide: "next,episodes,cast" },
    movieUrl: (id) => `https://embed.vidrift.net/embed/movie/${id}`,
    tvUrl: (id, s, e) => `https://embed.vidrift.net/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: "vidnest",
    label: "Vidnest",
    tag: null,
    note: "Anime",
    colorParam: null,
    langParam: null,
    params: {},
    movieUrl: (id) => `https://vidnest.fun/movie/${id}`,
    tvUrl: (id, s, e) => `https://vidnest.fun/tv/${id}/${s}/${e}`,
    animeUrl: (anilistId, ep, lang) => `https://vidnest.fun/anime/${anilistId}/${ep}/${lang}`,
  },
  {
    id: "devideosrc",
    label: "DeVideoSrc",
    tag: null,
    note: "DE",
    colorParam: "color",
    colorWithHash: true,
    langParam: null,
    params: { autoplay: "1", muted: "0" },
    movieUrl: (id) => `https://devideosrc.co/custom/movie/${id}`,
    tvUrl: (id, s, e) => `https://devideosrc.co/custom/serial/${id}/${s}/${e}`,
  },
  {
    id: "frembed",
    label: "Frembed",
    tag: null,
    note: "FR",
    colorParam: null,
    langParam: null,
    params: {},
    movieUrl: (id) => `https://frembed.uno/embed/movie/${id}`,
    tvUrl: (id, s, e) => `https://frembed.uno/embed/serie/${id}?sa=${s}&epi=${e}`,
  },
  {
    id: "kinohub",
    label: "KinoHub",
    tag: null,
    note: "RU",
    movieOnly: true,
    colorParam: null,
    langParam: null,
    params: {},
    movieUrl: (id) => `https://on.kinohub.vip/movie/${id}`,
  },
];

// Sources that needed a transparent request intercept in Streambert's
// Electron build; the GPUI web view cannot intercept, so they are listed
// but may fail to load.
export const NEEDS_INTERCEPT = ["vidsrc", "devideosrc", "frembed", "kinohub"];

export interface PlayRequest {
  type: MediaType;
  /** TMDB id for movie/tv, AniList id for anime. */
  id: number;
  season?: number;
  episode?: number;
  title?: string;
  poster?: string;
  /** sub | dub for anime. */
  lang?: "sub" | "dub";
}

export function getSourceUrl(
  sourceId: string,
  req: PlayRequest,
  extraParams: Record<string, string> = {},
  accentColor: string | null = null,
  subtitleLang: string | null = null,
): string | null {
  const src = PLAYER_SOURCES.find((s) => s.id === sourceId) ?? PLAYER_SOURCES[0];
  if (!req.id) return null;
  if (req.type !== "movie" && !src.tvUrl && !src.animeUrl) return null;
  if (req.type === "anime" && !src.animeUrl) return null;
  if (req.type !== "anime" && req.type !== "movie" && src.movieOnly) return null;

  let baseUrl: string;
  if (req.type === "anime") {
    baseUrl = src.animeUrl!(req.id, req.episode ?? 1, req.lang ?? "sub");
  } else {
    const s = req.type === "tv" ? (req.season ?? 1) : 0;
    const e = req.type === "tv" ? (req.episode ?? 1) : 0;
    baseUrl =
      req.type === "movie"
        ? src.movieUrl(String(req.id))
        : src.tvUrl!(String(req.id), s, e);
  }

  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(src.params)) url.searchParams.set(k, v);
  if (accentColor && src.colorParam) {
    const hex = accentColor.replace(/^#/, "");
    url.searchParams.set(src.colorParam, src.colorWithHash ? `#${hex}` : hex);
  }
  if (subtitleLang && src.langParam) url.searchParams.set(src.langParam, subtitleLang);
  for (const [k, v] of Object.entries(extraParams)) {
    if (v != null) url.searchParams.set(k, v);
  }
  return url.toString();
}

export function sourcesFor(type: MediaType): Source[] {
  return PLAYER_SOURCES.filter((s) => {
    if (type === "anime") return !!s.animeUrl || s.id === "vidnest";
    if (type === "tv") return !!s.tvUrl && !s.movieOnly;
    return !s.movieOnly || s.id !== "kinohub" ? true : false;
  });
}
