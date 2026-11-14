// The app's own video player (stage-0 spike): the native component
// `rustflix.video` (src/player, an AVPlayer painted by GPUI) playing the
// local streaming proxy's URLs (src/stream, `dl.stream.*`). Behind the
// Storage flag `rustflix.nativeplayer` = "1"; the shipping player
// (screens/Player.tsx) does not use it.
//
// Layout contract (src/player/component.rs): give the component an EMPTY
// box (width/height 0) at the picture's top-left and the picture's size in
// `frame`. NSH then puts no mouse-blocking hitbox over the picture, so
// controls drawn after it in the tree (above it) keep their clicks.
//
// NSH hands a component its props and commands only with a frame the
// window draws; an occluded window draws none. The component's `ready`
// event gives a handle, and `controlVideo(handle, …)` (`sys.nativeVideo`)
// sets src / paused / muted / volume / rate and seeks at once, frame or
// not. Using both is fine (the same src twice changes nothing).
//
// macOS only: elsewhere nothing is registered under the name and it
// renders an empty view.

import { host, nativeComponent, Storage } from "nsh";

export const NATIVE_PLAYER_FLAG = "rustflix.nativeplayer";

export interface NativeVideoProps {
  src?: string | null;
  paused?: boolean;
  muted?: boolean;
  volume?: number;
  rate?: number;
  /** Where the picture goes, in points from the component's own corner. */
  frame?: { x?: number; y?: number; width: number; height: number };
  /** Position applied once when a new `src` loads (resume / relink). */
  startAt?: number;
  fit?: "contain" | "cover";
  /** Upper bound for the variant / decoded size (pixels); null = the
   * platform's choice (desktop: the picture's size on screen). */
  maxResolution?: { width: number; height: number } | null;
  /** Now Playing / lock screen / media keys (macOS, iOS). */
  nowPlaying?: { title: string; subtitle?: string; artwork?: string } | null;
}

/** A track of `load` / `tracks` (contract §1.5): ids are stable per item. */
export interface Track {
  id: string;
  label: string;
  lang: string | null;
  default: boolean;
  selected: boolean;
}

export interface NativeVideoEvents {
  /** At once when the component is made: its handle for `controlVideo`. */
  ready: { handle: number | null };
  load: { duration: number | null; width: number; height: number; ms: number; audioTracks: Track[]; subtitleTracks: Track[] };
  tracks: { audioTracks: Track[]; subtitleTracks: Track[] };
  /** `by`: the player changed on its own ("remote": media keys / Control
   * Centre; iOS also "route" | "interruption") — set `paused` to match. */
  rate: { rate: number; paused?: boolean; by?: "remote" | "route" | "interruption" };
  /** The selected embedded subtitle track's text from `time` on (plain
   * text, line breaks kept; empty = nothing shown). macOS: draw it. */
  cues: { time: number | null; lines: string[] };
  pip: { active: boolean; possible: boolean };
  /** The first pixel buffer of the source. */
  frame: { ms: number; width: number; height: number };
  progress: { currentTime: number | null; buffered: number | null; playable: number | null; frames?: number };
  buffer: { stalled: boolean; reason: string | null };
  seeked: { target: number; time: number | null; finished: boolean; ms: number };
  end: Record<string, never>;
  error: { message: string; code: string; fatal: boolean };
}

export const NativeVideo = nativeComponent<NativeVideoProps, NativeVideoEvents>("rustflix.video", {
  props: ["src", "paused", "muted", "volume", "rate", "frame", "startAt", "fit", "maxResolution", "nowPlaying"],
  events: ["ready", "load", "frame", "progress", "buffer", "seeked", "end", "error", "tracks", "rate", "pip", "cues"],
});

/** What `ref` of a NativeVideo gets (`ref.command`). */
export interface NativeVideoRef {
  command(name: "seek", args: { time: number }): void;
  command(name: "selectAudio", args: { id: string }): void;
  command(name: "selectSubtitle", args: { id: string | null }): void;
  command(name: "enterPip" | "exitPip", args: Record<string, never>): void;
}

/** Sets a player's props / seeks by its `ready` handle, without waiting
 * for a frame of the window (`sys.nativeVideo`). */
export async function controlVideo(
  handle: number,
  data: {
    src?: string | null;
    startAt?: number;
    paused?: boolean;
    muted?: boolean;
    volume?: number;
    rate?: number;
    fit?: "contain" | "cover";
    maxResolution?: { width: number; height: number } | null;
    seek?: number;
    selectAudio?: string;
    selectSubtitle?: string | null;
    pip?: boolean;
    /** Desktop: the picture's size in points (sizes the decode cap before
     * the `frame` prop arrives with a drawn frame). */
    frame?: { width: number; height: number };
    nowPlaying?: { title: string; subtitle?: string; artwork?: string } | null;
  },
): Promise<boolean> {
  return !!(await call<{ ok: boolean }>("sys.nativeVideo", { handle, ...data }))?.ok;
}

/** Whether the native player flag is on. */
export async function nativePlayerEnabled(): Promise<boolean> {
  try {
    return (await Storage.getItem(NATIVE_PLAYER_FLAG)) === "1";
  } catch {
    return false;
  }
}

// --- The streaming proxy (src/stream) ---------------------------------------------

export interface StreamSession {
  sid: string;
  /** The local URL to play. */
  url: string;
}

