// Debug hook for the native player spike (lib/nativevideo.tsx): no third
// party page on screen — the stream is resolved in the hidden web view
// (lib/resolver.ts), served by the local proxy (`dl.stream.*`) with the
// page's headers, and played by AVPlayer in the app's own window.
//
// Runs only when Storage `rustflix.nativeplayer` is "1" AND Storage
// `rustflix.nativetest` holds a request (JSON, removed when read):
//   {"type":"movie","id":550,"source":"vidfast"}
//   (+ optional "season", "episode", "lang", "holdMs": how long the screen
//   stays up after the run for a real click on the press target, default
//   60000; "rect": {x, y, width, height} of the picture in window points,
//   default 40, 80, 960×540 — e.g. the whole window to measure paint cost;
//   "download": a finished download's id — plays its `dl.playUrl` `src`
//   in the same component instead of resolving)
// It resolves, opens a proxy session, shows the video MUTED, then records
// to Storage `rustflix.nativetest.result` (rewritten after every step, so
// a run that stops midway still leaves what it got):
//   resolveMs, firstFrameMs (the video output's first pixel buffer — not a
//   GPUI paint, which a hidden window never does), load (duration, size),
//   seeks (10 / 50 / 90 %: landed within 2 s, ms), expiry (a debug 403 →
//   `expired` → re-resolve → `dl.stream.update` → playback continues,
//   stall ms), proxy stats (requests, bytes, upstream statuses, header
//   names), webViews (`sys.webViews`), players during / after
//   (`sys.nativePlayers`), press (a click on the target drawn OVER the
//   video), errors and steps. `done` once the measured part ends,
//   `finished` once the screen is gone and the session closed.
//
// The press target: JS cannot synthesize a pointer press through GPUI's
// hit testing (an accessibility press calls the handler directly, NSH
// access.rs `Action::Click` → `activate`, which proves nothing about the
// video's hitbox) — a real click at the target's centre (window
// coordinates in `result.pressTarget`) is needed.

import { host, platform, signal, Storage, Text, View } from "nsh";
import { resolveStream, type ResolveRequest, type ResolveResult } from "../lib/resolver";
import {
  closeStream,
  controlVideo,
  forceUpstreamStatus,
  NativeVideo,
  nativePlayerEnabled,
  type NativeVideoRef,
  onStreamEvent,
  openStream,
  streamStats,
  updateStream,
} from "../lib/nativevideo";
import { perfMark } from "../lib/perf";

const TEST_KEY = "rustflix.nativetest";
const RESULT_KEY = "rustflix.nativetest.result";

/** Where the picture goes in the window (points); `rect` in the request
 * overrides it. */
const DEFAULT_RECT = { x: 40, y: 80, width: 960, height: 540 };
const rect = signal(DEFAULT_RECT);
/** The press target, centred over the picture. */
const TARGET = { width: 220, height: 64 };

const active = signal<{ src: string } | null>(null);
const status = signal("");
const presses = signal(0);
let ref: NativeVideoRef | null = null;
/** The player's handle (its `ready` event): drives it with no frame drawn. */
let handle: number | null = null;

/** Seeks through the handle (works in a window that draws no frames), else
 * through the ref (delivered with the next frame). */
function seekTo(time: number) {
  if (handle !== null) void controlVideo(handle, { seek: time });
  else ref?.command("seek", { time });
}

type Ev = { t: number; name: string; d: any };
const events: Ev[] = [];
const MAX_EVENTS = 4000;
function record(name: string, d: unknown) {
  if (events.length >= MAX_EVENTS) events.splice(0, 1000);
  events.push({ t: Date.now(), name, d });
}

