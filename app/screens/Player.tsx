// Player: the chosen embed source in a WebView. The WebView is a native
// view above all GPUI content, so nothing can draw over it on desktop:
// the transport bar lives below the video there. On iOS the "Cinema"
// overlay (PlayerControls.tsx) draws over the web view. The palette and
// the source picker are modal dialogs in their own layer. Cmd+K toggles
// the palette; it lists episodes and playback controls, filters as you
// type, and ⌘1–⌘9 pick items.

import {
  cleanup,
  computed,
  createAnimatedValue,
  Easing,
  effect,
  platform,
  reduceMotion,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  WebView,
} from "nsh";
import { Dialog, Slider } from "nsh/base";
import { isAvailable as hasWindow, Window } from "nsh/desktop";
import { exitPlayer, route } from "../lib/router";
import {
  closePalette,
  debug,
  episodes,
  extLoading,
  loadEpisodes,
  mediaFullscreen,
  mediaMuted,
  mediaPaused,
  mediaRate,
  mediaVolume,
  nextEpisode,
  onPlayerError,
  onPlayerLoad,
  beginPicker,
  endPicker,
  onPageAction,
  pagePointer,
  onPlayerMessage,
  pageControlsActive,
  type PageAction,
  paletteAllSelected,
  paletteQuery,
  paletteRows,
  paletteSelect,
  paletteView,
  paletteViewTitle,
  pipSupported,
  enterPip,
  playerPhase,
  position,
  duration,
  seekStep,
  PLAYER_BRIDGE,
  playerRoute,
  playerUrl,
  setPageControls,
  setPageKeysBlocked,
  showPalette,
  showSources,
  startPlayer,
  stopPlayer,
  currentSubtitle,
  toggleFullscreen,
  toggleMute,
  togglePlay,
  setVolumeTo,
  switchNotice,
  tryAgain,
  webview,
  nativeActive,
  loadingArt,
  registerPlaybackHost,
  webPageUrl,
} from "../lib/player";
import {
  NativeVideo,
  nativeHandlers,
  nativeRateProp,
  nativeView,
  setNativeFrame,
  setNativeNowPlaying,
} from "../lib/playback/nativeBackend";
import { cancelResolve, resolveStream, warmResolver, type ResolveRequest } from "../lib/resolver";
import { PLAYER_SOURCES } from "../lib/sources";
import { motionReduced, settings } from "../lib/store";
import { Captions } from "./Captions";
import { focusContent, restoreBrightness, webBackground } from "../lib/system";
import { downloadFor } from "../lib/downloads";
import { Button } from "../lib/ui";
import { closeEpisodes, EpisodePicker, openEpisodes, showEpisodes } from "./EpisodePicker";
import { openSources, SourcePicker } from "./SourcePicker";
import {
  AudioSubsPanel,
  closePlayerPopups,
  playerPopup,
  SpeedList,
  toggleSpeedList,
  toggleSubsPanel,
} from "./AudioSubsPanel";
import {
  episodeLine,
  FAIL_TITLE,
  failReason,
  fmtTime,
  Glyph,
  hasNext,
  hideControls,
  isSeries,
  PhoneControls,
  pokeControls,
  rateLabel,
  resetControls,
  SeekBar,
  SeekIcon,
  skipBy,
  stopGestures,
  Spinner,
  titleLine,
  DesktopControls,
  type IconName,
} from "./PlayerControls";

// The app's own player resolves streams in the hidden page
// (lib/resolver.ts imports lib/player.ts, so the player gets it here).
registerPlaybackHost({
  resolve: (req) => resolveStream(req as ResolveRequest),
  cancelResolve: () => cancelResolve("player"),
  cancelPrefetch: () => cancelResolve("prefetch"),
});

// At idle after boot: one tiny navigation of the hidden resolver view, so
// the first play's resolve finds its web process, network and scripts up.
{
  let tries = 0;
  const warm = () => {
    tries++;
    let url = "https://vidfast.vc/robots.txt";
    try {
      const s = PLAYER_SOURCES.find((x) => x.id === untracked(settings).defaultSource && x.playback === "native");
      if (s) url = `${new URL(s.movieUrl("1")).origin}/robots.txt`;
    } catch {}
    if (!warmResolver(url) && tries < 15) setTimeout(warm, 2000);
  };
  setTimeout(warm, 3500);
}

/** The app's own player (lib/playback/nativeBackend.ts) and the captions
 * over it. Phones: the component fills the video area. Desktop: its box is
 * empty at the area's top left and the picture goes in `frame` (NSH puts
 * no mouse-blocking hitbox over an empty native box, so the controls drawn
 * after it get the clicks — contract §1.2). */