export type StreamEvent =
  /** Re-resolve now and `updateStream` (the link expires in `inSec`). */
  | { sid: string; type: "expiring"; expiresAt: number; inSec: number }
  /** Upstream refused: requests are held ≤ 20 s — re-resolve and update. */
  | { sid: string; type: "expired"; status: number }
  | { sid: string; type: "updated"; generation: number }
  /** reason: "drm" (fatal) | "expired" | "relink" (rebuild the item at the
   * current time: same src again with `startAt`) | "upstream". */
  | { sid: string; type: "error"; reason: string; message: string; fatal: boolean }
  | { sid: string; type: "stats"; stats: Record<string, unknown> };

async function call<T>(name: string, data: unknown): Promise<T | null> {
  try {
    return (await host.call(name, data as never)) as T;
  } catch {
    return null;
  }
}

/** Opens a proxy session for a resolved stream (URL + the page's headers). */
export async function openStream(
  url: string,
  kind: "hls" | "file",
  headers: Record<string, string>,
  opts: { cookies?: string; key?: string } = {},
): Promise<StreamSession | { error: string }> {
  const r = await call<{ ok: boolean; sid?: string; url?: string; error?: string }>("dl.stream.open", { url, kind, headers, ...opts });
  if (!r?.ok || !r.sid || !r.url) return { error: r?.error ?? "dl.stream.open failed" };
  return { sid: r.sid, url: r.url };
}

/** A fresh link for the same stream (the local URLs stay). */
export async function updateStream(sid: string, url: string, headers: Record<string, string>, cookies?: string): Promise<boolean> {
  return !!(await call<{ ok: boolean }>("dl.stream.update", { sid, url, headers, ...(cookies ? { cookies } : {}) }))?.ok;
}

export async function closeStream(sid: string): Promise<void> {
  await call("dl.stream.close", { sid });
}

export async function streamStats(sid: string): Promise<Record<string, unknown> | null> {
  return await call<Record<string, unknown>>("dl.stream.stats", { sid });
}

/** Debug: the next `count` upstream answers are `status` (default 403). */
export async function forceUpstreamStatus(sid: string, status = 403, count = 1): Promise<boolean> {
  return !!(await call<{ ok: boolean }>("dl.stream.debug", { sid, status, count }))?.ok;
}

/** Listens to `dl.stream.event`; returns the function that stops. */
export function onStreamEvent(listener: (e: StreamEvent) => void): () => void {
  try {
    return host.on("dl.stream.event", (d) => {
      try {
        listener(d as StreamEvent);
      } catch {}
    });
  } catch {
    return () => {};
  }
}

// --- A fake of the component, for tests without a window -----------------------------

export type NativeVideoHandlers = { [K in keyof NativeVideoEvents as `on${Capitalize<K & string>}`]?: (d: NativeVideoEvents[K]) => void };

/** A scripted stand-in for `rustflix.video` (no window, no player): emits
 * the contract's events in its order and timing (ready at once; frame, then
 * load after `loadMs`; progress every 250 ms while playing; seeked + one
 * progress after a seek; end at `duration`). Drive it like the real one. */
export function fakeNativeVideo(
  handlers: NativeVideoHandlers,
  opts: { duration?: number | null; width?: number; height?: number; loadMs?: number; audioTracks?: Track[]; subtitleTracks?: Track[]; failWith?: string } = {},
) {
  const duration = opts.duration === undefined ? 600 : opts.duration;
  let src: string | null = null;
  let paused = false;
  let rate = 1;
  let time = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  const tracks = () => ({ audioTracks: opts.audioTracks ?? [], subtitleTracks: opts.subtitleTracks ?? [] });
  const progress = () => handlers.onProgress?.({ currentTime: time, buffered: duration === null ? null : Math.min(duration, time + 30), playable: duration === null ? null : Math.min(duration, time + 60) });
  const stop = () => {
    if (timer) clearInterval(timer);
    if (loadTimer) clearTimeout(loadTimer);
    timer = loadTimer = null;
  };
  const run = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (paused || !src) return;
      time += 0.25 * rate;
      if (duration !== null && time >= duration) {
        time = duration;
        progress();
        handlers.onEnd?.({} as Record<string, never>);
        stop();
        return;
      }
      progress();
    }, 250);
  };
  handlers.onReady?.({ handle: null });
  return {
    setSrc(next: string | null, startAt = 0) {
      if (next === src) return;
      stop();
      src = next;
      time = startAt;
      if (!next) return;
      const ms = opts.loadMs ?? 300;
      loadTimer = setTimeout(() => {
        if (opts.failWith) {
          handlers.onError?.({ message: opts.failWith, code: "network", fatal: true });
          return;
        }
        handlers.onFrame?.({ ms, width: opts.width ?? 1920, height: opts.height ?? 1080 });
        handlers.onLoad?.({ duration, width: opts.width ?? 1920, height: opts.height ?? 1080, ms, ...tracks() });
        handlers.onPip?.({ active: false, possible: false });
        progress();
        run();
      }, ms);
    },
    setPaused(p: boolean) {
      paused = p;
      handlers.onRate?.({ rate: p ? 0 : rate });
      progress();
    },
    setRate(r: number) {
      rate = r;
      if (!paused) handlers.onRate?.({ rate });
    },
    seek(t: number) {
      const target = Math.max(0, duration === null ? t : Math.min(t, duration));
      setTimeout(() => {
        time = target;
        handlers.onSeeked?.({ target: t, time: target, finished: true, ms: 80 });
        progress();
      }, 80);
    },
    stall(on: boolean) {
      handlers.onBuffer?.({ stalled: on, reason: on ? "test" : null });
    },
    unmount: stop,
  };
}
