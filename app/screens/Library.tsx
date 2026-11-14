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
  resumeRoute,
  Section,
  type CardTarget,
} from "../lib/ui";

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

let libraryScroll: ScrollRef | undefined;
/** Scrolls My List's page (the perf scenario's `lscroll`). */
export function scrollLibraryTo(y: number) {
  libraryScroll?.scrollTo({ y, animated: true });
}

export function Library() {
  const watching = computed(() => continueWatchingByTitle());
  const items = computed(() => watchlist());
  const gridW = signal(0);
  const cols = computed(() => Math.max(1, Math.floor((gridW() + 16) / (140 + 16))));
  /** Cards fill their column (at least 140 pt). */
  const cardW = computed(() => Math.max(140, Math.floor((gridW() - (cols() - 1) * 16) / cols())));
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
      refreshing={refreshing()}
      onRefresh={() => void refresh()}
    >
      <View class="gap-8 p-4 pb-10">
        <Section title={`Continue Watching (${watching().length})`}>
          <If when={watching().length === 0}>
            <Text class="text-sm text-muted-foreground">
              Nothing in progress. Play something and it shows up here.
            </Text>
          </If>
          <View class="gap-2">
            <Each of={watching()} key={(p) => `${p.type}:${p.id}`}>
              {(p) => (
                <View class="flex-row items-center gap-3 rounded-lg bg-muted/50 p-2">
                  <View
                    role="button"
                    accessibilityLabel={`Resume ${p().title}`}
                    onPress={() => navigate(resumeRoute(p()))}
                    onLongPress={
                      platform.desktop ? undefined : () => void openCardMenu(progressTarget(p()))
                    }
                    onContextMenu={(e) => void openCardMenu(progressTarget(p()), e.pagePosition)}
                    class="flex-1 cursor-pointer flex-row items-center gap-3 active:opacity-70"
                  >
                    <Image
                      src={p().poster}
                      style={{ width: 90, height: 60, borderRadius: 6 }}
                    />
                    <View class="flex-1 gap-0.5">
                      <Text class="text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>
                        {p().title}
                      </Text>
                      <Text class="text-xs text-muted-foreground">
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
                    role="button"
                    accessibilityLabel="Remove from Continue Watching"
                    onPress={() => removeProgressForTitle(p().type, p().id)}
                    class="cursor-pointer rounded-lg p-2 hover:bg-muted active:bg-muted"
                  >
                    <Text class="text-xs text-muted-foreground">✕</Text>
                  </View>
                </View>
              )}
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
              Columns of 140 pt cards fit the width (16 pt apart). */}
          <View onLayout={(e) => gridW.set(e.bounds.size.width)}>
            <If when={gridW() > 0 && items().length > 0}>
            <List
              viewport="parent"
              each={items()}
              numColumns={cols()}
              estimatedItemSize={262}
              contentStyle={{ rowGap: 16, columnGap: 16 }}
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
