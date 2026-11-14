// Home: a billboard over horizontal rows, like Streambert's HomePage.
// Every row has its own loader (loading | ok | error): skeleton cards
// while it loads, an inline Retry when it fails, its cards when it is in.

import {
  cleanup,
  computed,
  effect,
  platform,
  signal,
  Scroll,
  Text,
  untracked,
  View,
  type JSX,
  type ScrollRef,
} from "nsh";
import { Image } from "nsh";
import { aniTrending, type AniMedia } from "../lib/anilist";
import { goTitle, navigate, selectTab, currentTab, tabReselected } from "../lib/router";
import { downloadList } from "../lib/downloads";
import { debug } from "../lib/player";
import { perfTask } from "../lib/perf";
import { continueWatchingByTitle } from "../lib/store";
import { Glyph } from "./PlayerControls";
import {
  clearCache,
  currentKey,
  hasKey,
  imgUrl,
  isMovie,
  nowPlaying,
  popularMovies,
  popularTv,
  title as mediaTitle,
  topRatedMovies,
  trending,
  upcoming,
  type Media,
} from "../lib/tmdb";
import {
  AnimeCard,
  Badge,
  Button,
  EmptyState,
  MediaCard,
  mediaTarget,
  playTarget,
  ListRow,
  ProgressCard,
  Row,
  RowError,
  Skeleton,
  SkeletonCards,
} from "../lib/ui";

type RowState = "loading" | "ok" | "error";

interface Loader<T> {
  state: () => RowState;
  items: () => T[];
  error: () => string;
  load: () => Promise<void>;
  /** Loading for longer than STUCK_MS (a request that never answered). */
  stuck: () => boolean;
}

/** A row loading longer than this is asked again when Home shows. */
const STUCK_MS = 15_000;
/** Pull-to-refresh's spinner ends after this even if a row is still out. */
const REFRESH_CAP_MS = 8_000;

/** One row's data. A reload keeps the cards it has: only a row with
 * nothing yet shows skeletons or the error. Only the latest load counts. */
function loader<T>(name: string, fetch: () => Promise<T[]>): Loader<T> {
  const state = signal<RowState>("loading");
  const items = signal<T[]>([]);
  const error = signal("");
  let seq = 0;
  let startedAt = 0;
  const load = async () => {
    const mine = ++seq;
    startedAt = Date.now();
    const had = items().length > 0;
    if (!had) state.set("loading");
    error.set("");
    try {
      const r = await fetch();
      if (mine !== seq) return;
      perfTask(`home: row ${name}`, () => {
        items.set(r);
        state.set("ok");
      });
    } catch (e) {
      if (mine !== seq) return;
      // The reason shows under "This row did not load" and goes to the
      // console and the debug log, so a failing row says why.
      const why = String(e instanceof Error ? e.message : e);
      console.warn(`home row "${name}" failed: ${why}`);
      debug(`home: row ${name} failed`, why);
      error.set(why);
      if (!had) state.set("error");
    }
  };
  const stuck = () => state() === "loading" && startedAt > 0 && Date.now() - startedAt > STUCK_MS;
  return { state, items, error, load, stuck };
}

const trendingRow = loader<Media>("trending", () => trending());
const nowPlayingRow = loader<Media>("now playing", () => nowPlaying());
const moviesRow = loader<Media>("popular movies", () => popularMovies());
const tvRow = loader<Media>("popular tv", () => popularTv());
const topRatedRow = loader<Media>("top rated", () => topRatedMovies());
const upcomingRow = loader<Media>("upcoming", () => upcoming());
const animeRow = loader<AniMedia>("anime", () => aniTrending());

const tmdbRows = [trendingRow, nowPlayingRow, moviesRow, tvRow, topRatedRow, upcomingRow];

const hero = computed<Media | null>(() => {
  const r = trendingRow.items();
  return r.find((m) => m.backdrop_path) ?? r[0] ?? null;
});

/** Never loaded, failed, or stuck loading: worth asking again. */
const needsLoad = (r: Loader<unknown>) => r.state() === "error" || r.stuck();

