// The pure part of the hidden-page resolver (lib/resolver.ts): turns what
// the pages report into stream candidates, ranks them, and builds the
// request headers the native stream proxy must send. No NSH imports, so it
// is unit-tested with bun (resolvecore.test.ts).
//
// Inputs (web view messages):
// - `{t:-11, m}`: one record of the all-frames media sniffer (adblock.ts
//   SNIFF_JS) — the URL the page fetched, its kind/role, the requesting
//   frame (origin, URL, referrer, cookies, referrer policy, UA) and the
//   headers the page set.
// - `{t:-2, streams, hdrs, ua, src?}`: the top-document bridge's stream list
//   (answer to `{t:'streams'}`), or a push of the Android Sniffer
//   (`src:'android'`, any frame, with the request's real headers).

import { AD_HOSTS, siteOf } from "./adblock";

export type StreamFormat = "hls" | "mp4" | "dash";

/** One media URL a page requested. */
export interface StreamCandidate {
  /** What the page fetched (a page-side proxy URL stays as it is: the
   * stream proxy must fetch exactly this). */
  url: string;
  format: StreamFormat;
  /** master | media | file | "" (unknown) */
  role: string;
  /** How it was seen: fetch, xhr, perf:<initiator>, video, source, hls.js,
   * bridge, android. */
  via: string;
  /** The requesting frame. */
  frameOrigin: string;
  frameUrl: string;
  /** The frame's document.referrer. */
  docReferrer: string;
  /** document.cookie of the requesting frame (HttpOnly not included). */
  frameCookies: string;
  /** The frame's <meta name=referrer> policy, if any. */
  referrerPolicy: string;
  ua: string;
  /** Request headers the page set itself (Authorization, tokens…), or the
   * real request headers (Android). */
  pageHeaders: Record<string, string>;
  /** The URL inside a page-side proxy (`…?url=<m3u8>`, base64 path). */
  inner?: string;
  /** ms since the requesting document started. */
  at: number;
  /** Arrival order. */
  seq: number;
}

const AD = new Set(AD_HOSTS);
function adHost(host: string): boolean {
  let h = host.toLowerCase();
  while (h) {
    if (AD.has(h)) return true;
    const i = h.indexOf(".");
    if (i < 0) return false;
    h = h.slice(i + 1);
  }
  return false;
}

function formatOf(k: unknown, url: string): StreamFormat | null {
  if (k === "hls" || k === "dash" || k === "mp4") return k;
  const p = url.toLowerCase().split("#")[0];
  if (/\.m3u8?(\?|$)/.test(p) || p.includes(".m3u8")) return "hls";
  if (/\.mpd(\?|$)/.test(p)) return "dash";
  if (/\.(mp4|m4v|mov|webm)(\?|$)/.test(p)) return "mp4";
  return null;
}

function usable(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return false;
  return !adHost(u.hostname);
}

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");

function cleanHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== "object") return out;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    const s = String(v);
    if (!k || /[\r\n]/.test(k) || /[\r\n]/.test(s)) continue;
    out[k] = s;
  }
  return out;
}

/** Collects candidates from page messages; dedupes by URL (the richest
 * record wins: a sniffer record over a bridge/Android one). */
export class CandidateSet {
  private byUrl = new Map<string, StreamCandidate>();
  private seq = 0;
  /** Non-candidate notes (segments, clicks, MSE hints) for the steps log. */
  notes: string[] = [];

  /** `{t:-11, m}` from the sniffer. Returns the candidate when it is one. */
  addSniff(m: Record<string, unknown>): StreamCandidate | null {
    const url = str(m.u);
    const k = m.k;
    if (k === "note" || k === "seg") {
      if (this.notes.length < 20) this.notes.push(`${String(k)} ${str(m.r, 20)} ${url.slice(0, 120)} ${str(m.el, 60)}`.trim());
      return null;
    }
    const format = formatOf(k, url);
    if (!format || !usable(url)) return null;
    const c: StreamCandidate = {
      url,
      format,
      role: str(m.r, 16),
      via: str(m.via, 24),
      frameOrigin: str(m.fo, 300),
      frameUrl: str(m.fr, 1000),
      docReferrer: str(m.ref, 1000),
      frameCookies: str(m.ck, 4000),
      referrerPolicy: str(m.rp, 40).toLowerCase(),
      ua: str(m.ua, 400),
      pageHeaders: cleanHeaders(m.h),
      inner: str(m.inner, 2000) || undefined,
      at: typeof m.ms === "number" ? m.ms : 0,
      seq: ++this.seq,
    };
    return this.put(c, true);
  }

