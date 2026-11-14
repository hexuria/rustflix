// Search: a query field over TMDB multi-search and AniList anime.

import { cleanup, effect, signal, Scroll, Text, untracked, View, type ScrollRef } from "nsh";
import { Input } from "nsh/base";
import { aniSearch, type AniMedia } from "../lib/anilist";
import { currentTab, tabReselected } from "../lib/router";
import { hasKey, isMovie, search, type Media } from "../lib/tmdb";
import { AnimeCard, EmptyState, MediaCard } from "../lib/ui";
import { focusContent } from "../lib/system";

type Status = "idle" | "searching" | "done" | "error";

const query = signal("");
const results = signal<Media[]>([]);
const animeResults = signal<AniMedia[]>([]);
const status = signal<Status>("idle");
/** Which source failed when the other one still answered. */
const partialError = signal("");
const errorText = signal("");
const refreshing = signal(false);
let timer: ReturnType<typeof setTimeout> | undefined;
// Only the latest search may write results: an older, slower response
// that arrives late is dropped.
let seq = 0;

async function runNow(q: string, mine = ++seq) {
  if (!q.trim()) {
    results.set([]);
    animeResults.set([]);
    partialError.set("");
    status.set("idle");
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
  status.set("done");
}

/** Search as you type: waits for a pause in typing. The sequence moves
 * on at once, so a response for the previous text is dropped even before
 * the new search starts. */
function run(q: string) {
  if (timer) clearTimeout(timer);
  const mine = ++seq;
  timer = setTimeout(() => void runNow(q, mine), 350);
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
  let mine: { focus(): void } | undefined;
  cleanup(() => {
    if (field === mine) field = undefined;
  });
  return (
    <View class="flex-1 gap-4 p-4 pb-0">
      <Input
        ref={(n: { focus(): void }) => {
          mine = n;
          field = n;
          focusNow();
        }}
        value={query()}
        // macOS: the keyboard to the app's view, not a web view.
        onFocus={focusContent}
        onChange={({ value }) => {
          query.set(value);
          run(value);
        }}
        placeholder="Search movies, shows, anime…"
        class="rounded-lg border border-input bg-background px-3 py-2 text-foreground focus:border-ring"
      />
      <Scroll
        ref={(n: ScrollRef) => (scroll = n)}
        class="flex-1"
        keyboardShouldPersistTaps="handled"
        refreshing={refreshing()}
        onRefresh={() => void refresh()}
      >
        <View class="pb-10">
          <If when={status() === "idle"}>
            <EmptyState
              icon="⌕"
              title="Search movies, shows and anime"
              body="Movies and series come from TMDB; anime from AniList. Start typing to search."
            />
          </If>
          <If when={status() === "searching" && !refreshing()}>
            <Text class="text-sm text-muted-foreground">Searching…</Text>
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
          <If when={status() === "done" && count() > 0}>
            <View class="gap-2">
              <Text class="text-sm font-semibold text-muted-foreground">
                {`${count()} results`}
              </Text>
              <If when={partialError()}>
                {(e) => <Text class="text-xs text-muted-foreground">{e()}</Text>}
              </If>
              <View class="flex-row flex-wrap gap-4">
                <Each of={animeResults()}>{(m) => <AnimeCard anime={m()} badge />}</Each>
                <Each of={results()}>
                  {(m) => <MediaCard media={m()} type={isMovie(m()) ? "movie" : "tv"} />}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </Scroll>
    </View>
  );
}
