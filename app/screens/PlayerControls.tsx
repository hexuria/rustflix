// Player controls shared by both shells, and the phone's "Cinema" overlay.
//
// iOS composites native views in tree order, so the phone overlay really
// draws over the WKWebView (the GPUI desktop backend cannot: its web view
// is a native child above all GPUI content — desktop gets a bar below the
// video, built in Player.tsx from the pieces exported here).
//
// The phone overlay is two sibling stacks:
//   gesture layer (panActivation: brightness/volume slides; pinch: fill)
//     tap layer   (tap: toggle chrome; double tap: ± the seek step; hold: 2×)
//   chrome        (above them, box-none: buttons and the seek bar, which
//                  therefore never share an ancestor with the gestures)
// Nothing native stops a slide from also ending as a press: NSH's pan
// gate only drops ancestor responder candidates, and the iOS press
// recognizer fails only when the finger leaves the view's bounds. So the
// tap layer watches its raw touches itself and treats any touch that
// moved past the slide threshold, or had a second finger (a pinch), as
// not-a-tap: no toggle, no double-tap seek, no 2× hold.

import {
  Canvas,
  cleanup,
  computed,
  createAnimatedValue,
  Path2D,
  effect,
  Image,
  PanResponder,
  platform,
  safeAreaInsets,
  signal,
  Text,
  untracked,
  View,
} from "nsh";
import { Slider } from "nsh/base";
import { exitPlayer } from "../lib/router";
import { openEpisodes } from "./EpisodePicker";
import { openSources } from "./SourcePicker";
import {
  AudioSubsPanel,
  closePlayerPopups,
  playerPopup,
  SpeedList,
  toggleSpeedList,
  toggleSubsPanel,
} from "./AudioSubsPanel";
// For the shell's title bar (one import site for the player's chrome).
export { closeSources, openSources, showSourcesPicker } from "./SourcePicker";
import {
  activeSource,
  debug,
  duration,
  enterFullscreen,
  enterPip,
  episodes,
  hasNextEpisode,
  failState,
  holdRate,
  mediaFullscreen,
  mediaPaused,
  mediaRate,
  mediaVolume,
  nextEpisode,
  pipSupported,
  playerPhase,
  playerRoute,
  position,
  rateHeld,
  tryAgain,
  switchNotice,
  playerTitle,
  currentSubtitle,
  playerUrl,
  seekBy,
  seekTo,
  setFill,
  setRate,
  seekStep,
  skipPill,
  skipPillPress,
  SPEEDS,
  upNextAction,
  upNextCard,
  setCaptionLift,
  togglePlay,
  setVolumeTo,
  mediaMuted,
  nativeActive,
  toggleFullscreen,
  toggleMute,
  onAutotestUi,
} from "../lib/player";
import { nativeFullscreenCapable, nativeFullscreenOn, nativePipActive } from "../lib/playback/nativeBackend";
import { sourcesFor, type MediaType } from "../lib/sources";
import { downloadCurrent, type DlTarget } from "../lib/downloads";
import { Button, DownloadButton } from "../lib/ui";
import {
  getBrightness,
  getVolume,
  hasSystemControls,
  playerFullscreen,
  setBrightness,
  setVolume,
} from "../lib/system";

// --- Shared helpers -----------------------------------------------------------

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** "1×", "1.25×". */
export function rateLabel(rate: number): string {
  return `${Math.round(rate * 100) / 100}×`;
}

/** Next speed in SPEEDS after the current one. */
export function cycleRate() {
  const cur = mediaRate();
  const i = SPEEDS.findIndex((x) => Math.abs(x - cur) < 0.01);
  setRate(SPEEDS[(i + 1) % SPEEDS.length]);
}

/** Whether there is an episode after this one (this season or the next). */
/** Whether there is an episode after this one (the core's rule). */
export const hasNext = computed(() => hasNextEpisode());

export const isSeries = computed(() => {
  const p = playerRoute();
  return !!p && p.type !== "movie";
});

/** The playing title; "" until known (never a placeholder). */
export const titleLine = computed(() => playerTitle());

/** "S1 · E4 · Episode name" (anime: no season); "" for movies. */
export const episodeLine = computed(() => {
  const p = playerRoute();
  if (!p || p.type === "movie") return "";
  const ep = p.episode ?? 1;
  const name = episodes().find((e) => e.n === ep)?.name ?? "";
  const parts = [p.type === "tv" ? `S${p.season ?? 1}` : "", `E${ep}`, name];
  return parts.filter(Boolean).join(" · ");
});

/** The label of the source in use. */
export const sourceName = computed(() => {
  const p = playerRoute();
  const id = activeSource();
  return sourcesFor((p?.type ?? "movie") as MediaType).find((s) => s.id === id)?.label ?? id;
});

// --- Failure wording (phone and desktop) -----------------------------------------

/** The terminal state's two lines: "Couldn't play this right now" and the
 * reason in plain words ("None of the 6 sources responded", "You're
 * offline", "Vidlove, the source you picked, didn't respond"). */
export const FAIL_TITLE = "Couldn't play this right now";
export const failReason = computed(() => failState()?.reason ?? "");

/** The video in the player as a download target (the shared
 * DownloadButton in the phone overlay and the desktop title bar). */
export const playerDlTarget = computed<DlTarget | null>(() => {
  const p = playerRoute();
  if (!p) return null;
  const ep = p.type !== "movie" ? episodes().find((e) => e.n === (p.episode ?? 1)) : undefined;
  return {
    type: p.type,
    id: p.id,
    season: p.type === "tv" ? (p.season ?? 1) : undefined,
    episode: p.type === "movie" ? undefined : (p.episode ?? 1),
    lang: p.type === "anime" ? (p.lang ?? "sub") : undefined,
    title: playerTitle(),
    episodeName: ep?.name || undefined,
    poster: p.poster,
    still: ep?.still,
  };
});

// --- Icons ----------------------------------------------------------------------
//
// Vector icons drawn as inline SVG data URIs — real shapes, not emoji or
// font glyphs, so they match the system player's line-icon look.

export const icon = (body: string, size = 22) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${body}</svg>`,
  )}`;

const S = `fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"`;
const CC_PATH =
  "M11 10.2C9.6 8.8 7 9.6 7 12C7 14.4 9.6 15.2 11 13.8M17.5 10.2C16.1 8.8 13.5 9.6 13.5 12C13.5 14.4 16.1 15.2 17.5 13.8";

export const ICONS = {
  back: `<path d="M14.5 5.5 8 12l6.5 6.5" ${S} stroke-width="2.4"/>`,
  forward: `<path d="M9.5 5.5 16 12l-6.5 6.5" ${S} stroke-width="2.4"/>`,
  close: `<path d="M6.5 6.5l11 11m0-11-11 11" ${S} stroke-width="2.2"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5" ${S} stroke-width="2.4"/>`,
  alert: `<circle cx="12" cy="12" r="9" ${S} stroke-width="1.9"/><path d="M12 7.5v5.5" ${S} stroke-width="2.2"/><circle cx="12" cy="16.6" r="1.25" fill="#fff"/>`,
  play: `<path d="M8.5 5.5v13l10.5-6.5z" fill="#fff"/>`,
  pause: `<rect x="6.5" y="5" width="3.8" height="14" rx="1.3" fill="#fff"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.3" fill="#fff"/>`,
  vol: `<path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5H4z" fill="#fff"/><path d="M15 9.6a3.8 3.8 0 0 1 0 4.8M17.6 7.4a7.2 7.2 0 0 1 0 9.2" ${S} stroke-width="1.7"/>`,
  mute: `<path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5H4z" fill="#fff"/><path d="M15.5 9.8l5 4.4m0-4.4-5 4.4" ${S} stroke-width="1.8"/>`,
  sources: `<path d="M8.5 7h10m0 0-3.2-3.2M18.5 7l-3.2 3.2M15.5 17H5.5m0 0 3.2-3.2M5.5 17l3.2 3.2" ${S} stroke-width="1.9"/>`,
  fullscreen: `<path d="M9.5 4.5H4.5v5M14.5 4.5h5v5M9.5 19.5h-5v-5M14.5 19.5h5v-5" ${S} stroke-width="2"/>`,
  // Android: leave full screen (the corners turned inward).
  fullscreenExit: `<path d="M4.5 9.5h5v-5M19.5 9.5h-5v-5M4.5 14.5h5v5M19.5 14.5h-5v5" ${S} stroke-width="2"/>`,
  pip: `<rect x="3" y="5" width="18" height="14" rx="2" ${S} stroke-width="1.8"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="#fff"/>`,
  nextEp: `<rect x="16.4" y="5" width="2.8" height="14" rx="1" fill="#fff"/><path d="M5.4 5.8v12.4L13.6 12z" fill="#fff"/>`,
  // The ±10 arrows without their number: the "10" is a Text on top so
  // only the arrow turns when it spins.
  arrowBack: `<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" ${S} stroke-width="1.9"/><path d="M3.5 3.8v5.4h5.4" ${S} stroke-width="1.9"/>`,
  arrowFwd: `<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" ${S} stroke-width="1.9"/><path d="M20.5 3.8v5.4h-5.4" ${S} stroke-width="1.9"/>`,
  download: `<path d="M12 4v10.5m0 0-3.8-3.8M12 14.5l3.8-3.8" ${S} stroke-width="2"/><path d="M5 14.5h14v4.5H5z" ${S} stroke-width="1.9"/>`,
  downloaded: `<path d="M5 12.5l4.5 4.5L19 7.5" ${S} stroke-width="2.2"/>`,
  lock: `<rect x="5.5" y="10.5" width="13" height="9.5" rx="2" fill="#fff"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" ${S} stroke-width="2"/>`,
  // Open: outline body, shackle lifted clear of it on the right.
  unlock: `<rect x="5.5" y="11" width="13" height="9" rx="2" ${S} stroke-width="1.9"/><path d="M8.5 11V6.5a3.5 3.5 0 0 1 7 0" ${S} stroke-width="1.9"/>`,
  episodes: `<rect x="3.5" y="8" width="17" height="11.5" rx="2" ${S} stroke-width="1.8"/><path d="M6.5 5h11" ${S} stroke-width="1.8"/><path d="M10.5 11.2v5.1l4.2-2.55z" fill="#fff"/>`,
  ccOn: `<rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="#fff"/><path d="${CC_PATH}" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round"/>`,
  ccOff: `<rect x="3" y="5.5" width="18" height="13" rx="2.5" ${S} stroke-width="1.6"/><path d="${CC_PATH}" ${S} stroke-width="1.6"/>`,
  sun: `<circle cx="12" cy="12" r="3.8" fill="#fff"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" ${S} stroke-width="1.8"/>`,
  spinner: `<circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-opacity="0.25" stroke-width="2.4"/><path d="M12 3a9 9 0 0 1 9 9" ${S} stroke-width="2.4"/>`,
  // Download states (the shared DownloadButton, lib/ui.tsx).
  clock: `<circle cx="12" cy="12" r="8.5" ${S} stroke-width="1.9"/><path d="M12 7.6V12l3 2" ${S} stroke-width="1.9"/>`,
  playCircle: `<circle cx="12" cy="12" r="8.5" ${S} stroke-width="1.9"/><path d="M10.2 8.6v6.8l5.4-3.4z" fill="#fff"/>`,
  // A filled disc with a dark check (recolour the disc with Glyph's `color`).
  checkCircle: `<circle cx="12" cy="12" r="9" fill="#fff"/><path d="M7.8 12.3l2.9 2.9 5.5-5.6" fill="none" stroke="#0b0b0d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  chevUp: `<path d="M6 14.5 12 8.5l6 6" ${S} stroke-width="2.2"/>`,
  chevDown: `<path d="M6 9.5l6 6 6-6" ${S} stroke-width="2.2"/>`,
  film: `<rect x="3.5" y="4.5" width="17" height="15" rx="2" ${S} stroke-width="1.8"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4" ${S} stroke-width="1.6"/>`,
  more: `<circle cx="6" cy="12" r="1.7" fill="#fff"/><circle cx="12" cy="12" r="1.7" fill="#fff"/><circle cx="18" cy="12" r="1.7" fill="#fff"/>`,
  offline: `<path d="M2.8 9.2a13.5 13.5 0 0 1 18.4 0M5.8 12.5a9 9 0 0 1 12.4 0M8.9 15.7a4.6 4.6 0 0 1 6.2 0" ${S} stroke-width="1.9"/><circle cx="12" cy="19" r="1.3" fill="#fff"/><path d="M4.5 4.5l15 15" ${S} stroke-width="2"/>`,
} as const;

