// Title page: details, seasons/episodes, watchlist toggle, play.
// Movie/TV metadata from TMDB; anime from AniList.
//
// Phone: the header image runs to the top of the screen under a
// transparent system header (its back button floats over the image), and
// everything else is one full-width column on a 16 pt gutter. The header
// has a fixed aspect ratio and the action buttons exist from the first
// frame, so nothing above the fold moves when the details arrive. Desktop:
// the wide layout, the poster beside the text.

import {
  cleanup,
  computed,
  createAnimatedValue,
  Easing,
  effect,
  Image,
  platform,
  safeAreaInsets,
  Scroll,
  signal,
  Storage,
  Text,
  View,
  untracked,
  windowSize,
  type ScrollRef,
  type ViewRef,
} from "nsh";
import {
  aniDetails,
  aniEpisodeCount,
  aniEpisodes,
  aniTitle,
  type AniEpisodeData,
  type AniMedia,
} from "../lib/anilist";
import { goTitle, navigate, setPageLeaver, type HeroRect, type Route } from "../lib/router";
import { flyPoster, heroMs, onScreen, setHeroMs } from "../lib/hero";
import { inWatchlist, motionReduced, progress, toggleWatchlist, type Progress } from "../lib/store";
import {
  canDownload,
  downloadFor,
  enqueueMany,
  titleDownloads,
  type DlEntry,
  type DlTarget,
} from "../lib/downloads";
import { debug, notify, preferredAnimeLang } from "../lib/player";
import {
  imgUrl,
  movieDetails,
  seasonDetails,
  title as mediaTitle,
  tvDetails,
  year,
  type Episode,
  type Season,
  type TitleDetails,
} from "../lib/tmdb";
import {
  Badge,
  Button,
  Chip,
  chooseAction,
  DownloadAction,
  DownloadButton,
  episodeLabel,
  openDownloadMenu,
  rememberPoster,
  resumable,
  resumeRoute,
  Section,
  Skeleton,
} from "../lib/ui";

type TitleRoute = Extract<Route, { name: "title" }>;

const desktop = platform.desktop;

/** The page's one horizontal gutter. */
const GUTTER = desktop ? 32 : 16;
/** The phone header's width over its height. */
const HEADER_RATIO = 4 / 3;
/** The desktop header's height. */
const DESKTOP_HEADER = 340;

/** Not downloaded (or failed): worth queueing. */
function missing(e: DlEntry | null): boolean {
  return !e || e.state === "error";
}


// --- Coming in and going back ------------------------------------------------------
//
// Phones: the platform's own push and pop (iOS slide with the interactive
// swipe back, Android's), nothing of ours. Desktop: the screen fades
// (GPUI's 200 ms ease-out cross-fade, `animation="fade"`) while the page's
// content is under a veil of the page's colour, so the old page fades out
// alone; the veil then lifts (ease-out) over the second half. Opened from
// a poster card, that card's poster flies into the page's poster slot
// meanwhile (lib/hero.tsx) and lands on it exactly; Back runs it the other
// way. Images are never faded on the desktop (GPUI fades a picture by
// uploading sixteen copies of it): veils, plain quads, fade over them.

/** The veil lifts from this share of the flight to `VEIL_END`. */
const VEIL_START = 0.45;
const VEIL_END = 0.92;
/** Going back, the veil covers the page over this share of the flight
 * (ease-in) before the page goes. */
const VEIL_BACK = 0.4;
/** How long the header's veil takes to lift once the backdrop is in. */
const HEADER_FADE_MS = 220;
/** The poster slot of the desktop layout (the flight lands on it). */
const POSTER_W = 180;
const POSTER_H = 270;
const POSTER_RADIUS = 10;

/** Debug: the header's image is asked for this much later (a slow image). */
let headerDelayMs = 0;

// --- Debug start route ---------------------------------------------------------------
//
// Storage `rustflix.opentitle` = JSON `{ "type": "tv", "id": 84773,
// "scroll": "episodes", "image": "<poster url>", "backdrop": "<url>",
// "title": "…", "from": { "x": 16, "y": 400, "w": 140, "h": 210 },
// "heroMs": 3000, "headerDelayMs": 1000, "delay": 1500, "keep": true }`
// opens that title page once the app is up (`delay` ms after boot, 1200 by
// default), optionally scrolled to its episodes (or to a y offset).
// `heroMs` slows the desktop's poster flight and page fades down (also
// for later taps: it stays for the session); `headerDelayMs` asks for the
// header's image that much later (a slow image). Removed after one run
// unless `keep`.

const OPEN_KEY = "rustflix.opentitle";

/** A scroll the debug hook asked of a title page (`type:id`). */
const pendingScroll = new Map<string, "episodes" | number>();

export async function runOpenTitleTest() {
  let raw: string | null = null;
  try {
    raw = await Storage.getItem(OPEN_KEY);
  } catch {}
  if (!raw) return;
  let req: {
    type?: "movie" | "tv" | "anime";
    id?: number;
    scroll?: "episodes" | number;
    image?: string;
    title?: string;
    backdrop?: string;
    from?: HeroRect;
    heroMs?: number;
    zoomMs?: number;
    headerDelayMs?: number;
    delay?: number;
    keep?: boolean;
  };
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req.keep) {
    try {
      await Storage.removeItem(OPEN_KEY);
    } catch {}
  }
  if (!req.type || !req.id) return;
  if (req.heroMs || req.zoomMs) setHeroMs(req.heroMs || req.zoomMs || 360);
  if (req.headerDelayMs) headerDelayMs = req.headerDelayMs;
  if (req.scroll != null) pendingScroll.set(`${req.type}:${req.id}`, req.scroll);
  const type = req.type;
  const id = req.id;
  setTimeout(
    () =>
      goTitle(type, id, {
        image: req.image,
        backdrop: req.backdrop,
        title: req.title,
        from: req.from,
      }),
    req.delay ?? 1200,
  );
}

/** Scrolls the newest title page (the perf scenario's `tscroll`). */
let lastTitleScroll: ((y: number) => void) | undefined;
export function scrollTitleTo(y: number) {
  lastTitleScroll?.(y);
}