function NativeStage(props: { mobile: boolean }) {
  const size = signal({ w: 0, h: 0 });
  cleanup(() => nativeView.unmounted());
  // iOS: the lock screen / Control Centre's info (ignored elsewhere).
  const nowPlaying = computed(() => {
    const r = playerRoute();
    const art = loadingArt() || r?.poster || "";
    return {
      title: titleLine() || "rustflix",
      subtitle: episodeLine() || undefined,
      artwork: /^https?:/.test(art) ? art : undefined,
    };
  });
  // Also through the handle (macOS Now Playing / media keys, iOS lock screen).
  effect(() => {
    const np = nowPlaying();
    untracked(() => setNativeNowPlaying(np));
  });
  return (
    <View
      class="pointer-events-none absolute inset-0"
      onLayout={(e: { bounds: { size: { width: number; height: number } } }) => {
        size.set({ w: e.bounds.size.width, h: e.bounds.size.height });
        // Desktop: the decode cap follows the picture (resize, full screen).
        if (!props.mobile) setNativeFrame(e.bounds.size.width, e.bounds.size.height);
      }}
    >
      <NativeVideo
        ref={(n: unknown) => nativeView.setRef(n)}
        class="absolute"
        style={props.mobile ? { left: 0, top: 0, right: 0, bottom: 0 } : { left: 0, top: 0, width: 0, height: 0 }}
        src={nativeView.src()}
        startAt={nativeView.startAt()}
        paused={nativeView.paused()}
        muted={nativeView.muted()}
        volume={nativeView.volume()}
        rate={nativeRateProp()}
        fit={nativeView.fit()}
        nowPlaying={nowPlaying()}
        frame={{ width: size().w, height: size().h }}
        onReady={nativeHandlers.onReady}
        onLoad={nativeHandlers.onLoad}
        onFrame={nativeHandlers.onFrame}
        onTracks={nativeHandlers.onTracks}
        onProgress={nativeHandlers.onProgress}
        onBuffer={nativeHandlers.onBuffer}
        onSeeked={nativeHandlers.onSeeked}
        onRate={nativeHandlers.onRate}
        onPip={nativeHandlers.onPip}
        onEnd={nativeHandlers.onEnd}
        onError={nativeHandlers.onError}
      />
      <Captions mobile={props.mobile} size={() => size()} />
    </View>
  );
}

// The last player route we armed for. NSH effects re-run on signal
// writes, and the player writes signals every probe — without this guard
// startPlayer/armResume would re-fire constantly and the resume seek
// would keep resetting the video (the 9:43 loop).
let handledRoute = "";

// First mouse input the desktop pointer layer gets this session, logged
// once each so the debug log proves whether GPUI delivers it here.
const pointerSeen = { move: false, press: false };
function notePointer(kind: "move" | "press") {
  if (pointerSeen[kind]) return;
  pointerSeen[kind] = true;
  debug(`pointer layer: first ${kind}`);
}

// --- The palette's caret ----------------------------------------------------------

/** The palette field's caret: a thin accent bar, blinking (solid again on
 * each keystroke; steady when the user asks for less motion), its opacity
 * driven natively by an animated value. */
function PaletteCaret() {
  const blink = createAnimatedValue(1);
  const start = () => {
    void blink.stop();
    blink.set(1);
    if (motionReduced()) return;
    void blink.keyframes(
      [
        { offset: 0, value: 1 },
        { offset: 0.48, value: 1 },
        { offset: 0.52, value: 0 },
        { offset: 0.96, value: 0 },
        { offset: 1, value: 1 },
      ],
      { duration: 1060, easing: Easing.linear, iterations: "infinite" },
    );
  };
  effect(() => {
    paletteQuery();
    untracked(start);
  });
  cleanup(() => void blink.stop());
  return (
    <View
      class="bg-primary"
      style={{ width: 1.5, height: 18, marginLeft: 1, borderRadius: 1, opacity: blink }}
    />
  );
}

// --- Desktop bar pieces ---------------------------------------------------------

function BarBtn(props: {
  label: string;
  onPress: () => void;
  d?: IconName;
  text?: string;
  disabled?: boolean;
  on?: boolean;
  /** Toggles a popup itself (CC, speed): no close-first. */
  keepPopup?: boolean;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={() => {
        if (!props.keepPopup) closePlayerPopups();
        props.onPress();
      }}
      class={`h-9 min-w-9 cursor-pointer items-center justify-center rounded-md px-1.5 hover:bg-white/10 active:bg-white/20 disabled:opacity-35 ${
        props.on ? "bg-white/10" : ""
      }`}
    >
      <If when={props.d}>{(d) => <Glyph d={d()} size={20} />}</If>
      <If when={props.text}>
        {(t) => <Text class="text-[13px] font-bold text-white">{t()}</Text>}
      </If>
    </View>
  );
}

// --- Desktop: the page's controls before the page shows ------------------------
//
// Until the page has painted its black background and the in-page overlay
// (see Player: the transparent web view, or the gate), GPUI draws the
// overlay's loading state at the same metrics as the bridge's CIN_CSS /
// cinHtml (lib/player.ts), so the hand-over is not seen: pure black (no
// artwork while loading), title at left 32 / bottom 120,
// the centre cluster (56 / 80 / 56 circles, 28 apart, a 40 spinner in the
// play button), and the bottom block (padding 44 16 12 under a gradient:
// seek line 22 high with a 4 px track and a 13 px thumb, `rem` 56 wide,
// then 6 below a row of 36 px buttons 4 apart, right-aligned). Loading
// dims what the page dims ('dis': ±10, speed, CC, mute, volume, PiP,
// fullscreen); episodes, next and sources stay bright.

