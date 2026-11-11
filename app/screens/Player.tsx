// Player: the chosen embed source in a WebView. The WebView is a native
// view above all GPUI content, so nothing can draw over it: while the
// command palette or the source picker is open, the video area collapses
// to zero height (the page keeps its state) and a fixed-size floating
// card takes the space. Cmd+K toggles the palette; it lists episodes and
// playback controls, filters as you type, and ⌘1–⌘9 pick items.

import { computed, effect, platform, signal, Text, View, WebView } from "nsh";
import { Slider } from "nsh/base";
import { goBack, route } from "../lib/router";
import {
  cancelDownload,
  closePalette,
  debug,
  downloads,
  episodes,
  extLoading,
  loadEpisodes,
  mediaFullscreen,
  mediaPaused,
  mediaRate,
  nextEpisode,
  onPlayerMessage,
  openPalette,
  paletteQuery,
  paletteRows,
  paletteSelect,
  paletteView,
  paletteViewTitle,
  pickSource,
  playPlayback,
  enterFullscreen,
  position,
  duration,
  armBridge,
  PLAYER_BRIDGE,
  playerRoute,
  playerUrl,
  prevEpisode,
  seekTo,
  setPageKeysBlocked,
  setRate,
  showPalette,
  showSources,
  seasons,
  sourceId,
  startPlayer,
  stopPlayer,
  togglePlay,
  webview,
} from "../lib/player";
import { NEEDS_INTERCEPT, sourcesFor, type MediaType } from "../lib/sources";

// The last player route we armed for. NSH effects re-run on signal
// writes, and the player writes signals every probe — without this guard
// startPlayer/armResume would re-fire constantly and the resume seek
// would keep resetting the video (the 9:43 loop).
let handledRoute = "";

// --- Touch controls ---------------------------------------------------------
//
// iOS composites native views in tree order, so this overlay really draws
// over the WKWebView (the GPUI desktop backend cannot: its web view is a
// native child above all GPUI content). A full-area tap layer owns every
// touch — the embed's own controls stay unreachable underneath — and the
// chrome auto-hides a few seconds after the last interaction.
const controlsVisible = signal(true);
const seekDrag = signal<number | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function pokeControls() {
  controlsVisible.set(true);
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => controlsVisible.set(false), 4000);
}

