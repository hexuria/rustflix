// Search: a query field over TMDB multi-search and AniList anime.
//
// The field shows what is going on (the system's activity indicator while
// a search runs, a clear button otherwise); results stay on screen, dimmed,
// while the next ones load, so typing does not flash the page empty. The
// grid is three posters across on a phone and fills the width (lib/ui
// `posterGrid`). Chips narrow the results to movies, shows or anime. The
// last few searches are offered again on the empty screen.

import {
  cleanup,
  computed,
  effect,
  Image,
  Scroll,
  signal,
  Storage,
  Text,
  untracked,
  View,
  type ScrollRef,
} from "nsh";
import { Input } from "nsh/base";
import { aniSearch, type AniMedia } from "../lib/anilist";
import { ActivitySpinner } from "../lib/nativespinner";
import { currentTab, selectTab, tabReselected } from "../lib/router";
import { hasKey, isMovie, search, type Media } from "../lib/tmdb";
import { AnimeCard, Chip, EmptyState, MediaCard, posterGrid } from "../lib/ui";
import { focusContent } from "../lib/system";
import { Glyph, icon } from "./PlayerControls";

type Status = "idle" | "searching" | "done" | "error";
type Kind = "all" | "movie" | "tv" | "anime";

const query = signal("");
const results = signal<Media[]>([]);
const animeResults = signal<AniMedia[]>([]);
const status = signal<Status>("idle");
const kind = signal<Kind>("all");
/** Which source failed when the other one still answered. */
const partialError = signal("");
const errorText = signal("");
const refreshing = signal(false);
let timer: ReturnType<typeof setTimeout> | undefined;
// Only the latest search may write results: an older, slower response
// that arrives late is dropped.
let seq = 0;

// --- Recent searches -------------------------------------------------------------

const RECENT_KEY = "rustflix.search.recent";
const RECENT_MAX = 8;
const recent = signal<string[]>([]);
let recentTimer: ReturnType<typeof setTimeout> | undefined;

void (async () => {
  try {
    const raw = await Storage.getItem(RECENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) recent.set(list.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX));
  } catch {}
})();

function saveRecent(list: string[]) {
  recent.set(list);
  void Storage.setItem(RECENT_KEY, JSON.stringify(list)).catch(() => {});
}

/** A search that found something goes to the top of the recent ones. */
function remember(q: string) {
  const text = q.trim();
  if (text.length < 2) return;
  const rest = untracked(recent).filter((r) => r.toLowerCase() !== text.toLowerCase());
  saveRecent([text, ...rest].slice(0, RECENT_MAX));
}

// --- Searching -------------------------------------------------------------------

function clearResults() {
  results.set([]);
  animeResults.set([]);
  partialError.set("");
  kind.set("all");
  status.set("idle");
}

async function runNow(q: string, mine = ++seq) {
  if (!q.trim()) {
    clearResults();
    return;
  }
  // A refresh keeps the results on screen while it asks again.
  if (!refreshing()) status.set("searching");
  const withTmdb = hasKey();
  const [tmdbRes, aniRes] = await Promise.allSettled([
    withTmdb ? search(q) : Promise.resolve([] as Media[]),
    aniSearch(q),
  ]);
  if (mine !== seq) return;
  const reason = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? String(r.reason?.message ?? r.reason) : "";
  // Every source that was asked failed (AniList alone when there is no
  // TMDB key): an error, not "no results".
  if (aniRes.status === "rejected" && (!withTmdb || tmdbRes.status === "rejected")) {
    results.set([]);
    animeResults.set([]);
    errorText.set(reason(withTmdb ? tmdbRes : aniRes) || reason(aniRes));
    status.set("error");
    return;
  }
  results.set(tmdbRes.status === "fulfilled" ? tmdbRes.value : []);
  animeResults.set(aniRes.status === "fulfilled" ? aniRes.value : []);
  partialError.set(
    tmdbRes.status === "rejected"
      ? "Movies and shows could not load; showing anime only."
      : aniRes.status === "rejected"
        ? "Anime could not load; showing movies and shows only."
        : "",
  );
  // The chip picked for the last results may have nothing now.
  if (countOf(untracked(kind)) === 0) kind.set("all");
  status.set("done");
  // Still the query a moment later (not a stop on the way to a longer
  // word): worth offering again.
  if (recentTimer) clearTimeout(recentTimer);
  if (results().length + animeResults().length > 0) {
    recentTimer = setTimeout(() => {
      if (mine === seq) remember(q);
    }, 1500);
  }
}

/** Search as you type: waits for a pause in typing. The sequence moves
 * on at once, so a response for the previous text is dropped even before
 * the new search starts; the field shows it is busy from the first key. */
