// Search: a query field over TMDB multi-search and AniList anime.

import { signal, Scroll, Text, View, Image } from "nsh";
import { Input } from "nsh/base";
import { aniSearch, aniTitle, type AniMedia } from "../lib/anilist";
import { goTitle, navigate } from "../lib/router";
import { isMovie, search, title as mediaTitle, year, type Media } from "../lib/tmdb";
import { MediaCard } from "../lib/ui";

const query = signal("");
const results = signal<Media[]>([]);
const animeResults = signal<AniMedia[]>([]);
const searching = signal(false);
const searched = signal(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function run(q: string) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!q.trim()) {
      results.set([]);
      animeResults.set([]);
      searched.set(false);
      return;
    }
    searching.set(true);
    searched.set(true);
    try {
      const [tmdbRes, aniRes] = await Promise.all([
        search(q).catch(() => [] as Media[]),
        aniSearch(q).catch(() => [] as AniMedia[]),
      ]);
      results.set(tmdbRes);
      animeResults.set(aniRes);
    } finally {
      searching.set(false);
    }
  }, 350);
}

export function Search() {
  return (
    <View class="flex-1 gap-4 p-4">
      <Input
        value={query()}
        onChange={({ value }) => {
          query.set(value);
          run(value);
        }}
        placeholder="Search movies, shows, anime…"
        class="rounded-lg border border-input bg-background px-3 py-2 text-foreground"
      />
      <If when={searching()}>
        <Text class="text-sm text-muted-foreground">Searching…</Text>
      </If>
      <If when={searched() && !searching()}>
        <Scroll class="flex-1">
          <Text class="pb-2 text-sm font-semibold text-muted-foreground">
            {`${results().length + animeResults().length} results`}
          </Text>
          <View class="flex-row flex-wrap gap-4">
            <Each of={animeResults()}>
              {(m) => (
                <View
                  role="button"
                  onPress={() => navigate({ name: "title", type: "anime", id: m().id })}
                  style={{ width: 140 }}
                  class="gap-1 active:opacity-70"
                >
                  <View class="relative">
                    <Image
                      src={m().coverImage.large}
                      style={{ width: 140, height: 210, borderRadius: 8 }}
                    />
                    <View class="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5">
                      <Text class="text-[10px] font-bold text-primary-foreground">ANIME</Text>
                    </View>
                  </View>
                  <Text class="text-xs font-medium text-foreground" style={{ numberOfLines: 1 }}>
                    {aniTitle(m())}
                  </Text>
                  <Text class="text-[11px] text-muted-foreground">{m().seasonYear ?? ""}</Text>
                </View>
              )}
            </Each>
            <Each of={results()}>
              {(m) => (
                <MediaCard
                  media={m()}
                  onPress={() => goTitle(isMovie(m()) ? "movie" : "tv", m().id)}
                />
              )}
            </Each>
          </View>
        </Scroll>
      </If>
      <If when={!searched()}>
        <Text class="text-sm text-muted-foreground">
          Movies and series come from TMDB; anime from AniList. Start typing to search.
        </Text>
      </If>
    </View>
  );
}
