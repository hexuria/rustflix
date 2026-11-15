// Library: watchlist grid and "continue watching" progress rows.

import { computed, effect, List, platform, signal, Storage, Text, untracked, View, Image, Scroll, type ScrollRef } from "nsh";
import { navigate, currentTab, tabReselected } from "../lib/router";
import { debug } from "../lib/player";
import {
  continueWatchingByTitle,
  removeProgressForTitle,
  watchlist,
  type LibraryItem,
  type Progress,
} from "../lib/store";
import {
  EmptyState,
  episodeLabel,
  openCardMenu,
  PosterCard,
  posterGrid,
  resumeRoute,
  Section,
  type CardTarget,
} from "../lib/ui";
import { tvFocus, tvMode, TV_SAFE, useFocusable } from "../lib/tv";

const refreshing = signal(false);

// Mirrors store.ts's WATCHLIST_KEY (not exported there).
const WATCHLIST_KEY = "rustflix.watchlist.v1";

/** Pull to refresh: re-reads My List from storage. Only the watchlist:
 * `loadLibrary()` would also re-notify settings listeners and put stored
 * progress over newer progress still in memory. */
async function refresh() {
  refreshing.set(true);
  try {
    const raw = await Storage.getItem(WATCHLIST_KEY);
    if (raw) watchlist.set(JSON.parse(raw) as LibraryItem[]);
  } catch (e) {
    console.warn("my list refresh failed", e);
    debug("library: refresh failed", String(e));
  } finally {
    refreshing.set(false);
  }
}

function progressTarget(p: Progress): CardTarget {
  return { type: p.type, id: p.id, title: p.title, poster: p.poster, progress: p };
}

/** A Continue Watching row: resume (holding select or the menu key on a TV:
 * the card menu) and its remove button beside it. */
function WatchingRow(props: { p: Progress }) {
  const p = () => props.p;
  const resume = useFocusable({
    onPress: () => navigate(resumeRoute(p())),
    onLongPress: () => void openCardMenu(progressTarget(p())),
  });
  const remove = useFocusable({ onPress: () => void removeProgressForTitle(p().type, p().id) });
  return (
    <View class="flex-row items-center gap-3 rounded-lg bg-muted/50 p-2">
      <View
        ref={resume.ref}
        role="button"
        accessibilityLabel={`Resume ${p().title}`}
        onMouseEnter={resume.onMouseEnter}
        onPressIn={resume.onPressIn}
        onPress={() => navigate(resumeRoute(p()))}
        onLongPress={platform.desktop ? undefined : () => void openCardMenu(progressTarget(p()))}
        onContextMenu={(e) => void openCardMenu(progressTarget(p()), e.pagePosition)}
        class={`flex-1 cursor-pointer flex-row items-center gap-3 rounded-lg active:opacity-70 ${resume.focused() ? tvFocus.row : ""}`}
      >
        <Image src={p().poster} style={{ width: 90, height: 60, borderRadius: 6 }} />
        <View class="flex-1 gap-0.5">
          <Text class="text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>
            {p().title}
          </Text>
          <Text class={tvMode() ? "text-sm text-muted-foreground" : "text-xs text-muted-foreground"}>
            {episodeLabel(p()) ? `${episodeLabel(p())} · ` : ""}
            {fmt(p().position)} / {fmt(p().duration)}
          </Text>
          <View class="mt-1 h-1 w-full rounded bg-background">
            <View
              class="h-1 rounded bg-primary"
              style={{
                width: `${Math.min(100, (p().position / Math.max(1, p().duration)) * 100)}%`,
              }}
            />
          </View>
        </View>
      </View>
      <View
        ref={remove.ref}
        role="button"
        accessibilityLabel="Remove from Continue Watching"
        onMouseEnter={remove.onMouseEnter}
        onPressIn={remove.onPressIn}
        onPress={() => removeProgressForTitle(p().type, p().id)}
        class={`cursor-pointer rounded-lg p-2 ${remove.focused() ? tvFocus.row : "hover:bg-muted active:bg-muted"}`}
      >
        <Text class={tvMode() ? "text-sm text-muted-foreground" : "text-xs text-muted-foreground"}>✕</Text>
      </View>
    </View>
  );
}