export type IconName = keyof typeof ICONS;

/** A progress ring (download running): a faint track and a red arc for
 * `frac` (0..1) from the top, clockwise. `null`: a quarter arc, for an
 * indeterminate ring (spin it). Pass the result to `icon()`. */
export function progressRing(frac: number | null): string {
  const r = 9.5;
  const c = 2 * Math.PI * r;
  const f = frac == null ? 0.25 : Math.max(0, Math.min(1, frac));
  const track = `<circle cx="12" cy="12" r="${r}" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="2.2"/>`;
  if (f <= 0) return track;
  return `${track}<circle cx="12" cy="12" r="${r}" fill="none" stroke="#e50914" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${(f * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 12 12)"/>`;
}

/** An icon from ICONS; `color` (CSS color, default white) recolours it. */
export function Glyph(props: { d: IconName; size?: number; color?: string }) {
  const s = props.size ?? 22;
  return (
    <Image
      src={icon(
        props.color ? ICONS[props.d].split("#fff").join(props.color) : ICONS[props.d],
        s,
      )}
      style={{ width: s, height: s }}
    />
  );
}

// --- Turning icons on the desktop ------------------------------------------------------
//
// nsh-platform-gpui 0.4.0 does not rotate images: an image whose view turns
// is painted upright into the turned box's axis-aligned bounding box
// (image.rs `draw_one`: `cx.rect(..)`, which render.rs documents as "its
// bounding box" for a non-axis-aligned transform). A spinning ring or a
// turning ±10 arrow drawn as an <Image> therefore only grows and shrinks
// (s·(|cos a|+|sin a|)) — the "pulsing". Paths and canvases do turn
// (render.rs: "filled as paths whose points are mapped"; canvas.rs
// rasterizes in the view's whole transform, and a drawing that reads an
// animated value is redrawn natively each frame). So on the desktop the
// spinner and the ±10 arrows are canvases whose rotation reads an animated
// value; phones keep the images (UIKit / Android rotate them).

const DESKTOP_UI = platform.desktop;
const DEG = Math.PI / 180;

/** The page overlay's spinner (`IC.spinner` + `.rot`: 0.9 s linear, endless). */
function CanvasSpinner(props: { size: number }) {
  const turn = createAnimatedValue(0);
  // Endless while mounted; it stops with this component (its value goes).
  void turn.keyframes([0, 360], { duration: 900, easing: "linear", iterations: "infinite" });
  const ring = new Path2D("M12 3a9 9 0 0 1 9 9");
  return (
    <Canvas
      style={{ width: props.size, height: props.size }}
      draw={(cx, { width }) => {
        const k = width / 24;
        cx.scale(k, k);
        cx.translate(12, 12);
        cx.rotate(turn.mul(DEG));
        cx.translate(-12, -12);
        cx.lineWidth = 2.4;
        cx.lineCap = "round";
        cx.strokeStyle = "rgba(255,255,255,0.25)";
        cx.beginPath();
        cx.arc(12, 12, 9, 0, Math.PI * 2);
        cx.stroke();
        cx.strokeStyle = "#ffffff";
        cx.stroke(ring);
      }}
    />
  );
}

export function Spinner(props: { size?: number }) {
  const s = props.size ?? 40;
  if (DESKTOP_UI) return <CanvasSpinner size={s} />;
  return (
    <Image src={icon(ICONS.spinner, s)} class="animate-spin" style={{ width: s, height: s }} />
  );
}

/** The ±10 arrow (`IC.arrowBack` / `IC.arrowFwd`), turned by `turn` (degrees). */
const ARROW = {
  back: ["M3.5 12a8.5 8.5 0 1 0 2.5-6", "M3.5 3.8v5.4h5.4"],
  fwd: ["M20.5 12a8.5 8.5 0 1 1-2.5-6", "M20.5 3.8v5.4h-5.4"],
};
function CanvasArrow(props: { dir: number; size: number }) {
  const turn = props.dir < 0 ? spinBack : spinFwd;
  const paths = (props.dir < 0 ? ARROW.back : ARROW.fwd).map((d) => new Path2D(d));
  return (
    <Canvas
      style={{ position: "absolute", left: 0, top: 0, width: props.size, height: props.size }}
      draw={(cx, { width }) => {
        const k = width / 24;
        cx.scale(k, k);
        cx.translate(12, 12);
        cx.rotate(turn.mul(DEG));
        cx.translate(-12, -12);
        cx.lineWidth = 1.9;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.strokeStyle = "#ffffff";
        for (const p of paths) cx.stroke(p);
      }}
    />
  );
}

// --- ±10 s with the arrow spin ------------------------------------------------------
//
// Like the iPhone's player: every −10 / +10 turns its arrow once in its
// direction (counter-clockwise back, clockwise forward). One value per
// direction, shared by every icon bound to it (centre cluster, the
// double-tap flash, the desktop bar).

const spinBack = createAnimatedValue(0);
const spinFwd = createAnimatedValue(0);

export function spin(dir: number) {
  const v = dir < 0 ? spinBack : spinFwd;
  v.set(0);
  void v.timing(dir < 0 ? -360 : 360, { duration: 300, easing: "easeOut" });
}

/** One seek step (`seekStep()`) back / forward, with the spin. */
export function skipBy(dir: number) {
  spin(dir);
  seekBy(dir * seekStep());
}

export function SeekIcon(props: { dir: number; size: number }) {
  // props.dir is read in the JSX so it stays reactive (the double-tap
  // flash reuses one icon for both sides).
  const s = props.size;
  return (
    // The arc's centre is the viewBox centre (12,12), so the arrow and the
    // number share one box: both are absolute fills of it, the number
    // centred with a line box exactly its font size (no baseline drop).
    <View style={{ width: s, height: s }}>
      <If
        when={DESKTOP_UI}
        else={
          <Image
            src={icon(props.dir < 0 ? ICONS.arrowBack : ICONS.arrowFwd, s)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: s,
              height: s,
              transform: [{ rotate: props.dir < 0 ? spinBack : spinFwd }],
            }}
          />
        }
      >
        <CanvasArrow dir={props.dir} size={s} />
      </If>
      <View
        class="pointer-events-none absolute inset-0 items-center justify-center"
      >
        <Text
          class="font-bold text-white"
          allowFontScaling={false}
          style={{
            width: s,
            textAlign: "center",
            fontSize: Math.round(s * 0.3),
            lineHeight: Math.round(s * 0.3),
          }}
        >
          {String(seekStep())}
        </Text>
      </View>
    </View>
  );
}

// --- Seek slider with the time bubble ---------------------------------------------