// --- Pieces ----------------------------------------------------------------------------

/** Long text that folds to `lines` lines, with "More" / "Less" under it when
 * it is longer (counted on a hidden copy of the whole text). */
function FoldingText(props: { text: string; lines: number }) {
  const open = signal(false);
  const total = signal(0);
  return (
    <View class="relative gap-1">
      <Text
        class="text-zinc-200"
        style={{ fontSize: 15, lineHeight: 22, numberOfLines: open() ? 0 : props.lines }}
      >
        {props.text}
      </Text>
      {/* The whole text, laid out out of sight, to count its lines. */}
      <Text
        class="pointer-events-none absolute left-0 right-0 top-0 opacity-0"
        accessibilityElementsHidden
        style={{ fontSize: 15, lineHeight: 22 }}
        onTextLayout={(e: { lines: unknown[] }) => total.set(e.lines.length)}
      >
        {props.text}
      </Text>
      <If when={total() > props.lines}>
        <View
          role="button"
          accessibilityLabel={open() ? "Show less" : "Show more"}
          onPress={() => open.set(!open())}
          class="cursor-pointer self-start justify-center active:opacity-60"
          style={{ height: 32 }}
        >
          <Text class="font-semibold text-foreground" style={{ fontSize: 14, lineHeight: 18 }}>
            {open() ? "Less" : "More"}
          </Text>
        </View>
      </If>
    </View>
  );
}

/** What an episode row shows, from TMDB (TV) or the anime sources. */
interface RowEp {
  n: number;
  name: string;
  /** Full image URL, "" when none. */
  still: string;
  /** The still is the show's artwork standing in (no episode still known):
   * drawn dimmed. */
  stand?: boolean;
  airDate: string;
  runtime: number | null;
  overview: string;
}

function tvRowEp(ep: Episode): RowEp {
  return {
    n: ep.episode_number,
    name: ep.name ?? "",
    still: imgUrl(ep.still_path, "w300") || "",
    airDate: ep.air_date?.slice(0, 10) ?? "",
    runtime: ep.runtime ?? null,
    overview: ep.overview ?? "",
  };
}

/** One episode: still (16:9) with its watch progress, "n. Title" on up to
 * two lines, date · runtime, three lines of description, the download
 * control at the right. Full-bleed pressed state; contents on the gutter.
 * TV and anime alike. `note`: a short extra line ("Dub downloaded"). */
function EpisodeRow(props: {
  ep: RowEp;
  watched: number | null;
  selected: boolean;
  note?: string;
  target: () => DlTarget;
  onPress: () => void;
}) {
  const thumbW = desktop ? 176 : 128;
  const thumbH = Math.round((thumbW * 9) / 16);
  const meta = computed(() =>
    [props.ep.airDate, props.ep.runtime ? `${props.ep.runtime}m` : "", props.note ?? ""]
      .filter(Boolean)
      .join(" · "),
  );
  const title = computed(() => `${props.ep.n}. ${props.ep.name || `Episode ${props.ep.n}`}`);
  return (
    <View
      role="button"
      accessibilityLabel={`Episode ${props.ep.n}${props.ep.name ? `, ${props.ep.name}` : ""}`}
      onPress={props.onPress}
      class="cursor-pointer flex-row items-center gap-3 hover:bg-white/5 active:bg-white/10"
      style={{
        marginLeft: -GUTTER,
        marginRight: -GUTTER,
        paddingLeft: GUTTER,
        paddingRight: GUTTER,
        paddingTop: 10,
        paddingBottom: 10,
      }}
    >
      <View
        class="self-start overflow-hidden bg-white/10"
        style={{ width: thumbW, height: thumbH, borderRadius: 6 }}
      >
        <If when={props.ep.still}>
          <Image
            src={props.ep.still}
            style={{ width: thumbW, height: thumbH, objectFit: "cover", opacity: props.ep.stand ? 0.45 : 1 }}
          />
        </If>
        <If when={props.ep.stand}>
          <View class="absolute inset-0 items-center justify-center">
            <Text class="font-bold text-white/80" style={{ fontSize: 18, lineHeight: 22 }}>
              {String(props.ep.n)}
            </Text>
          </View>
        </If>
        <If when={props.watched != null}>
          <View class="absolute bottom-0 left-0 right-0 bg-black/60" style={{ height: 3 }}>
            <View class="bg-primary" style={{ height: 3, width: `${props.watched ?? 0}%` }} />
          </View>
        </If>
      </View>
      <View class="flex-1 gap-1 self-start">
        <Text
          class={`font-semibold ${props.selected ? "text-primary" : "text-foreground"}`}
          style={{ fontSize: 15, lineHeight: 20, numberOfLines: 2 }}
        >
          {title()}
        </Text>
        <If when={meta()}>
          <Text class="text-muted-foreground" style={{ fontSize: 12, lineHeight: 16, numberOfLines: 1 }}>
            {meta()}
          </Text>
        </If>
        <If when={props.ep.overview}>
          <Text class="text-muted-foreground" style={{ fontSize: 13, lineHeight: 18, numberOfLines: 3 }}>
            {props.ep.overview}
          </Text>
        </If>
      </View>
      {/* The mark's right edge on the gutter: its 44 pt hit area reaches
          past it by the slack around the 24 pt mark. */}
      <View style={{ marginRight: -10 }}>
        <DownloadButton target={props.target} size={24} />
      </View>
    </View>
  );
}

/** Placeholder rows while a season's episodes load. */
function EpisodeSkeletons() {
  const thumbW = desktop ? 176 : 128;
  const thumbH = Math.round((thumbW * 9) / 16);
  return (
    <Each of={[0, 1, 2]} key="index">
      {() => (
        <View class="flex-row gap-3" style={{ paddingTop: 10, paddingBottom: 10 }}>
          <Skeleton width={thumbW} height={thumbH} radius={6} />
          <View class="flex-1 gap-2 pt-1">
            <Skeleton width="70%" height={14} radius={4} />
            <Skeleton width="40%" height={10} radius={4} />
            <Skeleton width="90%" height={10} radius={4} />
          </View>
        </View>
      )}
    </Each>
  );
}