/** Set once any video reported in: from then on `pipSupported` says what
 * the page's PiP button does (before, the page shows it). */
let videoSeen = false;

/** The page's controls in their loading state, before its overlay is up:
 * the desktop controls themselves, inert (PlayerControls.tsx), on black —
 * the same views the app's own player shows while loading, so neither the
 * hand-over to the page nor a native play looks any different. */
function PagePlaceholder(props: { spinning: boolean }) {
  return (
    <View class="pointer-events-none absolute inset-0 overflow-hidden bg-black">
      <DesktopControls inert spinning={props.spinning} />
    </View>
  );
}

/** Time from the page's first word to its being shown: the page has laid
 * out its loading state; a frame or two for WebKit to paint it. */
const SETTLE_MS = 50;
/** Shown regardless after this long hidden. */
const REVEAL_TIMEOUT_MS = 4000;

export function Player() {
  const mobile = !platform.desktop;
  /** The player route is up. The desktop keeps this screen mounted (hidden
   * by App.tsx) between plays, with its one web view; the phone mounts it
   * in its dialog for each play. */
  const onRoute = computed(() => route().name === "player");
  /** A play was started and not left yet. */
  let playing = false;
  let pickerOpen = false;
  /** A page was loaded during this play (the web view may hold the keys). */
  let webUsed = false;

  // Leaving a play (the route moved on, or the phone's dialog unmounts
  // this screen first): stop it, close what belongs to it. Brightness
  // slides change the whole screen: put it back on the way out (pending
  // slide writes are dropped first so none lands after it).
  function leave() {
    if (!playing) return;
    playing = false;
    closePlayerPopups();
    stopPlayer();
    stopGestures();
    void restoreBrightness();
    if (pickerOpen) {
      pickerOpen = false;
      endPicker();
    }
    showSources.set(false);
    closeEpisodes();
    // A next episode being resolved ahead of time is not needed now.
    cancelResolve("prefetch");
    // The keyboard back to the app's own view (a web view that had it is
    // hidden now, and would keep it). Only a page can have taken it.
    if (!mobile && webUsed) focusContent();
    webUsed = false;
  }

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
    untracked(() => {
      if (r.name === "player") {
        playing = true;
        resetControls();
        startPlayer();
        void loadEpisodes(r);
      } else {
        leave();
      }
    });
  });

  // Unmounted (the phone's dialog closes before the effect above sees the
  // route): leave, and forget the route so opening the same title again
  // (or Back then Forward) starts it afresh.
  cleanup(() => {
    handledRoute = "";
    leave();
  });

  // While an overlay card owns the keyboard, the page must not also act
  // on the same keys: the native web view keeps first responder (GPUI's
  // blur() cannot resign it), so the bridge swallows keys page-side.
  effect(() => {
    const open = showPalette() || showSources() || showEpisodes();
    setPageKeysBlocked(open);
    // A modal owns the keyboard: the app's view gets it back from the web
    // view (which a picker also hides). Clicking into the page later gives
    // it to the page again.
    if (open && platform.desktop && untracked(src)) untracked(focusContent);
    // A modal owns the screen: when it closes, the touch chrome stays
    // hidden until the next tap instead of reappearing over the video.
    if (open) hideControls();
  });

  // Back from native fullscreen (AVPlayerViewController's Done): show
  // the chrome at once — usually paused there, and paused keeps it up;
  // while playing the 3 s auto-hide runs.
  let wasFs = false;
  effect(() => {
    const fs = mediaFullscreen();
    if (wasFs && !fs) untracked(pokeControls);
    wasFs = fs;
  });

  /** The page in the web view: null when the app's player plays (the
   * view idles on about:blank) — no page is ever on screen then. */
  const src = computed(() => webPageUrl());
  const native = computed(() => nativeActive());
  effect(() => {
    if (src()) webUsed = true;
  });
  const overlay = computed(() => showPalette() || showSources() || showEpisodes());

  // --- The web view, and when it shows -----------------------------------------
  //
  // Desktop (macOS): one web view for the whole session. It is made when
  // this screen mounts at idle (App.tsx), hidden, on about:blank, and each
  // play navigates it; leaving navigates it back to about:blank. Made on
  // open it cost 100–300 ms of main thread (wry's `new_ns_view`: the
  // WKWebView, its configuration and process pool, and the web content
  // process launch) inside the first frame.
  //
  // wry builds every web view at a default 200×200 at the window's top
  // left (lb-wry 0.53.3 lib.rs `WebViewAttributes::default().bounds`; NSH
  // never passes `with_bounds`), and NSH only sizes it when it is shown
  // (native/web.rs `place`, from prepaint, only for a view that shows). A
  // page loaded while hidden is therefore laid out in that 200×200 box,
  // and the first frame after showing it is that stale layout in the top
  // left corner (the controls squeezed there). So the view is never
  // hidden while a page loads: it is made transparent instead
  // (`sys.webBackground`: drawsBackground NO), shown — and so sized — on
  // about:blank, which draws nothing, as the play opens, and the page
  // loads at its real size. Until the page paints its black background and
  // its controls, GPUI's identical placeholder shows through it.
  //
  // Without that host op (an older host, the phone), the gate below keeps
  // the view hidden until its page has reported in, as before.
  //
  // A WKWebView is white until its page first paints. On macOS the colour
  // the WebView is given never reaches it: NSH (nsh-platform-gpui 0.4.0
  // native/web.rs) passes an opaque background to wry's
  // `with_background_color`, which lb-wry 0.53.3 applies on iOS only (its
  // macOS build ignores it and never touches `drawsBackground` without the
  // `transparent` feature). So the web view is kept out of sight — its
  // area at opacity 0, which NSH turns into the native view's
  // set_visible(false) while the page keeps loading — for every new page
  // (first open, source switch, next episode), until the bridge in THAT
  // document reports in: at document start it has forced the black page
  // background and built the overlay. Desktop then asks the page to lay
  // out its loading state at once (`ctl` → cinSync, then the chrome push)
  // and shows the view on the page's answer plus a short settle; GPUI
  // draws the same controls meanwhile (PagePlaceholder). The phone keeps
  // the view and covers it with black under its own overlay instead.
  // Docs are told apart by the bridge's per-document id: reports from a
  // page seen before the change never count.
  const webShown = signal(false);
  /** The player's web view draws no background of its own (macOS host op
   * applied after the view was made: its own load events ask for it). */
  const transparent = signal(false);
  const clearWeb = () => {
    if (mobile) return;
    void webBackground().then((n) => {
      if (n && n > 0 && !untracked(transparent)) {
        transparent.set(true);
        debug("player: web view transparent");
      }
    });
  };
  /** Bridge document ids of the earlier pages of this player. */
  const oldDocs = new Set<string>();
  /** Document ids reported since the gate armed. */
  let newDocs = new Set<string>();
  /** The new document asked to lay out its controls (desktop). */
  let syncedDoc = "";
  let settling = false;
  /** The no-overlay fallback is armed for this gate. */
  let bareArmed = false;
  let gateUrl = "";
  let gateTimers: ReturnType<typeof setTimeout>[] = [];
  const clearGate = () => {
    for (const t of gateTimers) clearTimeout(t);
    gateTimers = [];
  };
  const gateLater = (ms: number, why: string) => {
    gateTimers.push(setTimeout(() => reveal(why), ms));
  };
  function reveal(why: string) {
    if (webShown()) return;
    clearGate();
    // macOS: no white behind a page that has not painted yet.
    if (!mobile) void webBackground();
    webShown.set(true);
    debug(`player: web view shown (${why})`);
  }
  /** Same page apart from the fragment: no new document comes. */
  const samePage = (a: string, b: string) => a.split("#")[0] === b.split("#")[0];
  effect(() => {
    const u = src();
    untracked(() => {
      const prev = gateUrl;
      gateUrl = u ?? "";
      if (prev && u && samePage(prev, u)) return;
      clearGate();
      for (const d of newDocs) oldDocs.add(d);
      newDocs = new Set();
      syncedDoc = "";
      settling = false;
      bareArmed = false;
      if (webShown()) webShown.set(false);
      if (u) gateLater(REVEAL_TIMEOUT_MS, "timeout");
    });
  });
  cleanup(clearGate);
  // A new page that is already showing frames is never kept hidden.
  effect(() => {
    const ph = playerPhase();
    if (ph === "playing" || ph === "paused" || ph === "stalled") {
      untracked(() => {
        videoSeen = true;
        if (!webShown() && newDocs.size > 0) reveal(`phase ${ph}`);
      });
    }
  });
  function gateMessage(e: { data: unknown }) {
    if (!gateUrl) return;
    let v: { t?: unknown; doc?: unknown; vid?: unknown; ctl?: unknown } | null = null;
    try {
      v = typeof e.data === "string" ? JSON.parse(e.data) : (e.data as typeof v);
    } catch {
      return;
    }
    if (!v || typeof v.t !== "number") return;
    const doc =
      typeof v.doc === "string" ? v.doc : typeof v.vid === "string" ? v.vid.split(":")[0] : "";
    if (!doc || oldDocs.has(doc)) return;
    // Every document of this page is noted, also once shown, so none of
    // its late reports counts for the next page.
    newDocs.add(doc);
    if (webShown() || settling) return;
    if (mobile) {
      // The phone draws its own controls: the black page is enough.
      settling = true;
      gateLater(SETTLE_MS, "page");
      return;
    }
    if (syncedDoc === doc) {
      // The answer to the sync below: the page has laid out its loading
      // state.
      settling = true;
      gateLater(SETTLE_MS, "page");
      return;
    }
    if (syncedDoc) return;
    if (typeof v.ctl === "number" && v.ctl >= 1) {
      syncedDoc = doc;
      setPageControls(true);
      // No answer (WebKit can drop a script of a busy page): shown anyway.
      gateLater(400, "page, no answer");
    } else if (!bareArmed) {
      // The page has no overlay (yet): blind pages never build one.
      bareArmed = true;
      gateLater(1200, "page without overlay");
    }
  }
  // A finished download with no URL yet: its local page is being prepared
  // (the engine leaves the URL empty meanwhile; not a failure).
  const preparing = computed(() => {
    const r = playerRoute();
    if (!r || playerUrl()) return false;
    const e = downloadFor(r.type, r.id, r.season, r.episode);
    return (
      e?.state === "done" && (r.type !== "anime" || (e.lang ?? "sub") === (r.lang ?? "sub"))
    );
  });

  // Fresh playback: flash the chrome once, then let the hide timer run.
  let shownFor = "";
  effect(() => {
    const u = playerUrl();
    if (!u || u === shownFor) return;
    shownFor = u;
    pokeControls();
  });

  // Desktop: clicks reach the page, so the bridge draws the Cinema
  // controls over the video itself (the core turns them on; see
  // `pageControlsActive`). The GPUI bar below is the fallback while the
  // page has no overlay; both drive playback through the JS bridge.
  // Page buttons that need the app arrive through onPageAction.
  const offPageAction = onPageAction((a: PageAction) => {
    if (a === "escape" && closePlayerPopups()) return;
    if (a === "back") exitPlayer();
    else if (a === "sources") openSources();
    else if (a === "episodes") openEpisodes();
    else if (a === "escape") {
      if (showEpisodes()) closeEpisodes();
      else if (showPalette()) closePalette();
      else if (showSources()) showSources.set(false);
      else exitPlayer();
    } else if (a === "fullscreen") {
      // The page's own fullscreen failed; asking the page again would
      // fail the same way (and loop), so the app window goes fullscreen.
      if (hasWindow) Window.toggleFullScreen();
    }
  });
  cleanup(offPageAction);
  // Autoplay lives in player.ts; native fullscreen only ever starts from
  // the fullscreen button.

  const phase = computed(() => playerPhase());

  // Pickers pause the video: beginPicker() when the first one opens,
  // endPicker() when the last one closes — exactly once per open/close,
  // whichever way it closes (✕, Escape, a pick, the page's srcx). Going
  // from one picker to the other (batched) is not a close. Unmounting
  // with one open closes it too.
  effect(() => {
    const open = showSources() || showEpisodes();
    if (open === pickerOpen) return;
    pickerOpen = open;
    untracked(() => (open ? beginPicker() : endPicker()));
  });

  // Desktop fallback bar: the page draws the same controls in every
  // state, so the GPUI bar shows only when the page cannot (blind), or as
  // a safety net when it has not confirmed its overlay 4 s after the web
  // view loaded — never while loading.
  const loadedAt = signal(0);
  const now = signal(Date.now());
  const tick = setInterval(() => {
    if (loadedAt() && !pageControlsActive()) now.set(Date.now());
  }, 1000);
  cleanup(() => clearInterval(tick));
  effect(() => {
    src();
    loadedAt.set(0);
  });
  const confirmLate = computed(
    () => loadedAt() > 0 && !pageControlsActive() && now() - loadedAt() > 4000,
  );
  const showBar = computed(
    () => !mobile && !native() && (phase() === "blind" || (confirmLate() && phase() !== "loading")),
  );
  // "blind": the video is out of the bridge's reach — the transport
  // cannot work, so it is dimmed (sources, episodes and next still do).
  const blind = computed(() => phase() === "blind");
  const volDrag = signal<number | null>(null);
  // Desktop popups live in the strip above the bar (nothing GPUI draws
  // can cover the native web view): gone with the bar.
  effect(() => {
    if (!mobile && !showBar()) untracked(closePlayerPopups);
  });
  let swallowClick = false;
  /** The speed button's x in the bar row: the list opens above it. */
  const speedX = signal(0);
  const paletteWidth = platform.select({ desktop: 620 });

  // Desktop: the web view shows while a play is up and no picker or the
  // palette hides it — at once when it is transparent (the page loads at
  // its real size, see above), else once the gate lets it.
  const webVisible = computed(
    () =>
      mobile ||
      (onRoute() && !native() && !overlay() && phase() !== "failed" && (transparent() || webShown())),
  );
  const placeholderOn = computed(
    () =>
      onRoute() &&
      !native() &&
      !overlay() &&
      !preparing() &&
      (src() ? !webShown() : extLoading() || phase() === "loading"),
  );
  // Ask for transparency once the view exists (it is made at the next
  // frames after this screen mounts); its load events ask again.
  effect(() => {
    if (onRoute() && src()) untracked(clearWeb);
  });
  if (!mobile) {
    const t1 = setTimeout(clearWeb, 300);
    const t2 = setTimeout(clearWeb, 1500);
    cleanup(() => {
      clearTimeout(t1);
      clearTimeout(t2);
    });
  }

  /** The player's web view. Its events only count while a play is up (the
   * desktop's view also loads about:blank between plays). */
  const webEl = (url: () => string) => (
    <WebView
      ref={(node) => webview.set(node)}
      src={url()}
      class="flex-1 bg-black"
      // iOS: wry builds the view non-opaque on this colour. The macOS
      // build ignores it (see above).
      style={{ backgroundColor: "#000" }}
      userAgent={platform.select({
        desktop:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        android:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      })}
      injectedJavaScriptBeforeContentLoaded={PLAYER_BRIDGE}
      onMessage={(e: { data: unknown }) => {
        if (!untracked(src)) return;
        onPlayerMessage(e);
        gateMessage(e);
      }}
      onLoadStart={(e: unknown) => {
        debug("wv:loadStart", e);
        // The native view exists by now: no background of its own.
        clearWeb();
      }}
      onLoad={(e: unknown) => {
        if (!untracked(src)) return;
        onPlayerLoad(e);
        loadedAt.set(Date.now());
      }}
      onError={(e: unknown) => {
        if (untracked(src)) onPlayerError(e);
      }}
    />
  );

  return (
    <View class="flex-1 bg-black">
      <View class="flex-1 flex-col">
        {/* Video area. On the desktop the web view is a native view above
            everything GPUI draws, so while a picker or the palette is open
            — and until a new page is ready (webShown, above) — its box goes
            to opacity 0: NSH then treats the web view as not drawn and
            hides its native view (set_visible(false)) without resizing or
            reloading the page; it comes back at the same size and position.
            The video is paused meanwhile for a picker (beginPicker). Never
            unmounted for a picker. */}
        <View class="flex-1 bg-black" style={{ backgroundColor: "#000" }}>
          <View
            class="absolute inset-0 bg-black"
            style={{
              opacity: webVisible() ? 1 : 0,
              backgroundColor: "#000",
            }}
          >
            {mobile ? (
              <If when={src()}>{(u) => webEl(u)}</If>
            ) : (
              webEl(() => src() || "about:blank")
            )}
          </View>
          {/* Desktop: the page's controls in their loading state, drawn by
              GPUI where the page draws them — under the transparent web view
              until its page paints, or alone while the view is hidden (no
              page yet: resolving; or the gate). Always mounted: opening a
              play mounts nothing here. */}
          <If when={!mobile}>
            <View
              class="pointer-events-none absolute inset-0"
              style={{ opacity: placeholderOn() ? 1 : 0 }}
            >
              {/* The spinner only while shown: an animation in a hidden view
                  would still run the frame clock. */}
              <PagePlaceholder spinning={placeholderOn() && phase() !== "failed"} />
            </View>
          </If>
          {/* Phone: black over the web view until its page reports in (a
              WKWebView is white before its first paint); the controls draw
              above it. */}
          <If when={mobile && src() && !webShown()}>
            <View class="pointer-events-none absolute inset-0 bg-black" />
          </If>
          {/* No URL: resolving (an IMDb id) shows this on the phone (the
              desktop draws its placeholder); a source that cannot play the
              title at all is the "failed" phase. */}
          <If when={mobile && !native() && !src() && extLoading() && !preparing()}>
            <View class="flex-1 items-center justify-center">
              <Text class="text-zinc-400">Loading source…</Text>
            </View>
          </If>
          {/* The app's own player: the picture, the captions, and on the
              desktop the controls (later siblings of the video, so they get
              the clicks). Phones draw PhoneControls below, as for a page. */}
          <If when={onRoute() && native()}>
            <NativeStage mobile={mobile} />
          </If>
          <If when={!mobile && onRoute() && native() && !overlay() && phase() !== "failed"}>
            <DesktopControls />
          </If>
          {/* Desktop: moving on from a failing source by itself — one line
              under the placeholder's spinner (shown while the next page
              loads). */}
          <If when={!mobile && placeholderOn() && switchNotice()}>
            <View
              class="pointer-events-none absolute inset-x-0 items-center px-8"
              style={{ top: "50%", marginTop: 56 }}
            >
              <Text class="text-center text-sm text-zinc-300">{switchNotice()}</Text>
            </View>
          </If>
          {/* Desktop: the terminal state, centred in the video area (no page
              behind it: the web view is hidden). The same words and the
              one button as the phone's. */}
          <If when={!mobile && phase() === "failed"}>
            <View class="absolute inset-0 items-center justify-center px-8">
              <View class="items-center gap-2" style={{ maxWidth: 420 }}>
                <Text class="text-center text-lg font-bold text-white">{FAIL_TITLE}</Text>
                <If when={failReason()}>
                  <Text class="text-center text-sm text-zinc-400">{failReason()}</Text>
                </If>
                <View class="mt-3">
                  <Button variant="primary" size="md" icon="retry" label="Try again" onPress={() => tryAgain()} />
                </View>
              </View>
            </View>
          </If>
          {/* Desktop: centred in the black video area. (The phone shows it
              over its overlay, below.) */}
          <If when={!mobile && preparing()}>
            <View class="pointer-events-none absolute inset-0 items-center justify-center">
              <Text class="text-sm text-zinc-300">Preparing your download…</Text>
            </View>
          </If>
          {/* Desktop pointer layer over the video: forwards the mouse to
              the page's overlay (pagePointer), since real clicks never
              reach the page on macOS. Later sibling of the WebView, so
              it is on top in nsh's hit testing. Desktop only, only while
              a page is showing; the dialogs are their own layer above. */}
          <If when={!mobile && src()}>
            <View
              class="absolute inset-0"
              onMouseMove={(e: { position: { x: number; y: number } }) => {
                notePointer("move");
                pagePointer("move", e.position.x, e.position.y);
              }}
              onMouseLeave={() => pagePointer("leave", 0, 0)}
              // NSH 0.4.0's press phases are onPressDown / onPressUp (there
              // is no onPressIn / onPressOut: drags never reached the page).
              // The page takes down → moves → up → click as one gesture
              // (cinPtr: a click on the seek bar or the volume does nothing
              // more; one click on the picture toggles once).
              onPressDown={(e: { position: { x: number; y: number } }) => {
                notePointer("press");
                // A click on the video with a popup open only closes it.
                swallowClick = closePlayerPopups();
                if (swallowClick) return;
                pagePointer("down", e.position.x, e.position.y);
              }}
              onPressUp={(e: { position: { x: number; y: number } }) => {
                if (!swallowClick) pagePointer("up", e.position.x, e.position.y);
              }}
              onPress={(e: { position: { x: number; y: number }; clickCount?: number }) => {
                if (swallowClick) return;
                pagePointer(
                  (e.clickCount ?? 1) >= 2 ? "dblclick" : "click",
                  e.position.x,
                  e.position.y,
                );
              }}
            />
          </If>
          {/* Touch controls composite over the WKWebView on iOS; hidden
              while the palette or source picker owns the screen. */}
          <If when={mobile && !overlay()}>
            <PhoneControls />
          </If>
          {/* Phone: over the overlay's loading artwork, under the centre
              spinner (pointer-transparent). */}
          <If when={mobile && !overlay() && preparing()}>
            <View
              class="pointer-events-none absolute inset-0 items-center justify-center"
              style={{ paddingTop: 140 }}
            >
              <View class="rounded-full bg-black/60 px-4 py-2">
                <Text class="text-sm font-semibold text-white">Preparing your download…</Text>
              </View>
            </View>
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
                accessibilityLabel="Close"
                class="h-8 w-8 cursor-pointer items-center justify-center rounded-md hover:bg-zinc-800 active:bg-zinc-800"
              >
                <Glyph d="close" size={16} color="#a1a1aa" />
              </View>
            </View>
            {/* The palette owns the keyboard through keymap bindings
                (bound on open, removed on close) — no text field, so
                Escape and every printable key reach it, whichever view
                (the page's web view included) holds the focus. Drawn as
                a focused field: an accent ring and a blinking caret after
                the query (⌘⌫ clears it, ⌥⌫ drops a word, ⌘A selects it,
                ⌘V pastes). On touch devices there is no keyboard: the
                list is tapped. */}
            <If when={paletteView() === "root" && platform.desktop}>
              <View class="mx-2 mb-1 rounded-[10px] bg-primary/25" style={{ padding: 2 }}>
                <View
                  class="flex-row items-center rounded-lg border border-primary bg-zinc-950 px-3"
                  style={{ height: 40 }}
                >
                  <View class="flex-1 flex-row items-center">
                    <If when={paletteQuery()}>
                      <Text
                        class={`text-sm text-zinc-100 ${paletteAllSelected() ? "rounded-sm bg-primary/40" : ""}`}
                        style={{ numberOfLines: 1, flexShrink: 1 }}
                      >
                        {paletteQuery()}
                      </Text>
                    </If>
                    <If when={showPalette()}>
                      <PaletteCaret />
                    </If>
                    <If when={!paletteQuery()}>
                      <Text class="text-sm text-zinc-500" style={{ marginLeft: 4 }}>
                        Type to filter…
                      </Text>
                    </If>
                  </View>
                  <Text class="text-[11px] text-zinc-600">↵</Text>
                </View>
              </View>
            </If>
            <Scroll class="flex-1">
              <View class="p-1.5">
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
                          <Glyph d="check" size={16} color="#e50914" />
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
            </Scroll>
          </View>
        </Dialog>

      </View>

      {/* Below the video (desktop only), laid out only when it has
          something: the fallback transport bar while the page's own
          overlay is not active. With the overlay active, nothing of ours
          takes any height: the video fills the screen. Downloads are
          announced by toasts, not here. */}
      <If when={!mobile && showBar()}>
        <View class="flex-col bg-zinc-950">
          {/* The page draws the Cinema controls over the video while it
              confirms them (pageControlsActive): the bar below is then
              hidden and the video takes the full height. It returns
              whenever the page has none (no video yet, blind, never
              confirmed). */}
          <If when={showBar()}>
          <View class="flex-col border-t border-zinc-800">
          {/* The popups, above the bar: the same panel and list as the
              phone's, in the strip (the video shrinks while one is open). */}
          <If when={playerPopup() === "subs"}>
            <View class="flex-row justify-end px-2 pt-2">
              <View style={{ width: 620, maxWidth: "100%", height: 300 }}>
                <AudioSubsPanel desktop />
              </View>
            </View>
          </If>
          <If when={playerPopup() === "speed"}>
            <View class="flex-row pt-2" style={{ paddingLeft: 8 + speedX() }}>
              <SpeedList desktop />
            </View>
          </If>
          {/* Title and episode, with the phase at the right. */}
          <View class="flex-row items-center gap-2 px-4 pt-2">
            <Text class="text-[13px] font-bold text-white" style={{ numberOfLines: 1 }}>
              {titleLine()}
            </Text>
            <If when={episodeLine()}>
              <Text class="flex-1 text-xs text-zinc-400" style={{ numberOfLines: 1 }}>
                {episodeLine()}
              </Text>
            </If>
            <If when={!episodeLine()}>
              <View class="flex-1" />
            </If>
            <If when={phase() === "loading" || phase() === "stalled"}>
              <View class="flex-row items-center gap-1.5">
                <Spinner size={14} />
                <Text class="text-xs text-zinc-400">
                  {phase() === "loading" ? "Loading…" : "Buffering…"}
                </Text>
              </View>
            </If>
            <If when={blind()}>
              <Text class="text-xs text-zinc-500">Controls unavailable for this source</Text>
            </If>
          </View>

          <View class="flex-row items-center gap-1 px-2 pb-2 pt-1">
            <BarBtn
              label={mediaPaused() ? "Play" : "Pause"}
              d={mediaPaused() ? "play" : "pause"}
              disabled={blind()}
              onPress={togglePlay}
            />
            <View
              role="button"
              accessibilityLabel={`Back ${seekStep()} seconds`}
              disabled={blind()}
              onPress={() => skipBy(-1)}
              class="h-9 w-9 cursor-pointer items-center justify-center rounded-md hover:bg-white/10 active:bg-white/20 disabled:opacity-35"
            >
              <SeekIcon dir={-1} size={24} />
            </View>
            <View
              role="button"
              accessibilityLabel={`Forward ${seekStep()} seconds`}
              disabled={blind()}
              onPress={() => skipBy(1)}
              class="h-9 w-9 cursor-pointer items-center justify-center rounded-md hover:bg-white/10 active:bg-white/20 disabled:opacity-35"
            >
              <SeekIcon dir={1} size={24} />
            </View>
            <View class={`flex-1 flex-row items-center gap-2 ${blind() ? "opacity-35" : ""}`}>
              <Text
                class="text-right text-[11px] font-medium text-zinc-300"
                style={{ minWidth: 48, flexShrink: 0, numberOfLines: 1 }}
              >
                {fmtTime(position())}
              </Text>
              <SeekBar desktop disabled={blind()} />
              <Text
                class="text-[11px] font-medium text-zinc-300"
                style={{ minWidth: 48, flexShrink: 0, numberOfLines: 1 }}
              >
                {fmtTime(Math.max(0, duration() - position()))}
              </Text>
            </View>
            <BarBtn
              label={mediaMuted() ? "Unmute" : "Mute"}
              d={mediaMuted() || mediaVolume() <= 0 ? "mute" : "vol"}
              disabled={blind()}
              onPress={toggleMute}
            />
            <Slider
              value={volDrag() ?? (mediaMuted() ? 0 : mediaVolume())}
              min={0}
              max={1}
              step={0}
              disabled={blind()}
              onChange={({ value }) => {
                const v = Number(value);
                volDrag.set(v);
                if (mediaMuted() && v > 0) toggleMute();
                setVolumeTo(v);
              }}
              onChangeEnd={() => volDrag.set(null)}
              accessibilityLabel="Volume"
              class="w-20"
              trackClass="h-6 w-20 justify-center px-1.5 cursor-pointer disabled:opacity-35"
              indicatorClass="h-1 rounded-full bg-white/20"
              rangeClass="h-full rounded-full bg-white"
              thumbClass="h-2.5 w-2.5 rounded-full bg-white"
            />
            <View
              onLayout={(e: { bounds: { origin?: { x: number } } }) =>
                speedX.set(e.bounds.origin?.x ?? 0)
              }
            >
              <BarBtn
                label="Playback speed"
                text={rateLabel(mediaRate())}
                disabled={blind()}
                on={playerPopup() === "speed"}
                keepPopup
                onPress={toggleSpeedList}
              />
            </View>
            <BarBtn
              label="Audio and subtitles"
              d={currentSubtitle() !== null ? "ccOn" : "ccOff"}
              disabled={blind()}
              on={playerPopup() === "subs"}
              keepPopup
              onPress={toggleSubsPanel}
            />
            <If when={isSeries()}>
              <BarBtn label="Episodes" d="episodes" onPress={openEpisodes} />
            </If>
            <BarBtn label="Sources" d="sources" onPress={openSources} />
            <If when={pipSupported() && !blind()}>
              <BarBtn label="Picture in picture" d="pip" onPress={enterPip} />
            </If>
            <If when={hasNext()}>
              <BarBtn label="Next episode" d="nextEp" onPress={() => void nextEpisode()} />
            </If>
            <BarBtn
              label="Full screen"
              d="fullscreen"
              disabled={blind()}
              onPress={toggleFullscreen}
            />
          </View>
          </View>
          </If>
        </View>
      </If>
      {/* Full-screen pickers: views in this tree, over everything (see
          SourcePicker.tsx / EpisodePicker.tsx). */}
      <EpisodePicker />
      <SourcePicker />
    </View>
  );
}