export function SeekBar(props: {
  desktop?: boolean;
  disabled?: boolean;
  onActive?: (dragging: boolean) => void;
}) {
  const drag = signal<number | null>(null);
  const width = signal(0);
  const pad = props.desktop ? 6 : 8;
  const value = computed(() => {
    const d = drag();
    if (d != null) return d;
    const dur = duration();
    return dur > 0 ? Math.min(position(), dur) : 0;
  });
  const frac = computed(() => {
    const dur = duration();
    return dur > 0 ? Math.max(0, Math.min(1, value() / dur)) : 0;
  });
  return (
    <View
      class="flex-1 justify-center"
      onLayout={(e: { bounds: { size: { width: number } } }) => width.set(e.bounds.size.width)}
    >
      <If when={drag() != null}>
        <View
          class="pointer-events-none absolute items-center"
          style={{
            bottom: props.desktop ? 20 : 36,
            width: 72,
            left: pad + frac() * Math.max(0, width() - 2 * pad) - 36,
          }}
        >
          <View class="rounded-md bg-black/85 px-2 py-1">
            <Text class="text-xs font-bold text-white">{fmtTime(drag() ?? 0)}</Text>
          </View>
        </View>
      </If>
      <Slider
        value={value()}
        min={0}
        max={Math.max(1, duration())}
        step={0}
        disabled={props.disabled}
        onChange={({ value: v }) => {
          // Every step: the phone times a lost end event out from the last one.
          props.onActive?.(true);
          drag.set(Number(v));
        }}
        onChangeEnd={({ value: v }) => {
          seekTo(Number(v));
          drag.set(null);
          props.onActive?.(false);
        }}
        accessibilityLabel="Seek"
        class="flex-1"
        trackClass={
          props.desktop
            ? "h-6 flex-1 justify-center px-1.5 cursor-pointer"
            : "h-11 flex-1 justify-center px-2"
        }
        indicatorClass={
          props.desktop ? "h-1 rounded-full bg-white/20" : "h-1 rounded-full bg-white/30"
        }
        rangeClass="h-full rounded-full bg-primary"
        thumbClass={
          props.desktop ? "h-3 w-3 rounded-full bg-primary" : "h-4 w-4 rounded-full bg-primary"
        }
      />
    </View>
  );
}

// --- Phone seek bar: its own responder ---------------------------------------------
//
// A plain view that becomes the touch responder when a finger goes down
// on it (44 pt tall): a tap jumps there, a drag scrubs with the time
// bubble, and the release seeks once. Track, fill, thumb and bubble take
// no touches, so locationX is always in the bar's own coordinates.

const SEEK_H = 44;
const SEEK_PAD = 10;

function TouchSeekBar(props: { onActive: (scrubbing: boolean) => void }) {
  const drag = signal<number | null>(null);
  const width = signal(0);
  const frac = computed(() => {
    const d = duration();
    if (!(d > 0)) return 0;
    const v = drag() ?? Math.min(position(), d);
    return Math.max(0, Math.min(1, v / d));
  });
  const span = computed(() => Math.max(0, width() - 2 * SEEK_PAD));
  const toSec = (x: number) => {
    const w = span();
    const d = duration();
    if (!(w > 0) || !(d > 0)) return 0;
    return Math.max(0, Math.min(1, (x - SEEK_PAD) / w)) * d;
  };
  let target = 0;
  const begin = (x: number) => {
    target = toSec(x);
    drag.set(target);
    props.onActive(true);
    debug("seek: scrub start", { sec: Math.round(target), x: Math.round(x) });
  };
  const move = (x: number) => {
    if (drag() == null) return;
    target = toSec(x);
    drag.set(target);
    props.onActive(true);
  };
  const end = () => {
    if (drag() == null) return;
    drag.set(null);
    seekTo(target);
    debug("seek: commit", { sec: Math.round(target) });
    props.onActive(false);
  };
  const thumb = computed(() => (drag() != null ? 22 : 14));
  return (
    <View
      class="flex-1"
      style={{ height: SEEK_H }}
      accessibilityLabel="Seek"
      onLayout={(e: { bounds: { size: { width: number } } }) => width.set(e.bounds.size.width)}
      onStartShouldSetResponder={() => duration() > 0}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e: { locationX: number }) => {
        begin(e.locationX);
        return true;
      }}
      onResponderMove={(e: { locationX: number }) => move(e.locationX)}
      onResponderRelease={end}
      onResponderTerminate={end}
    >
      <View
        class="pointer-events-none absolute overflow-hidden rounded-full bg-white/30"
        style={{ left: SEEK_PAD, right: SEEK_PAD, top: SEEK_H / 2 - 2, height: 4 }}
      >
        <View class="h-full bg-primary" style={{ width: span() * frac() }} />
      </View>
      <View
        class="pointer-events-none absolute rounded-full bg-primary"
        style={{
          width: thumb(),
          height: thumb(),
          top: SEEK_H / 2 - thumb() / 2,
          left: SEEK_PAD + frac() * span() - thumb() / 2,
        }}
      />
      <If when={drag() != null}>
        <View
          class="pointer-events-none absolute items-center"
          style={{ bottom: SEEK_H - 4, width: 80, left: SEEK_PAD + frac() * span() - 40 }}
        >
          <View class="rounded-md bg-black/85 px-2 py-1">
            <Text class="text-sm font-bold text-white">{fmtTime(drag() ?? 0)}</Text>
          </View>
        </View>
      </If>
    </View>
  );
}

// --- Phone overlay state (module level: it survives the overlay being
// unmounted while the palette or the source picker is open) -----------------------

export const controlsVisible = signal(true);

// The autotest's `ui:` actions (lib/player.ts runAutotest).
onAutotestUi((name) => {
  if (name === "controls") pokeControls();
  else if (name === "hide") hideControls();
  else if (name === "panel") {
    pokeControls();
    if (playerPopup() !== "subs") toggleSubsPanel();
  } else if (name === "close") closePlayerPopups();
});
const locked = signal(false);
const hint = signal<string | null>(null);
const seekFlash = signal<{ label: string; dir: number } | null>(null);
const level = signal<{ kind: "bright" | "vol"; v: number } | null>(null);
const overlaySize = signal({ w: 0, h: 0 });
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let levelTimer: ReturnType<typeof setTimeout> | undefined;
let tapTimer: ReturnType<typeof setTimeout> | undefined;
let lastTap = { dir: 0, at: 0, count: 0 };
let seekDragging = false;
let seekDragTimer: ReturnType<typeof setTimeout> | undefined;
// The current touch sequence on the tap layer: `notTap` once it moved
// past SLIDE_PX or a second finger came down. Reset when a first finger
// goes down again.
const SLIDE_PX = 12;
let gestureSeq = 0;
let notTap = false;
let touchStart = { x: 0, y: 0 };

// Loading: the page URL whose video has shown a frame (playing, paused or
// stalled once) — the loading title does not come back for it.
let framedUrl = "";

function onTouchStart(e: { pageX: number; pageY: number; touches?: unknown[] }) {
  const fingers = e.touches?.length ?? 1;
  if (fingers <= 1) {
    gestureSeq++;
    notTap = false;
    touchStart = { x: e.pageX, y: e.pageY };
  } else {
    notTap = true;
    cancelTap();
  }
}

function onTouchMove(e: { pageX: number; pageY: number; touches?: unknown[] }) {
  if (notTap) return;
  if ((e.touches?.length ?? 1) > 1 || Math.hypot(e.pageX - touchStart.x, e.pageY - touchStart.y) > SLIDE_PX) {
    notTap = true;
    cancelTap();
  }
}

/** The seek slider is being dragged; a lost end event clears it after 4 s
 * of no changes so the auto-hide cannot stay blocked. */
function noteSeekDrag(on: boolean) {
  if (seekDragTimer) clearTimeout(seekDragTimer);
  seekDragTimer = undefined;
  seekDragging = on;
  if (on) {
    seekDragTimer = setTimeout(() => {
      seekDragTimer = undefined;
      seekDragging = false;
      if (controlsVisible()) armHide();
    }, 4000);
  }
  pokeControls();
}

function interactive() {
  const ph = playerPhase();
  return ph === "playing" || ph === "paused" || ph === "stalled";
}

function canAutoHide() {
  // An open popup (Audio & Subtitles, speed) keeps the controls up.
  return !seekDragging && !mediaPaused() && playerPhase() === "playing" && playerPopup() === null;
}

function clearHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = undefined;
}

function armHide() {
  clearHide();
  if (!canAutoHide()) return;
  hideTimer = setTimeout(() => {
    hideTimer = undefined;
    if (canAutoHide()) controlsVisible.set(false);
  }, 3000);
}

/** Shows the chrome and restarts the 3 s auto-hide. */
export function pokeControls() {
  controlsVisible.set(true);
  armHide();
}

/** A new title: unlocked, no leftover feedback. (An open popup stays:
 * an anime sub/dub pick in the panel re-opens the episode as a new route.) */
export function resetControls() {
  framedUrl = "";
  locked.set(false);
  hint.set(null);
  seekFlash.set(null);
  level.set(null);
}

/** Hides the chrome, and with it any open popup (a picker opening, the
 * lock). */
export function hideControls() {
  clearHide();
  closePlayerPopups();
  controlsVisible.set(false);
}

function flashHint(text: string, ms = 1400) {
  hint.set(text);
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.set(null), ms);
}

function doubleTapSeek(dir: number) {
  const now = Date.now();
  lastTap.count = lastTap.dir === dir && now - lastTap.at < 2000 ? lastTap.count + 1 : 1;
  lastTap.dir = dir;
  lastTap.at = now;
  skipBy(dir);
  if (controlsVisible()) armHide();
  seekFlash.set({ label: `${dir > 0 ? "+" : "−"}${lastTap.count * seekStep()}`, dir });
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => seekFlash.set(null), 900);
}

