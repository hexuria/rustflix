// Episode picker: a full-screen carousel of episode cards over the player
// (Netflix-style). A view in the player's own tree, not a Dialog: on iOS
// views composite over the WKWebView in tree order, and on the desktop
// the player hides the web view while a picker is open (GPUI cannot draw
// over it), so the layer shows in its place. Season chips browse other seasons without leaving it; a
// card plays that episode; the playing one is ringed and scrolled into
// view when the picker opens.

import {
  batch,
  computed,
  effect,
  Image,
  platform,
  safeAreaInsets,
  Scroll,
  signal,
  Text,
  View,
  type ScrollRef,
} from "nsh";
import {
  browseSeason,
  closePalette,
  episodeProgress,
  episodes,
  playEpisode,
  playerRoute,
  playerTitle,
  seasons,
  showSources,
  type EpisodeInfo,
} from "../lib/player";
import { playDownload, type DlEntry, type DlTarget } from "../lib/downloads";
import { DownloadButton, Skeleton } from "../lib/ui";
import { Glyph } from "./PlayerControls";

const desktop = platform.desktop;
const CARD_W = desktop ? 320 : 280;
const CARD_H = Math.round((CARD_W * 9) / 16);
const GAP = 14;

export const showEpisodes = signal(false);

export function openEpisodes() {
  batch(() => {
    closePalette();
    showSources.set(false);
    showEpisodes.set(true);
  });
}

export function closeEpisodes() {
  showEpisodes.set(false);
}

export function EpisodePicker() {
  return (
    <If when={showEpisodes()}>
      <PickerBody />
    </If>
  );
}