function ErrorLine(props: { message: string; onRetry: () => void }) {
  return (
    <View class="flex-row items-center gap-3">
      <Text class="flex-1 text-red-400" style={{ fontSize: 14, lineHeight: 20 }}>
        {props.message}
      </Text>
      <Button size="sm" icon="retry" label="Retry" onPress={props.onRetry} />
    </View>
  );
}

// --- The page ----------------------------------------------------------------------------

// One title page. Its route comes from the page stack (not the global
// route): pages stay mounted under others and under the player, so each
// keeps its own state and loads its own title.
export function Title(props: { route: TitleRoute }) {
  const t = props.route;
  const details = signal<TitleDetails | null>(null);
  const anime = signal<AniMedia | null>(null);
  const seasons = signal<Season[]>([]);
  const episodes = signal<Episode[]>([]);
  const selectedSeason = signal(1);
  const selectedEp = signal(1);
  const loading = signal(true);
  const seasonLoading = signal(false);
  const error = signal("");
  const seasonError = signal("");
  const animeLang = signal<"sub" | "dub">(preferredAnimeLang() ?? "sub");
  // Only the newest request of each kind may write: a retry or a season
  // picked while another is loading never shows the older answer.
  let loadSeq = 0;
  let seasonSeq = 0;

  function play(r: TitleRoute) {
    if (r.type === "anime") {
      navigate({
        name: "player",
        type: r.type,
        id: r.id,
        episode: selectedEp(),
        lang: animeLang(),
        title: anime() ? aniTitle(anime()!) : t.title,
        poster: anime()?.coverImage.large ?? t.image,
      });
      return;
    }
    const d = details();
    const isTv = r.type === "tv";
    navigate({
      name: "player",
      type: r.type,
      id: r.id,
      season: isTv ? selectedSeason() : undefined,
      episode: isTv ? selectedEp() : undefined,
      title: d ? mediaTitle(d) : t.title,
      poster: d ? imgUrl(d.poster_path, "w342") : t.image,
      next: isTv ? nextEpisode() : undefined,
    });
  }

  /** The episode after the selected one, across seasons. */
  function nextEpisode(): { season?: number; episode?: number } | undefined {
    const eps = episodes();
    const s = seasons();
    const si = s.findIndex((x) => x.season_number === selectedSeason());
    const cur = eps.find((e) => e.episode_number === selectedEp());
    if (!cur) return undefined;
    const nextEp = eps.find((e) => e.episode_number === cur.episode_number + 1);
    if (nextEp) return { season: selectedSeason(), episode: nextEp.episode_number };
    const nextSeason = s[si + 1];
    if (nextSeason && nextSeason.season_number > 0) {
      return { season: nextSeason.season_number, episode: 1 };
    }
    return undefined;
  }

  // A season's episodes; a failure shows under the season picker with
  // Retry (`retrySeason`), the initial load's and a switch's alike.
  async function loadSeason(id: number, n: number) {
    const seq = ++seasonSeq;
    seasonError.set("");
    seasonLoading.set(true);
    try {
      const data = await seasonDetails(id, n);
      if (seq === seasonSeq) episodes.set(data.episodes ?? []);
    } catch (e) {
      if (seq !== seasonSeq) return;
      episodes.set([]);
      seasonError.set(String(e));
    } finally {
      if (seq === seasonSeq) seasonLoading.set(false);
    }
  }

  function retrySeason() {
    const d = details();
    if (d) void loadSeason(d.id, selectedSeason());
  }

  function pickSeason(n: number) {
    if (n === selectedSeason() && episodes().length > 0) return;
    selectedSeason.set(n);
    selectedEp.set(1);
    const d = details();
    if (!d) return;
    episodes.set([]);
    void loadSeason(d.id, n);
  }

  // Loads the title; again after a failure (Retry).
  function load() {
    const seq = ++loadSeq;
    const current = () => seq === loadSeq;
    seasonSeq++;
    loading.set(true);
    error.set("");
    seasonError.set("");
    details.set(null);
    anime.set(null);
    seasons.set([]);
    episodes.set([]);
    selectedSeason.set(1);
    selectedEp.set(1);
    animeLang.set(preferredAnimeLang() ?? "sub");

    if (t.type === "anime") {
      aniDetails(t.id)
        .then((m) => {
          if (!current()) return;
          anime.set(m);
          selectedEp.set(1);
        })
        .catch((e) => {
          if (current()) error.set(String(e));
        })
        .finally(() => {
          if (current()) loading.set(false);
        });
      return;
    }

    const fetchDetails = t.type === "movie" ? movieDetails : tvDetails;
    fetchDetails(t.id)
      .then(async (d) => {
        if (!current()) return;
        details.set(d);
        if (t.type === "tv") {
          const list = (d.seasons ?? []).filter((s) => s.season_number > 0);
          seasons.set(list);
          const first = list[0]?.season_number ?? 1;
          selectedSeason.set(first);
          await loadSeason(d.id, first);
        }
      })
      .catch((e) => {
        if (current()) error.set(String(e));
      })
      .finally(() => {
        if (current()) loading.set(false);
      });
  }

  load();

  const d = computed(() => details());
  const a = computed(() => anime());
  const isAnime = () => t.type === "anime";
  const loaded = computed(() => (isAnime() ? !!a() : !!d()));
  const displayTitle = computed(() =>
    isAnime() ? (a() ? aniTitle(a()!) : (t.title ?? "")) : d() ? mediaTitle(d()!) : (t.title ?? ""),
  );
  const poster = computed(() =>
    isAnime() ? a()?.coverImage.large : d() ? imgUrl(d()!.poster_path, "w342") : "",
  );
  // Downloads saved without artwork show this poster (resolved at render).
  effect(() => rememberPoster(t.type, t.id, poster()));
  const backdrop = computed(() =>
    isAnime()
      ? a()?.bannerImage || a()?.coverImage.extraLarge || ""
      : d()
        ? imgUrl(d()!.backdrop_path, "w1280")
        : "",
  );
  /** The poster slot's image (desktop) and the flight's: the card's poster
   * (the URL the details resolve to), else the details'. */
  const posterImage = computed(() => t.image || poster() || "");

  /** The header's image: the backdrop and nothing else — from the card's
   * list (asked for before the details load), else from the details. A
   * title with no backdrop shows its poster, from the first frame it is
   * known. Until then the header is the page's colour with its gradient;
   * the image fades in once. Never one image and then another. */
  const headerAsked = signal(headerDelayMs <= 0);
  if (headerDelayMs > 0) setTimeout(() => headerAsked.set(true), headerDelayMs);
  const headerImage = computed(() => {
    if (!headerAsked()) return "";
    if (t.backdrop) return t.backdrop;
    if (t.backdrop === "") return posterImage();
    if (!loaded()) return "";
    return backdrop() || poster() || "";
  });

  // Desktop: the screen's fade with the content under a veil, and the
  // poster's flight (see "Coming in and going back"). Reduce Motion: GPUI's
  // plain cross-fade, no veil, no flight.
  const fades = desktop && !motionReduced();
  const flies = fades && !!t.from && !!t.image;
  const veil = createAnimatedValue(fades ? 1 : 0);
  if (fades) {
    void veil.timing(0, {
      delay: Math.round(heroMs * VEIL_START),
      duration: Math.round(heroMs * (VEIL_END - VEIL_START)),
      easing: Easing.out(Easing.cubic),
    });
  }
  /** The real poster shows (the flight has landed on it). */
  const posterShown = signal(!flies);
  /** The header's image is made once the screen's fade is over: GPUI fades
   * a picture by uploading sixteen copies of it. Going back, it goes before
   * the screen fades out. */
  const settled = signal(!fades);
  if (fades) setTimeout(() => settled.set(true), Math.max(heroMs, 230));
  const leaving = signal(false);
  /** The header's own veil (desktop): lifts once its image has loaded. */
  const headerVeil = createAnimatedValue(desktop ? 1 : 0);
  let headerLifted = false;
  const liftHeader = () => {
    if (headerLifted || !desktop) return;
    headerLifted = true;
    if (motionReduced()) headerVeil.set(0);
    else void headerVeil.timing(0, { duration: HEADER_FADE_MS, easing: Easing.out(Easing.cubic) });
  };

  let posterRef: ViewRef | undefined;
  const rectOf = (m: { bounds: { size: { width: number; height: number } }; pagePosition: { x: number; y: number } } | null) =>
    m ? { x: m.pagePosition.x, y: m.pagePosition.y, w: m.bounds.size.width, h: m.bounds.size.height } : null;

  if (flies) {
    // After the page's first layout: where its poster slot really is, in
    // this window at its size (sidebar, title bar and scroll included).
    setTimeout(() => {
      const ref = posterRef;
      if (!ref) {
        posterShown.set(true);
        return;
      }
      ref
        .measure()
        .then((m) => {
          const to = rectOf(m);
          if (!to || !t.from || !t.image) {
            posterShown.set(true);
            return;
          }
          if (Math.abs(to.w - POSTER_W) > 0.5 || Math.abs(to.h - POSTER_H) > 0.5) {
            debug("title: poster slot is not the size the layout sets", JSON.stringify(to));
          }
          void flyPoster(t.image, t.from, to, POSTER_RADIUS, () => posterShown.set(true), t.sourceKey);
        })
        .catch(() => posterShown.set(true));
    }, 0);
  }

  if (fades) {
    // Back: the content goes under the veil (ease-in) while the poster flies
    // back to its card, when both are on screen; then the page goes (GPUI's
    // fade of a page that is only its colour by then: the page below fades
    // in) and the poster lands on the card.
    setPageLeaver(t, async () => {
      const src = t.source;
      const img = posterImage();
      if (posterShown() && img && src && posterRef) {
        const [slot, card] = await Promise.all([posterRef.measure(), src.measure()]).catch(
          () => [null, null] as const,
        );
        const a = rectOf(slot);
        const b = rectOf(card);
        const win = windowSize();
        if (a && b && onScreen(a, win) && onScreen(b, win)) {
          posterShown.set(false);
          void flyPoster(img, a, b, 8, undefined, t.sourceKey);
        }
      }
      await veil.timing(1, {
        duration: Math.round(heroMs * VEIL_BACK),
        easing: Easing.in(Easing.cubic),
      });
      leaving.set(true);
      await new Promise((done) => setTimeout(done, 20));
    });
    cleanup(() => setPageLeaver(t, null));
  }

  // Everything under the actions (overview, seasons, episodes) is made
  // only once the page has come in: the transition's frames carry the
  // header, heading and buttons alone. Desktop: once the flight / fade has
  // landed; a phone's push: once it has slid in.
  const bodyReady = signal(false);
  setTimeout(() => bodyReady.set(true), fades ? heroMs : desktop ? 0 : 320);

  const inList = computed(() => inWatchlist(t.type, t.id));
  // Adding needs the loaded name and poster (they are stored with the
  // entry); removing works at once.
  const canToggleList = computed(() => inList() || loaded());

  const toggleList = () => {
    if (!canToggleList()) return;
    const item = isAnime()
      ? {
          type: "anime" as const,
          id: t.id,
          title: a() ? aniTitle(a()!) : (t.title ?? ""),
          poster: a()?.coverImage.large ?? "",
          year: a()?.seasonYear ? String(a()!.seasonYear) : undefined,
        }
      : {
          type: t.type as "movie" | "tv",
          id: t.id,
          title: d() ? mediaTitle(d()!) : (t.title ?? ""),
          poster: d() ? imgUrl(d()!.poster_path, "w342") : "",
          year: d() ? year(d()!) : undefined,
        };
    void toggleWatchlist(item);
  };

  // --- Anime episodes ------------------------------------------------------------
  //
  // Titles, stills, synopses, air dates and runtimes per episode
  // (lib/anilist.ts aniEpisodes: ani.zip + AniList's streams), asked for
  // once the page has come in (never before the transition lands, never
  // waited on); until then — and for episodes nothing is known about —
  // a row says "Episode N" over the show's artwork, dimmed.
  const aniEps = signal<AniEpisodeData | null>(null);
  effect(() => {
    if (!isAnime() || !a() || !bodyReady()) return;
    untracked(() => {
      if (aniEps()) return;
      void aniEpisodes(t.id).then((data) => aniEps.set(data));
    });
  });
  /** The furthest episode with saved progress (lists never end before it). */
  const watchedMax = computed(() => {
    let n = 0;
    for (const p of progress()) if (p.type === "anime" && p.id === t.id) n = Math.max(n, p.episode || 1);
    return n;
  });
  /** Every aired episode: long-running shows list them all (in ranges). */
  const animeCount = computed(() => {
    const m = a();
    return m ? aniEpisodeCount(m, aniEps(), watchedMax()) : 0;
  });
  /** Ranges of RANGE episodes for long shows ("1–100", "101–200", …). */
  const RANGE = 100;
  const rangeCount = computed(() => Math.ceil(animeCount() / RANGE));
  const range = signal(0);
  /** The range opens on the next episode to watch, once (then the user's). */
  let rangePicked = false;
  effect(() => {
    const total = animeCount();
    if (rangePicked || total <= RANGE) return;
    const mine = progress()
      .filter((p) => p.type === "anime" && p.id === t.id)
      .sort((x, y) => y.updatedAt - x.updatedAt)[0];
    let next = 1;
    if (mine) {
      const done = mine.duration > 0 && mine.position >= mine.duration * 0.95;
      next = Math.min((mine.episode || 1) + (done ? 1 : 0), total);
    }
    untracked(() => range.set(Math.floor((next - 1) / RANGE)));
  });
  const rangeLabel = (i: number) =>
    `${i * RANGE + 1}–${Math.min(animeCount(), (i + 1) * RANGE)}`;
  /** The rows of the range shown. */
  const animeRows = computed<RowEp[]>(() => {
    const m = a();
    if (!m) return [];
    const data = aniEps()?.episodes;
    const stand = m.bannerImage || m.coverImage.extraLarge || m.coverImage.large || "";
    const from = range() * RANGE + 1;
    const to = Math.min(animeCount(), from + RANGE - 1);
    const rows: RowEp[] = [];
    for (let n = from; n <= to; n++) {
      const e = data?.get(n);
      rows.push({
        n,
        name: e?.title ?? "",
        still: e?.image || stand,
        stand: !e?.image,
        airDate: e?.airDate ?? "",
        runtime: e?.runtime ?? m.duration ?? null,
        overview: e?.overview ?? "",
      });
    }
    return rows;
  });

  // Long lists grow over a few frames instead of in one commit: the
  // first EP_FIRST rows (a screenful and more), then EP_STEP more every
  // frame or two. Rows keep their identity, so nothing is made twice.
  // Small steps: each is one engine commit applied in one main-thread
  // wake-up, kept under a refresh (rows are ~20 views each).
  const EP_FIRST = 4;
  const EP_STEP = 4;
  const epShown = signal(EP_FIRST);
  let growTimer: ReturnType<typeof setTimeout> | undefined;
  const grow = () => {
    growTimer = undefined;
    const eps = isAnime() ? untracked(animeRows).length : untracked(episodes).length;
    if (untracked(epShown) < eps) {
      epShown.set(untracked(epShown) + EP_STEP);
      growTimer = setTimeout(grow, 32);
    }
  };
  effect(() => {
    // A new season (or the anime's count) starts from the top again.
    episodes();
    animeCount();
    range();
    if (!bodyReady()) return;
    epShown.set(EP_FIRST);
    if (growTimer === undefined) growTimer = setTimeout(grow, 32);
  });
  cleanup(() => {
    if (growTimer !== undefined) clearTimeout(growTimer);
  });

  // --- Resume ------------------------------------------------------------------

  /** The unfinished progress Play resumes, if any. */
  const resume = computed<Progress | undefined>(() =>
    resumable({ type: t.type, id: t.id, title: "", poster: "" }),
  );
  const playLabel = computed(() => {
    const p = resume();
    if (!p) return "Play";
    if (p.type === "movie") return "Resume";
    const ep = episodeLabel(p).replace(/^S(\d+)E/, "S$1 E");
    return `Continue ${ep}`;
  });
  const onPlay = () => {
    const p = resume();
    if (p) navigate(resumeRoute(p));
    else play(t);
  };

  /** Watched share (0..100) of each episode of the shown season with
   * progress (`episode number` → percent). */
  const watchedMap = computed(() => {
    const m = new Map<number, number>();
    for (const p of progress()) {
      if (p.type !== t.type || p.id !== t.id) continue;
      if (t.type === "tv" && (p.season || 1) !== selectedSeason()) continue;
      if (p.duration <= 0) continue;
      const pct = Math.min(100, Math.round((p.position / p.duration) * 100));
      m.set(p.episode || 1, pct >= 95 ? 100 : pct);
    }
    return m;
  });

  // --- Downloads ---------------------------------------------------------------

  const movieTarget = (): DlTarget | null => {
    const m = d();
    if (t.type !== "movie" || !m) return null;
    return { type: "movie", id: t.id, title: mediaTitle(m), poster: imgUrl(m.poster_path, "w342") };
  };

  const tvTarget = (ep: Episode): DlTarget => ({
    type: "tv",
    id: t.id,
    season: selectedSeason(),
    episode: ep.episode_number,
    title: d() ? mediaTitle(d()!) : (t.title ?? ""),
    episodeName: ep.name || undefined,
    poster: d() ? imgUrl(d()!.poster_path, "w342") : undefined,
    still: ep.still_path ? imgUrl(ep.still_path, "w300") : undefined,
  });

  const animeTarget = (n: number): DlTarget => {
    const e = untracked(aniEps)?.episodes.get(n);
    return {
      type: "anime",
      id: t.id,
      episode: n,
      lang: animeLang(),
      title: a() ? aniTitle(a()!) : (t.title ?? ""),
      episodeName: e?.title || undefined,
      poster: a()?.coverImage.large,
      still: e?.image || undefined,
    };
  };

  // "2 downloaded" / "1 downloading" in the badges row.
  const dl = computed(() =>
    canDownload() ? titleDownloads(t.type, t.id) : { done: 0, active: 0, entries: [] },
  );
  /** Anime: each episode's download state, one map per change of the
   * title's downloads (not a scan of every download per chip). */
  const animeDl = computed(() => {
    const m = new Map<number, DlEntry>();
    if (t.type !== "anime") return m;
    for (const e of dl().entries) {
      const n = e.episode ?? 1;
      if (!m.has(n)) m.set(n, e);
    }
    return m;
  });
  /** An episode's download in the other audio ("Dub downloaded"): one
   * download per episode, so the row says which language it is. */
  const otherLangNote = (n: number): string => {
    const e = animeDl().get(n);
    if (!e || (e.lang ?? "sub") === animeLang()) return "";
    const lang = (e.lang ?? "sub") === "dub" ? "Dub" : "Sub";
    return e.state === "done" ? `${lang} downloaded` : `${lang} downloading`;
  };

  /** The episodes of the list shown (this season; anime: all), in order,
   * as download targets. */
  const shownTargets = (): DlTarget[] =>
    isAnime()
      ? animeEpisodeList(animeCount()).map(animeTarget)
      : episodes().map(tvTarget);

  /** Where "next" starts: the latest watched episode of this list —
   * itself while unfinished, the one after once finished; else the first. */
  const resumeIndex = (list: DlTarget[]): number => {
    const mine = progress()
      .filter(
        (p) =>
          p.type === t.type &&
          p.id === t.id &&
          (t.type !== "tv" || (p.season || 1) === selectedSeason()),
      )
      .sort((x, y) => y.updatedAt - x.updatedAt)[0];
    if (!mine) return 0;
    const i = list.findIndex((x) => x.episode === (mine.episode || 1));
    if (i < 0) return 0;
    const finished = mine.duration > 0 && mine.position >= mine.duration * 0.95;
    return finished ? Math.min(i + 1, list.length) : i;
  };

  async function downloadSeries(e: { pagePosition?: { x: number; y: number } }) {
    const list = shownTargets();
    const from = list.slice(resumeIndex(list));
    const todo = from.filter((x) => missing(downloadFor(x.type, x.id, x.season, x.episode)));
    if (todo.length === 0) {
      notify(
        list.length ? "Everything from here on is already downloaded" : "No episodes to download yet",
        "info",
      );
      return;
    }
    const actions = [{ id: "1", label: "Next episode" }];
    if (todo.length > 1) actions.push({ id: "3", label: `Next ${Math.min(3, todo.length)} episodes` });
    if (todo.length > 3) {
      actions.push({
        id: "all",
        label: `${isAnime() ? "All remaining episodes" : "Rest of this season"} (${todo.length})`,
      });
    }
    await chooseAction(
      displayTitle(),
      actions,
      (picked) => {
        const n = picked === "1" ? 1 : picked === "3" ? 3 : todo.length;
        enqueueMany(todo.slice(0, n));
      },
      desktop ? e.pagePosition : undefined,
    );
  }

  // --- Scroll: header motion, status bar scrim, the debug hook's scroll ---------

  let scrollRef: ScrollRef | undefined;
  let episodesRef: ViewRef | undefined;
  lastTitleScroll = (y) => scrollRef?.scrollTo({ y, animated: true });
  /** The scroll offset, natively (drives the header and the scrim). */
  const scrollY = createAnimatedValue(0);
  const pageW = signal(0);
  const headerH = computed(() => Math.round((pageW() || 402) / HEADER_RATIO));

  /** This page's insets: the status bar plus the (transparent) system
   * header's bar, which the status-bar backing covers. */
  const insets = safeAreaInsets();
  const scrollKey = `${t.type}:${t.id}`;
  const wantScroll = pendingScroll.get(scrollKey);
  if (wantScroll != null) {
    pendingScroll.delete(scrollKey);
    let done = false;
    effect(() => {
      const ready = wantScroll === "episodes" ? episodes().length > 0 || (isAnime() && !!a()) : loaded();
      if (!ready || done) return;
      done = true;
      setTimeout(() => {
        if (typeof wantScroll === "number") {
          scrollRef?.scrollTo({ y: wantScroll, animated: false });
          return;
        }
        void episodesRef?.measure().then((m) => {
          if (m) scrollRef?.scrollTo({ y: Math.max(0, m.pagePosition.y - insets().top - 8), animated: false });
        });
      }, 600);
    });
  }

  // --- The parts -----------------------------------------------------------------

  const Header = () => (
    <View
      class="relative w-full overflow-visible bg-white/5"
      style={desktop ? { height: DESKTOP_HEADER } : { aspectRatio: HEADER_RATIO }}
    >
      {/* Image and its gradient: stretched from the bottom edge while the
          page is pulled down, so the bounce never shows a gap above it. */}
      <View
        class="absolute inset-0 overflow-hidden"
        style={
          desktop
            ? undefined
            : {
                transformOrigin: "center bottom",
                scale: scrollY.interpolate({
                  inputRange: [-headerH(), 0],
                  outputRange: [2, 1],
                  extrapolateRight: "clamp",
                }),
              }
        }
      >
        <If when={headerImage() && settled() && !leaving()}>
          <Image
            src={headerImage()}
            // Phones: the image fades in natively once loaded. Desktop: no
            // image fade (GPUI uploads sixteen copies of a fading picture);
            // the page-coloured veil over it lifts instead.
            fadeDuration={desktop ? 0 : HEADER_FADE_MS}
            onLoad={liftHeader}
            onError={liftHeader}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, objectFit: "cover" }}
          />
        </If>
        {/* One layer over the whole image: dark enough at the top for the
            status bar and the back button, clear in the middle, the page's
            own colour at the bottom edge. Desktop: only with the image, and
            under the header's veil — never under the screen's fade: NSH's
            GPUI backend draws a gradient into an image keyed by its colours
            with the pass's opacity in them, so under an animating opacity
            it rasterises and uploads a new image every frame and frees old
            ones mid-paint (decor/gradient.rs). */}
        <If when={!desktop || (headerImage() && settled() && !leaving())}>
          <View class="absolute inset-0 bg-linear-to-b from-black/45 via-transparent to-background" />
        </If>
        <If when={desktop}>
          <View
            class="pointer-events-none absolute inset-0 bg-background"
            style={{ opacity: headerVeil }}
          />
        </If>
      </View>
    </View>
  );

  const metaChips = () => (
    <View class="flex-row flex-wrap gap-2">
      <If when={isAnime()}>
        <>
          <Badge text={a()?.format === "MOVIE" ? "Anime Movie" : "Anime"} accent />
          <If when={a()?.seasonYear}>{(y) => <Badge text={String(y())} />}</If>
          <If when={a()?.averageScore}>
            {(s) => <Badge text={`★ ${(Number(s()) / 10).toFixed(1)}`} />}
          </If>
          <If when={a()?.status}>{(s) => <Badge text={statusLabel(String(s()))} />}</If>
        </>
      </If>
      <If when={!isAnime()}>
        <>
          <Badge text={t.type === "movie" ? "Movie" : "TV"} accent />
          <If when={d()?.release_date || d()?.first_air_date}>
            {(date) => <Badge text={String(date()).slice(0, 4)} />}
          </If>
          <If when={d()?.vote_average}>{(v) => <Badge text={`★ ${Number(v()).toFixed(1)}`} />}</If>
          <If when={t.type === "movie" && d()?.runtime}>
            {(m) => <Badge text={runtimeLabel(Number(m()))} />}
          </If>
          <If when={d()?.status}>{(s) => <Badge text={String(s())} />}</If>
        </>
      </If>
      <If when={dl().done > 0}>
        <Badge text={`${dl().done} downloaded`} green />
      </If>
      <If when={dl().active > 0}>
        <Badge text={`${dl().active} downloading`} />
      </If>
    </View>
  );

  const genres = computed(() =>
    isAnime() ? (a()?.genres ?? []).join(" · ") : (d()?.genres ?? []).map((g) => g.name).join(" · "),
  );

  /** Title, meta chips and genres; skeletons of the same size while loading. */
  const Heading = () => (
    <View class="gap-3">
      <If
        when={displayTitle()}
        else={<Skeleton width="70%" height={desktop ? 40 : 34} radius={6} />}
      >
        <Text
          class="font-extrabold text-foreground"
          style={{
            fontSize: desktop ? 34 : 28,
            lineHeight: desktop ? 40 : 34,
            letterSpacing: -0.3,
            numberOfLines: 3,
          }}
        >
          {displayTitle()}
        </Text>
      </If>
      <If
        when={loaded()}
        else={
          <View class="gap-3">
            <View class="flex-row gap-2">
              <Skeleton width={44} height={24} radius={6} />
              <Skeleton width={48} height={24} radius={6} />
              <Skeleton width={52} height={24} radius={6} />
            </View>
            <Skeleton width="55%" height={20} radius={4} />
          </View>
        }
      >
        <View class="gap-3">
          {metaChips()}
          <If when={genres()}>
            <Text class="text-muted-foreground" style={{ fontSize: 14, lineHeight: 20, numberOfLines: 2 }}>
              {genres()}
            </Text>
          </If>
        </View>
      </If>
    </View>
  );

  const playButton = (extra: { fullWidth?: boolean }) => (
    <Button
      variant="primary"
      size="lg"
      icon="play"
      label={playLabel()}
      fullWidth={extra.fullWidth}
      onPress={onPlay}
    />
  );

  const downloadButton = (flex: boolean) => (
    <>
      <If when={t.type === "movie" && canDownload()}>
        <If
          when={loaded()}
          else={<Button size="lg" icon="download" label="Download" flex={flex} disabled />}
        >
          <DownloadAction target={movieTarget} size="lg" flex={flex} />
        </If>
      </If>
      <If when={t.type !== "movie" && canDownload()}>
        <Button
          size="lg"
          icon="download"
          label="Download"
          flex={flex}
          disabled={!loaded()}
          onPress={(e) => void downloadSeries(e)}
        />
      </If>
    </>
  );

  const listButton = (flex: boolean) => (
    <Button
      size="lg"
      icon={inList() ? "check" : "plus"}
      label="My List"
      accessibilityLabel={inList() ? "In My List, remove" : "Add to My List"}
      flex={flex}
      disabled={!canToggleList()}
      onPress={toggleList}
    />
  );

  /** Phone: Play across, Download and My List sharing the row under it.
   * Desktop: the three in one row. All 48 pt. */
  const Actions = () =>
    desktop ? (
      <View class="flex-row flex-wrap gap-3">
        <View style={{ minWidth: 168 }}>{playButton({})}</View>
        {downloadButton(false)}
        {listButton(false)}
      </View>
    ) : (
      <View class="gap-3">
        {playButton({ fullWidth: true })}
        <View class="flex-row gap-3">
          {downloadButton(true)}
          {listButton(true)}
        </View>
      </View>
    );

  const overview = computed(() =>
    isAnime()
      ? String(a()?.description ?? "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
      : (d()?.overview ?? ""),
  );

  const Body = () => (
    <View class="gap-8">
      <If when={error()}>{(e) => <ErrorLine message={e()} onRetry={load} />}</If>

      <If when={overview()}>
        {(o) => (
          <Section title={isAnime() ? "Synopsis" : "Overview"}>
            <FoldingText text={o()} lines={4} />
          </Section>
        )}
      </If>

      {/* TV seasons & episodes */}
      <If when={t.type === "tv" && seasons().length > 0}>
        <View ref={(n: ViewRef) => (episodesRef = n)}>
          <Section title="Episodes">
            <If when={seasons().length > 1}>
              <Scroll
                horizontal
                scrollbar={false}
                style={{ height: 36, marginLeft: -GUTTER, marginRight: -GUTTER }}
              >
                <View class="flex-row gap-2" style={{ paddingLeft: GUTTER, paddingRight: GUTTER }}>
                  <Each of={seasons()}>
                    {(s) => (
                      <Chip
                        label={s().name}
                        selected={selectedSeason() === s().season_number}
                        onPress={() => pickSeason(s().season_number)}
                      />
                    )}
                  </Each>
                </View>
              </Scroll>
            </If>
            <If when={seasons().length === 1}>
              <Text class="text-muted-foreground" style={{ fontSize: 14, lineHeight: 20 }}>
                {seasons()[0]?.name ?? ""}
              </Text>
            </If>
            <If when={seasonError()}>{(e) => <ErrorLine message={e()} onRetry={retrySeason} />}</If>
            <View>
              <If when={seasonLoading() && episodes().length === 0}>
                <EpisodeSkeletons />
              </If>
              <Each of={episodes().slice(0, epShown())}>
                {(ep) => (
                  <EpisodeRow
                    ep={tvRowEp(ep())}
                    selected={false}
                    watched={watchedMap().get(ep().episode_number) ?? null}
                    target={() => tvTarget(ep())}
                    onPress={() => {
                      selectedEp.set(ep().episode_number);
                      play(t);
                    }}
                  />
                )}
              </Each>
            </View>
          </Section>
        </View>
      </If>

      {/* Anime episodes + sub/dub */}
      <If when={isAnime() && a()}>
        <View ref={(n: ViewRef) => (episodesRef = n)}>
          <Section title={animeCount() > 1 ? `Episodes (${animeCount()})` : "Episodes"}>
            <View class="flex-row gap-2">
              <Chip label="Sub" selected={animeLang() === "sub"} onPress={() => animeLang.set("sub")} />
              <Chip label="Dub" selected={animeLang() === "dub"} onPress={() => animeLang.set("dub")} />
            </View>
            {/* Long shows: the episodes in ranges, opened on the one to
                watch next. */}
            <If when={rangeCount() > 1}>
              <Scroll
                horizontal
                scrollbar={false}
                style={{ height: 36, marginLeft: -GUTTER, marginRight: -GUTTER }}
              >
                <View class="flex-row gap-2" style={{ paddingLeft: GUTTER, paddingRight: GUTTER }}>
                  <Each of={Array.from({ length: rangeCount() }, (_, i) => i)} key="index">
                    {(i) => (
                      <Chip
                        label={rangeLabel(i())}
                        selected={range() === i()}
                        onPress={() => {
                          rangePicked = true;
                          range.set(i());
                        }}
                      />
                    )}
                  </Each>
                </View>
              </Scroll>
            </If>
            <View>
              <Each of={animeRows().slice(0, epShown())} key={(r: RowEp) => r.n}>
                {(ep) => (
                  <EpisodeRow
                    ep={ep()}
                    selected={false}
                    watched={watchedMap().get(ep().n) ?? null}
                    note={otherLangNote(ep().n)}
                    target={() => animeTarget(ep().n)}
                    onPress={() => {
                      selectedEp.set(ep().n);
                      play(t);
                    }}
                  />
                )}
              </Each>
            </View>
          </Section>
        </View>
      </If>
    </View>
  );

  if (desktop) {
    return (
      <View class="relative flex-1">
      <Scroll class="flex-1" ref={(n: ScrollRef) => (scrollRef = n)}>
        <View style={{ paddingBottom: 48 }}>
          <Header />
          <View class="flex-row gap-8" style={{ marginTop: -150, paddingLeft: GUTTER, paddingRight: GUTTER }}>
            {/* The poster slot: the flight from the card lands here. */}
            <View
              ref={(n: ViewRef) => (posterRef = n)}
              class={`overflow-hidden ${posterShown() ? "bg-white/10" : ""}`}
              style={{ width: POSTER_W, height: POSTER_H, borderRadius: POSTER_RADIUS }}
            >
              <If when={posterShown() && posterImage() && !leaving()}>
                <Image
                  src={posterImage()}
                  fadeDuration={0}
                  style={{ width: POSTER_W, height: POSTER_H, objectFit: "cover" }}
                />
              </If>
            </View>
            <View class="flex-1 gap-5" style={{ paddingTop: 110, maxWidth: 820 }}>
              <Heading />
              <Actions />
            </View>
          </View>
          <View style={{ paddingLeft: GUTTER, paddingRight: GUTTER, paddingTop: 32, maxWidth: 1100 }}>
            <If when={bodyReady()}>
              <Body />
            </If>
          </View>
        </View>
      </Scroll>
      {/* The page's colour over its content while the screen fades in or
          out (the flying poster is over it, in the window's hero layer). */}
      <View
        class="pointer-events-none absolute inset-0 bg-background"
        style={{ opacity: veil }}
      />
      </View>
    );
  }

  return (
    <View class="flex-1 bg-background" onLayout={(e) => pageW.set(e.bounds.size.width)}>
      <Scroll class="flex-1" scrollValue={scrollY} ref={(n: ScrollRef) => (scrollRef = n)}>
        <Header />
        <View
          class="gap-6"
          style={{
            marginTop: -28,
            paddingLeft: GUTTER,
            paddingRight: GUTTER,
            paddingBottom: 40,
          }}
        >
          <Heading />
          <Actions />
          <If when={bodyReady()}>
            <Body />
          </If>
        </View>
      </Scroll>
      {/* The backing of the status bar and the floating back button: fades
          in once the header has scrolled away, so text never runs under
          the clock or the button. Natively driven by the scroll offset. */}
      <View
        class="pointer-events-none absolute left-0 right-0 top-0 bg-background"
        style={{
          height: insets().top,
          opacity: scrollY.interpolate({
            inputRange: [headerH() - 120, headerH() - 40],
            outputRange: [0, 1],
          }),
        }}
      />
    </View>
  );
}

/** AniList's status in words ("RELEASING" → "Airing"). */
function statusLabel(s: string): string {
  switch (s) {
    case "RELEASING":
      return "Airing";
    case "FINISHED":
      return "Finished";
    case "NOT_YET_RELEASED":
      return "Upcoming";
    case "CANCELLED":
      return "Cancelled";
    case "HIATUS":
      return "On hiatus";
    default:
      return s;
  }
}

/** "2h 14m" / "48m". */
function runtimeLabel(min: number): string {
  if (!min) return "";
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

function animeEpisodeList(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => i + 1);
}
