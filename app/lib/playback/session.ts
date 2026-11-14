// PlaySession: one native play of one title/episode from one source.
//
//   open ─► link cache hit? ─no─► resolve in the hidden page (lib/resolver.ts)
//            │                         │ fails ─► onFail("resolve")
//            ▼                         ▼
//          dl.stream.open (local proxy) ── fails ─► onFail("open")
//            ▼
//          onSrc(proxyUrl, startAt) ─► the native player plays
//            │
//   dl.stream.event  expiring / expired ─► re-resolve (cache dropped) ─► dl.stream.update
//                    error relink       ─► update, then onSrc(same url, current time)
//                    error drm          ─► onFail("drm")
//   the player's fatal error ─► a cached link that never played is resolved
//                    afresh once; else onFail("player")
//   close ─► dl.stream.close, a pending resolve of ours cancelled
//
// A finished download skips all of it: onSrc(localUrl) at once.
//
// What to do on a failure (next source, the page) is the player's
// (lib/player.ts): this module only says what failed. Everything it needs
// from outside is injected (SessionDeps), so it runs in tests unchanged.

import { dropLink, getLink, linkKey, putLink, type CachedLink, type LinkRoute } from "./linkcache";
import { SOURCE_TIMEOUT } from "../resolvecore";

export interface ResolveLike {
  ok: boolean;
  url?: string;
  kind?: "hls" | "file";
  headers?: Record<string, string>;
  ua?: string;
  source?: string;
  error?: string;
  cancelled?: boolean;
  ms?: number;
  /** Optional (resolver coverage work): the requesting frame's origin. */
  frameOrigin?: string;
  /** Optional: a Cookie header value for the stream's hosts. */
  cookies?: string;
  /** false: a stream the proxy cannot serve (DASH). */
  native?: boolean;
  steps?: string[];
}

export interface ResolveReqLike extends LinkRoute {
  type: "movie" | "tv" | "anime";
  lang?: "sub" | "dub";
  source: string;
  timeoutMs?: number;
  /** lib/resolver.ts queue: higher first (player 10, prefetch 5, downloads 0). */
  priority?: number;
  /** Who asked (`cancelResolve(tag)`). */
  tag?: string;
  /** Never the playing page's own link (a re-resolve after expiry). */
  fresh?: boolean;
}

export type StreamEventLike = { sid: string; type: string; reason?: string; message?: string; status?: number; [k: string]: unknown };

export interface SessionDeps {
  resolve(req: ResolveReqLike): Promise<ResolveLike>;
  /** Cancels the session's own hidden resolves (tag "player"). */
  cancelResolve(): void;
  open(data: { url: string; kind: "hls" | "file"; headers: Record<string, string>; cookies?: string; key?: string }): Promise<{ ok: boolean; sid?: string; url?: string; error?: string } | null>;
  update(data: { sid: string; url: string; headers: Record<string, string>; cookies?: string }): Promise<{ ok: boolean } | null>;
  close(sid: string): Promise<unknown>;
  onEvent(fn: (e: StreamEventLike) => void): () => void;
  log(line: string, data?: unknown): void;
}

export type SessionState = "idle" | "resolving" | "opening" | "playing" | "refreshing" | "failed" | "closed";
/** "refused": the stream's server refused the proxy (401/403 on a fresh
 * link before the first picture) — this platform cannot play the source. */
export type FailKind = "resolve" | "open" | "drm" | "player" | "refused";

export interface SessionTarget extends ResolveReqLike {
  /** A finished download's local URL: played as is. */
  local?: string;
  /** Where playback starts (resume / carry-over), s. */
  startAt?: number;
}

export interface SessionCallbacks {
  onState?(s: SessionState): void;
  /** Play `url` from `at` (a new item, or the same URL rebuilt on relink). */
  onSrc(url: string, at: number): void;
  /** `learn`: false when the failure says nothing about the source (a
   * timeout of a cold start, a resolve still making progress). */
  onFail(kind: FailKind, why: string, learn: boolean): void;
  /** The link this session plays (for downloads / the player's link). */
  onLink?(link: CachedLink): void;
  /** The player's current time (relink rebuilds from here). */
  position(): number;
}

