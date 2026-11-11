// Title page: details, seasons/episodes, watchlist toggle, play.
// Movie/TV metadata from TMDB; anime from AniList.

import { computed, effect, signal, Scroll, Text, View, Image } from "nsh";
import { aniDetails, aniTitle, type AniMedia } from "../lib/anilist";
import { navigate, route } from "../lib/router";
import { inWatchlist, toggleWatchlist } from "../lib/store";
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
import { Badge, Button, Section } from "../lib/ui";
import type { Route } from "../lib/router";

type TitleRoute = Extract<Route, { name: "title" }>;

const details = signal<TitleDetails | null>(null);
const anime = signal<AniMedia | null>(null);
const seasons = signal<Season[]>([]);
const episodes = signal<Episode[]>([]);
const selectedSeason = signal(1);
const selectedEp = signal(1);
const loading = signal(true);
const error = signal("");
const animeLang = signal<"sub" | "dub">("sub");
let loadedFor = "";

const current = computed<TitleRoute | null>(() => {
  const r = route();
  return r.name === "title" ? r : null;
});

function play(r: TitleRoute) {
  if (r.type === "anime") {
    navigate({
      name: "player",
      type: r.type,
      id: r.id,
      episode: selectedEp(),
      lang: animeLang(),
      title: anime() ? aniTitle(anime()!) : undefined,
      poster: anime()?.coverImage.large,
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
    title: d ? mediaTitle(d) : undefined,
    poster: d ? imgUrl(d.poster_path, "w342") : undefined,
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

async function pickSeason(n: number) {
  selectedSeason.set(n);
  selectedEp.set(1);
  const d = details();
  if (!d) return;
  try {
    const data = await seasonDetails(d.id, n);
    episodes.set(data.episodes ?? []);
  } catch {
    episodes.set([]);
  }
}

function load(r: TitleRoute) {
  const key = `${r.type}:${r.id}`;
  if (key === loadedFor) return;
  loadedFor = key;
  loading.set(true);
  error.set("");
  details.set(null);
  anime.set(null);
  seasons.set([]);
  episodes.set([]);
  selectedSeason.set(1);
  selectedEp.set(1);
  animeLang.set("sub");

  if (r.type === "anime") {
    aniDetails(r.id)
      .then((m) => {
        anime.set(m);
        selectedEp.set(1);
      })
      .catch((e) => error.set(String(e)))
      .finally(() => loading.set(false));
    return;
  }

  const fetchDetails = r.type === "movie" ? movieDetails : tvDetails;
  fetchDetails(r.id)
    .then(async (d) => {
      details.set(d);
      if (r.type === "tv") {
        const list = (d.seasons ?? []).filter((s) => s.season_number > 0);
        seasons.set(list);
        const first = list[0]?.season_number ?? 1;
        selectedSeason.set(first);
        const data = await seasonDetails(d.id, first);
        episodes.set(data.episodes ?? []);
      }
    })
    .catch((e) => error.set(String(e)))
    .finally(() => loading.set(false));
}

function Meta({ children }: { children: any }) {
  return <Text class="text-sm text-muted-foreground">{children}</Text>;
}

export function Title() {
  // Reload whenever the route's title changes.
  effect(() => {
    const r = current();
    if (r) load(r);
  });

  const d = computed(() => details());
  const a = computed(() => anime());
  const r = computed(() => current());
  const isAnime = () => r()?.type === "anime";
  const displayTitle = computed(() =>
    isAnime() ? (a() ? aniTitle(a()!) : "…") : d() ? mediaTitle(d()!) : "…",
  );
  const poster = computed(() =>
    isAnime() ? a()?.coverImage.large : d() ? imgUrl(d()!.poster_path, "w342") : "",
  );
  const backdrop = computed(() =>
    isAnime() ? a()?.bannerImage : d() ? imgUrl(d()!.backdrop_path, "w1280") : "",
  );
  const inList = computed(() => {
    const t = r();
    return t ? inWatchlist(t.type, t.id) : false;
  });

  const toggleList = () => {
    const t = r();
    if (!t) return;
    const item = isAnime()
      ? {
          type: "anime" as const,
          id: t.id,
          title: a() ? aniTitle(a()!) : "Anime",
          poster: a()?.coverImage.large ?? "",
          year: a()?.seasonYear ? String(a()!.seasonYear) : undefined,
        }
      : {
          type: t.type as "movie" | "tv",
          id: t.id,
          title: d() ? mediaTitle(d()!) : "Title",
          poster: d() ? imgUrl(d()!.poster_path, "w342") : "",
          year: d() ? year(d()!) : undefined,
        };
    void toggleWatchlist(item);
  };

  const animeCount = computed(() => {
    const m = a();
    if (!m?.episodes) return 12;
    return Math.min(m.episodes, 300);
  });

  return (
    <Scroll class="flex-1">
      <View class="pb-10">
        <View class="relative h-[280px] w-full">
          <Image src={backdrop() ?? ""} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 200,
              backgroundColor: "rgba(0,0,0,0.8)",
            }}
          />
        </View>
        <View class="-mt-40 flex-row gap-5 px-6">
          <Image
            src={poster() ?? ""}
            style={{ width: 160, height: 240, borderRadius: 10 }}
          />
          <View class="flex-1 gap-2 pt-44">
            <Text class="text-2xl font-extrabold text-white" style={{ numberOfLines: 2 }}>
              {displayTitle()}
            </Text>
            <View class="flex-row flex-wrap gap-2">
              <If when={isAnime()}>
                <>
                  <Badge text="ANIME" accent />
                  <If when={a()?.seasonYear}>
                    {(y) => <Badge text={String(y())} />}
                  </If>
                  <If when={a()?.averageScore}>
                    {(s) => <Badge text={`${Math.round(s()! / 10)} / 10`} />}
                  </If>
                  <If when={a()?.status}>
                    {(s) => <Badge text={String(s())} />}
                  </If>
                </>
              </If>
              <If when={!isAnime()}>
                <>
                  <Badge text={r()?.type === "movie" ? "Movie" : "TV"} accent />
                  <If when={d()?.release_date ?? d()?.first_air_date}>
                    {(date) => <Badge text={String(date()).slice(0, 4)} />}
                  </If>
                  <If when={d()?.vote_average}>
                    {(v) => <Badge text={`${Number(v()).toFixed(1)} ★`} />}
                  </If>
                  <If when={d()?.status}>
                    {(s) => <Badge text={String(s())} />}
                  </If>
                </>
              </If>
            </View>
            <If
              when={
                isAnime()
                  ? a()?.genres?.join(", ")
                  : d()?.genres?.map((g) => g.name).join(", ")
              }
            >
              {(g) => <Meta>{g()}</Meta>}
            </If>
            <View class="mt-2 flex-row gap-3">
              <Button
                primary
                label="▶ Play"
                onPress={() => {
                  const t = r();
                  if (t) play(t);
                }}
              />
              <Button label={inList() ? "✓ In List" : "+ My List"} onPress={toggleList} />
            </View>
          </View>
        </View>

        <View class="gap-6 px-6 pt-8">
          <If when={loading()}>
            <Text class="text-muted-foreground">Loading…</Text>
          </If>
          <If when={error()}>
            {(e) => <Text class="text-red-400">{e()}</Text>}
          </If>

          <If when={!isAnime() && d()?.overview}>
            {(o) => (
              <Section title="Overview">
                <Text class="text-sm leading-5 text-foreground">{o()}</Text>
              </Section>
            )}
          </If>
          <If when={isAnime() && a()?.description}>
            {(o) => (
              <Section title="Synopsis">
                <Text class="text-sm leading-5 text-foreground" style={{ numberOfLines: 12 }}>
                  {String(o()).replace(/<[^>]+>/g, "")}
                </Text>
              </Section>
            )}
          </If>

          {/* TV seasons & episodes */}
          <If when={r()?.type === "tv" && seasons().length > 0}>
            <Section title="Episodes">
              <Scroll horizontal style={{ height: 40 }} class="-mx-1">
                <View class="flex-row gap-2 px-1">
                  <Each of={seasons()}>
                    {(s) => (
                      <View
                        role="button"
                        onPress={() => pickSeason(s().season_number)}
                        class={
                          selectedSeason() === s().season_number
                            ? "rounded-lg bg-primary px-3 py-1.5"
                            : "rounded-lg bg-muted px-3 py-1.5"
                        }
                      >
                        <Text
                          class={
                            selectedSeason() === s().season_number
                              ? "text-sm font-semibold text-primary-foreground"
                              : "text-sm text-muted-foreground"
                          }
                        >
                          {s().name}
                        </Text>
                      </View>
                    )}
                  </Each>
                </View>
              </Scroll>
              <View class="gap-1">
                <Each of={episodes()}>
                  {(ep) => (
                    <View
                      role="button"
                      onPress={() => {
                        selectedEp.set(ep().episode_number);
                        const t = r();
                        if (t) play(t);
                      }}
                      class="flex-row items-center gap-3 rounded-lg p-2 active:bg-muted"
                    >
                      <Image
                        src={imgUrl(ep().still_path, "w300") || ""}
                        style={{ width: 140, height: 80, borderRadius: 6 }}
                      />
                      <View class="flex-1 gap-0.5">
                        <Text class="text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>
                          {ep().episode_number}. {ep().name}
                        </Text>
                        <Text class="text-xs text-muted-foreground">
                          {ep().air_date?.slice(0, 10) ?? ""} {ep().runtime ? `· ${ep().runtime}m` : ""}
                        </Text>
                        <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 2 }}>
                          {ep().overview ?? ""}
                        </Text>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </Section>
          </If>

          {/* Anime episodes + sub/dub */}
          <If when={isAnime() && a()}>
            <Section title={`Episodes (${a()?.episodes ?? "?"})`}>
              <View class="flex-row gap-2">
                <View
                  role="button"
                  onPress={() => animeLang.set("sub")}
                  class={
                    animeLang() === "sub"
                      ? "rounded-lg bg-primary px-4 py-1.5"
                      : "rounded-lg bg-muted px-4 py-1.5"
                  }
                >
                  <Text class={animeLang() === "sub" ? "text-sm font-semibold text-primary-foreground" : "text-sm text-muted-foreground"}>
                    Sub
                  </Text>
                </View>
                <View
                  role="button"
                  onPress={() => animeLang.set("dub")}
                  class={
                    animeLang() === "dub"
                      ? "rounded-lg bg-primary px-4 py-1.5"
                      : "rounded-lg bg-muted px-4 py-1.5"
                  }
                >
                  <Text class={animeLang() === "dub" ? "text-sm font-semibold text-primary-foreground" : "text-sm text-muted-foreground"}>
                    Dub
                  </Text>
                </View>
              </View>
              <View class="flex-row flex-wrap gap-2">
                <Each of={animeEpisodeList(animeCount())}>
                  {(n) => (
                    <View
                      role="button"
                      onPress={() => {
                        selectedEp.set(n());
                        const t = r();
                        if (t) play(t);
                      }}
                      class={
                        selectedEp() === n()
                          ? "rounded-lg bg-primary px-3 py-1.5"
                          : "rounded-lg bg-muted px-3 py-1.5"
                      }
                    >
                      <Text
                        class={
                          selectedEp() === n()
                            ? "text-sm font-semibold text-primary-foreground"
                            : "text-sm text-muted-foreground"
                        }
                      >
                        {n()}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </Section>
          </If>
        </View>
      </View>
    </Scroll>
  );
}

function animeEpisodeList(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => i + 1);
}
