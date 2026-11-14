// The native backend: the app's own player, the `rustflix.video` component
// (contract: …/native/contract.md §1; AVPlayer on macOS and iOS, Media3 on
// Android), playing what a PlaySession hands it (a local stream-proxy URL,
// or a finished download's local URL).
//
// One player at a time: this module holds its props as signals; the
// player screen renders <NativeVideo> bound to `nativeView` and forwards
// its events here. Component events become MediaReports in the bridge's
// shape (lib/playback/backend.ts), so lib/player.ts runs the same phase,
// resume and saving logic as for a page.
//
// Desktop delivers props and commands to a component only with a frame
// the window draws: once the component's `ready` gave a numeric handle,
// every change also goes through `sys.nativeVideo` at once (contract §1.4)
// and the props stay in sync.
//
// No imports from the player (lib/player.ts imports this module).

import { host, nativeComponent, signal, untracked } from "nsh";
import type { CaptionSink, MediaReport, PlaybackBackend } from "./backend";
import { nativeInfo } from "./caps";

export type NativeTrack = { id: string; label: string; lang: string | null; default: boolean; selected: boolean };

export interface NativeProps {
  src?: string | null;
  startAt?: number;
  paused?: boolean;
  muted?: boolean;
  volume?: number;
  rate?: number;
  fit?: "contain" | "cover";
  frame?: { x?: number; y?: number; width: number; height: number };
  maxResolution?: { width: number; height: number } | null;
  /** iOS (additive): the lock screen / Control Centre's info. */
  nowPlaying?: { title: string; subtitle?: string; artwork?: string } | null;
}

export interface NativeEvents {
  ready: { handle: number | null; fullscreen?: boolean };
  load: { duration: number | null; width: number; height: number; audioTracks?: NativeTrack[]; subtitleTracks?: NativeTrack[]; ms: number };
  frame: { ms: number; width: number; height: number };
  tracks: { audioTracks?: NativeTrack[]; subtitleTracks?: NativeTrack[] };
  progress: { currentTime: number | null; buffered?: number | null; playable?: number | null };
  buffer: { stalled: boolean; reason: string | null };
  seeked: { target: number; time: number | null; finished: boolean; ms: number };
  /** iOS adds `paused` and, when the platform changed play state itself,
   * `by` ("remote" lock screen / Control Centre, "route" headphones
   * unplugged, "interruption" a call). */
  rate: { rate: number; paused?: boolean; by?: string };
  pip: { active: boolean; possible: boolean };
  end: Record<string, never>;
  error: { message: string; code?: string; fatal?: boolean };
  /** v1.3 (macOS): the selected embedded track's cues from `time` on —
   * plain text, one entry per cue; `[]` clears. Drawn by Captions.tsx. */
  cues: { time: number | null; lines: string[] };
}

/** The component, with every prop and event of the contract (v1). */
export const NativeVideo = nativeComponent<NativeProps, NativeEvents>("rustflix.video", {
  props: ["src", "startAt", "paused", "muted", "volume", "rate", "fit", "frame", "maxResolution", "nowPlaying"],
  events: ["ready", "load", "frame", "tracks", "progress", "buffer", "seeked", "rate", "pip", "end", "error", "cues"],
});

type Ref = { command(name: string, args?: unknown): void } | null;

// --- The props (what <NativeVideo> renders with) -------------------------------------

const src = signal<string | null>(null);
const startAt = signal(0);
const paused = signal(false);
const muted = signal(false);
const volume = signal(1);
const rate = signal(1);
const fit = signal<"contain" | "cover">("contain");

let ref: Ref = null;
let handle: number | null = null;

// --- What the player reported ----------------------------------------------------------

let gen = 0;
let doc = "n0";
let loaded = false;
let framed = false;
let dur: number | null = null;
let pos = 0;
let stalled = false;
let ended = false;
let pipPossible = false;
let pipActive = false;
/** The component said it has its own full screen (`ready {fullscreen}`). */
const fsCapable = signal(false);
/** Full screen as the app asked for it (iOS: landscape). */
export const nativeFullscreenOn = signal(false);
let audio: NativeTrack[] = [];
let subs: NativeTrack[] = [];
/** Our own last play: a rate-0 report right after it is the start, not a pause. */
let playAt = 0;
let heldRate: number | null = null;

export interface NativeListener {
  report(r: MediaReport): void;
  /** `error {fatal:true}`: nothing plays until a new src. */
  fatal(message: string, code: string): void;
  /** The first picture of the current src. */
  frame?(ms: number): void;
}
let listener: NativeListener | null = null;