/** The first event `name` after index `from` (matching `ok`), within `ms`. */
function waitFor(name: string, from: number, ms: number, ok?: (d: any) => boolean): Promise<Ev | null> {
  const start = events.length >= from ? from : 0;
  const t0 = Date.now();
  return new Promise((done) => {
    const tick = () => {
      for (let i = start; i < events.length; i++) {
        const e = events[i];
        if (e.name === name && (!ok || ok(e.d))) return done(e);
      }
      if (Date.now() - t0 > ms) return done(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hostCall(name: string, data?: unknown): Promise<any> {
  try {
    return await host.call(name, (data ?? {}) as never);
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

function originOf(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "about:" ? u : `${x.protocol}//${x.host}`;
  } catch {
    return u.slice(0, 40);
  }
}

export async function runNativeTest() {
  let raw: string | null = null;
  try {
    raw = await Storage.getItem(TEST_KEY);
  } catch {}
  if (!raw) return;
  try {
    await Storage.removeItem(TEST_KEY);
  } catch {}
  const t0 = Date.now();
  const result: any = { startedAt: new Date().toISOString(), done: false, finished: false, steps: [], errors: [] };
  const save = () => Storage.setItem(RESULT_KEY, JSON.stringify(result)).catch(() => {});
  const step = (s: string) => {
    result.steps.push(`+${Date.now() - t0}ms ${s}`);
    status.set(s);
    perfMark(`native:${s.slice(0, 40)}`);
    try {
      console.log(`[rustflix] nativetest: ${s}`);
    } catch {}
    void save();
  };
  const fail = (where: string, e: unknown) => {
    result.errors.push({ step: where, error: String(e instanceof Error ? e.message : e) });
    step(`FAILED ${where}: ${String(e instanceof Error ? e.message : e)}`);
  };
  if (!(await nativePlayerEnabled())) {
    result.error = 'Storage "rustflix.nativeplayer" is not "1"';
    result.done = result.finished = true;
    await save();
    return;
  }
  let req: ResolveRequest & { holdMs?: number; rect?: Partial<typeof DEFAULT_RECT>; download?: number };
  try {
    req = JSON.parse(raw);
  } catch (e) {
    result.error = `bad JSON in ${TEST_KEY}: ${String(e)}`;
    result.done = result.finished = true;
    await save();
    return;
  }
  result.request = req;
  const holdMs = typeof req.holdMs === "number" ? req.holdMs : 60000;
  const r0 = { ...DEFAULT_RECT, ...(req.rect ?? {}) };
  if ([r0.x, r0.y, r0.width, r0.height].every((n) => typeof n === "number" && Number.isFinite(n)) && r0.width > 0 && r0.height > 0) rect.set(r0);
  const VIDEO = rect();
  result.rect = VIDEO;
  step("starting in 3 s");
  await sleep(3000);

  let sid: string | null = null;
  let stopEvents: () => void = () => {};
  const resolveReq: ResolveRequest = {
    type: req.type,
    id: req.id,
    season: req.season,
    episode: req.episode,
    lang: req.lang,
    source: req.source,
    timeoutMs: 45000,
  };
  const summarize = (r: ResolveResult) => ({
    ok: r.ok,
    kind: r.kind,
    source: r.source,
    upstream: originOf(r.url),
    headerNames: r.headers ? Object.keys(r.headers) : [],
    ms: r.ms,
    error: r.error,
  });

  // Watchdog: whatever hangs, the result is written.
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    fail("watchdog", "the run took over 5 minutes");
  }, 300000);

  try {
    let r: ResolveResult = { ok: false } as ResolveResult;
    let s: { sid: string; url: string };
    if (typeof req.download === "number") {
      // A finished download played by the same component (`dl.playUrl` →
      // `src`, the host's local media server): no resolve, no proxy.
      step(`download ${req.download}`);
      const p = await hostCall("dl.playUrl", { id: req.download });
      if (typeof p?.src !== "string") throw new Error(`dl.playUrl: no src (${JSON.stringify(p)})`);
      s = { sid: "", url: p.src };
      result.downloadSrc = p.src.replace(/:\d+\//, ":<port>/");
    } else {
    // 1. Resolve in the hidden web view.
    step("resolve");
    const tr = Date.now();
    r = await resolveStream(resolveReq);
    result.resolveMs = Date.now() - tr;
    result.resolve = summarize(r);
    if (!r.ok || !r.url || !r.kind) throw new Error(`resolve: ${r.error ?? "no link"}`);
    // 2. A proxy session with the page's headers.
    step(`open proxy session (${r.kind})`);
    const opened = await openStream(r.url, r.kind, r.headers ?? {});
    if ("error" in opened) throw new Error(`dl.stream.open: ${opened.error}`);
    s = opened;
    sid = s.sid;
    result.proxyUrl = s.url.replace(/\/[0-9a-f]{32}\//, "/<token>/");
    }
    // Expiry: resolve again and hand the fresh link over.
    const expiry: any = { events: [] };
    result.expiry = expiry;
    let reResolving = false;
    stopEvents = onStreamEvent((e) => {
      if (e.sid !== sid) return;
      record(`stream:${e.type}`, e);
      if (e.type === "stats") {
        result.proxyLast = e.stats;
        return;
      }
      expiry.events.push({ t: Date.now() - t0, type: e.type, ...(e.type === "error" ? { reason: e.reason, message: e.message } : {}) });
      if (e.type === "error") result.errors.push({ step: "proxy", error: `${e.reason}: ${e.message}` });
      // The fresh link cannot serve what the player has: rebuild the item
      // where it is (a new query: the same src would change nothing).
      if (e.type === "error" && e.reason === "relink" && handle !== null && sid) {
        const at = [...events].reverse().find((x) => x.name === "progress")?.d?.currentTime ?? 0;
        expiry.relinks = (expiry.relinks ?? 0) + 1;
        void controlVideo(handle, { startAt: at, src: `${s.url}?relink=${expiry.relinks}` });
      }
      if (e.type === "expired" && !reResolving) {
        reResolving = true;
        expiry.expiredAt = Date.now();
        void (async () => {
          step("expired: re-resolving");
          const t1 = Date.now();
          const fresh = await resolveStream(resolveReq);
          expiry.reResolveMs = Date.now() - t1;
          expiry.reResolve = summarize(fresh);
          if (fresh.ok && fresh.url && sid) {
            expiry.sameUrl = fresh.url === r.url;
            expiry.updateOk = await updateStream(sid, fresh.url, fresh.headers ?? {});
            expiry.updatedAfterMs = Date.now() - (expiry.expiredAt as number);
            step(`update sent (${expiry.updateOk ? "ok" : "refused"})`);
          } else {
            step(`re-resolve failed: ${fresh.error ?? "?"}`);
          }
          reResolving = false;
        })();
      }
    });
    // 3. The native video, muted.
    step("mount native video (muted)");
    const tm = Date.now();
    active.set({ src: s.url });
    // Props reach the component only with a frame of the window: drive it
    // through its handle as well (a hidden window draws none).
    const ready = await waitFor("ready", 0, 5000);
    if (ready && typeof ready.d?.handle === "number") {
      handle = ready.d.handle;
      result.drive = (await controlVideo(handle, { src: s.url, muted: true, paused: false })) ? "handle" : "props (sys.nativeVideo refused)";
    } else {
      result.drive = ready ? "props (ready without a handle: this platform has no sys.nativeVideo channel)" : "props (no ready event)";
    }
    step(`driving the player by ${result.drive}`);
    const frame = await waitFor("frame", 0, 30000);
    if (frame) {
      result.firstFrameMs = frame.d.ms;
      result.firstFrameWallMs = frame.t - tm;
      result.frameSize = { width: frame.d.width, height: frame.d.height };
      step(`first frame after ${frame.d.ms} ms (${frame.d.width}x${frame.d.height})`);
    } else {
      fail("first frame", "no pixel buffer within 30 s");
    }
    const load = await waitFor("load", 0, frame ? 10000 : 1000);
    const duration: number | null = load?.d?.duration ?? null;
    result.load = load?.d ?? null;
    if (!load) fail("load", "no load event");
    // Only a fatal error ends the run (contract §1.5); others are notes.
    const err = events.find((e) => e.name === "error" && e.d?.fatal === true);
    if (err) throw new Error(`player: ${err.d?.message}`);

    // 4. Seeks.
    if (duration && duration > 30) {
      result.seeks = [];
      for (const f of [0.1, 0.5, 0.9]) {
        const target = duration * f;
        const from = events.length;
        const ts = Date.now();
        step(`seek ${Math.round(f * 100)}% (${Math.round(target)} s)`);
        seekTo(target);
        const done = await waitFor("seeked", from, 15000);
        const playing = await waitFor("progress", from, 8000, (d) => typeof d?.currentTime === "number" && Math.abs(d.currentTime - target) <= 5);
        const landed: number | null = done?.d?.time ?? null;
        result.seeks.push({
          at: f,
          target,
          landed,
          within2s: landed !== null && Math.abs(landed - target) <= 2,
          seekMs: done?.d?.ms ?? null,
          wallMs: done ? done.t - ts : null,
          finished: done?.d?.finished ?? null,
          progressNear: !!playing,
        });
        await sleep(1500);
      }
    } else {
      step(`seeks skipped (duration ${duration})`);
    }

    // 5. Forced expiry: the next upstream answer is a 403.
    if (duration && duration > 30 && sid) {
      step("forced expiry: next upstream answer 403");
      expiry.forced = await forceUpstreamStatus(sid, 403, 1);
      const from = events.length;
      const target = duration * 0.3;
      const tf = Date.now();
      seekTo(target);
      const expired = await waitFor("stream:expired", from, 20000);
      expiry.expiredEvent = !!expired;
      expiry.expiredAfterMs = expired ? expired.t - tf : null;
      const resumed = await waitFor("progress", from, 60000, (d) => typeof d?.currentTime === "number" && d.currentTime > target + 2);
      expiry.resumed = !!resumed;
      expiry.resumedAfterMs = resumed ? resumed.t - tf : null;
      // Stall time from the buffer events since the seek.
      let stallMs = 0;
      let since: number | null = null;
      for (const e of events.slice(from)) {
        if (e.name !== "buffer") continue;
        if (e.d?.stalled && since === null) since = e.t;
        if (!e.d?.stalled && since !== null) {
          stallMs += e.t - since;
          since = null;
        }
      }
      expiry.stallMs = stallMs + (since !== null ? Date.now() - since : 0);
      step(`expiry: expired=${expiry.expiredEvent} resumed=${expiry.resumed} stall=${expiry.stallMs} ms`);
    }
  } catch (e) {
    fail("run", e);
  }

  // 6. What the window holds, the proxy's numbers, the players.
  try {
    const wv = await hostCall("sys.webViews");
    result.webViews = {
      count: wv?.count ?? null,
      views: Array.isArray(wv?.views)
        ? wv.views.map((v: any) => ({ ...v, url: originOf(v.url) }))
        : wv,
    };
    if (sid) result.proxy = await streamStats(sid);
    result.playersDuring = await hostCall("sys.nativePlayers");
    const progress = [...events].reverse().find((e) => e.name === "progress");
    result.lastProgress = progress?.d ?? null;
    result.bufferEvents = events.filter((e) => e.name === "buffer").length;
    result.playerErrors = events.filter((e) => e.name === "error").map((e) => e.d?.message);
  } catch (e) {
    fail("collect", e);
  }
  result.pressTarget = {
    label: "Native video press target",
    window: {
      x: VIDEO.x + (VIDEO.width - TARGET.width) / 2,
      y: VIDEO.y + (VIDEO.height - TARGET.height) / 2,
      width: TARGET.width,
      height: TARGET.height,
    },
    centre: { x: VIDEO.x + VIDEO.width / 2, y: VIDEO.y + VIDEO.height / 2 },
    holdMs,
  };
  result.done = true;
  step(`measured; waiting ${Math.round(holdMs / 1000)} s for a click on the press target`);
  const tp = Date.now();
  while (Date.now() - tp < holdMs && !watchdogFired) {
    await sleep(250);
    if (presses() > 0 && !result.press) {
      result.press = { received: true, count: presses(), afterMs: Date.now() - tp };
      void save();
    }
  }
  result.press = { received: presses() > 0, count: presses() };

  // 7. Teardown: the player stops, the session closes.
  clearTimeout(watchdog);
  if (handle !== null) await controlVideo(handle, { src: null, paused: true });
  active.set(null);
  ref = null;
  handle = null;
  await sleep(1500);
  stopEvents();
  if (sid) await closeStream(sid);
  result.playersAfter = await hostCall("sys.nativePlayers");
  result.webViewsAfter = (await hostCall("sys.webViews"))?.count ?? null;
  result.totalMs = Date.now() - t0;
  result.finished = true;
  step("finished");
  await save();
}

/** The debug screen: nothing unless the hook runs. */
export function NativePlayerDebug() {
  const v = () => rect();
  return (
    <If when={active()}>
      <View class="absolute inset-0 bg-black" accessibilityLabel="Native player debug">
        {/* The video: an EMPTY box at the picture's corner; the picture
            is painted at `frame` (src/player/component.rs). */}
        <NativeVideo
          ref={(n: unknown) => (ref = n as NativeVideoRef | null)}
          class="absolute"
          // Phones: the component fills its own box (contract §1.2).
          style={{ left: v().x, top: v().y, width: platform.desktop ? 0 : v().width, height: platform.desktop ? 0 : v().height }}
          src={active()?.src ?? null}
          muted
          paused={false}
          frame={{ width: v().width, height: v().height }}
          onReady={(d) => record("ready", d)}
          onFrame={(d) => record("frame", d)}
          onLoad={(d) => record("load", d)}
          onProgress={(d) => record("progress", d)}
          onBuffer={(d) => record("buffer", d)}
          onSeeked={(d) => record("seeked", d)}
          onEnd={(d) => record("end", d)}
          onError={(d) => record("error", d)}
        />
        {/* Drawn after the video, so above it. */}
        <View
          role="button"
          accessibilityLabel="Native video press target"
          onPress={() => presses.set(presses() + 1)}
          class="absolute cursor-pointer items-center justify-center rounded-lg bg-primary"
          style={{
            left: v().x + (v().width - TARGET.width) / 2,
            top: v().y + (v().height - TARGET.height) / 2,
            width: TARGET.width,
            height: TARGET.height,
            opacity: 0.85,
          }}
        >
          <Text class="text-sm font-semibold text-primary-foreground">{`Press target (${presses()})`}</Text>
        </View>
        <Text class="absolute text-xs text-muted-foreground" style={{ left: v().x + 8, top: Math.max(0, v().y - 24) }}>
          {`native player spike — ${status()}`}
        </Text>
      </View>
    </If>
  );
}