// Loads every row once per TMDB key (setup/settings change it). Coming
// back to Home retries the rows that failed or never answered instead of
// keeping them empty until a restart.
let loadedFor = "";
let animeAsked = false;
function load() {
  if (!animeAsked || needsLoad(animeRow)) {
    animeAsked = true;
    void animeRow.load();
  }
  const k = currentKey();
  if (!k) return;
  if (k !== loadedFor) {
    loadedFor = k;
    for (const r of tmdbRows) void r.load();
    return;
  }
  for (const r of tmdbRows) if (needsLoad(r)) void r.load();
}

const refreshing = signal(false);
async function refresh() {
  refreshing.set(true);
  clearCache();
  // Rows keep their cards while they reload; the spinner ends when every
  // row has settled or after REFRESH_CAP_MS, whichever comes first.
  const all = Promise.all([
    animeRow.load(),
    ...(currentKey() ? tmdbRows.map((r) => r.load()) : []),
  ]);
  await Promise.race([all, new Promise((done) => setTimeout(done, REFRESH_CAP_MS))]);
  refreshing.set(false);
}

/** Every row that is asked for failed (no network, most likely) while a
 * finished download exists: Home shows one "You're offline" state instead
 * of a stack of row errors. Without downloads, the rows' own errors stay. */
const offline = computed(() => {
  const rows = [animeRow, ...(hasKey() ? tmdbRows : [])];
  if (!rows.every((r) => r.state() === "error")) return false;
  return downloadList().some((e) => e.state === "done");
});

function OfflineState() {
  return (
    <View class="items-center gap-2 px-6 py-16">
      <Glyph d="offline" size={44} color="#a1a1aa" />
      <Text class="text-center text-base font-bold text-foreground">You're offline</Text>
      <Text class="text-center text-sm text-muted-foreground">Your downloads still play.</Text>
      <View class="mt-2">
        <Button primary label="Go to Downloads" onPress={() => selectTab("downloads")} />
      </View>
    </View>
  );
}

function HeroSkeleton() {
  return (
    <View class="absolute bottom-6 left-4 right-4 gap-3 md:left-6">
      <Skeleton width={260} height={30} radius={6} />
      <View class="flex-row gap-2">
        <Skeleton width={48} height={18} radius={6} />
        <Skeleton width={40} height={18} radius={6} />
      </View>
      <Skeleton width={320} height={12} radius={4} />
      <Skeleton width={240} height={12} radius={4} />
      <View class="mt-1 flex-row gap-3">
        <Skeleton width={92} height={38} />
        <Skeleton width={92} height={38} />
      </View>
    </View>
  );
}

/** Desktop: a scrim of the page's colour as plain bands (24 quads at
 * stepped opacity) instead of a CSS gradient. NSH's GPUI backend draws a
 * gradient into an image keyed by its colours with the pass's opacity in
 * them (decor/gradient.rs), so under the page stack's cross-fade every
 * frame rasterised and uploaded two new hero-sized images and freed old
 * ones mid-paint; quads at any opacity are free. `stops`: opacity at the
 * start, middle and end, `dir`: from the bottom up or from the left. */
function BandScrim(props: { dir: "up" | "right"; stops: [number, number, number] }) {
  const N = 24;
  const [a, b, c] = props.stops;
  const at = (t: number) => (t < 0.5 ? a + (b - a) * (t / 0.5) : b + (c - b) * ((t - 0.5) / 0.5));
  const bands = Array.from({ length: N }, (_, i) => i);
  return (
    <View class="pointer-events-none absolute inset-0" style={{ flexDirection: props.dir === "up" ? "column-reverse" : "row" }}>
      <Each of={bands} key="index">
        {(i) => <View class="flex-1 bg-background" style={{ opacity: at((i() + 0.5) / N) }} />}
      </Each>
    </View>
  );
}