/** A second tap within this long of the first is a double tap. */
const DOUBLE_TAP_MS = 320;
/** After a double-tap seek, each further tap on the same side within this
 * long seeks one more step (10 s steps: a triple tap = 20 s). */
const SEEK_STREAK_MS = 800;
/** The previous tap on the picture: when and where (overlay x). */
let prevTap = { at: 0, x: -1 };

// Single tap toggles the chrome, a double tap seeks one step (seekStep())
// on the side tapped (each further tap adds one): the single tap waits a moment so a
// double tap does not also flash the chrome.
//
// The double tap is recognised here from the taps' timing: NSH reports a
// click count only for mouse clicks (the desktop backends); touches on
// iOS and Android always come with clickCount 1.
function onTap(e: { position?: { x: number }; clickCount?: number } | undefined) {
  if (notTap) return;
  if (locked()) {
    flashHint("Locked — hold to unlock");
    return;
  }
  if (!interactive()) return;
  const now = Date.now();
  const w = overlaySize().w || 1;
  const x = e?.position?.x ?? w / 2;
  const dir = x < w / 2 ? -1 : 1;
  const prev = prevTap;
  prevTap = { at: now, x };
  let clicks = e?.clickCount ?? 1;
  if (clicks < 2 && now - prev.at < DOUBLE_TAP_MS && (prev.x < w / 2 ? -1 : 1) === dir) clicks = 2;
  // Tapping on during a seek streak keeps seeking.
  if (clicks < 2 && lastTap.dir === dir && now - lastTap.at < SEEK_STREAK_MS) clicks = 2;
  if (clicks >= 2) {
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = undefined;
    // A streak's taps are not the first of a new double tap.
    prevTap = { at: 0, x: -1 };
    doubleTapSeek(dir);
    return;
  }
  if (tapTimer) clearTimeout(tapTimer);
  const seq = gestureSeq;
  tapTimer = setTimeout(() => {
    tapTimer = undefined;
    // The touch turned into a slide or a pinch after the press arrived.
    if (seq === gestureSeq && notTap) return;
    if (controlsVisible()) hideControls();
    else pokeControls();
  }, 260);
}

function cancelTap() {
  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = undefined;
}

// --- Brightness / volume slides ------------------------------------------------------

let lastBright = 0.5;
let lastVol = 1;
let slide: {
  kind: "bright" | "vol";
  start: number;
  dy: number;
  h: number;
  sys: boolean;
} | null = null;
let applyTimer: ReturnType<typeof setTimeout> | undefined;
let applyWant: { kind: "bright" | "vol"; v: number; sys: boolean } | null = null;

function flushLevel() {
  const w = applyWant;
  applyWant = null;
  if (!w) return;
  if (w.kind === "bright") {
    lastBright = w.v;
    void setBrightness(w.v);
  } else if (w.sys) {
    lastVol = w.v;
    void setVolume(w.v);
  } else {
    setVolumeTo(w.v);
  }
}

/** Drops pending slide writes (before restoreBrightness on unmount). */
export function stopGestures() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = undefined;
  applyWant = null;
  slide = null;
}

// At most one native call per 50 ms while sliding, the last value always sent.
function applyLevel(kind: "bright" | "vol", v: number, sys: boolean) {
  applyWant = { kind, v, sys };
  if (applyTimer) return;
  flushLevel();
  applyTimer = setTimeout(() => {
    applyTimer = undefined;
    flushLevel();
  }, 50);
}

function slideValue() {
  if (!slide) return 0;
  return Math.max(0, Math.min(1, slide.start - slide.dy / (slide.h * 0.7)));
}

function slideStart(x0: number) {
  if (locked() || !interactive()) return;
  cancelTap();
  if (rateHeld()) holdRate(false);
  const sys = hasSystemControls();
  const { w, h } = overlaySize();
  const left = x0 < (w || 1) / 2;
  if (left && !sys) return; // no brightness off iOS
  const kind = left ? "bright" : "vol";
  const start = kind === "bright" ? lastBright : sys ? lastVol : mediaVolume();
  slide = { kind, start, dy: 0, h: h || 320, sys };
  if (levelTimer) clearTimeout(levelTimer);
  level.set({ kind, v: start });
  if (sys) {
    // The real level, before the finger has moved far.
    void (kind === "bright" ? getBrightness() : getVolume()).then((v) => {
      if (!slide || slide.kind !== kind) return;
      if (Math.abs(slide.dy) >= 4) return; // already moving from the cached value
      slide.start = v;
      level.set({ kind, v });
    });
  }
}

function slideMove(dy: number) {
  if (!slide) return;
  slide.dy = dy;
  const v = slideValue();
  level.set({ kind: slide.kind, v });
  applyLevel(slide.kind, v, slide.sys);
}

function slideEnd() {
  notTap = true;
  if (!slide) return;
  slide = null;
  if (levelTimer) clearTimeout(levelTimer);
  levelTimer = setTimeout(() => level.set(null), 600);
}

// --- Up next ----------------------------------------------------------------------------

function CardBtn(props: { label: string; primary?: boolean; desktop?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class={`${props.desktop ? "min-h-9 cursor-pointer" : "min-h-11"} items-center justify-center rounded-full px-4 active:opacity-70 ${
        props.primary ? "bg-white hover:bg-zinc-200" : "border border-white/30 hover:bg-white/15"
      }`}
    >
      <Text class={`text-[13px] font-bold ${props.primary ? "text-black" : "text-white"}`}>{props.label}</Text>
    </View>
  );
}

/** Up next / the end of the episode / Still watching? (lib/player.ts
 * `upNextCard`): the next episode's still, "Next: S1 · E3 · Name", the
 * countdown bar and two buttons — the page overlay's #un, drawn by the
 * app (phones; desktop over the app's own player). */
export function UpNextCard(props: { desktop?: boolean }) {
  const w = props.desktop ? 300 : 260;
  return (
    <If when={upNextCard()}>
      {(c) => (
        <View
          class="flex-col gap-2 rounded-2xl p-3"
          style={{
            width: w,
            backgroundColor: "rgba(20,20,23,0.94)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.18)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
          }}
        >
          <If when={c().still}>
            {(src) => (
              <Image
                src={src()}
                class="rounded-lg bg-zinc-800"
                style={{ width: w - 24, height: Math.round(((w - 24) * 9) / 16) }}
              />
            )}
          </If>
          <Text class="text-[15px] font-bold text-white">{c().title}</Text>
          <Text class="text-[13px] text-zinc-300" style={{ numberOfLines: 1 }}>
            {c().line}
          </Text>
          <If when={c().frac !== null}>
            <View class="overflow-hidden rounded-full" style={{ height: 3, backgroundColor: "rgba(255,255,255,0.2)" }}>
              <View style={{ height: 3, width: `${Math.round((c().frac ?? 0) * 100)}%`, backgroundColor: "#e50914" }} />
            </View>
          </If>
          <View class="flex-row gap-2">
            <CardBtn primary desktop={props.desktop} label={c().primary.label} onPress={() => upNextAction(c().primary.id)} />
            <If when={c().secondary}>
              {(b) => <CardBtn desktop={props.desktop} label={b().label} onPress={() => upNextAction(b().id)} />}
            </If>
          </View>
        </View>
      )}
    </If>
  );
}

// --- Phone overlay -------------------------------------------------------------------

function IconBtn(props: {
  d: IconName;
  label: string;
  onPress: () => void;
  size?: number;
  /** The button toggles a popup itself (CC): pressing it does not first
   * close the open one. */
  keepPopup?: boolean;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={() => {
        if (!props.keepPopup) closePlayerPopups();
        pokeControls();
        props.onPress();
      }}
      class="h-11 w-11 items-center justify-center active:opacity-50"
    >
      <Glyph d={props.d} size={props.size ?? 24} />
    </View>
  );
}

/** The terminal state (nothing left to try): centred, two lines and one
 * Try again. Picking a source by hand stays in the top row's sources
 * button. */
function FailedPanel() {
  return (
    <View class="absolute inset-0 items-center justify-center px-8" style={{ pointerEvents: "box-none" }}>
      <View class="items-center gap-2" style={{ maxWidth: 360 }}>
        <Text class="text-center text-lg font-bold text-white">{FAIL_TITLE}</Text>
        <If when={failReason()}>
          <Text class="text-center text-sm text-zinc-400">{failReason()}</Text>
        </If>
        <View class="mt-3">
          <Button variant="primary" size="md" icon="retry" label="Try again" onPress={() => tryAgain()} />
        </View>
      </View>
    </View>
  );
}

