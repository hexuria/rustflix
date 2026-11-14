// The playback seam: lib/player.ts drives every play through one
// PlaybackBackend and hears back through MediaReport.
//
//   webBackend    (lib/playback/webBackend.ts)    the source's embed page in
//                 the player's web view, driven over the injected bridge —
//                 the fallback, unchanged.
//   nativeBackend (lib/playback/nativeBackend.ts) the app's own player, the
//                 `rustflix.video` component, fed by a PlaySession
//                 (lib/playback/session.ts) through the local stream proxy.
//
// Reports keep the bridge's state-report shape (one per media event, ~4/s
// while playing), so the phase machine, resume, saving, auto-pick and the
// signals the controls read (position, duration, mediaPaused, …) are the
// same code for both.

/** A text track of the video. `i` indexes the backend's own list. */
export type ReportTrack = { i: number; label: string; mode: string; lang?: string; kind?: string; raw?: string };
/** An audio track of the video. */
export type ReportAudio = { i: number; label: string; lang: string; on: boolean };

/** One state report (the bridge's `{t, d, p, …}`). */
export interface MediaReport {
  /** currentTime (s). */
  t: number;
  /** duration (s), when known. */
  d?: number;
  /** paused. */
  p?: boolean;
  /** playbackRate. */
  r?: number;
  /** fullscreen (the platform's own). */
  f?: boolean;
  /** muted. */
  m?: boolean;
  /** volume 0..1. */
  vo?: number;
  /** readyState (≥ 3: can play). */
  rs?: number;
  /** picture in picture possible. */
  pip?: boolean;
  /** `<doc>:<video>` — reports of an earlier epoch's doc are dropped. */
  vid?: string;
  tracks?: ReportTrack[];
  aud?: ReportAudio[];
  /** The media event: "playing", "pause", "waiting", "canplay", "timeupdate", "seeked", "ended", "error", … */
  ev?: string;
  err?: number;
  /** Out of sight: the page's document is hidden or its video is in
   * picture in picture (web). */
  hid?: boolean;
  ctl?: number;
  clk?: number;
}

/** Captions: the app owns the model (lib/player.ts); a backend shows it. */
export interface CaptionSink {
  off(): void;
  /** An embedded track (`i` of the reported tracks). */
  track(i: number, label: string, lang: string): void;
  /** Cues the app loaded (online / downloaded), by file id. */
  cues(id: string, cues: { s: number; e: number; t: string }[]): void;
  /** Size, timing offset (s), lifted above the controls. Partial updates. */
  config(c: { size?: "s" | "m" | "l"; offset?: number; lift?: boolean }): void;
}

export interface PlaybackBackend {
  readonly kind: "web" | "native";
  play(): void;
  pause(): void;
  toggle(): void;
  /** Absolute seek (s); safe before the video can seek. */
  seek(t: number): void;
  /** Relative seek (s), clamped by the backend. */
  seekBy(s: number): void;
  setRate(r: number): void;
  /** 2× while held; off restores the rate. */
  hold(on: boolean): void;
  setVolume(v: number): void;
  toggleMute(): void;
  /** Audio track `i` of the reported list. */
  selectAudio(i: number): void;
  /** true: cover (fill, crop); false: contain. */
  fit(fill: boolean): void;
  pip(): void;
  fullscreen(mode: "enter" | "exit" | "toggle"): void;
  /** One fresh report as soon as possible (after a picker). */
  sync(): void;
  readonly captions: CaptionSink;
  /** Stops and releases everything of this play. */
  destroy(): void;
}
