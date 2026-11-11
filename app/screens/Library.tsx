// Library: watchlist grid and "continue watching" progress rows.

import { computed, Text, View, Image, Scroll } from "nsh";
import { goTitle, navigate } from "../lib/router";
import { continueWatching, progress, removeProgress, watchlist } from "../lib/store";
import { Section } from "../lib/ui";

export function Library() {
  const watching = computed(() => continueWatching());
  const items = computed(() => watchlist());

  return (
    <Scroll class="flex-1">
      <View class="gap-8 p-4 pb-10">
        <Section title={`Continue Watching (${watching().length})`}>
          <If when={watching().length === 0}>
            <Text class="text-sm text-muted-foreground">
              Nothing in progress. Play something and it shows up here.
            </Text>
          </If>
          <View class="gap-2">
            <Each of={watching()}>
              {(p) => (
                <View class="flex-row items-center gap-3 rounded-lg bg-muted/50 p-2">
                  <View
                    role="button"
                    onPress={() =>
                      navigate({
                        name: "player",
                        type: p().type,
                        id: p().id,
                        season: p().season,
                        episode: p().episode,
                        title: p().title,
                        poster: p().poster,
                      })
                    }
                    class="flex-1 flex-row items-center gap-3"
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
                        {p().type === "tv" || p().type === "anime"
                          ? `S${p().season}E${p().episode} · `
                          : ""}
                        {fmt(p().position)} / {fmt(p().duration)}
                      </Text>
                      <View class="mt-1 h-1 w-full rounded bg-zinc-700">
                        <View
                          class="h-1 rounded bg-red-600"
                          style={{
                            width: `${Math.min(100, (p().position / Math.max(1, p().duration)) * 100)}%`,
                          }}
                        />
                      </View>
                    </View>
                  </View>
                  <View
                    role="button"
                    onPress={() => removeProgress(p().key)}
                    class="rounded-lg p-2 active:bg-zinc-700"
                  >
                    <Text class="text-xs text-zinc-500">✕</Text>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </Section>

        <Section title={`My List (${items().length})`}>
          <If when={items().length === 0}>
            <Text class="text-sm text-muted-foreground">
              Add movies, shows and anime from their pages.
            </Text>
          </If>
          <View class="flex-row flex-wrap gap-4">
            <Each of={items()}>
              {(item) => (
                <View
                  role="button"
                  onPress={() => goTitle(item().type, item().id)}
                  style={{ width: 140 }}
                  class="gap-1 active:opacity-70"
                >
                  <Image
                    src={item().poster}
                    style={{ width: 140, height: 210, borderRadius: 8 }}
                  />
                  <Text class="text-xs font-medium text-foreground" style={{ numberOfLines: 1 }}>
                    {item().title}
                  </Text>
                  <Text class="text-[11px] text-muted-foreground">
                    {item().type.toUpperCase()} {item().year ?? ""}
                  </Text>
                </View>
              )}
            </Each>
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