export function PhoneControls() {
  const ins = safeAreaInsets();
  const padL = computed(() => Math.max(ins().left, 12));
  const padR = computed(() => Math.max(ins().right, 12));
  const padT = computed(() => Math.max(ins().top, 6));
  const padB = computed(() => Math.max(ins().bottom, 8));
  const barH = signal(0);
  const pinchScale = createAnimatedValue(1);
  // iPhone + the app's player: the component's own full screen (landscape,
  // the app's controls stay), toggled; Android: the player window's.
  const iosNative = computed(() => platform.os === "ios" && nativeActive());
  const fsOn = computed(() =>
    platform.os === "android" ? playerFullscreen() : iosNative() ? nativeFullscreenOn() : false,
  );

  const phase = computed(() => playerPhase());
  const blind = computed(() => phase() === "blind");
  const canPlay = computed(() => interactive());
  // One control set in every state: while loading the chrome stays up
  // (a spinner takes the play button's place, ±10 dimmed), so the layout
  // never changes between loading, playing, paused and stalled.
  const loading = computed(() => phase() === "loading");
  const busy = computed(() => phase() === "loading" || phase() === "stalled");
  const chrome = computed(
    () =>
      !mediaFullscreen() &&
      !locked() &&
      (canPlay() || loading()) &&
      (controlsVisible() || loading()),
  );
  const showTop = computed(
    () => !mediaFullscreen() && !locked() && (chrome() || phase() === "failed"),
  );
  const popup = computed(() => (chrome() ? playerPopup() : null));

  // The page draws the captions: they sit above the seek row while the
  // bottom bar shows, and drop back when it hides (locked, hidden, blind,
  // fullscreen, this overlay unmounted).
  effect(() => {
    const lift = chrome();
    untracked(() => setCaptionLift(lift));
  });
  cleanup(() => setCaptionLift(false));

  // Loading: black (no artwork), the controls in their places and the
  // title over the bottom bar until this video has shown a frame; the
  // picture then simply appears behind them.
  effect(() => {
    const ph = playerPhase();
    const u = playerUrl();
    if (u && (ph === "playing" || ph === "paused" || ph === "stalled")) framedUrl = u;
  });
  const loadingTitle = computed(() => {
    const u = playerUrl() ?? "";
    return playerPhase() === "loading" && (!u || u !== framedUrl);
  });

  // Paused (by the page, the system or the user) keeps the chrome up;
  // playing again lets the 3 s timer run.
  // Blind and failed need the page or the panel: a lock cannot stay.
  effect(() => {
    const ph = playerPhase();
    if ((ph === "blind" || ph === "failed") && locked()) locked.set(false);
  });

  let prevPhase = "";
  effect(() => {
    const ph = playerPhase();
    const vis = controlsVisible();
    playerPopup(); // closing a popup lets the 3 s timer run again
    if (ph === "paused" && prevPhase !== "paused") controlsVisible.set(true);
    prevPhase = ph;
    if (!vis) return;
    if (canAutoHide()) {
      if (!hideTimer) armHide();
    } else {
      clearHide();
    }
  });

  const responder = PanResponder.create({
    onPanResponderGrant: (_e: unknown, g: { x0: number }) => slideStart(g.x0),
    onPanResponderMove: (_e: unknown, g: { dy: number }) => slideMove(g.dy),
    onPanResponderRelease: () => slideEnd(),
    onPanResponderTerminate: () => slideEnd(),
    onPanResponderTerminationRequest: () => false,
  }).panHandlers;

  const topRow = (slim: boolean) => (
    <View
      class="absolute inset-x-0 top-0 flex-row items-center"
      style={{
        paddingTop: padT(),
        paddingLeft: padL() - 6,
        paddingRight: padR() - 6,
        paddingBottom: slim ? 4 : 8,
        pointerEvents: "box-none",
      }}
    >
      <IconBtn d="back" label="Back" onPress={exitPlayer} />
      <View class="ml-1 flex-1 flex-col" style={{ pointerEvents: "none" }}>
        <Text class="text-[15px] font-bold text-white" style={{ numberOfLines: 1 }}>
          {titleLine()}
        </Text>
        <If when={episodeLine()}>
          <Text class="text-xs text-zinc-300" style={{ numberOfLines: 1 }}>
            {episodeLine()}
          </Text>
        </If>
      </View>
      <If when={!slim && pipSupported() && canPlay()}>
        <IconBtn d="pip" label="Picture in picture" onPress={enterPip} size={22} />
      </If>
      <IconBtn d="sources" label="Sources" onPress={openSources} size={22} />
      {/* Android: switches inline ↔ landscape full screen (the icon shows
          which way); iPhone: AVKit's full screen (enterFullscreen). */}
      {/* iPhone with the app's player: only when the component has its
          own full screen (the dialog already fills the screen). */}
      <If when={!slim && canPlay() && (platform.os !== "ios" || !nativeActive() || nativeFullscreenCapable())}>
        <IconBtn
          d={fsOn() ? "fullscreenExit" : "fullscreen"}
          label={fsOn() ? "Exit full screen" : "Full screen"}
          onPress={iosNative() ? toggleFullscreen : enterFullscreen}
          size={22}
        />
      </If>
    </View>
  );

  // Scrims: their own tall views under the rows (Tailwind gradients), so
  // white icons stay readable over a bright frame.
  const topScrim = (h: number) => (
    <View
      class="pointer-events-none absolute inset-x-0 top-0 bg-linear-to-b from-black/80 via-black/45 to-black/0"
      style={{ height: padT() + h }}
    />
  );
  const bottomScrim = () => (
    <View
      class="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 via-black/50 to-black/0"
      style={{ height: barH() + 90 }}
    />
  );

  const bottomBar = () => (
    <View
      class="absolute inset-x-0 bottom-0 flex-col"
      onLayout={(e: { bounds: { size: { height: number } } }) => barH.set(e.bounds.size.height)}
      style={{
        paddingLeft: padL(),
        paddingRight: padR(),
        paddingBottom: padB(),
        paddingTop: 8,
        pointerEvents: "box-none",
      }}
    >
      <View class="flex-row items-center gap-2" style={{ pointerEvents: "box-none" }}>
        <TouchSeekBar onActive={noteSeekDrag} />
        <Text class="w-14 text-right text-xs font-medium text-white">
          {`−${fmtTime(Math.max(0, duration() - position()))}`}
        </Text>
      </View>
      <View class="-mx-2 flex-row items-center gap-3" style={{ pointerEvents: "box-none" }}>
        <View
          role="button"
          accessibilityLabel="Playback speed"
          onPress={() => {
            pokeControls();
            toggleSpeedList();
          }}
          class={`h-11 min-w-11 items-center justify-center rounded-lg px-1 active:opacity-50 ${
            playerPopup() === "speed" ? "bg-white/15" : ""
          }`}
        >
          <Text class="text-[15px] font-bold text-white">{rateLabel(mediaRate())}</Text>
        </View>
        <IconBtn
          d="unlock"
          label="Lock controls"
          onPress={() => {
            locked.set(true);
            hideControls();
            flashHint("Locked — hold to unlock");
          }}
          size={24}
        />
        {/* Speed and lock at the left; the rest at the right. */}
        <View class="flex-1" />
        <IconBtn
          d={currentSubtitle() !== null ? "ccOn" : "ccOff"}
          label="Audio and subtitles"
          keepPopup
          onPress={toggleSubsPanel}
        />
        <If when={isSeries()}>
          <IconBtn d="episodes" label="Episodes" onPress={openEpisodes} />
        </If>
        {/* The shared download control for the playing video (hidden
            where downloads are not available): a ring with the percent
            while it runs, a check once done. */}
        <DownloadButton
          target={() => playerDlTarget()}
          size={24}
          onInteract={() => {
            closePlayerPopups();
            pokeControls();
          }}
          onDownload={() => void downloadCurrent()}
        />
        <If when={hasNext()}>
          <IconBtn d="nextEp" label="Next episode" onPress={() => void nextEpisode()} size={22} />
        </If>
      </View>
    </View>
  );

  // Popups: the Audio & Subtitles panel at the right, from under the top
  // row to above the seek row (about 60% of the width), clear of the notch
  // and the home indicator on either side; the speed list above `1×`.
  const panelW = computed(() => {
    const w = overlaySize().w;
    const room = Math.max(0, w - padL() - padR());
    return Math.min(room, Math.max(340, Math.round(w * 0.6)));
  });

  return (
    <>
      {/* Loading: the title above the bottom bar on black; takes no
          touches. */}
      <If when={loadingTitle() && !mediaFullscreen()}>
        <View class="pointer-events-none absolute inset-0">
          <View
            class="absolute flex-col gap-1"
            style={{ left: padL() + 4, right: padR() + 120, bottom: (barH() || padB() + 96) + 20 }}
          >
            <Text class="text-3xl font-black text-white" style={{ numberOfLines: 2 }}>
              {titleLine()}
            </Text>
            <If when={episodeLine()}>
              <Text class="text-base font-medium text-zinc-300" style={{ numberOfLines: 1 }}>
                {episodeLine()}
              </Text>
            </If>
          </View>
        </View>
      </If>
      {/* Blind: the page's own controls must work — only a slim top
          row, everything else lets touches through. */}
      <If when={blind() && !mediaFullscreen()}>
        <View class="absolute inset-0" style={{ pointerEvents: "box-none" }}>
          {topScrim(64)}
          {topRow(true)}
        </View>
      </If>
      <If when={!blind()}>
        {/* Gesture layer: vertical slides (panActivation) and pinch. */}
        <View
          class="absolute inset-0"
          {...responder}
          panActivation={{ activeOffsetY: 14, failOffsetX: 18 }}
          pinch={{ scale: pinchScale }}
          onPinchStart={() => {
            // The touch tracking marks a two-finger sequence not-a-tap;
            // the next first finger down clears it.
            notTap = true;
            cancelTap();
          }}
          onPinchEnd={(e: { scale?: number } | undefined) => {
            pinchScale.set(1);
            if (locked() || !interactive()) return;
            const s = e?.scale ?? 1;
            if (s > 1.08) {
              setFill(true);
              flashHint("Fill screen", 900);
            } else if (s < 0.92) {
              setFill(false);
              flashHint("Fit to screen", 900);
            }
          }}
          onLayout={(e: { bounds: { size: { width: number; height: number } } }) =>
            overlaySize.set({ w: e.bounds.size.width, h: e.bounds.size.height })
          }
        >
          {/* Tap layer: tap / double tap / hold on the picture. The
              controls are not inside it (see the chrome layer below). */}
          <View
            class="absolute inset-0"
            style={{ backgroundColor: "rgba(0,0,0,0.01)" }}
            onPress={onTap}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onLongPress={() => {
              if (locked() || !interactive() || notTap) return;
              cancelTap();
              holdRate(true);
            }}
            // The finger lifting ends a held 2x. (onPressOut is not an NSH
            // prop, so the 2x never ended; onPressUp comes as soon as the
            // long press is recognised.)
            onTouchEnd={() => {
              if (rateHeld()) holdRate(false);
            }}
          >
            {/* Feedback that shows whatever the chrome does. */}
            <If when={seekFlash()}>
              {(f) => (
                <View
                  class={`pointer-events-none absolute inset-y-0 w-1/2 items-center justify-center gap-1 ${
                    f().dir < 0 ? "left-0" : "right-0"
                  }`}
                >
                  <SeekIcon dir={f().dir} size={44} />
                  <Text class="text-xl font-black text-white">{f().label}</Text>
                </View>
              )}
            </If>
            <If when={rateHeld()}>
              <View
                class="pointer-events-none absolute inset-x-0 items-center"
                style={{ top: padT() + 52 }}
              >
                <View class="flex-row items-center gap-1 rounded-full bg-black/60 px-3 py-1">
                  <Text class="text-sm font-bold text-white">2×</Text>
                  <Glyph d="play" size={12} />
                  <Glyph d="play" size={12} />
                </View>
              </View>
            </If>
            <If when={level()}>
              {(l) => (
                <View
                  class="pointer-events-none absolute inset-y-0 items-center justify-center"
                  style={l().kind === "bright" ? { left: padL() + 24 } : { right: padR() + 24 }}
                >
                  <View class="items-center gap-2 rounded-full bg-black/55 px-2 py-3">
                    <View
                      class="justify-end overflow-hidden rounded-full bg-white/25"
                      style={{ width: 6, height: 120 }}
                    >
                      <View class="rounded-full bg-white" style={{ height: 120 * l().v }} />
                    </View>
                    <Glyph d={l().kind === "bright" ? "sun" : "vol"} size={18} />
                  </View>
                </View>
              )}
            </If>
            <If when={hint()}>
              {(h) => (
                <View
                  class="pointer-events-none absolute inset-x-0 items-center"
                  style={{ top: padT() + 52 }}
                >
                  <View class="rounded-full bg-black/70 px-4 py-2">
                    <Text class="text-sm font-semibold text-white">{h()}</Text>
                  </View>
                </View>
              )}
            </If>

            {/* Phase indicators. */}
            {/* Stalled with the chrome hidden: the same spinner, where the
                play button sits (screen centre, same size). */}
            <If when={!mediaFullscreen() && busy() && !chrome() && !locked()}>
              <View class="pointer-events-none absolute inset-0 items-center justify-center">
                <Spinner size={48} />
              </View>
            </If>
          </View>
        </View>
        {/* Chrome: a SIBLING above the gesture and tap layers, never
            inside them, so no ancestor of a control has a pan gate, a
            pinch, a press or touch tracking: the seek bar and every
            button get their touches alone. Containers are box-none, so
            empty areas fall through to the tap layer underneath. */}
        <View class="absolute inset-0" style={{ pointerEvents: "box-none" }}>
        <If when={!mediaFullscreen() && phase() === "failed"}>
          <FailedPanel />
        </If>
        {/* Moving on from a failing source by itself: one line under the
            spinner, nothing to press. */}
        <If when={!mediaFullscreen() && phase() !== "failed" && switchNotice()}>
          <View
            class="pointer-events-none absolute inset-x-0 items-center px-8"
            style={{ top: "50%", marginTop: 48 }}
          >
            <Text class="text-center text-sm text-zinc-300" style={{ numberOfLines: 2 }}>
              {switchNotice()}
            </Text>
          </View>
        </If>

        <If when={showTop()}>{topScrim(110)}</If>
        <If when={chrome()}>{bottomScrim()}</If>
        {/* A popup is open: this full-screen catcher sits over the tap
            and gesture layers (no toggle, seek, 2× or brightness/volume
            slide can start) and under the rows, so the buttons and the
            seek bar still work; a tap on it closes the popup. */}
        <If when={popup()}>
          <View
            class="absolute inset-0"
            style={{ backgroundColor: "rgba(0,0,0,0.01)" }}
            accessibilityLabel="Close"
            onPress={() => {
              closePlayerPopups();
              pokeControls();
            }}
          />
        </If>
        {/* Centre transport before the bars: document order is
            z-order, and its box spans the screen (box-none). Under the
            panel it would only peek out at its left edge: hidden. */}
        <If when={chrome() && popup() !== "subs"}>
          <View
            class="absolute inset-0 flex-row items-center justify-center gap-12"
            style={{ pointerEvents: "box-none" }}
          >
            <View
              role="button"
              accessibilityLabel={`Back ${seekStep()} seconds`}
              disabled={busy()}
              onPress={() => {
                pokeControls();
                skipBy(-1);
              }}
              class={`h-16 w-16 items-center justify-center active:opacity-50 ${busy() ? "opacity-40" : ""}`}
            >
              <SeekIcon dir={-1} size={40} />
            </View>
            <View
              role="button"
              accessibilityLabel={mediaPaused() ? "Play" : "Pause"}
              onPress={() => {
                pokeControls();
                togglePlay();
              }}
              class="h-20 w-20 items-center justify-center active:opacity-50"
            >
              <If when={busy()}>
                <Spinner size={48} />
              </If>
              <If when={!busy()}>
                <Glyph d={mediaPaused() ? "play" : "pause"} size={52} />
              </If>
            </View>
            <View
              role="button"
              accessibilityLabel={`Forward ${seekStep()} seconds`}
              disabled={busy()}
              onPress={() => {
                pokeControls();
                skipBy(1);
              }}
              class={`h-16 w-16 items-center justify-center active:opacity-50 ${busy() ? "opacity-40" : ""}`}
            >
              <SeekIcon dir={1} size={40} />
            </View>
          </View>
        </If>
        <If when={showTop()}>{topRow(false)}</If>
        <If when={chrome()}>{bottomBar()}</If>

        {/* Up next / the end of the episode / Still watching? — above the
            controls at the right, with the chrome hidden too. */}
        <If when={upNextCard() && !locked() && !mediaFullscreen() && !popup()}>
          <View
            class="absolute"
            style={{ right: padR(), bottom: chrome() ? barH() + 8 : padB() + 16 }}
          >
            <UpNextCard />
          </View>
        </If>
        {/* Skip Intro / Credits: shows with the chrome hidden too. */}
        <If when={skipPill() && canPlay() && !locked() && !mediaFullscreen() && !popup()}>
          <View
            class="absolute"
            style={{
              right: padR(),
              // Just above the seek row.
              bottom: chrome() ? barH() + 8 : padB() + 16,
            }}
          >
            <View
              role="button"
              onPress={() => {
                skipPillPress();
                if (controlsVisible()) armHide();
              }}
              class="min-h-11 items-center justify-center rounded-md border border-white/70 bg-black/55 px-5 active:opacity-70"
            >
              <Text class="text-sm font-bold text-white">{skipPill()?.label ?? ""}</Text>
            </View>
          </View>
        </If>

        {/* The popups, over everything in the chrome. */}
        <If when={popup() === "subs"}>
          <View
            class="absolute"
            style={{
              right: padR(),
              width: panelW(),
              top: padT() + 52,
              bottom: barH() + 4,
            }}
          >
            <AudioSubsPanel />
          </View>
        </If>
        <If when={popup() === "speed"}>
          <View
            class="absolute"
            style={{ left: padL() - 8, bottom: padB() + 48 }}
          >
            <SpeedList />
          </View>
        </If>
        </View>
      </If>
      {/* Locked: one small lock, in every phase; holding it ~1 s
          unlocks (blind and failed also clear the lock). */}
      <If when={locked() && !mediaFullscreen()}>
        <View class="absolute" style={{ left: padL(), top: padT() + 4 }}>
          <View
            role="button"
            accessibilityLabel="Unlock controls (hold)"
            delayLongPress={1000}
            onPress={() => flashHint("Locked — hold to unlock")}
            onPressDown={() => flashHint("Keep holding to unlock", 1200)}
            onLongPress={() => {
              locked.set(false);
              flashHint("Unlocked", 800);
              pokeControls();
            }}
            class="h-11 w-11 items-center justify-center rounded-full bg-black/45 active:bg-black/70"
          >
            <Glyph d="lock" size={24} />
          </View>
        </View>
      </If>
    </>
  );
}