  /** `{t:-2}` from the top bridge or the Android Sniffer. */
  addStreams(v: Record<string, unknown>, pageUrl: string): StreamCandidate[] {
    const list = Array.isArray(v.streams) ? (v.streams as unknown[]).filter((s): s is string => typeof s === "string") : [];
    const hdrs = (v.hdrs && typeof v.hdrs === "object" ? v.hdrs : {}) as Record<string, unknown>;
    const android = v.src === "android";
    let origin = "";
    try {
      origin = new URL(pageUrl).origin;
    } catch {}
    const out: StreamCandidate[] = [];
    for (const url of list) {
      const format = formatOf(null, url);
      if (!format || !usable(url)) continue;
      // Segments (.ts/.m4s) are not entry points.
      if (format === "hls" || format === "dash" || format === "mp4") {
        const h = cleanHeaders(hdrs[url]);
        const ref = Object.entries(h).find(([k2]) => k2.toLowerCase() === "referer")?.[1] ?? "";
        let fo = origin;
        if (android) {
          // The Android Sniffer sees any frame: the Referer it saw tells it.
          fo = "";
          try {
            fo = ref ? new URL(ref).origin : "";
          } catch {}
        }
        const c: StreamCandidate = {
          url,
          format,
          role: "",
          via: android ? "android" : "bridge",
          frameOrigin: fo,
          frameUrl: android ? ref : pageUrl,
          docReferrer: "",
          frameCookies: "",
          referrerPolicy: "",
          ua: str(v.ua, 400),
          pageHeaders: h,
          at: 0,
          seq: ++this.seq,
        };
        const got = this.put(c, false);
        if (got) out.push(got);
      }
    }
    return out;
  }

  private put(c: StreamCandidate, rich: boolean): StreamCandidate | null {
    const old = this.byUrl.get(c.url);
    if (!old) {
      this.byUrl.set(c.url, c);
      return c;
    }
    // Keep the first sighting's order; take the richer frame data / role.
    if (rich && (old.via === "bridge" || old.via === "android")) {
      const merged = { ...c, seq: old.seq, pageHeaders: { ...old.pageHeaders, ...c.pageHeaders } };
      this.byUrl.set(c.url, merged);
      return merged;
    }
    if (!old.role && c.role) old.role = c.role;
    return null;
  }

  all(): StreamCandidate[] {
    return [...this.byUrl.values()];
  }

  size(): number {
    return this.byUrl.size;
  }

  /** Best first: master playlists, then (hls.js entry), unknown-role
   * playlists, media playlists by resolution hint, progressive files, DASH
   * last (not playable natively). Ties: the earliest seen. */
  ranked(): StreamCandidate[] {
    return this.all().sort((a, b) => score(b) - score(a) || a.seq - b.seq);
  }

  /** Whether the best one is final enough to stop collecting: a master
   * playlist (nothing beats it). */
  hasMaster(): boolean {
    return this.all().some((c) => c.format === "hls" && c.role === "master");
  }
}

function resHint(url: string): number {
  const m = url.match(/(2160|1440|1080|720|576|480|360|240)p?/);
  return m ? Number(m[1]) : 0;
}

export function score(c: StreamCandidate): number {
  if (c.format === "hls") {
    if (c.role === "master") return 3000;
    if (c.role === "master?") return 2800;
    if (!c.role) return 2000 + resHint(c.url) / 10;
    return 1500 + resHint(c.url) / 10;
  }
  if (c.format === "mp4") return 1000 + resHint(c.url) / 10;
  return 100;
}

const HOP = new Set(["range", "host", "content-length", "connection", "accept-encoding", "transfer-encoding", "cookie"]);

/** The request headers the stream proxy must send for `c`: what the page
 * set itself, plus Referer (per the requesting frame and its referrer
 * policy — never the top page's origin for an inner frame's request),
 * Origin for a cross-origin fetch/XHR, and the page's User-Agent. */
export function headersFor(c: StreamCandidate, fallbackUa: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.pageHeaders)) {
    if (HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  const has = (n: string) => Object.keys(out).some((k) => k.toLowerCase() === n);
  let target: URL | null = null;
  try {
    target = new URL(c.url);
  } catch {}
  const cross = !!target && !!c.frameOrigin && target.origin !== c.frameOrigin;
  if (!has("referer") && c.frameOrigin) {
    const rp = c.referrerPolicy;
    if (rp === "no-referrer") {
      // no Referer at all
    } else if (rp === "unsafe-url" || rp === "no-referrer-when-downgrade" || (!cross && rp !== "origin" && rp !== "strict-origin")) {
      out.Referer = c.frameUrl || `${c.frameOrigin}/`;
    } else if (!(rp === "same-origin" && cross)) {
      out.Referer = `${c.frameOrigin}/`;
    }
  }
  if (!has("origin") && cross && /^(fetch|xhr|hls\.js)/.test(c.via) && c.frameOrigin) out.Origin = c.frameOrigin;
  if (!has("user-agent")) out["User-Agent"] = c.ua || fallbackUa;
  return out;
}

/** Same site (registrable domain) — for using a frame's document.cookie. */
export function sameSite(a: string, b: string): boolean {
  try {
    return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname);
  } catch {
    return false;
  }
}

/** Per-source time budgets (ms, from the page load), from the simulator
 * runs: Vidfast 2–5 s, Vidrift 2.3 s, Aether 4.7 s, Vidnest 1.9 s; sources
 * that need a frame chain or one click get more. */