function run(q: string) {
  if (timer) clearTimeout(timer);
  if (recentTimer) clearTimeout(recentTimer);
  const mine = ++seq;
  if (!q.trim()) {
    clearResults();
    return;
  }
  status.set("searching");
  timer = setTimeout(() => void runNow(q, mine), 350);
}

function countOf(k: Kind): number {
  const movies = results().filter(isMovie).length;
  if (k === "movie") return movies;
  if (k === "tv") return results().length - movies;
  if (k === "anime") return animeResults().length;
  return results().length + animeResults().length;
}

// ⌘F (App.tsx): focus the query field, also when the screen is still
// being mounted by the same keystroke — the field takes the focus once
// its view is in the tree (a focus command before that is dropped).
let field: { focus(): void } | undefined;
let focusWanted = false;

function focusNow() {
  if (!focusWanted || !field) return;
  try {
    field.focus();
  } catch {}
}

/** Focuses the Search screen's text field (now, or as soon as it mounts). */
export function focusSearchField() {
  focusWanted = true;
  focusNow();
  // Again a moment later: the first command can reach a field the
  // navigation that comes with ⌘F has not attached yet.
  setTimeout(() => {
    focusNow();
    focusWanted = false;
  }, 120);
}

async function refresh() {
  if (timer) clearTimeout(timer);
  refreshing.set(true);
  try {
    await runNow(query());
  } finally {
    refreshing.set(false);
  }
}

// Debug start route: Storage `rustflix.opensearch` = JSON `{ "q": "naruto",
// "delay": 1500, "keep": true }` opens the Search tab and searches for
// `q` once the app is up (as `rustflix.opentitle` does for a title page).
// Removed after one run unless `keep`.
export async function runOpenSearchTest() {
  let raw: string | null = null;
  try {
    raw = await Storage.getItem("rustflix.opensearch");
  } catch {}
  if (!raw) return;
  let req: { q?: string; delay?: number; keep?: boolean };
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req.keep) {
    try {
      await Storage.removeItem("rustflix.opensearch");
    } catch {}
  }
  setTimeout(() => {
    selectTab("search");
    if (typeof req.q === "string") {
      query.set(req.q);
      run(req.q);
    }
  }, req.delay ?? 1200);
}

const LENS = `<circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="#a1a1aa" stroke-width="2"/><path d="M15.2 15.2 20 20" fill="none" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round"/>`;

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "all", label: "All" },
  { kind: "movie", label: "Movies" },
  { kind: "tv", label: "Shows" },
  { kind: "anime", label: "Anime" },
];