// --- Desktop controls -------------------------------------------------------------------
//
// One control set on the desktop, the in-page "Cinema" overlay's (the
// bridge's CIN_CSS / cinHtml in lib/player.ts), drawn by the app:
//   - over the app's own player (native backend), from the first frame of
//     the loading state on;
//   - inert (no input), as the placeholder of a web play until the page's
//     own overlay is up (Player.tsx PagePlaceholder) — the same component,
//     so the hand-over to the page changes nothing on screen.
// Metrics are the overlay's: the title at left 32 / bottom 120 (until the
// first picture), the centre cluster (56 · 80 · 56 circles, 28 apart, 34 pt
// icons, a 40 pt spinner), the bottom block (padding 44 16 12 on a
// gradient: the 22 pt seek line with its 4 pt track — 6 pt on hover —, red
// fill, 13 pt white thumb and time bubble, the time left 56 wide; 6 below,
// a row of 36 pt buttons 4 apart: speed, CC, episodes, next, sources,
// mute, 80 pt volume, PiP, full screen). Loading dims ±10, speed, CC, mute,
// volume, PiP and full screen; episodes, next and sources stay bright.
//
// Circles: GPUI draws no backdrop blur (nsh-platform-gpui decor.rs: "GPUI
// has no offscreen passes: blur(), backdropFilter and mixBlendMode are not
// drawn"), and the video is a surface under everything, so the overlay's
// glass is replaced here AND in the page (`.c`) by one look that reads on
// white and black frames alike: a dark translucent fill, a hairline light
// border and a soft shadow (GLASS below; the page's CSS uses the same
// values).
//
// The seek and volume lines handle the pointer themselves (press → the
// fraction of the line's width → seek; drag scrubs with the time bubble;
// release commits), as the overlay's #seek does.

