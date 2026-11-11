// Player: the chosen embed source in a WebView. The WebView is a native
// view above all GPUI content, so nothing can draw over it: while the
// command palette or the source picker is open, the video area collapses
// to zero height (the page keeps its state) and a fixed-size floating
// card takes the space. Cmd+K toggles the palette; it lists episodes and
// playback controls, filters as you type, and ⌘1–⌘9 pick items.

import { computed, effect, Image, platform, signal, Text, View, WebView } from "nsh";
import { Dialog, Slider } from "nsh/base";
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
  mediaMuted,
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
  seekBy,
  seekTo,
  setPageKeysBlocked,
  setRate,
  showPalette,
  showSources,
  seasons,
  sourceId,
  startPlayer,
  stopPlayer,
  toggleMute,
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

// Vector icons drawn as inline SVG data URIs — real shapes, not emoji
// font glyphs, so they match the system player's line-icon look.
const icon = (body: string, size = 22) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${body}</svg>`,
  )}`;

const ICONS = {
  back: `<path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  play: `<path d="M8.5 5.5v13l10.5-6.5z" fill="#fff"/>`,
  pause: `<rect x="6.5" y="5" width="3.8" height="14" rx="1.3" fill="#fff"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.3" fill="#fff"/>`,
  vol: `<path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5H4z" fill="#fff"/><path d="M15 9.6a3.8 3.8 0 0 1 0 4.8M17.6 7.4a7.2 7.2 0 0 1 0 9.2" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`,
  mute: `<path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5H4z" fill="#fff"/><path d="M15.5 9.8l5 4.4m0-4.4-5 4.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
  sources: `<path d="M8.5 7h10m0 0-3.2-3.2M18.5 7l-3.2 3.2M15.5 17H5.5m0 0 3.2-3.2M5.5 17l3.2 3.2" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  fullscreen: `<path d="M9.5 4.5H4.5v5M14.5 4.5h5v5M9.5 19.5h-5v-5M14.5 19.5h5v-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  prevEp: `<rect x="4.8" y="5" width="2.8" height="14" rx="1" fill="#fff"/><path d="M18.6 5.8v12.4L10.4 12z" fill="#fff"/>`,
  nextEp: `<rect x="16.4" y="5" width="2.8" height="14" rx="1" fill="#fff"/><path d="M5.4 5.8v12.4L13.6 12z" fill="#fff"/>`,
  back10: `<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/><path d="M3.5 3.8v5.4h5.4" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><text x="12.4" y="14.6" text-anchor="middle" font-size="6.4" font-weight="700" fill="#fff" font-family="-apple-system,sans-serif">10</text>`,
  fwd10: `<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/><path d="M20.5 3.8v5.4h-5.4" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><text x="11.6" y="14.6" text-anchor="middle" font-size="6.4" font-weight="700" fill="#fff" font-family="-apple-system,sans-serif">10</text>`,
} as const;

function Glyph(props: { d: keyof typeof ICONS; size?: number }) {
  const s = props.size ?? 22;
  return <Image src={icon(ICONS[props.d], s)} style={{ width: s, height: s }} />;
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
  // Native Liquid Glass on iOS 26+ (glassEffect); backdrop-blur is the
  // fallback the style draws on older systems. Circular buttons like
  // AVPlayerViewController's system controls.
  const glass = { glassEffect: "regular" } as never;
  const circle =
    "items-center justify-center rounded-full bg-white/15 backdrop-blur-md active:bg-white/30";
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const rate = computed(() => mediaRate());
  const muted = computed(() => mediaMuted());
  const cycleRate = () => {
    const cur = rate();
    const i = RATES.findIndex((x) => Math.abs(x - cur) < 0.01);
    setRate(RATES[(i + 1) % RATES.length]);
  };
  const remaining = computed(() => Math.max(0, dur() - position()));
  return (
    // The toggle lives on the container itself: a full-screen pressable
    // SIBLING underneath the buttons can claim every touch in its bounds
    // (only the innermost pressable responds), which left every button
    // dead. As the parent, empty areas toggle the chrome while the
    // buttons — its descendants — win as the innermost pressables.
    <View
      class="absolute inset-0"
      style={{ backgroundColor: "rgba(0,0,0,0.01)" }}
      onPress={tapControls}
    >
      <If when={controlsVisible() && !mediaFullscreen()}>
        {/* Top: close, then mute / sources / fullscreen on the right —
            the same arrangement as the system player. */}
        <View class="absolute inset-x-0 top-0 flex-row items-center px-3 pt-3">
          <View
            role="button"
            onPress={() => {
              pokeControls();
              goBack();
            }}
            class={`${circle} h-11 w-11`}
            style={glass}
          >
            <Glyph d="back" size={20} />
          </View>
          <View class="flex-1" />
          <View
            role="button"
            onPress={() => {
              pokeControls();
              toggleMute();
            }}
            class={`${circle} h-11 w-11`}
            style={glass}
          >
            <Glyph d={muted() ? "mute" : "vol"} size={20} />
          </View>
          <View
            role="button"
            onPress={() => {
              pokeControls();
              showSources.set(!showSources());
            }}
            class={`${circle} ml-2 h-11 w-11`}
            style={glass}
          >
            <Glyph d="sources" size={20} />
          </View>
          <View
            role="button"
            onPress={() => {
              pokeControls();
              enterFullscreen();
            }}
            class={`${circle} ml-2 h-11 w-11`}
            style={glass}
          >
            <Glyph d="fullscreen" size={20} />
          </View>
        </View>
        {/* Center transport: episode skip flanks the −10/+10 pair around
            a larger play button, like the system player. */}
        <View class="absolute inset-0 items-center justify-center">
          <View class="flex-row items-center gap-6">
            <If when={canPrev()}>
              <View
                role="button"
                onPress={() => {
                  pokeControls();
                  void prevEpisode();
                }}
                class={`${circle} h-12 w-12`}
                style={glass}
              >
                <Glyph d="prevEp" size={24} />
              </View>
            </If>
            <View
              role="button"
              onPress={() => {
                pokeControls();
                seekBy(-10);
              }}
              class={`${circle} h-14 w-14`}
              style={glass}
            >
              <Glyph d="back10" size={30} />
            </View>
            <View
              role="button"
              onPress={() => {
                pokeControls();
                togglePlay();
              }}
              class={`${circle} h-20 w-20`}
              style={glass}
            >
              <Glyph d={paused() ? "play" : "pause"} size={30} />
            </View>
            <View
              role="button"
              onPress={() => {
                pokeControls();
                seekBy(10);
              }}
              class={`${circle} h-14 w-14`}
              style={glass}
            >
              <Glyph d="fwd10" size={30} />
            </View>
            <If when={canNext()}>
              <View
                role="button"
                onPress={() => {
                  pokeControls();
                  void nextEpisode();
                }}
                class={`${circle} h-12 w-12`}
                style={glass}
              >
                <Glyph d="nextEp" size={24} />
              </View>
            </If>
          </View>
        </View>
        {/* Bottom: playback speed + subtitles right-aligned above the
            seek bar, which shows elapsed and remaining time. */}
        <View class="absolute inset-x-0 bottom-0 flex-col gap-2 bg-black/50 px-4 pb-6 pt-12">
          <View class="flex-row items-center justify-end gap-2">
            <View
              role="button"
              onPress={() => {
                pokeControls();
                cycleRate();
              }}
              class={`${circle} h-10 px-4`}
              style={glass}
            >
              <Text class="text-xs font-bold text-white">
                {Math.round(rate() * 100) / 100}×
              </Text>
            </View>
            <View
              role="button"
              onPress={() => {
                pokeControls();
                paletteView.set("subs");
                openPalette();
              }}
              class={`${circle} h-10 w-10`}
              style={glass}
            >
              <Text class="text-[11px] font-bold text-white">CC</Text>
            </View>
          </View>
          <View class="flex-row items-center gap-2">
            <Text class="w-11 text-right text-xs font-medium text-zinc-300">
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
              trackClass="h-9 flex-1 justify-center px-2"
              indicatorClass="h-1.5 rounded-full bg-white/25"
              rangeClass="h-full rounded-full bg-red-600"
              thumbClass="h-4 w-4 rounded-full bg-white"
            />
            <Text class="w-11 text-xs font-medium text-zinc-300">
              -{fmtTime(remaining())}
            </Text>
          </View>
        </View>
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
    const open = showPalette() || showSources();
    setPageKeysBlocked(open);
    // A modal owns the screen: when it closes, the touch chrome stays
    // hidden until the next tap instead of reappearing over the video.
    if (open) controlsVisible.set(false);
  });

  // Back from native fullscreen (AVPlayerViewController's Done), the
  // inline player remounts its chrome: keep it hidden until the next tap
  // instead of flashing the controls over the video again.
  let wasFs = false;
  effect(() => {
    const fs = mediaFullscreen();
    if (wasFs && !fs) {
      controlsVisible.set(false);
      if (hideTimer) clearTimeout(hideTimer);
    }
    wasFs = fs;
  });

  const src = computed(() => playerUrl());
  const r = computed(() => playerRoute());
  const overlay = computed(() => showPalette() || showSources());

  // Fresh playback: flash the chrome once, then let the hide timer run —
  // controlsVisible starts true with no timer armed, which otherwise left
  // the overlay stuck on screen until the first tap.
  let shownFor = "";
  effect(() => {
    const u = src();
    if (!u || u === shownFor) return;
    shownFor = u;
    pokeControls();
  });

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
        {/* Video area: the palette and source picker are modal dialogs
            in their own layer, so the video keeps its full size behind
            them and never collapses (a hidden/zero-size web view would
            suspend page JS and kill the bridge's reports). */}
        <View class="flex-1">
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

        {/* Palette and sources are real modal dialogs: their own layer
            floats over the video, the backdrop dims it, and a tap/click
            away (Escape on desktop, a sheet swipe on iOS) dismisses them
            while playback continues behind. */}
        <Dialog
          open={showPalette()}
          onOpenChange={({ open }) => {
            if (!open) closePalette();
          }}
          animation="fade"
          backdropStyle={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          presentation="fullScreen"
          style={{
            alignSelf: "center",
            marginVertical: "auto",
            width: platform.desktop ? (paletteWidth ?? "92%") : "92%",
            height: platform.desktop ? "62%" : "60%",
            borderRadius: 16,
            borderWidth: 1,
            borderColor: "#27272a",
            overflow: "hidden",
            backgroundColor: "#18181b",
          }}
        >
          <View class="flex-1 flex-col">
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
        </Dialog>

        <Dialog
          open={showSources()}
          onOpenChange={({ open }) => {
            if (!open) showSources.set(false);
          }}
          animation="fade"
          backdropStyle={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          presentation="fullScreen"
          style={{
            alignSelf: "center",
            marginVertical: "auto",
            width: platform.desktop ? (sourcesWidth ?? "92%") : "92%",
            height: platform.desktop ? "55%" : "60%",
            borderRadius: 16,
            borderWidth: 1,
            borderColor: "#27272a",
            overflow: "hidden",
            backgroundColor: "#18181b",
          }}
        >
          <View class="flex-1 flex-col">
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
        </Dialog>
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
              trackClass="h-5 flex-1 justify-center px-1.5 cursor-pointer"
              indicatorClass="h-1.5 rounded-full bg-zinc-700"
              rangeClass="h-full rounded-full bg-red-600"
              thumbClass="h-3.5 w-3.5 rounded-full bg-white"
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