export function Search() {
  let scroll: ScrollRef | undefined;
  let lastTap = tabReselected();
  effect(() => {
    const n = tabReselected();
    if (n !== lastTap) {
      lastTap = n;
      // Every tab's root stays mounted: only the shown one scrolls up.
      if (untracked(currentTab) === "search") scroll?.scrollTo({ y: 0, animated: true });
    }
  });
  const count = () => results().length + animeResults().length;
  const busy = () => status() === "searching" && !refreshing();
  /** The chips worth showing: kinds that have results, when there is more
   * than one. */
  const chips = computed(() => {
    const some = KINDS.filter((k) => k.kind !== "all" && countOf(k.kind) > 0);
    return some.length > 1 ? [KINDS[0]!, ...some] : [];
  });
  const shownAnime = computed(() => (kind() === "all" || kind() === "anime" ? animeResults() : []));
  const shownMedia = computed(() => {
    const k = kind();
    if (k === "anime") return [];
    if (k === "all") return results();
    return results().filter((m) => (k === "movie") === isMovie(m));
  });
  const gridW = signal(0);
  const grid = computed(() => posterGrid(gridW()));

  let mine: { focus(): void } | undefined;
  cleanup(() => {
    if (field === mine) field = undefined;
  });
  const setQuery = (text: string, now = false) => {
    query.set(text);
    if (now && text.trim()) {
      if (timer) clearTimeout(timer);
      void runNow(text);
    } else run(text);
  };
  return (
    <View class="flex-1 gap-3 px-4 pt-4">
      {/* The field: lens, text, then what is going on at its right end. */}
      <View class="flex-row items-center gap-2 rounded-xl bg-white/10 pl-3 pr-2" style={{ height: 44 }}>
        <Image src={icon(LENS, 20)} style={{ width: 20, height: 20 }} />
        <Input
          ref={(n: { focus(): void }) => {
            mine = n;
            field = n;
            focusNow();
          }}
          value={query()}
          // macOS: the keyboard to the app's view, not a web view.
          onFocus={focusContent}
          onChange={({ value }) => setQuery(value)}
          onSubmit={() => {
            setQuery(query(), true);
            remember(query());
          }}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Movies, shows, anime"
          class="flex-1 bg-transparent py-2 text-[15px] text-foreground"
        />
        <If when={busy()}>
          <View class="items-center justify-center" style={{ width: 32, height: 32 }}>
            <ActivitySpinner size={20} />
          </View>
        </If>
        <If when={!busy() && query().length > 0}>
          <View
            role="button"
            accessibilityLabel="Clear search"
            onPress={() => {
              setQuery("");
              try {
                mine?.focus();
              } catch {}
            }}
            class="cursor-pointer items-center justify-center active:opacity-60"
            style={{ width: 32, height: 32 }}
          >
            <View class="items-center justify-center rounded-full bg-white/20" style={{ width: 20, height: 20 }}>
              <Glyph d="close" size={12} />
            </View>
          </View>
        </If>
      </View>
      <If when={chips().length > 0 && count() > 0}>
        {/* Four chips do not fit a narrow phone: the row scrolls, edge to edge. */}
        <Scroll horizontal scrollbar={false} style={{ height: 32, marginLeft: -16, marginRight: -16 }}>
        <View class="flex-row gap-2" style={{ paddingLeft: 16, paddingRight: 16 }}>
          <Each of={chips()} key={(c: { kind: Kind }) => c.kind}>
            {(c) => (
              <Chip
                size="sm"
                label={`${c().label} ${countOf(c().kind)}`}
                selected={kind() === c().kind}
                onPress={() => {
                  kind.set(c().kind);
                  scroll?.scrollTo({ y: 0, animated: false });
                }}
              />
            )}
          </Each>
        </View>
        </Scroll>
      </If>
      <Scroll
        ref={(n: ScrollRef) => (scroll = n)}
        class="flex-1"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshing={refreshing()}
        onRefresh={() => void refresh()}
      >
        <View class="pb-10" onLayout={(e) => gridW.set(e.bounds.size.width)}>
          <If when={status() === "idle" && recent().length === 0}>
            <EmptyState
              icon="⌕"
              title="Search movies, shows and anime"
              body="Movies and series come from TMDB; anime from AniList. Start typing to search."
            />
          </If>
          <If when={status() === "idle" && recent().length > 0}>
            <View class="gap-3 pt-1">
              <View class="flex-row items-center justify-between">
                <Text class="text-sm font-semibold text-muted-foreground">Recent</Text>
                <View
                  role="button"
                  accessibilityLabel="Clear recent searches"
                  onPress={() => saveRecent([])}
                  class="cursor-pointer active:opacity-60"
                  style={{ paddingTop: 6, paddingBottom: 6, paddingLeft: 8 }}
                >
                  <Text class="text-sm font-medium text-primary">Clear</Text>
                </View>
              </View>
              <View class="flex-row flex-wrap gap-2">
                <Each of={recent()} key={(r: string) => r}>
                  {(r) => <Chip size="sm" label={r()} onPress={() => setQuery(r(), true)} />}
                </Each>
              </View>
            </View>
          </If>
          {/* A first search (nothing to keep on screen): the indicator alone. */}
          <If when={busy() && count() === 0}>
            <View class="items-center" style={{ paddingTop: 72 }}>
              <ActivitySpinner size={36} />
            </View>
          </If>
          <If when={status() === "error"}>
            <EmptyState
              icon="⚠"
              title="Search failed"
              body={`Could not reach TMDB or AniList. ${errorText()}`}
              actionLabel="Retry"
              onAction={() => void runNow(query())}
            />
          </If>
          <If when={status() === "done" && count() === 0}>
            <EmptyState
              title={`No results for “${query().trim()}”`}
              body={partialError() || "Check the spelling or try another title."}
              actionLabel={partialError() ? "Retry" : undefined}
              onAction={() => void runNow(query())}
            />
          </If>
          <If when={count() > 0 && status() !== "error" && status() !== "idle" && gridW() > 0}>
            {/* While the next results load, these stay, dimmed. */}
            <View class="gap-3" style={{ opacity: busy() ? 0.45 : 1 }}>
              <If when={chips().length === 0}>
                <Text class="text-sm font-semibold text-muted-foreground">
                  {count() === 1 ? "1 result" : `${count()} results`}
                </Text>
              </If>
              <If when={partialError()}>
                {(e) => <Text class="text-xs text-muted-foreground">{e()}</Text>}
              </If>
              <View class="flex-row flex-wrap" style={{ columnGap: grid().gap, rowGap: 16 }}>
                <Each of={shownAnime()}>{(m) => <AnimeCard anime={m()} badge width={grid().cardW} />}</Each>
                <Each of={shownMedia()}>
                  {(m) => (
                    <MediaCard media={m()} type={isMovie(m()) ? "movie" : "tv"} width={grid().cardW} />
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </Scroll>
    </View>
  );
}