function tapControls() {
  if (controlsVisible()) {
    controlsVisible.set(false);
    if (hideTimer) clearTimeout(hideTimer);
  } else {
    pokeControls();
  }
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function MobileControls() {
  const r = computed(() => playerRoute());
  const paused = computed(() => mediaPaused());
  const dur = computed(() => duration());
  const pct = computed(() => {
    const drag = seekDrag();
    if (drag != null) return drag;
    const d = duration();
    return d > 0 ? Math.min(100, (position() / d) * 100) : 0;
  });
  const canNext = computed(() => {
    const p = r();
    if (!p || p.type === "movie") return false;
    const cur = p.episode ?? 1;
    const eps = episodes();
    const i = eps.findIndex((e) => e.n === cur);
    if (i >= 0 && i + 1 < eps.length) return true;
    if (p.type === "anime") return false;
    const ss = seasons();
    const si = ss.indexOf(p.season ?? 1);
    return si >= 0 && si + 1 < ss.length;
  });
  const canPrev = computed(() => {
    const p = r();
    if (!p || p.type === "movie") return false;
    if ((p.episode ?? 1) > 1) return true;
    if (p.type === "anime") return false;
    const ss = seasons();
    return ss.indexOf(p.season ?? 1) > 0;
  });
  const ctlBtn =
    "flex-row items-center justify-center rounded-full bg-white/10 px-3 py-2 active:bg-white/25";
  return (
    <View class="absolute inset-0">
      {/* Tap layer: owns every touch so the chrome can auto-hide; the
          embed's own controls stay unreachable underneath it. The near-
          transparent background keeps it a real hit target. */}
      <View
        class="absolute inset-0"
        style={{ backgroundColor: "rgba(0,0,0,0.01)" }}
        onPress={tapControls}
      />
      <If when={controlsVisible() && !mediaFullscreen()}>
        <>
          <View class="absolute inset-x-0 top-0 flex-row items-center gap-2 bg-black/60 px-3 pb-8 pt-3">
            <View
              role="button"
              onPress={() => {
                pokeControls();
                goBack();
              }}
              class={ctlBtn}
            >
              <Text class="text-lg font-bold text-white">‹</Text>
            </View>
            <Text
              class="flex-1 text-sm font-semibold text-white"
              style={{ numberOfLines: 1 }}
            >
              {r()?.title ?? ""}
            </Text>
            <View
              role="button"
              onPress={() => {
                pokeControls();
                showSources.set(!showSources());
              }}
              class={ctlBtn}
            >
              <Text class="text-sm font-bold text-white">⇄</Text>
            </View>
          </View>
          <View class="absolute inset-x-0 bottom-0 flex-col gap-2 bg-black/60 px-4 pb-5 pt-10">
            <View class="flex-row items-center gap-3">
              <Text class="w-10 text-right text-[11px] font-medium text-zinc-300">
                {fmtTime(position())}
              </Text>
              <Slider
                value={pct()}
                onChange={({ value }) => seekDrag.set(Number(value))}
                onChangeEnd={({ value }) => {
                  const d = duration();
                  seekTo((Number(value) / 100) * d);
                  seekDrag.set(null);
                  pokeControls();
                }}
                accessibilityLabel="Seek"
                class="flex-1"
                trackClass="h-1 flex-1 rounded-full bg-white/25"
                indicatorClass="h-full"
                rangeClass="rounded-full bg-red-600"
                thumbClass="h-3 w-3 rounded-full bg-white"
              />
              <Text class="w-10 text-[11px] font-medium text-zinc-300">
                {fmtTime(dur())}
              </Text>
            </View>
            <View class="flex-row items-center gap-2">
              <If when={canPrev()}>
                <View
                  role="button"
                  onPress={() => {
                    pokeControls();
                    void prevEpisode();
                  }}
                  class={ctlBtn}
                >
                  <Text class="text-base text-white">⏮</Text>
                </View>
              </If>
              <View
                role="button"
                onPress={() => {
                  pokeControls();
                  togglePlay();
                }}
                class="flex-row items-center justify-center rounded-full bg-white/10 px-4 py-2 active:bg-white/25"
              >
                <Text class="text-lg font-bold text-white">
                  {paused() ? "▶" : "⏸"}
                </Text>
              </View>
              <If when={canNext()}>
                <View
                  role="button"
                  onPress={() => {
                    pokeControls();
                    void nextEpisode();
                  }}
                  class={ctlBtn}
                >
                  <Text class="text-base text-white">⏭</Text>
                </View>
              </If>
              <View class="flex-1" />
              <View
                role="button"
                onPress={() => {
                  pokeControls();
                  seekBy(-10);
                }}
                class={ctlBtn}
              >
                <Text class="text-xs font-bold text-white">−10s</Text>
              </View>
              <View
                role="button"
                onPress={() => {
                  pokeControls();
                  seekBy(10);
                }}
                class={ctlBtn}
              >
                <Text class="text-xs font-bold text-white">+10s</Text>
              </View>
              <View
                role="button"
                onPress={() => {
                  pokeControls();
                  enterFullscreen();
                }}
                class={ctlBtn}
              >
                <Text class="text-sm font-bold text-white">⛶</Text>
              </View>
              <View
                role="button"
                onPress={() => {
                  pokeControls();
                  openPalette();
                }}
                class={ctlBtn}
              >
                <Text class="text-sm font-bold text-white">⋯</Text>
              </View>
            </View>
          </View>
        </>
      </If>
    </View>
  );
}

export function Player() {
  // (Re)arm state, episode list and resume only when the route itself
  // changes — not on every position/progress signal write.
  effect(() => {
    const r = route();
    const key =
      r.name === "player"
        ? `p:${r.type}:${r.id}:${r.season ?? 0}:${r.episode ?? 0}`
        : r.name;
    if (key === handledRoute) return;
    handledRoute = key;
    if (r.name === "player") {
      startPlayer();
      void loadEpisodes(r);
    } else {
      stopPlayer();
    }
  });

  // While an overlay card owns the keyboard, the page must not also act
  // on the same keys: the native web view keeps first responder (GPUI's
  // blur() cannot resign it), so the bridge swallows keys page-side.
  effect(() => {
    setPageKeysBlocked(showPalette() || showSources());
  });

  const src = computed(() => playerUrl());
  const r = computed(() => playerRoute());
  const overlay = computed(() => showPalette() || showSources());

  // NOTE: an in-page control bar was tried and removed — on GPUI/macOS
  // the GPUIView sits above the WKWebView and swallows every mouse event
  // (verified: the page's click counter never increments), so nothing
  // injected into the page can be clicked. Desktop controls live in the
  // GPUI bottom bar below; they drive playback through the JS bridge.

  // iOS blocks the embed's autoplay; a programmatic play() once the page
  // has settled works (verified against WKWebView), so retry it once —
  // the user already pressed Play on the title page. On desktop the same
  // retry covers embeds that ignore the autoPlay parameter.
  let autoPlayed = "";
  effect(() => {
    const u = src();
    if (!u) return;
    if (autoPlayed === u) return;
    autoPlayed = u;
    setTimeout(() => {
      if (mediaPaused()) playPlayback();
      // Native fullscreen is the mobile player: landscape, system
      // controls, no letterboxing. If the page refuses the call the
      // inline overlay controls remain.
      if (mobile) enterFullscreen();
    }, 9000);
  });

  const canNext = computed(() => {
    const p = r();
    if (!p || p.type === "movie") return false;
    const cur = p.episode ?? 1;
    const eps = episodes();
    const i = eps.findIndex((e) => e.n === cur);
    if (i >= 0 && i + 1 < eps.length) return true;
    if (p.type === "anime") return false;
    const ss = seasons();
    const si = ss.indexOf(p.season ?? 1);
    return si >= 0 && si + 1 < ss.length;
  });

  // Recent downloads (running first, then latest finished/failed) shown
  // in the bottom bar so progress is visible outside the palette.
  const recentDownloads = computed(() =>
    downloads()
      .slice()
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"))
      .slice(0, 2),
  );
  const mobile = !platform.desktop;
  // Touch devices get the auto-hiding overlay controls instead; desktop
  // gets a permanent GPUI transport bar — the only place clicks can
  // reach, since the web view swallows all mouse input over the video.
  const showBar = computed(() => !mobile);
  const isPaused = computed(() => mediaPaused());
  const dur = computed(() => duration());
  const rate = computed(() => mediaRate());
  const pct = computed(() => {
    const drag = seekDrag();
    if (drag != null) return drag;
    const d = duration();
    return d > 0 ? Math.min(100, (position() / d) * 100) : 0;
  });
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const cycleRate = () => {
    const cur = rate();
    const i = RATES.findIndex((x) => Math.abs(x - cur) < 0.01);
    setRate(RATES[(i + 1) % RATES.length]);
  };
  const paletteWidth = platform.select({ desktop: 620 });
  const sourcesWidth = platform.select({ desktop: 560 });

  return (
    <View class="flex-1 bg-black">
      <View class="flex-1 flex-col">
        {/* Video area: shrunk while an overlay card is open so the card
            can sit in-flow (the WebView itself stays mounted). It must
            NOT collapse to zero — a hidden/zero-size web view suspends
            page JS, which kills the bridge's reports and commands. */}
        <View
          class={overlay() ? "overflow-hidden" : "flex-1"}
          style={overlay() ? { height: "44%" } : undefined}
        >
          <If when={src()}>
            {(u) => (
              <WebView
                ref={(node) => webview.set(node)}
                src={u()}
                class="flex-1"
                userAgent={platform.select({
                  desktop:
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
                  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
                  android:
                    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
                })}
                injectedJavaScriptBeforeContentLoaded={PLAYER_BRIDGE}
                onMessage={onPlayerMessage}
                onLoadStart={(e: unknown) => debug("wv:loadStart", e)}
                onLoad={(e: unknown) => {
                  debug("wv:load", e);
                  armBridge();
                }}
                onError={(e: unknown) => debug("wv:error", e)}
              />
            )}
          </If>
          <If when={!src()}>
            <View class="flex-1 items-center justify-center">
              <Text class="text-zinc-400">
                {extLoading() ? "Loading source…" : "This source cannot play this title."}
              </Text>
            </View>
          </If>
          {/* Touch controls composite over the WKWebView on iOS; hidden
              while the palette or source picker owns the screen. */}
          <If when={mobile && !overlay()}>
            <MobileControls />
          </If>
        </View>

        {/* Floating cards: fixed width, fixed height, scrollable list. */}
        <If when={overlay()}>
          <View class="flex-1 items-center justify-center bg-black p-8">
            <If when={showPalette()}>
              <View
                class="flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
                style={{ width: paletteWidth ?? "92%", height: "62%" }}
              >
                <View class="flex-row items-center gap-2 border-b border-zinc-800 px-4 py-3">
                  <Text class="text-sm font-bold text-zinc-100">
                    {paletteViewTitle()}
                  </Text>
                  <View class="flex-1" />
                  <If when={platform.desktop}>
                    <Text class="text-[11px] text-zinc-600">esc</Text>
                  </If>
                  <View
                    role="button"
                    onPress={closePalette}
                    class="rounded-md px-2 py-1 active:bg-zinc-800"
                  >
                    <Text class="text-sm font-bold text-zinc-400">✕</Text>
                  </View>
                </View>
                {/* The palette owns the keyboard through keymap bindings
                    (bound on open, removed on close) — no text field, so
                    Escape and every printable key reach it. On touch
                    devices there is no keyboard: the list is tapped. */}
                <If when={paletteView() === "root" && platform.desktop}>
                  <View class="mx-3 mb-2 mt-1 flex-row items-center rounded-lg border border-zinc-800 bg-zinc-950 px-3"
                    style={{ height: 40 }}
                  >
                    <If when={!paletteQuery()}>
                      <Text class="text-sm text-zinc-500">Type to filter…</Text>
                    </If>
                    <Text class="flex-1 text-sm text-zinc-100">{paletteQuery()}</Text>
                    <If when={platform.desktop}>
                      <Text class="text-[11px] text-zinc-600">↵</Text>
                    </If>
                  </View>
                </If>
                <View class="flex-1 overflow-y-auto p-1.5">
                  <Each of={paletteRows()}>
                    {(row) => (
                      <>
                        <If when={row().kind === "header"}>
                          <Text class="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                            {row().label}
                          </Text>
                        </If>
                        <If when={row().kind === "item"}>
                          <View
                            role="button"
                            onPress={() => {
                              const id = row().id;
                              if (id) paletteSelect(id);
                            }}
                            class="mx-1 flex-row items-center gap-2 rounded-lg px-3 py-2 active:bg-zinc-800"
                          >
                            <If when={platform.desktop && (row().num ?? 99) <= 9}>
                              <Text class="w-6 text-[11px] font-bold text-zinc-600">
                                ⌘{row().num}
                              </Text>
                            </If>
                            <Text class="flex-1 text-sm text-zinc-100">
                              {row().label}
                            </Text>
                            <If when={row().checked}>
                              <Text class="text-sm text-red-500">✓</Text>
                            </If>
                          </View>
                        </If>
                      </>
                    )}
                  </Each>
                  <If when={paletteRows().length === 0}>
                    <Text class="p-4 text-sm text-zinc-500">No matches</Text>
                  </If>
                </View>
              </View>
            </If>

            <If when={showSources()}>
              <View
                class="flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
                style={{ width: sourcesWidth ?? "92%", height: "55%" }}
              >
                <View class="flex-row items-center border-b border-zinc-800 px-4 py-3">
                  <Text class="flex-1 text-sm font-bold text-zinc-100">Sources</Text>
                  <View
                    role="button"
                    onPress={() => showSources.set(false)}
                    class="rounded-md px-2 py-1 active:bg-zinc-800"
                  >
                    <Text class="text-sm font-bold text-zinc-400">✕</Text>
                  </View>
                </View>
                <View class="flex-1 overflow-y-auto p-1.5">
                  <Each of={sourcesFor((r()?.type ?? "movie") as MediaType)}>
                    {(s) => (
                      <View
                        role="button"
                        onPress={() => pickSource(s().id)}
                        class="mx-1 flex-row items-center gap-2 rounded-lg px-3 py-2 active:bg-zinc-800"
                      >
                        <View class="flex-1">
                          <Text class="text-sm font-medium text-zinc-100">
                            {s().label}
                          </Text>
                          <If when={NEEDS_INTERCEPT.includes(s().id)}>
                            <Text class="text-[11px] text-amber-500">
                              may not load
                            </Text>
                          </If>
                        </View>
                        <If when={s().note}>
                          {(n) => (
                            <Text class="text-xs text-zinc-500">{n()}</Text>
                          )}
                        </If>
                        <If when={sourceId() === s().id}>
                          <Text class="text-sm text-red-500">✓</Text>
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </If>
          </View>
        </If>
      </View>

      {/* Bottom bar (desktop): transport controls + download status +
          next episode. Every button drives the page through the JS
          bridge — the only input path, since the web view swallows all
          mouse events over the video area. Touch devices use the
          auto-hiding overlay instead. */}
      <If when={showBar()}>
        <View class="flex-col border-t border-zinc-800 bg-zinc-950">
          <View class="flex-row items-center gap-1 px-3 py-2">
            <View
              role="button"
              onPress={togglePlay}
              class="flex-row items-center justify-center rounded-md px-2.5 py-1.5 active:bg-zinc-800"
            >
              <Text class="text-sm font-bold text-zinc-200">
                {isPaused() ? "▶" : "⏸"}
              </Text>
            </View>
            <View
              role="button"
              onPress={() => seekBy(-10)}
              class="flex-row items-center justify-center rounded-md px-2 py-1.5 active:bg-zinc-800"
            >
              <Text class="text-xs font-bold text-zinc-300">−10</Text>
            </View>
            <View
              role="button"
              onPress={() => seekBy(10)}
              class="flex-row items-center justify-center rounded-md px-2 py-1.5 active:bg-zinc-800"
            >
              <Text class="text-xs font-bold text-zinc-300">+10</Text>
            </View>
            <Text class="w-10 text-right text-[11px] font-medium text-zinc-400">
              {fmtTime(position())}
            </Text>
            <Slider
              value={pct()}
              onChange={({ value }) => seekDrag.set(Number(value))}
              onChangeEnd={({ value }) => {
                const d = duration();
                seekTo((Number(value) / 100) * d);
                seekDrag.set(null);
              }}
              accessibilityLabel="Seek"
              class="flex-1"
              trackClass="h-1 flex-1 rounded-full bg-zinc-700"
              indicatorClass="h-full"
              rangeClass="rounded-full bg-red-600"
              thumbClass="h-3 w-3 rounded-full bg-white"
            />
            <Text class="w-10 text-[11px] font-medium text-zinc-400">
              {fmtTime(dur())}
            </Text>
            <View
              role="button"
              onPress={cycleRate}
              class="flex-row items-center justify-center rounded-md px-2 py-1.5 active:bg-zinc-800"
            >
              <Text class="text-xs font-bold text-zinc-300">
                {Math.round(rate() * 100) / 100}x
              </Text>
            </View>
            <View
              role="button"
              onPress={enterFullscreen}
              class="flex-row items-center justify-center rounded-md px-2 py-1.5 active:bg-zinc-800"
            >
              <Text class="text-sm font-bold text-zinc-300">⛶</Text>
            </View>
            <View
              role="button"
              onPress={() => showSources.set(true)}
              class="flex-row items-center justify-center rounded-md px-2 py-1.5 active:bg-zinc-800"
            >
              <Text class="text-sm font-bold text-zinc-300">⇄</Text>
            </View>
            <View
              role="button"
              onPress={openPalette}
              class="flex-row items-center justify-center rounded-md px-2 py-1.5 active:bg-zinc-800"
            >
              <Text class="text-sm font-bold text-zinc-300">⋯</Text>
            </View>
          </View>
          <If when={canNext() || recentDownloads().length > 0}>
            <View class="flex-row items-center gap-3 border-t border-zinc-800/60 px-3 py-1.5">
              <View class="flex-1 flex-col gap-0.5">
                <Each of={recentDownloads()}>
                  {(d) => (
                    <View class="flex-row items-center gap-2">
                      <Text
                        class={
                          d().status === "running"
                            ? "text-xs text-sky-400"
                            : d().status === "done"
                              ? "text-xs text-green-500"
                              : "text-xs text-red-400"
                        }
                      >
                        {d().status === "running"
                          ? `↓ ${d().name}${d().progress != null ? ` ${d().progress}%` : ""}`
                          : d().status === "done"
                            ? `✓ ${d().name} — downloaded`
                            : `✗ ${d().name} — ${d().message.slice(0, 60)}`}
                      </Text>
                      <If when={d().status === "running"}>
                        <View
                          role="button"
                          onPress={() => cancelDownload(d().id)}
                          class="rounded px-1.5 py-0.5 active:bg-zinc-800"
                        >
                          <Text class="text-[10px] text-zinc-500">cancel</Text>
                        </View>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
              <If when={canNext()}>
                <View
                  role="button"
                  onPress={() => void nextEpisode()}
                  class="rounded-lg bg-red-600 px-4 py-1.5"
                >
                  <Text class="text-sm font-bold text-white">Next Episode ›</Text>
                </View>
              </If>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}