/** The circles' look (page `.c`): fill, hover fill, border, shadow. */
export const GLASS = {
  fill: "rgba(20,20,23,0.55)",
  hover: "rgba(44,44,50,0.72)",
  border: "rgba(255,255,255,0.18)",
  shadow: "0 2px 10px rgba(0,0,0,0.35)",
} as const;

function RoundBtn(props: {
  label: string;
  onPress: () => void;
  d?: IconName;
  text?: string;
  size?: number;
  dim?: boolean;
  keepPopup?: boolean;
  on?: boolean;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={() => {
        if (props.dim) return;
        if (!props.keepPopup) closePlayerPopups();
        pokeControls();
        props.onPress();
      }}
      class={`items-center justify-center rounded-full ${props.dim ? "" : "cursor-pointer hover:bg-white/20"} ${
        props.on ? "bg-white/20" : ""
      }`}
      style={{ minWidth: 36, minHeight: 36, paddingLeft: 6, paddingRight: 6, opacity: props.dim ? 0.35 : 1 }}
    >
      <If when={props.d}>{(d) => <Glyph d={d()} size={props.size ?? 22} />}</If>
      <If when={props.text}>
        {(t) => (
          <Text class="text-white" style={{ fontSize: 13, fontWeight: "700", textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>
            {t()}
          </Text>
        )}
      </If>
    </View>
  );
}

/** A centre-cluster circle (page `.b.c.m` / `.b.c.l`). */
function GlassBtn(props: { label: string; size: number; dim?: boolean; onPress?: () => void; children: unknown }) {
  const hover = signal(false);
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={() => {
        if (props.dim || !props.onPress) return;
        pokeControls();
        props.onPress();
      }}
      onMouseEnter={() => hover.set(true)}
      onMouseLeave={() => hover.set(false)}
      class={`items-center justify-center rounded-full ${props.onPress && !props.dim ? "cursor-pointer" : ""}`}
      style={{
        width: props.size,
        height: props.size,
        opacity: props.dim ? 0.35 : 1,
        backgroundColor: hover() && props.onPress && !props.dim ? GLASS.hover : GLASS.fill,
        borderWidth: 1,
        borderColor: GLASS.border,
        boxShadow: GLASS.shadow,
      }}
    >
      {props.children as never}
    </View>
  );
}

/** The ± step icon of the cluster: the turning arrow, the step (seekStep()) 10 pt bold 3 below centre. */
function TenIcon(props: { dir: number }) {
  return (
    <View class="items-center justify-center" style={{ width: 34, height: 34 }}>
      <CanvasArrow dir={props.dir} size={34} />
      <Text class="text-white" style={{ fontSize: 10, fontWeight: "700", marginTop: 3 }} allowFontScaling={false}>
        {String(seekStep())}
      </Text>
    </View>
  );
}

/** A line the pointer sets (page #seek / #vol): press → value, drag →
 * preview, release → commit. `frac` 0..1 is what it shows; null width
 * until laid out. Pure maths in `lineFraction`. */
export function lineFraction(x: number, width: number): number {
  if (!(width > 0) || !isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x / width));
}

function PointerLine(props: {
  label: string;
  width?: number;
  enabled: () => boolean;
  frac: () => number;
  trackH: number;
  hoverTrackH?: number;
  thumb: number;
  fill: string;
  track: string;
  /** Preview while dragging (null = drag ended). */
  onPreview?: (f: number | null) => void;
  onCommit: (f: number) => void;
  /** Time bubble text for a fraction (seek line only). */
  bubble?: (f: number) => string;
}) {
  const w = signal(0);
  const hoverX = signal<number | null>(null);
  const dragF = signal<number | null>(null);
  let dragging = false;
  const shown = computed(() => dragF() ?? props.frac());
  const bubbleAt = computed(() => {
    if (!props.bubble || !props.enabled()) return null;
    const f = dragF() ?? (hoverX() !== null ? lineFraction(hoverX()!, w()) : null);
    return f;
  });
  let pressHeld = false;
  const begin = (x: number) => {
    if (!props.enabled()) return;
    dragging = true;
    pressHeld = true;
    const f = lineFraction(x, untracked(w));
    dragF.set(f);
    props.onPreview?.(f);
  };
  const move = (x: number) => {
    if (!dragging) return;
    const f = lineFraction(x, untracked(w));
    dragF.set(f);
    props.onPreview?.(f);
  };
  const end = (x?: number) => {
    if (!dragging) return;
    dragging = false;
    const f = x === undefined ? (untracked(dragF) ?? 0) : lineFraction(x, untracked(w));
    dragF.set(null);
    props.onPreview?.(null);
    props.onCommit(f);
  };
  const th = computed(() => (props.hoverTrackH && (hoverX() !== null || dragF() !== null) ? props.hoverTrackH : props.trackH));
  return (
    <View
      accessibilityLabel={props.label}
      role="adjustable"
      class={props.enabled() ? "cursor-pointer" : ""}
      style={{ height: 22, justifyContent: "center", ...(props.width ? { width: props.width } : { flex: 1 }), opacity: props.enabled() ? 1 : 1 }}
      onLayout={(e: { bounds: { size: { width: number } } }) => w.set(e.bounds.size.width)}
      // NSH 0.4.0 has onPressDown / onPressUp (no onPressIn / onPressOut).
      // A drag goes on while moves come with the button held; a move
      // without it, the press's end or its click commits.
      onPressDown={(e: { position?: { x: number } }) => begin(e?.position?.x ?? 0)}
      onPressUp={(e: { position?: { x: number } }) => end(e?.position?.x)}
      onPress={(e: { position?: { x: number } }) => end(e?.position?.x)}
      onMouseMove={(e: { position?: { x: number }; pressedButton?: unknown }) => {
        const x = e?.position?.x ?? 0;
        hoverX.set(x);
        if (e?.pressedButton) {
          // Held past an early press-up (a long press): still scrubbing.
          if (!dragging && untracked(dragF) === null && pressHeld) begin(x);
          move(x);
        } else if (dragging) end(x);
        if (!e?.pressedButton) pressHeld = false;
      }}
      onMouseLeave={() => hoverX.set(null)}
    >
      <View
        class="pointer-events-none rounded-full"
        style={{ height: th(), width: "100%", backgroundColor: props.track }}
      >
        <View class="absolute left-0 top-0 bottom-0 rounded-full" style={{ width: w() * shown(), backgroundColor: props.fill }} />
      </View>
      <View
        class="pointer-events-none absolute rounded-full bg-white"
        style={{ width: props.thumb, height: props.thumb, left: w() * shown() - props.thumb / 2, top: 11 - props.thumb / 2 }}
      />
      <If when={bubbleAt() !== null && props.bubble}>
        <View class="pointer-events-none absolute items-center" style={{ bottom: 24, width: 80, left: w() * (bubbleAt() ?? 0) - 40 }}>
          <View style={{ backgroundColor: "rgba(0,0,0,0.85)", borderRadius: 6, paddingLeft: 7, paddingRight: 7, paddingTop: 3, paddingBottom: 3 }}>
            <Text class="text-white" style={{ fontSize: 12, fontWeight: "600" }}>
              {props.bubble?.(bubbleAt() ?? 0) ?? ""}
            </Text>
          </View>
        </View>
      </If>
    </View>
  );
}

let lastPoke = 0;
/** Mouse movement over the picture: at most a poke every 250 ms. */
function pokeFromMouse() {
  const now = Date.now();
  if (controlsVisible() && now - lastPoke < 250) return;
  lastPoke = now;
  pokeControls();
}

/** The desktop controls. `inert`: the placeholder of a web play (loading
 * look, no input, `spinning` decides the play button's spinner). */