/** lib/player.ts hears the player through this. */
export function setNativeListener(l: NativeListener | null): void {
  listener = l;
}

function control(data: Record<string, unknown>): boolean {
  if (typeof handle !== "number") return false;
  try {
    void host.call("sys.nativeVideo", { handle, ...data } as never).catch(() => {});
  } catch {}
  return true;
}

function command(name: string, args: unknown, viaHandle: Record<string, unknown>) {
  if (control(viaHandle)) return;
  try {
    ref?.command(name, args);
  } catch {}
}

function report(ev: string) {
  const l = listener;
  if (!l) return;
  const r: MediaReport = {
    t: pos,
    p: untracked(paused) || ended,
    r: heldRate ?? untracked(rate),
    m: untracked(muted),
    vo: untracked(volume),
    rs: loaded || framed ? 4 : 0,
    pip: pipPossible,
    vid: `${doc}:v`,
    ev,
    tracks: subs.map((t, i) => ({
      i,
      label: t.label || t.lang || `Track ${i + 1}`,
      raw: t.label || t.lang || "",
      lang: t.lang ?? "",
      kind: "subtitles",
      mode: t.selected ? "showing" : "disabled",
    })),
    aud: audio.map((a, i) => ({ i, label: a.label ?? "", lang: a.lang ?? "", on: !!a.selected })),
  };
  if (typeof dur === "number" && dur > 0) r.d = dur;
  try {
    l.report(r);
  } catch {}
}

// --- Event handlers (bound by the player screen) ----------------------------------------

export const nativeHandlers = {
  onReady(d: NativeEvents["ready"]) {
    handle = typeof d?.handle === "number" ? d.handle : null;
    fsCapable.set(d?.fullscreen === true);
    // The props may have changed before the handle existed.
    if (handle !== null) {
      control({
        ...(lastFrame ? { frame: lastFrame } : {}),
        ...(lastNowPlaying ? { nowPlaying: lastNowPlaying } : {}),
        src: untracked(src),
        startAt: untracked(startAt),
        paused: untracked(paused),
        muted: untracked(muted),
        volume: untracked(volume),
        rate: heldRate ?? untracked(rate),
        fit: untracked(fit),
      });
    }
  },
  onLoad(d: NativeEvents["load"]) {
    loaded = true;
    if (typeof d?.duration === "number" && d.duration > 0) dur = d.duration;
    if (Array.isArray(d?.audioTracks)) audio = d.audioTracks;
    if (Array.isArray(d?.subtitleTracks)) subs = d.subtitleTracks;
    report("canplay");
  },
  onFrame(d: NativeEvents["frame"]) {
    const first = !framed;
    framed = true;
    if (first) {
      try {
        listener?.frame?.(d?.ms ?? 0);
      } catch {}
      report(untracked(paused) ? "canplay" : "playing");
    }
  },
  onTracks(d: NativeEvents["tracks"]) {
    if (Array.isArray(d?.audioTracks)) audio = d.audioTracks;
    if (Array.isArray(d?.subtitleTracks)) subs = d.subtitleTracks;
    report("tracks");
  },
  onProgress(d: NativeEvents["progress"]) {
    if (typeof d?.currentTime === "number" && isFinite(d.currentTime)) {
      // Time moves on while the prop says paused: the platform resumed by
      // itself (Android PiP's play button) — follow it.
      if (untracked(paused) && !ended && d.currentTime > pos + 1 && Date.now() - pauseAt > 1500) paused.set(false);
      pos = d.currentTime;
    }
    report(stalled ? "waiting" : "timeupdate");
  },
  onBuffer(d: NativeEvents["buffer"]) {
    const was = stalled;
    stalled = !!d?.stalled;
    if (was !== stalled) report(stalled ? "waiting" : "playing");
  },
  onSeeked(d: NativeEvents["seeked"]) {
    if (typeof d?.time === "number" && isFinite(d.time)) pos = d.time;
    if (d?.finished !== false) report("seeked");
  },
  onRate(d: NativeEvents["rate"]) {
    const r = typeof d?.rate === "number" ? d.rate : 0;
    // The platform paused / resumed by itself: the prop follows, else a
    // later `paused={false}` would be the same value and never be sent.
    if (typeof d?.by === "string" && typeof d?.paused === "boolean") {
      if (untracked(paused) !== d.paused) paused.set(d.paused);
      if (!d.paused) playAt = Date.now();
      report(d.paused ? "pause" : "playing");
      return;
    }
    if (r > 0) {
      ended = false;
      if (untracked(paused)) paused.set(false);
      report("playing");
    } else if (!stalled && (loaded || framed) && !untracked(paused) && Date.now() - playAt > 1500) {
      // Paused by the platform (PiP window, lock screen, an interruption).
      paused.set(true);
      report("pause");
    }
  },
  onCues(d: NativeEvents["cues"]) {
    const lines = Array.isArray(d?.lines) ? d.lines.filter((l) => typeof l === "string" && l) : [];
    embeddedCues.set(lines.length ? lines : null);
  },
  onPip(d: NativeEvents["pip"]) {
    pipPossible = !!d?.possible;
    pipActive = !!d?.active;
    nativePipActive.set(pipActive);
    report("pip");
  },
  onEnd() {
    ended = true;
    report("ended");
  },
  onError(d: NativeEvents["error"]) {
    const msg = String(d?.message ?? "error");
    const code = String(d?.code ?? "");
    if (code === "fullscreen") {
      // The rotation was refused: the button shows the real state.
      nativeFullscreenOn.set(false);
      return;
    }
    if (d?.fatal === false || code === "track" || code === "pip") return;
    // Spike builds send no `fatal`: an error then means the item failed.
    try {
      listener?.fatal(msg, code);
    } catch {}
  },
};