function Hero() {
  const m = computed(() => hero());
  const details = () => {
    const h = hero();
    // The billboard's backdrop (the very image it shows, already loaded),
    // poster and name go along: the title page shows them at once instead
    // of waiting for the details.
    if (h) {
      goTitle(isMovie(h) ? "movie" : "tv", h.id, {
        image: imgUrl(h.poster_path, "w342") || undefined,
        backdrop: imgUrl(h.backdrop_path, "w1280"),
        title: mediaTitle(h),
      });
    }
  };
  const play = () => {
    const h = hero();
    if (h) playTarget(mediaTarget(h));
  };
  return (
    <View
      class="relative w-full overflow-hidden bg-muted"
      style={{ height: platform.desktop ? 420 : 320 }}
    >
      <If when={m()?.backdrop_path}>
        <Image
          src={imgUrl(m()?.backdrop_path, "w1280")}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        />
      </If>
      {/* Scrims: fade into the page at the bottom, and darken the side
          the text sits on. */}
      <If
        when={platform.desktop}
        else={
          <>
            <View class="absolute inset-0 bg-linear-to-t from-background via-background/60 to-transparent" />
            <View class="absolute inset-0 bg-linear-to-r from-background/80 via-background/20 to-transparent" />
          </>
        }
      >
        <BandScrim dir="up" stops={[1, 0.6, 0]} />
        <BandScrim dir="right" stops={[0.8, 0.2, 0]} />
      </If>
      <If
        when={m()}
        else={
          <If when={hasKey() && trendingRow.state() === "loading"}>
            <HeroSkeleton />
          </If>
        }
      >
        {(h) => (
          <View
            class="absolute bottom-6 left-4 right-6 gap-2"
            style={{ maxWidth: platform.desktop ? 560 : undefined, left: platform.desktop ? 24 : 16 }}
          >
            <Text class="text-3xl font-extrabold text-foreground" style={{ numberOfLines: 2 }}>
              {mediaTitle(h())}
            </Text>
            <View class="flex-row gap-2">
              <Badge text={isMovie(h()) ? "Movie" : "TV"} accent />
              <If when={(h().release_date ?? h().first_air_date ?? "").slice(0, 4)}>
                {(y) => <Badge text={y()} />}
              </If>
              <If when={h().vote_average}>
                <Badge text={`${(h().vote_average ?? 0).toFixed(1)} ★`} />
              </If>
            </View>
            <Text class="text-sm text-muted-foreground" style={{ numberOfLines: 3 }}>
              {h().overview ?? ""}
            </Text>
            <View class="mt-1 flex-row gap-3">
              <Button variant="primary" icon="play" label="Play" onPress={play} />
              <Button icon="info" label="Details" onPress={details} />
            </View>
          </View>
        )}
      </If>
    </View>
  );
}

/** Poster cards: 140 pt wide, 210 pt posters over two lines of text. */
const POSTER_W = 140;
const POSTER_H = 250;

/** A row driven by a loader: skeletons, then cards; an inline Retry if it
 * failed; nothing at all if it loaded fine but came back empty. Its cards
 * are a virtualized row (`ListRow`): only those near its viewport exist. */
function LoadedRow<T>(props: {
  title: string;
  loader: Loader<T>;
  children: (item: () => T) => JSX.Element;
}) {
  const l = props.loader;
  return (
    <If when={!(l.state() === "ok" && l.items().length === 0)}>
      <If
        when={l.state() !== "error"}
        else={
          <View class="gap-2 px-4">
            <Text class="text-lg font-bold text-foreground">{props.title}</Text>
            <RowError message={l.error()} onRetry={() => void l.load()} />
          </View>
        }
      >
        <If
          when={l.state() === "ok"}
          else={
            <Row title={props.title}>
              <SkeletonCards />
            </Row>
          }
        >
          <ListRow title={props.title} items={l.items()} itemWidth={POSTER_W} itemHeight={POSTER_H}>
            {(m) => props.children(m)}
          </ListRow>
        </If>
      </If>
    </If>
  );
}

function TmdbRow(props: { title: string; loader: Loader<Media>; type?: "movie" | "tv" }) {
  return (
    <LoadedRow title={props.title} loader={props.loader}>
      {(m) => <MediaCard media={m()} type={props.type ?? (isMovie(m()) ? "movie" : "tv")} />}
    </LoadedRow>
  );
}