// Resolve budgets: the resolver's own per-source table (resolvecore
// SOURCE_TIMEOUT, 20–30 s) — no timeoutMs is passed unless the target sets
// one. A timeout of a page that was loading / had a video gets one more
// try with EXTRA_MS more.
const EXTRA_MS = 20_000;
/** No resolve has succeeded since launch: the hidden web view is cold. */
let warm = false;

/** A failed resolve that was still getting somewhere (page loaded or a
 * video seen when the budget ran out). */
export function stillProgressing(res: ResolveLike): boolean {
  if (res.ok || res.cancelled || !/no link within/i.test(res.error ?? "")) return false;
  return (res.steps ?? []).some((s) => /loaded=true|video=true/.test(s));
}

let seq = 0;

/** A link from a resolve result (null when it has none). */
export function linkFrom(res: ResolveLike, source: string, at: number): Omit<CachedLink, "until"> | null {
  if (!res.ok || !res.url || res.native === false) return null;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (typeof v === "string" && v && !/[\r\n]/.test(v)) headers[k] = v;
  }
  const ua = typeof res.ua === "string" ? res.ua : (Object.entries(headers).find(([k]) => k.toLowerCase() === "user-agent")?.[1] ?? "");
  return {
    url: res.url,
    kind: res.kind ?? (/\.m3u8(\?|#|$)/i.test(res.url) ? "hls" : "file"),
    headers,
    ua,
    cookies: typeof res.cookies === "string" && res.cookies && !/[\r\n]/.test(res.cookies) ? res.cookies : undefined,
    frameOrigin: typeof res.frameOrigin === "string" && res.frameOrigin ? res.frameOrigin : undefined,
    // A link the playing page exposed belongs to that page's source.
    source: res.source && res.source !== "player" ? res.source : source,
    at,
  };
}

export class PlaySession {
  readonly id = ++seq;
  state: SessionState = "idle";
  sid: string | null = null;
  url: string | null = null;
  link: CachedLink | null = null;
  /** The link came from the cache (not resolved for this session). */
  fromCache = false;
  /** The player showed a picture of this session. */
  played = false;
  readonly key: string;
  private off: (() => void) | null = null;
  private resolving = false;
  private refreshing: Promise<boolean> | null = null;
  private relinkWanted = false;
  private retriedFresh = false;
  /** Stats for tests / diagnostics. */
  readonly stats = { resolves: 0, cacheHits: 0, updates: 0, rebuilds: 0, opens: 0 };

  constructor(
    readonly target: SessionTarget,
    private readonly deps: SessionDeps,
    private readonly cb: SessionCallbacks,
  ) {
    this.key = linkKey(target, target.source);
  }

  private set(s: SessionState) {
    if (this.state === s) return;
    this.state = s;
    try {
      this.cb.onState?.(s);
    } catch {}
  }

  private get live(): boolean {
    return this.state !== "closed" && this.state !== "failed";
  }

  private failed(kind: FailKind, why: string, learn = true) {
    if (!this.live) return;
    this.deps.log(`session ${this.id}: ${kind} failed: ${why}${learn ? "" : " (not learned)"}`);
    this.set("failed");
    this.teardown();
    try {
      this.cb.onFail(kind, why, learn);
    } catch {}
  }

  private req(fresh = false): ResolveReqLike {
    const t = this.target;
    return {
      priority: 10,
      tag: "player",
      fresh,
      type: t.type,
      id: t.id,
      season: t.season,
      episode: t.episode,
      lang: t.lang,
      source: t.source,
      timeoutMs: t.timeoutMs,
    };
  }

  /** The last resolve failed in a way that says nothing about the source. */
  private uninformative = false;

  /** Resolves afresh; the link is cached. Null: no link (or closed). */
  private async resolveFresh(fresh = false): Promise<CachedLink | null> {
    this.stats.resolves++;
    this.resolving = true;
    let res: ResolveLike;
    const once = async (extra: number) => {
      const req = this.req(fresh);
      if (extra) req.timeoutMs = (req.timeoutMs ?? SOURCE_TIMEOUT[req.source] ?? 30_000) + extra;
      try {
        return await this.deps.resolve(req);
      } catch (e) {
        return { ok: false, error: String(e) } as ResolveLike;
      }
    };
    const cold = !warm;
    res = await once(0);
    if (this.live && stillProgressing(res)) {
      // The page was getting there (slow device, cold web view): once more.
      this.deps.log(`session ${this.id}: resolve still progressing at the budget; once more`);
      this.stats.resolves++;
      res = await once(EXTRA_MS);
    }
    this.resolving = false;
    if (!this.live) return null;
    const l = linkFrom(res, this.target.source, Date.now());
    if (!l) {
      this.lastError = res.cancelled ? "cancelled" : (res.error ?? "no link");
      this.uninformative = /no link within/i.test(res.error ?? "") && (cold || stillProgressing(res));
      return null;
    }
    warm = true;
    return putLink(this.key, l);
  }

  lastError = "";

  async open(): Promise<void> {
    if (this.state !== "idle") return;
    const t = this.target;
    if (t.local) {
      this.url = t.local;
      this.set("playing");
      this.cb.onSrc(t.local, t.startAt ?? 0);
      return;
    }
    this.set("resolving");
    let link = getLink(this.key);
    if (link) {
      this.fromCache = true;
      this.stats.cacheHits++;
      this.deps.log(`session ${this.id}: link cache hit (${t.source})`);
    } else {
      link = await this.resolveFresh();
      if (!this.live) return;
      if (!link) {
        this.failed("resolve", this.lastError === "cancelled" ? "cancelled" : "didn't respond", !this.uninformative);
        return;
      }
    }
    await this.openStream(link, t.startAt ?? 0);
  }

  private async openStream(link: CachedLink, at: number) {
    if (!this.live) return;
    this.set("opening");
    this.link = link;
    try {
      this.cb.onLink?.(link);
    } catch {}
    this.stats.opens++;
    let r: Awaited<ReturnType<SessionDeps["open"]>> = null;
    try {
      r = await this.deps.open({ url: link.url, kind: link.kind, headers: link.headers, cookies: link.cookies, key: this.key });
    } catch (e) {
      r = { ok: false, error: String(e) };
    }
    if (!this.live) {
      // Closed while opening: release what was opened.
      if (r?.ok && r.sid) void this.deps.close(r.sid);
      return;
    }
    if (!r?.ok || !r.sid || !r.url) {
      this.failed("open", r?.error ?? "the local stream did not open");
      return;
    }
    this.sid = r.sid;
    this.url = r.url;
    this.off?.();
    this.off = this.deps.onEvent((e) => this.onStreamEvent(e));
    this.set("playing");
    this.cb.onSrc(r.url, at);
  }

  private onStreamEvent(e: StreamEventLike) {
    if (!this.live || !e || e.sid !== this.sid) return;
    // A fresh link refused before any picture: the server will not serve
    // this platform's proxy (e.g. a CDN that 403s it) — no point waiting.
    const status = Number(e.status);
    if (!this.played && (status === 401 || status === 403) && (e.type === "expired" || e.type === "error") && this.link && Date.now() - this.link.at < 90_000) {
      this.failed("refused", "was refused by its server");
      return;
    }
    if (e.type === "expiring" || e.type === "expired") {
      this.deps.log(`session ${this.id}: link ${e.type}`, e.status);
      void this.refresh();
    } else if (e.type === "error") {
      if (e.reason === "drm") this.failed("drm", "is protected (DRM)");
      else if (e.reason === "relink") {
        this.relinkWanted = true;
        void this.refresh().then((ok) => {
          if (ok) this.rebuild();
        });
      } else if (e.reason === "expired") void this.refresh();
    }
  }

  /** A fresh link for the same session (`dl.stream.update`). One at a time. */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const run = (async () => {
      if (!this.sid) return false;
      const prev = this.state;
      this.set("refreshing");
      // The old link is never handed out again (nor by the resolver's
      // "the player's own link" shortcut, which reads this cache).
      dropLink(this.key);
      const link = await this.resolveFresh(true);
      if (!this.live || !this.sid) return false;
      if (!link) {
        this.deps.log(`session ${this.id}: re-resolve failed: ${this.lastError}`);
        this.set(prev === "refreshing" ? "playing" : prev);
        return false;
      }
      let ok = false;
      try {
        ok = !!(await this.deps.update({ sid: this.sid, url: link.url, headers: link.headers, cookies: link.cookies }))?.ok;
      } catch {}
      if (!this.live) return false;
      this.stats.updates++;
      this.link = link;
      try {
        this.cb.onLink?.(link);
      } catch {}
      this.set("playing");
      return ok;
    })();
    this.refreshing = run;
    void run.finally(() => {
      if (this.refreshing === run) this.refreshing = null;
    });
    return run;
  }

  private rebuild() {
    if (!this.live || !this.url || !this.relinkWanted) return;
    this.relinkWanted = false;
    this.stats.rebuilds++;
    this.cb.onSrc(this.url, Math.max(0, Math.floor(this.cb.position())));
  }

  /** The player showed a picture: the link works. */
  notePlayed() {
    this.played = true;
  }

  /** The player failed for good (`error {fatal:true}`). A link that came
   * from the cache and never played is resolved afresh once; true when
   * the session carries on. */
  playerFailed(why: string): boolean {
    if (!this.live) return false;
    if (this.target.local) {
      this.failed("player", why);
      return false;
    }
    if (!this.played && !this.retriedFresh) {
      this.retriedFresh = true;
      this.deps.log(`session ${this.id}: player failed (${why}); resolving afresh`);
      void (async () => {
        const old = this.sid;
        this.sid = null;
        this.off?.();
        this.off = null;
        if (old) void this.deps.close(old);
        dropLink(this.key);
        this.set("resolving");
        const link = await this.resolveFresh(true);
        if (!this.live) return;
        if (!link) {
          this.failed("player", why);
          return;
        }
        await this.openStream(link, Math.max(0, Math.floor(this.cb.position())) || (this.target.startAt ?? 0));
      })();
      return true;
    }
    this.failed("player", why);
    return false;
  }

  private teardown() {
    this.off?.();
    this.off = null;
    if (this.resolving) {
      this.resolving = false;
      try {
        this.deps.cancelResolve();
      } catch {}
    }
    const sid = this.sid;
    this.sid = null;
    if (sid) void this.deps.close(sid);
  }

  /** Leaving: closes the stream, cancels a resolve of ours. Idempotent. */
  close() {
    if (this.state === "closed") return;
    const wasFailed = this.state === "failed";
    this.set("closed");
    if (!wasFailed) this.teardown();
  }
}

/** Resolves `target` ahead of time (the next episode) into the link
 * cache, unless a fresh link is already there. True when one is. */
export async function preResolve(target: ResolveReqLike, deps: Pick<SessionDeps, "resolve" | "log">): Promise<boolean> {
  const key = linkKey(target, target.source);
  if (getLink(key)) return true;
  let res: ResolveLike;
  try {
    res = await deps.resolve({ priority: 5, tag: "prefetch", ...target });
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  const l = linkFrom(res, target.source, Date.now());
  if (!l) {
    deps.log(`pre-resolve failed (${target.source}): ${res.error ?? "no link"}`);
    return false;
  }
  putLink(key, l);
  deps.log(`pre-resolved ${key}`);
  return true;
}