export function DesktopControls(props: { inert?: boolean; spinning?: boolean }) {
  const inert = !!props.inert;
  const phase = computed(() => playerPhase());
  const loading = computed(() => inert || phase() === "loading");
  const busy = computed(() => (inert ? !!props.spinning : loading() || phase() === "stalled"));
  const canPlay = computed(() => !inert && interactive());
  const shown = computed(() => inert || controlsVisible() || loading() || playerPopup() !== null);
  const volDrag = signal<number | null>(null);
  // The title until the video's first picture (page #bd / #bdt).
  let framedUrl = "";
  const titleOn = computed(() => {
    if (inert) return true;
    const ph = phase();
    const u = playerUrl() ?? "";
    if (u && (ph === "playing" || ph === "paused" || ph === "stalled")) framedUrl = u;
    return ph === "loading" && (!u || u !== framedUrl);
  });
  const sub = computed(() => {
    const r = playerRoute();
    if (!r) return "";
    const ep = r.episode ?? 1;
    if (r.type === "tv") {
      const name = episodes().find((x) => x.n === ep)?.name;
      return `S${r.season ?? 1} E${ep}${name ? ` · ${name}` : ""}`;
    }
    return r.type === "anime" ? `Episode ${ep}` : "";
  });

  if (!inert) {
    // Captions rise above the bottom block while it shows.
    effect(() => {
      const lift = shown();
      untracked(() => setCaptionLift(lift));
    });
    cleanup(() => setCaptionLift(false));
    // Paused keeps the controls up; playing lets the 3 s timer run.
    let prevPhase = "";
    effect(() => {
      const ph = playerPhase();
      const vis = controlsVisible();
      playerPopup();
      if (ph === "paused" && prevPhase !== "paused") controlsVisible.set(true);
      prevPhase = ph;
      if (!vis) return;
      if (canAutoHide()) {
        if (!hideTimer) armHide();
      } else {
        clearHide();
      }
    });
  }

  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => {
    if (clickTimer) clearTimeout(clickTimer);
  });
  const onPicture = (e: { clickCount?: number } | undefined) => {
    if (closePlayerPopups()) return;
    if ((e?.clickCount ?? 1) >= 2) {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = undefined;
      toggleFullscreen();
      return;
    }
    if (!interactive()) {
      pokeControls();
      return;
    }
    if (clickTimer) clearTimeout(clickTimer);
    // A double click must not also pause.
    clickTimer = setTimeout(() => {
      clickTimer = undefined;
      togglePlay();
      pokeControls();
    }, 220);
  };
  const dur = computed(() => duration());
  const seekFrac = computed(() => (dur() > 0 ? Math.max(0, Math.min(1, position() / dur())) : 0));

  return (
    <View
      class="absolute inset-0"
      style={{ pointerEvents: inert ? "none" : "auto" }}
      onMouseMove={inert ? undefined : pokeFromMouse}
      onMouseLeave={inert ? undefined : () => {
        if (canAutoHide()) controlsVisible.set(false);
      }}
    >
      {/* The picture: click / double click; the pointer hides with the controls. */}
      <If when={!inert}>
        <View
          class={`absolute inset-0 ${shown() ? "" : "cursor-none"}`}
          accessibilityLabel="Video"
          onPress={onPicture}
        />
      </If>
      {/* The title until the first picture (page #bdt: 28/800, 15/500 #d4d4d8). */}
      <If when={titleOn()}>
        <View class="pointer-events-none absolute flex-col" style={{ left: 32, right: 32, bottom: 120 }}>
          <Text class="text-white" style={{ fontSize: 28, fontWeight: "800", numberOfLines: 2, textShadow: "0 1px 6px rgba(0,0,0,0.8)" }}>
            {titleLine()}
          </Text>
          <If when={sub()}>
            <Text style={{ fontSize: 15, fontWeight: "500", color: "#d4d4d8", marginTop: 4, numberOfLines: 1, textShadow: "0 1px 6px rgba(0,0,0,0.8)" }}>
              {sub()}
            </Text>
          </If>
        </View>
      </If>
      {/* Everything that hides (page #w; opacity .25 s). */}
      <View
        class="absolute inset-0"
        style={{
          opacity: shown() ? 1 : 0,
          pointerEvents: inert || !shown() ? "none" : "box-none",
          transitionProperty: "opacity",
          transitionDuration: 250,
          transitionTimingFunction: "ease",
        }}
      >
        {/* Centre cluster (#mid). Hidden under the subtitles panel. */}
        <If when={playerPopup() !== "subs" || inert}>
          <View class="absolute inset-0 flex-row items-center justify-center" style={{ gap: 28, pointerEvents: "box-none" }}>
            <GlassBtn label={`Back ${seekStep()} seconds`} size={56} dim={busy() || !canPlay()} onPress={inert ? undefined : () => skipBy(-1)}>
              <TenIcon dir={-1} />
            </GlassBtn>
            <GlassBtn label={mediaPaused() ? "Play" : "Pause"} size={80} onPress={inert ? undefined : togglePlay}>
              <If when={busy()} else={<Glyph d={mediaPaused() || inert ? "play" : "pause"} size={34} />}>
                <Spinner size={40} />
              </If>
            </GlassBtn>
            <GlassBtn label={`Forward ${seekStep()} seconds`} size={56} dim={busy() || !canPlay()} onPress={inert ? undefined : () => skipBy(1)}>
              <TenIcon dir={1} />
            </GlassBtn>
          </View>
        </If>
        {/* Bottom block (#bot). */}
        <View
          class="absolute bottom-0 left-0 right-0 flex-col bg-linear-to-t from-black/80 to-black/0"
          style={{ paddingTop: 44, paddingLeft: 16, paddingRight: 16, paddingBottom: 12, pointerEvents: "box-none" }}
        >
          <View class="flex-row items-center" style={{ gap: 10 }}>
            <PointerLine
              label="Seek"
              enabled={() => canPlay() && dur() > 0}
              frac={seekFrac}
              trackH={4}
              hoverTrackH={6}
              thumb={13}
              fill="#e50914"
              track="rgba(255,255,255,0.28)"
              onPreview={(f) => (f === null ? armHide() : clearHide())}
              onCommit={(f) => {
                if (dur() > 0) seekTo(f * dur());
                pokeControls();
              }}
              bubble={(f) => fmtTime(f * dur())}
            />
            <Text style={{ fontSize: 12, fontWeight: "500", color: "#e4e4e7", minWidth: 56, textAlign: "right", textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>
              {dur() > 0 && !inert ? `−${fmtTime(Math.max(0, dur() - position()))}` : ""}
            </Text>
          </View>
          <View class="flex-row items-center" style={{ gap: 4, marginTop: 6, pointerEvents: "box-none" }}>
            <View class="flex-1" style={{ pointerEvents: "none" }} />
            <RoundBtn label="Playback speed" text={rateLabel(inert ? 1 : mediaRate())} dim={!canPlay()} on={playerPopup() === "speed"} keepPopup onPress={toggleSpeedList} />
            <RoundBtn
              label="Audio and subtitles"
              d={!inert && currentSubtitle() !== null ? "ccOn" : "ccOff"}
              size={24}
              dim={!canPlay()}
              on={playerPopup() === "subs"}
              keepPopup
              onPress={toggleSubsPanel}
            />
            <If when={isSeries()}>
              <RoundBtn label="Episodes" d="episodes" dim={inert} onPress={openEpisodes} />
            </If>
            <If when={hasNext()}>
              <RoundBtn label="Next episode" d="nextEp" dim={inert} onPress={() => void nextEpisode()} />
            </If>
            <RoundBtn label="Sources" d="sources" dim={inert} onPress={openSources} />
            <RoundBtn
              label={mediaMuted() ? "Unmute" : "Mute"}
              d={!inert && (mediaMuted() || mediaVolume() <= 0) ? "mute" : "vol"}
              dim={!canPlay()}
              onPress={toggleMute}
            />
            <View style={{ marginRight: 6, opacity: canPlay() ? 1 : 0.35 }}>
              <PointerLine
                label="Volume"
                width={80}
                enabled={() => canPlay()}
                frac={() => volDrag() ?? (inert ? 1 : mediaMuted() ? 0 : mediaVolume())}
                trackH={4}
                thumb={12}
                fill="#ffffff"
                track="rgba(255,255,255,0.3)"
                onPreview={(f) => {
                  volDrag.set(f);
                  if (f === null) return;
                  if (mediaMuted() && f > 0) toggleMute();
                  setVolumeTo(f);
                }}
                onCommit={(f) => setVolumeTo(f)}
              />
            </View>
            <If when={(inert && props.spinning !== undefined) || pipSupported()}>
              <RoundBtn label="Picture in picture" d="pip" dim={!canPlay()} on={!inert && nativePipActive()} onPress={enterPip} />
            </If>
            <RoundBtn label="Full screen" d="fullscreen" dim={inert} onPress={toggleFullscreen} />
          </View>
        </View>
        {/* Popups, above the bottom block (page #av right 16 bottom 96 420×300; #spl right 150). */}
        <If when={!inert && playerPopup() === "subs"}>
          <View class="absolute" style={{ right: 16, bottom: 96, width: 460, maxWidth: "90%", height: 300 }}>
            <AudioSubsPanel desktop />
          </View>
        </If>
        <If when={!inert && playerPopup() === "speed"}>
          <View class="absolute" style={{ right: 150, bottom: 96 }}>
            <SpeedList desktop />
          </View>
        </If>
      </View>
      {/* Moving on from a failing source: one line under the spinner. */}
      <If when={!inert && loading() && switchNotice()}>
        <View class="pointer-events-none absolute inset-x-0 items-center px-8" style={{ top: "50%", marginTop: 56 }}>
          <Text class="text-center text-sm text-zinc-300" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
            {switchNotice()}
          </Text>
        </View>
      </If>
      {/* Up next (page #un: right 20, bottom 112, 300 wide). */}
      <If when={!inert && upNextCard() && playerPopup() === null}>
        <View class="absolute" style={{ right: 20, bottom: 112 }}>
          <UpNextCard desktop />
        </View>
      </If>
      {/* Skip Intro / Credits (page #skip: right 20, bottom 112, pill). */}
      <If when={!inert && skipPill() && canPlay() && playerPopup() === null}>
        <View class="absolute" style={{ right: 20, bottom: 112 }}>
          <View
            role="button"
            onPress={() => {
              skipPillPress();
              if (controlsVisible()) armHide();
            }}
            class="cursor-pointer rounded-full hover:bg-zinc-700"
            style={{
              paddingLeft: 18,
              paddingRight: 18,
              paddingTop: 10,
              paddingBottom: 10,
              backgroundColor: "rgba(24,24,27,0.85)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.35)",
            }}
          >
            <Text class="text-white" style={{ fontSize: 14, fontWeight: "700" }}>
              {skipPill()?.label ?? ""}
            </Text>
          </View>
        </View>
      </If>
    </View>
  );
}