let libraryScroll: ScrollRef | undefined;
/** Scrolls My List's page (the perf scenario's `lscroll`). */
export function scrollLibraryTo(y: number) {
  libraryScroll?.scrollTo({ y, animated: true });
}

export function Library() {
  const watching = computed(() => continueWatchingByTitle());
  const items = computed(() => watchlist());
  const gridW = signal(0);
  /** Three across on a phone, more on wider screens (lib/ui `posterGrid`). */
  const grid = computed(() => posterGrid(gridW()));
  const cols = () => grid().cols;
  const cardW = () => grid().cardW;
  let scroll: ScrollRef | undefined;
  let lastTap = tabReselected();
  effect(() => {
    const n = tabReselected();
    if (n !== lastTap) {
      lastTap = n;
      // Every tab's root stays mounted: only the shown one scrolls up.
      if (untracked(currentTab) === "library") scroll?.scrollTo({ y: 0, animated: true });
    }
  });

  return (
    <Scroll
      ref={(n: ScrollRef) => {
        scroll = n;
        libraryScroll = n;
      }}
      class="flex-1"
      // TV: no pull to refresh (no touch).
      refreshing={tvMode() ? undefined : refreshing()}
      onRefresh={tvMode() ? undefined : () => void refresh()}
    >
      <View
        class={tvMode() ? "gap-8 pb-10 pl-4" : "gap-8 p-4 pb-10"}
        style={tvMode() ? { paddingTop: TV_SAFE.top, paddingRight: TV_SAFE.right } : undefined}
      >
        <Section title={`Continue Watching (${watching().length})`}>
          <If when={watching().length === 0}>
            <Text class="text-sm text-muted-foreground">
              Nothing in progress. Play something and it shows up here.
            </Text>
          </If>
          <View class="gap-2">
            <Each of={watching()} key={(p) => `${p.type}:${p.id}`}>
              {(p) => <WatchingRow p={p()} />}
            </Each>
          </View>
        </Section>

        <Section title={`My List (${items().length})`}>
          <If when={items().length === 0}>
            <EmptyState
              icon="＋"
              title="Your list is empty"
              body="Add movies, shows and anime from their pages, or long-press (right-click on a computer) any poster."
              actionLabel="Browse Home"
              onAction={() => navigate({ name: "home" })}
            />
          </If>
          {/* A virtualized grid in the page (`viewport="parent"`): only the
              rows near the screen exist, however long the list grows.
              The columns fill the width (posterGrid). */}
          <View onLayout={(e) => gridW.set(e.bounds.size.width)}>
            {/* TV: a plain grid (every card in the D-pad's reach; a list's
                rows that are not mounted could not be moved to). */}
            <If when={tvMode() && gridW() > 0 && items().length > 0}>
              <View class="flex-row flex-wrap" style={{ columnGap: grid().gap, rowGap: 16 }}>
                <Each of={items()} key={(i: LibraryItem) => `${i.type}:${i.id}`}>
                  {(item) => (
                    <PosterCard
                      target={{
                        type: item().type,
                        id: item().id,
                        title: item().title,
                        poster: item().poster,
                        year: item().year,
                      }}
                      image={item().poster}
                      subtitle={`${item().type.toUpperCase()} ${item().year ?? ""}`.trim()}
                      width={cardW()}
                    />
                  )}
                </Each>
              </View>
            </If>
            <If when={!tvMode() && gridW() > 0 && items().length > 0}>
            <List
              viewport="parent"
              each={items()}
              numColumns={cols()}
              estimatedItemSize={Math.round(cardW() * 1.5) + 44}
              contentStyle={{ rowGap: 16, columnGap: grid().gap }}
            >
              {(item: () => LibraryItem) => (
                <PosterCard
                  target={{
                    type: item().type,
                    id: item().id,
                    title: item().title,
                    poster: item().poster,
                    year: item().year,
                  }}
                  image={item().poster}
                  subtitle={`${item().type.toUpperCase()} ${item().year ?? ""}`.trim()}
                  width={cardW()}
                />
              )}
            </List>
            </If>
          </View>
        </Section>
      </View>
    </Scroll>
  );
}

function fmt(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