function ContinueRow() {
  const watching = computed(() => continueWatchingByTitle());
  return (
    <If when={watching().length > 0}>
      {/* A few cards: a plain row (keyed, so a progress save updates its
          card in place). */}
      <Row title="Continue Watching">
        <Each of={watching()} key={(p) => `${p.type}:${p.id}`}>
          {(p) => <ProgressCard progress={p()} />}
        </Each>
      </Row>
    </If>
  );
}

/** The mounted Home's page scroll view (the perf scenario drives it). */
let homeScroll: ScrollRef | undefined;

/** Scrolls Home's page to `y`, animated (lib/perf.ts's scenario). */
export function scrollHomeTo(y: number) {
  homeScroll?.scrollTo({ y, animated: true });
}

/** Scrolls Home's page to `y` at once (the scenario's `scrollanim` steps). */
export function scrollHomeInstant(y: number) {
  homeScroll?.scrollTo({ y, animated: false });
}

/** The first card of Home's first TMDB row, if it loaded. */
export function firstHomeMedia(): Media | undefined {
  return untracked(trendingRow.items)[0];
}

/** Rows mounted with the page; the rest follow one per frame or two, so
 * (re)opening Home never builds every row in one commit. */
const ROWS_AT_ONCE = 2;
const ROW_COUNT = 7;

export function Home() {
  let scroll: ScrollRef | undefined;
  const shown = signal(ROWS_AT_ONCE);
  let more: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    more = undefined;
    const n = untracked(shown);
    if (n >= ROW_COUNT) return;
    shown.set(n + 1);
    // One row per wake-up, never two: a row is ~156 mount items (~6 ms to
    // apply); two in one main-thread wake-up made a 12 ms stall at launch.
    more = setTimeout(next, 64);
  };
  more = setTimeout(next, 120);
  cleanup(() => {
    if (more !== undefined) clearTimeout(more);
  });
  const later = (i: number) => shown() > i;
  // Follows the key only: the rows' own state changes must not re-run it
  // (a failing row would retry in a loop).
  // Also each time Home shows again (its page stays mounted while other
  // tabs show), as it did when every visit built it anew.
  effect(() => {
    currentKey();
    if (currentTab() === "home") untracked(load);
  });
  // Tapping the Home tab again goes back to the top.
  let lastTap = tabReselected();
  effect(() => {
    const n = tabReselected();
    if (n !== lastTap) {
      lastTap = n;
      // Every tab's root stays mounted: only the shown one scrolls up.
      if (untracked(currentTab) === "home") scroll?.scrollTo({ y: 0, animated: true });
    }
  });
  return (
    <Scroll
      ref={(n: ScrollRef) => {
        scroll = n;
        homeScroll = n;
      }}
      class="flex-1"
      refreshing={refreshing()}
      onRefresh={() => void refresh()}
    >
      <If when={!offline()}>
        <Hero />
      </If>
      <View class="gap-6 pb-10 pt-4">
        <If when={offline()}>
          <ContinueRow />
          <OfflineState />
        </If>
        <If when={!offline()}>
        <If when={!hasKey()}>
          <EmptyState
            icon="🔑"
            title="Add your TMDB key"
            body="Movies and shows come from TMDB and need a free API key. Anime works without one."
            actionLabel="Add key"
            onAction={() => navigate({ name: "setup" })}
          />
        </If>
        <ContinueRow />
        <If when={hasKey()}>
          <TmdbRow title="Trending This Week" loader={trendingRow} />
          <TmdbRow title="Now Playing" loader={nowPlayingRow} type="movie" />
          <If when={later(2)}>
            <TmdbRow title="Popular Movies" loader={moviesRow} type="movie" />
          </If>
          <If when={later(3)}>
            <TmdbRow title="Popular TV" loader={tvRow} type="tv" />
          </If>
          <If when={later(4)}>
            <TmdbRow title="Top Rated Movies" loader={topRatedRow} type="movie" />
          </If>
          <If when={later(5)}>
            <TmdbRow title="Upcoming" loader={upcomingRow} type="movie" />
          </If>
        </If>
        <If when={later(6) || !hasKey()}>
          <LoadedRow title="Trending Anime" loader={animeRow}>
            {(m) => <AnimeCard anime={m()} />}
          </LoadedRow>
        </If>
        </If>
      </View>
    </Scroll>
  );
}