function PickerBody() {
  const ins = safeAreaInsets();
  const padL = computed(() => Math.max(ins().left, 20));
  const padR = computed(() => Math.max(ins().right, 20));
  const route = computed(() => playerRoute());
  const isTv = computed(() => route()?.type === "tv");
  // The season the player is in (TV only; anime has one list).
  const curSeason = computed(() => (isTv() ? (route()?.season ?? 1) : undefined));
  const curEp = computed(() => route()?.episode ?? 1);

  const browsed = signal<number | undefined>(curSeason());
  const other = signal<EpisodeInfo[]>([]);
  const loading = signal(false);
  const error = signal<string | null>(null);
  let req = 0;

  const onCurrent = computed(() => browsed() === curSeason());
  const shown = computed(() => (onCurrent() ? episodes() : other()));

  const load = (s: number) => {
    browsed.set(s);
    error.set(null);
    scrolledFor = "";
    if (s === curSeason()) {
      loading.set(false);
      return;
    }
    const id = ++req;
    other.set([]);
    loading.set(true);
    browseSeason(s)
      .then((list) => {
        if (id !== req) return;
        other.set(list);
        loading.set(false);
      })
      .catch((e: unknown) => {
        if (id !== req) return;
        error.set(e instanceof Error ? e.message : String(e));
        loading.set(false);
      });
  };

  // The carousel: opens on the playing card; a browsed season from its start.
  let ref: ScrollRef | undefined;
  let scrolledFor = "";
  const viewW = signal(0);
  const contentW = signal(0);
  const x = signal(0);
  const maxX = computed(() => Math.max(0, contentW() - viewW()));
  const scrollIntoView = () => {
    const list = shown();
    const key = `${browsed() ?? "a"}:${list.length}`;
    if (!ref || !list.length || scrolledFor === key) return;
    scrolledFor = key;
    const i = onCurrent() ? list.findIndex((e) => e.n === curEp()) : 0;
    const to = Math.min(maxX(), Math.max(0, i * (CARD_W + GAP)));
    x.set(to);
    ref.scrollTo({ x: to, animated: false });
  };
  effect(() => {
    // Re-run when the list or the sizes change (after layout).
    shown();
    contentW();
    viewW();
    scrollIntoView();
  });
  const page = (dir: 1 | -1) => {
    const w = viewW() || 600;
    const to = Math.min(maxX(), Math.max(0, x() + dir * w * 0.85));
    x.set(to);
    ref?.scrollTo({ x: to, animated: true });
  };

  /** A card's download target (the browsed season's episode for TV). */
  const dlTarget = (e: EpisodeInfo): DlTarget | null => {
    const r = route();
    if (!r || r.type === "movie") return null;
    return {
      type: r.type,
      id: r.id,
      season: r.type === "tv" ? (browsed() ?? curSeason() ?? 1) : undefined,
      episode: e.n,
      lang: r.type === "anime" ? (r.lang ?? "sub") : undefined,
      title: playerTitle(),
      episodeName: e.name || undefined,
      poster: r.poster,
      still: e.still,
    };
  };

  const pick = (e: EpisodeInfo) => {
    const season = isTv() ? (browsed() ?? curSeason()) : undefined;
    const playing = (!isTv() || season === curSeason()) && e.n === curEp();
    closeEpisodes();
    if (!playing) playEpisode(season, e.n);
  };

  return (
    <View
      class="absolute inset-0 flex-col"
      style={{
        backgroundColor: "#0b0b0d",
        paddingTop: Math.max(ins().top, 12),
        paddingBottom: Math.max(ins().bottom, 12),
      }}
    >
      {/* Header: title, close. */}
      <View class="flex-row items-center" style={{ paddingLeft: padL(), paddingRight: padR() - 8 }}>
        <View class="flex-1 flex-col">
          <Text class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Episodes
          </Text>
          <Text class="text-xl font-bold text-foreground" style={{ numberOfLines: 1 }}>
            {route()?.title ?? ""}
          </Text>
        </View>
        <View
          role="button"
          accessibilityLabel="Close"
          onPress={closeEpisodes}
          class="h-11 w-11 cursor-pointer items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20"
        >
          <Glyph d="close" size={22} />
        </View>
      </View>

      {/* Season chips (series with more than one season). */}
      <If when={isTv() && seasons().length > 1}>
        <Scroll horizontal class="mt-3 flex-none" scrollbar={false}>
          <View class="flex-row gap-2" style={{ paddingLeft: padL(), paddingRight: padR() }}>
            <Each of={seasons()}>
              {(s) => (
                <View
                  role="button"
                  accessibilityLabel={`Season ${s()}`}
                  onPress={() => {
                    if (browsed() !== s()) load(s());
                  }}
                  class={`h-11 cursor-pointer items-center justify-center rounded-full px-4 ${
                    browsed() === s()
                      ? "bg-primary"
                      : "bg-white/10 hover:bg-white/20 active:bg-white/25"
                  }`}
                >
                  <Text
                    class={`text-sm font-semibold ${
                      browsed() === s() ? "text-primary-foreground" : "text-foreground"
                    }`}
                  >
                    {`Season ${s()}`}
                  </Text>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </If>

      {/* Body: the carousel, or skeletons / an error. */}
      <View class="relative flex-1 justify-center">
        <If when={error()}>
          {(msg) => (
            <View class="items-start gap-3" style={{ paddingLeft: padL(), paddingRight: padR() }}>
              <Text class="text-sm text-foreground">{msg()}</Text>
              <View
                role="button"
                onPress={() => {
                  const s = browsed();
                  if (s != null) load(s);
                }}
                class="h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-5 active:opacity-80"
              >
                <Text class="text-sm font-semibold text-primary-foreground">Retry</Text>
              </View>
            </View>
          )}
        </If>
        <If when={!error() && shown().length === 0}>
          <View class="flex-row" style={{ gap: GAP, paddingLeft: padL() }}>
            <Each of={[0, 1, 2, 3]}>
              {() => (
                <View class="gap-2">
                  <Skeleton width={CARD_W} height={CARD_H} radius={10} />
                  <Skeleton width={CARD_W * 0.7} height={14} />
                  <Skeleton width={CARD_W * 0.9} height={12} />
                </View>
              )}
            </Each>
          </View>
          <If when={!loading() && !onCurrent()}>
            <Text class="mt-3 text-sm text-muted-foreground" style={{ paddingLeft: padL() }}>
              No episodes listed for this season.
            </Text>
          </If>
        </If>
        <If when={!error() && shown().length > 0}>
          <Scroll
            ref={(n: ScrollRef) => {
              ref = n;
              scrollIntoView();
            }}
            horizontal
            class="flex-none"
            snapToInterval={CARD_W + GAP}
            decelerationRate="fast"
            onLayout={(e: { bounds: { size: { width: number } } }) =>
              viewW.set(e.bounds.size.width)
            }
            onScroll={(e: { offset: { x: number } }) => x.set(e.offset.x)}
          >
            <View
              class="flex-row items-start"
              style={{ gap: GAP, paddingLeft: padL(), paddingRight: padR() }}
              onLayout={(e: { bounds: { size: { width: number } } }) =>
                contentW.set(e.bounds.size.width)
              }
            >
              <Each of={shown()}>
                {(ep) => (
                  <EpisodeCard
                    ep={ep()}
                    season={isTv() ? browsed() : undefined}
                    playing={onCurrent() && ep().n === curEp()}
                    onPress={() => pick(ep())}
                    target={() => dlTarget(ep())}
                    onPlay={(d) => {
                      // The local copy (on the iPhone it may play in the
                      // system player); otherwise the episode itself, which
                      // starts a "play once" download by itself.
                      if (d.state === "done") {
                        closeEpisodes();
                        playDownload(d.dlId);
                      } else pick(ep());
                    }}
                  />
                )}
              </Each>
            </View>
          </Scroll>
          {/* Desktop: arrows page the carousel. */}
          <If when={desktop && x() > 4}>
            <EdgeArrow side="left" onPress={() => page(-1)} />
          </If>
          <If when={desktop && maxX() - x() > 4}>
            <EdgeArrow side="right" onPress={() => page(1)} />
          </If>
        </If>
      </View>
    </View>
  );
}

function EdgeArrow(props: { side: "left" | "right"; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.side === "left" ? "Scroll left" : "Scroll right"}
      onPress={props.onPress}
      class={`absolute bottom-0 top-0 w-12 cursor-pointer items-center justify-center bg-black/50 hover:bg-black/75 ${
        props.side === "left" ? "left-0" : "right-0"
      }`}
    >
      <Glyph d={props.side === "left" ? "back" : "forward"} size={26} />
    </View>
  );
}

function EpisodeCard(props: {
  ep: EpisodeInfo;
  season: number | undefined;
  playing: boolean;
  onPress: () => void;
  target: () => DlTarget | null;
  onPlay: (e: DlEntry) => void;
}) {
  const progress = computed(() => episodeProgress(props.season, props.ep.n) ?? 0);
  return (
    <View
      role="button"
      accessibilityLabel={`Episode ${props.ep.n}${props.ep.name ? `: ${props.ep.name}` : ""}`}
      onPress={props.onPress}
      class="cursor-pointer gap-1.5 active:opacity-80"
      style={{ width: CARD_W }}
    >
      <View
        class={`overflow-hidden rounded-xl bg-muted ${
          props.playing ? "border-2 border-primary" : "border border-white/10 hover:border-white/40"
        }`}
        style={{ width: CARD_W, height: CARD_H }}
      >
        <If when={props.ep.still}>
          {(src) => <Image src={src()} style={{ width: "100%", height: "100%" }} />}
        </If>
        <If when={!props.ep.still}>
          <View class="flex-1 items-center justify-center bg-linear-to-br from-zinc-800 to-zinc-900">
            <Text class="text-5xl font-black text-white/30">{String(props.ep.n)}</Text>
          </View>
        </If>
        <If when={props.playing}>
          <View class="absolute left-2 top-2 rounded bg-primary px-1.5 py-0.5">
            <Text class="text-[10px] font-bold uppercase text-primary-foreground">
              Now playing
            </Text>
          </View>
        </If>
        <If when={progress() > 0}>
          <View class="absolute inset-x-0 bottom-0 h-1 bg-white/25">
            <View class="h-full bg-primary" style={{ width: `${Math.round(progress() * 100)}%` }} />
          </View>
        </If>
      </View>
      {/* The title line: name, the download control (its own press, so
          it never also picks the card; full 44 pt touch area on phones),
          runtime. */}
      <View class="flex-row items-center gap-2">
        <Text class="flex-1 text-sm font-bold text-foreground" style={{ numberOfLines: 1 }}>
          {`${props.ep.n}. ${props.ep.name || `Episode ${props.ep.n}`}`}
        </Text>
        <DownloadButton target={props.target} size={20} onPlay={props.onPlay} />
        <If when={props.ep.runtime}>
          {(m) => <Text class="text-xs text-muted-foreground">{`${m()}m`}</Text>}
        </If>
      </View>
      <If when={props.ep.overview}>
        {(o) => (
          <Text class="text-xs leading-4 text-muted-foreground" style={{ numberOfLines: 3 }}>
            {o()}
          </Text>
        )}
      </If>
    </View>
  );
}