/** The player screen's binding: current props and the ref / unmount. */
export const nativeView = {
  src,
  startAt,
  paused,
  muted,
  volume,
  rate,
  fit,
  setRef(r: unknown) {
    ref = (r as Ref) ?? null;
  },
  /** The component went away: no handle, no ref (a new one sends `ready`). */
  unmounted() {
    ref = null;
    handle = null;
    nativePipActive.set(false);
    embeddedCues.set(null);
    // The component leaves full screen as it goes (contract iOS notes).
    nativeFullscreenOn.set(false);
  },
};

// --- Driving it ---------------------------------------------------------------------------

/** The selected embedded track's current cue lines (macOS `cues`); null: none. */
export const embeddedCues = signal<string[] | null>(null);
/** Picture in picture is on (the component's `pip` events). */
export const nativePipActive = signal(false);

let lastFrame: { width: number; height: number } | null = null;
/** Desktop: the picture's size in points, through the handle at once (the
 * `frame` prop only arrives with a drawn frame) — the player caps decoding
 * to it from the start (contract v1.3). */
export function setNativeFrame(width: number, height: number): void {
  if (!(width > 0 && height > 0)) return;
  const w = Math.round(width), h = Math.round(height);
  if (lastFrame && lastFrame.width === w && lastFrame.height === h) return;
  lastFrame = { width: w, height: h };
  control({ frame: lastFrame });
}

let lastNowPlaying: { title: string; subtitle?: string; artwork?: string } | null = null;
/** Lock screen / Now Playing / media keys info (iOS, macOS), also through
 * the handle so it is current before a frame is drawn. */
export function setNativeNowPlaying(np: { title: string; subtitle?: string; artwork?: string }): void {
  const key = JSON.stringify(np);
  if (lastNowPlaying && JSON.stringify(lastNowPlaying) === key) return;
  lastNowPlaying = np;
  control({ nowPlaying: np });
}

/** Plays `url` from `at` seconds (a new item; `null` stops and releases). */
export function setNativeSource(url: string | null, at = 0): void {
  gen++;
  doc = `n${gen}`;
  loaded = false;
  framed = false;
  dur = null;
  pos = at > 0 ? at : 0;
  stalled = false;
  ended = false;
  pipPossible = false;
  pipActive = false;
  audio = [];
  subs = [];
  embeddedCues.set(null);
  startAt.set(at > 0 ? at : 0);
  src.set(url);
  if (url) playAt = Date.now();
  control({ src: url, startAt: at > 0 ? at : 0 });
}

/** The current src's doc id (reports carry `${doc}:v`). */
export function nativeDoc(): string {
  return doc;
}

/** Whether the component reported a numeric handle (desktop). */
export function nativeHandle(): number | null {
  return handle;
}

let pauseAt = 0;
function setPaused(p: boolean) {
  if (!p) playAt = Date.now();
  else pauseAt = Date.now();
  paused.set(p);
  control({ paused: p });
}

function trackId(list: NativeTrack[], i: number): string | null {
  return list[i]?.id ?? null;
}