export const SOURCE_TIMEOUT: Record<string, number> = {
  vidfast: 20000,
  vidrift: 20000,
  aether: 25000,
  vidnest: 20000,
  vidsrc: 30000,
  frembed: 30000,
  kinohub: 30000,
  vidlove: 25000,
  devideosrc: 25000,
};

// --- Subtitles the page offers ------------------------------------------------------

/** One subtitle file a page offers (a `<track>`, a player's set-up list,
 * a JSON API answer, or a file it fetched), as the sniffer reported it.
 * `lang`/`label` are raw here; lib/subtitles.ts normalises them. */
export interface PageSubtitle {
  url: string;
  /** vtt | srt | ass | ssa | "" (unknown: decided by the body). */
  format: string;
  lang: string;
  label: string;
  /** track | json | player | fetch | xhr | perf:… */
  via: string;
  /** The page marked it as its default. */
  def: boolean;
  /** Headers to fetch it with (from the frame that listed or fetched it). */
  headers: Record<string, string>;
  frameOrigin: string;
  /** The URL inside a page-side proxy, when `url` is one. */
  inner?: string;
}

/** Collects the page's subtitle files; de-duplicated by URL, the first
 * listing's label/language kept, later ones fill gaps. */
export class SubtitleSet {
  private byUrl = new Map<string, PageSubtitle>();

  /** A `{t:-11, m}` record with `k:"sub"`; true when it added or improved one. */
  add(m: Record<string, unknown>, fallbackUa: string): boolean {
    if (m.k !== "sub") return false;
    const url = str(m.u, 4000);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return false;
    const via = str(m.via, 24);
    const pseudo: StreamCandidate = {
      url,
      format: "hls",
      role: "",
      via: via === "json" || via === "player" || via === "track" ? "media" : via,
      frameOrigin: str(m.fo, 300),
      frameUrl: str(m.fr, 1000),
      docReferrer: str(m.ref, 1000),
      frameCookies: "",
      referrerPolicy: str(m.rp, 40).toLowerCase(),
      ua: str(m.ua, 400),
      pageHeaders: cleanHeaders(m.h),
      at: 0,
      seq: 0,
    };
    // Players fetch subtitle files with XHR/fetch (CORS): an Origin is sent
    // for a cross-origin file; listed ones are fetched the same way.
    if (pseudo.via === "media") pseudo.via = "fetch";
    const sub: PageSubtitle = {
      url,
      format: str(m.r, 8).toLowerCase(),
      lang: str(m.lang, 40),
      label: str(m.label, 120),
      via,
      def: m.def === true,
      headers: headersFor(pseudo, fallbackUa),
      frameOrigin: pseudo.frameOrigin,
      inner: str(m.inner, 3000) || undefined,
    };
    const old = this.byUrl.get(url);
    if (!old) {
      this.byUrl.set(url, sub);
      return true;
    }
    let changed = false;
    if (!old.lang && sub.lang) (old.lang = sub.lang), (changed = true);
    if (!old.label && sub.label) (old.label = sub.label), (changed = true);
    if (!old.format && sub.format) (old.format = sub.format), (changed = true);
    if (sub.def && !old.def) (old.def = true), (changed = true);
    return changed;
  }

  size(): number {
    return this.byUrl.size;
  }

  /** The list, with page-side proxies applied: when the page fetched one
   * listed file through its own proxy (`…/fetch?url=<file>&ref=…`), the
   * other listed files of that host go through the same proxy (the bare
   * host may refuse the app); the proxied copy replaces the bare one. */
  list(): PageSubtitle[] {
    const all = [...this.byUrl.values()];
    const wrapped = all.filter((s) => s.inner);
    const templates: { host: string; make: (raw: string) => string; from: PageSubtitle }[] = [];
    for (const w of wrapped) {
      let host = "";
      try {
        host = new URL(w.inner!).host;
      } catch {
        continue;
      }
      const enc = encodeURIComponent(w.inner!);
      if (w.url.includes(enc)) templates.push({ host, make: (raw) => w.url.replace(enc, encodeURIComponent(raw)), from: w });
      else if (w.url.includes(w.inner!)) templates.push({ host, make: (raw) => w.url.replace(w.inner!, raw), from: w });
    }
    const listedUrls = new Set(all.filter((x) => !x.inner).map((x) => x.url));
    const out: PageSubtitle[] = [];
    for (const s of all) {
      // A fetched copy of a listed file takes the listing's place.
      if (s.inner && listedUrls.has(s.inner)) continue;
      const copy = wrapped.find((w) => w.inner === s.url);
      if (copy) {
        out.push({ ...copy, lang: copy.lang || s.lang, label: copy.label || s.label, def: copy.def || s.def });
        continue;
      }
      if (s.inner) {
        out.push(s);
        continue;
      }
      let host = "";
      try {
        host = new URL(s.url).host;
      } catch {}
      const t = templates.find((x) => x.host === host);
      if (t) out.push({ ...s, url: t.make(s.url), inner: s.url, headers: t.from.headers, frameOrigin: t.from.frameOrigin });
      else out.push(s);
    }
    return out;
  }
}
