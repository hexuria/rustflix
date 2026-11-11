// Home: a hero banner over horizontal rows, like Streambert's HomePage.

import { computed, signal, Text, View } from "nsh";
import { Image } from "nsh";
import { aniTitle, aniTrending, type AniMedia } from "../lib/anilist";
import { goTitle, navigate } from "../lib/router";
import {
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
import { Badge, Button, MediaCard, Row } from "../lib/ui";

const hero = signal<Media | null>(null);
const trendingMedia = signal<Media[]>([]);
const movies = signal<Media[]>([]);
const tv = signal<Media[]>([]);
const topRated = signal<Media[]>([]);
const upcomingMedia = signal<Media[]>([]);
const nowPlayingMedia = signal<Media[]>([]);
const anime = signal<AniMedia[]>([]);
const error = signal("");

let started = false;
function load() {
  if (started) return;
  started = true;
  trending()
    .then((r) => {
      trendingMedia.set(r);
      hero.set(r.find((m) => m.backdrop_path) ?? r[0] ?? null);
    })
    .catch((e) => error.set(String(e)));
  popularMovies().then(movies.set).catch(() => {});
  popularTv().then(tv.set).catch(() => {});
  topRatedMovies().then(topRated.set).catch(() => {});
  upcoming().then(upcomingMedia.set).catch(() => {});
  nowPlaying().then(nowPlayingMedia.set).catch(() => {});
  aniTrending().then(anime.set).catch(() => {});
}

function Hero() {
  const m = computed(() => hero());
  const open = () => {
    const h = hero();
    if (h) goTitle(isMovie(h) ? "movie" : "tv", h.id);
  };
  return (
    <View class="relative h-[300px] w-full overflow-hidden">
      <Image
        src={imgUrl(m()?.backdrop_path, "w1280")}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 220,
          backgroundColor: "rgba(0,0,0,0.78)",
        }}
      />
      <View class="absolute bottom-6 left-6 gap-2" style={{ maxWidth: 560 }}>
        <Text class="text-3xl font-extrabold text-white" style={{ numberOfLines: 2 }}>
          {m() ? mediaTitle(m()!) : ""}
        </Text>
        <View class="flex-row gap-2">
          <Badge text={m() && isMovie(m()!) ? "Movie" : "TV"} accent />
          <Badge text={String((m()?.release_date ?? m()?.first_air_date ?? "").slice(0, 4))} />
          {m()?.vote_average ? <Badge text={`${m()!.vote_average!.toFixed(1)} ★`} /> : null}
        </View>
        <Text class="text-sm text-zinc-300" style={{ numberOfLines: 3 }}>
          {m()?.overview ?? ""}
        </Text>
        <View class="mt-1 flex-row gap-3">
          <Button primary label="▶ Play" onPress={open} />
          <Button label="Details" onPress={open} />
        </View>
      </View>
    </View>
  );
}

function TmdbRow(props: { title: string; items: Media[]; type: "movie" | "tv" }) {
  return (
    <Row title={props.title}>
      <Each of={props.items}>
        {(m) => <MediaCard media={m()} onPress={() => goTitle(props.type, m().id)} />}
      </Each>
    </Row>
  );
}

export function Home() {
  load();
  return (
    <View class="flex-1">
      <Hero />
      <View class="flex-1 gap-6 pt-4">
        <If when={error()}>
          {(e) => (
            <View class="mx-4 rounded-lg border border-red-800 bg-red-950/40 p-3">
              <Text class="text-sm text-red-300">{e()}</Text>
            </View>
          )}
        </If>
        <Row title="Trending This Week">
          <Each of={trendingMedia()}>
            {(m) => (
              <MediaCard
                media={m()}
                onPress={() => goTitle(isMovie(m()) ? "movie" : "tv", m().id)}
              />
            )}
          </Each>
        </Row>
        <TmdbRow title="Now Playing" items={nowPlayingMedia()} type="movie" />
        <TmdbRow title="Popular Movies" items={movies()} type="movie" />
        <TmdbRow title="Popular TV" items={tv()} type="tv" />
        <TmdbRow title="Top Rated Movies" items={topRated()} type="movie" />
        <TmdbRow title="Upcoming" items={upcomingMedia()} type="movie" />
        <Row title="Trending Anime">
          <Each of={anime()}>
            {(m) => (
              <View
                role="button"
                onPress={() => navigate({ name: "title", type: "anime", id: m().id })}
                style={{ width: 140 }}
                class="gap-1 active:opacity-70"
              >
                <Image
                  src={m().coverImage.large}
                  style={{ width: 140, height: 210, borderRadius: 8 }}
                />
                <Text class="text-xs font-medium text-foreground" style={{ numberOfLines: 1 }}>
                  {aniTitle(m())}
                </Text>
                <Text class="text-[11px] text-muted-foreground">{m().seasonYear ?? ""}</Text>
              </View>
            )}
          </Each>
        </Row>
      </View>
    </View>
  );
}