const captions: CaptionSink = {
  off() {
    nativeCaptions.set(null);
    command("selectSubtitle", { id: null }, { selectSubtitle: null });
  },
  track(i) {
    // An embedded track and an online subtitle exclude each other.
    nativeCaptions.set(null);
    const id = trackId(subs, i);
    if (id !== null) command("selectSubtitle", { id }, { selectSubtitle: id });
  },
  cues(id, cues) {
    // External subtitles are drawn by the app (screens/Captions.tsx); an
    // embedded track the platform draws is turned off.
    if (subs.some((t) => t.selected)) command("selectSubtitle", { id: null }, { selectSubtitle: null });
    nativeCaptions.set({ id, cues });
  },
  config(c) {
    const cur = untracked(captionConfig);
    captionConfig.set({
      size: c.size ?? cur.size,
      offset: typeof c.offset === "number" ? c.offset : cur.offset,
      lift: typeof c.lift === "boolean" ? c.lift : cur.lift,
    });
  },
};

/** The external cues screens/Captions.tsx draws (null: none). */
export const nativeCaptions = signal<{ id: string; cues: { s: number; e: number; t: string }[] } | null>(null);
/** Caption size, timing offset (s) and lift (above the controls). */
export const captionConfig = signal<{ size: "s" | "m" | "l"; offset: number; lift: boolean }>({ size: "m", offset: 0, lift: false });

export const nativeBackend: PlaybackBackend = {
  kind: "native",
  play() {
    if (ended) {
      ended = false;
      command("seek", { time: 0 }, { seek: 0 });
    }
    setPaused(false);
    report("play");
  },
  pause() {
    setPaused(true);
    report("pause");
  },
  toggle() {
    if (untracked(paused) || ended) nativeBackend.play();
    else nativeBackend.pause();
  },
  seek(t) {
    const to = Math.max(0, dur ? Math.min(dur, t) : t);
    pos = to;
    ended = false;
    command("seek", { time: to }, { seek: to });
  },
  seekBy(s) {
    nativeBackend.seek(pos + s);
  },
  setRate(r) {
    rate.set(r);
    if (heldRate === null) control({ rate: r });
  },
  hold(on) {
    heldRate = on ? 2 : null;
    // The prop follows the effective rate (nativeRateProp); `rate` keeps
    // the chosen one.
    heldView.set(heldRate);
    control({ rate: heldRate ?? untracked(rate) });
  },
  setVolume(v) {
    const nv = Math.max(0, Math.min(1, v));
    volume.set(nv);
    if (nv > 0 && untracked(muted)) muted.set(false);
    control({ volume: nv, muted: untracked(muted) });
  },
  toggleMute() {
    const m = !untracked(muted);
    muted.set(m);
    control({ muted: m });
    report("volumechange");
  },
  selectAudio(i) {
    const id = trackId(audio, i);
    if (id !== null) command("selectAudio", { id }, { selectAudio: id });
  },
  fit(fill) {
    fit.set(fill ? "cover" : "contain");
    control({ fit: fill ? "cover" : "contain" });
  },
  pip() {
    if (pipActive) command("exitPip", {}, { pip: false });
    else command("enterPip", {}, { pip: true });
  },
  fullscreen(mode) {
    // Only where the component said it has its own (contract request);
    // desktop and Android go full screen by window (lib/player.ts).
    if (!nativeFullscreenCapable()) return;
    const on = mode === "toggle" ? !untracked(nativeFullscreenOn) : mode === "enter";
    nativeFullscreenOn.set(on);
    command(on ? "enterFullscreen" : "exitFullscreen", {}, { fullscreen: on });
  },
  sync() {
    report("sync");
  },
  captions,
  destroy() {
    // Leaving the player must not leave a PiP window playing.
    if (pipActive) command("exitPip", {}, { pip: false });
    pipActive = false;
    nativePipActive.set(false);
    setNativeSource(null);
    paused.set(false);
    heldRate = null;
    heldView.set(null);
    nativeCaptions.set(null);
    if (untracked(nativeFullscreenOn)) nativeBackend.fullscreen("exit");
  },
};

/** The rate the prop carries: a held 2× wins over the chosen rate. */
const heldView = signal<number | null>(null);
/** The `rate` prop for <NativeVideo>. */
export function nativeRateProp(): number {
  return heldView() ?? rate();
}

/** The component has its own full screen (iOS, when it says so). */
export function nativeFullscreenCapable(): boolean {
  return fsCapable() || nativeInfo().fullscreen === true;
}

/** Tests only: the module's player state. */
export function __nativeState() {
  return { src: untracked(src), startAt: untracked(startAt), paused: untracked(paused), muted: untracked(muted), volume: untracked(volume), rate: untracked(rate), fit: untracked(fit), held: heldRate, handle, doc, pos, dur, loaded };
}
