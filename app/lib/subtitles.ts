// Subtitles: language matching, a strict WebVTT/SRT parser, and the
// online subtitle providers (keyless Vidrift first, Wyzie Subs when the
// user set a key). Everything here is app-side: the embed page cannot
// fetch third-party hosts, so cues are downloaded and parsed here and
// pushed to the page bridge (see `PLAYER_BRIDGE` in player.ts).

import { host } from "nsh";
import { LANGUAGES, languageName, settings } from "./store";
import type { PageSubtitle } from "./resolvecore";

export { LANGUAGES, languageName };

/** One caption: start/end in seconds, text with "\n" line breaks and
 * italics marked by \u0001 (on) / \u0002 (off). No other markup. */
export type Cue = { s: number; e: number; t: string };

export type SubFormat = "vtt" | "srt";

/** One online subtitle file. */
export type SubResult = {
  lang: string;
  label: string;
  url: string;
  format: SubFormat;
  provider: string;
  /** Hearing-impaired (SDH) when the provider says so. */
  hi?: boolean;
  /** Provider popularity (downloads/rating) when it reports one; higher is better. */
  score?: number;
  /** The file is a zip archive holding the .srt/.vtt (SubDL). */
  archive?: "zip";
  /** Release name, for picking the right file inside a season pack. */
  release?: string;
  season?: number;
  episode?: number;
  /** Request headers the file needs (the embed page's Referer/Origin/UA:
   * provider "source"); fetched through the host then (`sys.webFetch`). */
  headers?: Record<string, string>;
  /** The page marked it as its default track. */
  def?: boolean;
};

/** Bundled provider keys. They are NOT in the repository: `build.rs`
 * replaces the two tokens below in the built bundle with the values of
 * the WYZIE_API_KEY / SUBDL_API_KEY environment variables (the packaging
 * scripts read them from the Keychain), lightly scrambled so they are
 * not sitting in the bundle as plain text. A build without those
 * variables ships no keys. The user's own key in Settings always wins.
 * Never log or display these. */
const KEY_SLOTS = ["@@RUSTFLIX_WYZIE_KEY@@", "@@RUSTFLIX_SUBDL_KEY@@"];
const KEY_PAD = "rustflix-subtitle-keys";
function unpackKey(slot: string): string {
  if (!slot || slot.charCodeAt(0) === 64 || slot.length % 2) return "";
  let out = "";
  for (let i = 0; i < slot.length; i += 2) {
    const b = parseInt(slot.slice(i, i + 2), 16);
    if (Number.isNaN(b)) return "";
    out += String.fromCharCode(b ^ KEY_PAD.charCodeAt((i / 2) % KEY_PAD.length));
  }
  return out;
}
export const BUNDLED_WYZIE_KEY = unpackKey(KEY_SLOTS[0]);
export const BUNDLED_SUBDL_KEY = unpackKey(KEY_SLOTS[1]);

/** The keys in effect (never log these). */
export function wyzieKey(): string {
  if (badKeys.has("wyzie")) return "";
  return (settings().subtitleKey || "").trim() || BUNDLED_WYZIE_KEY;
}
export function subdlKey(): string {
  if (badKeys.has("subdl")) return "";
  return (settings().subdlKey || "").trim() || BUNDLED_SUBDL_KEY;
}

export type SubQuery = {
  type: "movie" | "tv" | "anime";
  /** TMDB id (movie/tv). For anime: the AniList id. */
  tmdbId: number;
  imdbId?: string;
  season?: number;
  episode?: number;
  /** The user's languages, best first: searched (and listed) first. */
  langs: string[];
  /** Include the subtitles the source's page offered (captured by the
   * resolver for a native play; `setPageSubtitles`). Off for the page
   * player, whose own text tracks are listed instead. */
  page?: boolean;
};

// --- Debug hook (player.ts installs its ring-buffer logger) -----------------

let log: (event: string, data?: unknown) => void = () => {};
export function setSubtitleDebug(fn: (event: string, data?: unknown) => void) {
  log = fn;
}
let warn: (text: string) => void = () => {};
/** The player installs its toast here (a provider key was refused). */
export function setSubtitleNotify(fn: (text: string) => void) {
  warn = fn;
}
/** Providers whose key was refused (401/403): skipped for the session. */
const badKeys = new Set<string>();
function keyRefused(provider: string, name: string) {
  if (badKeys.has(provider)) return;
  badKeys.add(provider);
  log(`subs: ${provider} key refused`);
  warn(`${name} subtitle key was refused — check it in Settings`);
}

// --- Language matching ---------------------------------------------------------

/** Names, native names and ISO 639-2/3 codes → ISO 639-1. */
const ALIASES: Record<string, string> = {
  english: "en", eng: "en", "inglés": "en", ingles: "en",
  tagalog: "tl", filipino: "tl", pilipino: "tl", fil: "tl", tgl: "tl",
  spanish: "es", spa: "es", "español": "es", espanol: "es", castellano: "es", castilian: "es",
  french: "fr", fre: "fr", fra: "fr", "français": "fr", francais: "fr",
  german: "de", ger: "de", deu: "de", deutsch: "de",
  portuguese: "pt", por: "pt", "português": "pt", portugues: "pt", brazilian: "pt", pob: "pt",
  italian: "it", ita: "it", italiano: "it",
  japanese: "ja", jpn: "ja", jap: "ja", "日本語": "ja",
  korean: "ko", kor: "ko", "한국어": "ko",
  chinese: "zh", chi: "zh", zho: "zh", "中文": "zh", mandarin: "zh", cantonese: "zh",
  chs: "zh", cht: "zh", zhs: "zh", zht: "zh",
  arabic: "ar", ara: "ar", "العربية": "ar",
  hindi: "hi", hin: "hi",
  indonesian: "id", ind: "id", "bahasa indonesia": "id",
  russian: "ru", rus: "ru", "русский": "ru",
  turkish: "tr", tur: "tr", "türkçe": "tr", turkce: "tr",
  vietnamese: "vi", vie: "vi", "tiếng việt": "vi",
  thai: "th", tha: "th",
  dutch: "nl", nld: "nl", dut: "nl", nederlands: "nl", flemish: "nl",
  polish: "pl", pol: "pl", polski: "pl",
  swedish: "sv", swe: "sv", svenska: "sv",
  albanian: "sq", alb: "sq", sqi: "sq",
  bengali: "bn", ben: "bn", bangla: "bn",
  bosnian: "bs", bos: "bs",
  bulgarian: "bg", bul: "bg",
  catalan: "ca", cat: "ca",
  croatian: "hr", hrv: "hr",
  czech: "cs", cze: "cs", ces: "cs",
  danish: "da", dan: "da",
  estonian: "et", est: "et",
  finnish: "fi", fin: "fi",
  galician: "gl", glg: "gl",
  greek: "el", gre: "el", ell: "el",
  hebrew: "he", heb: "he", iw: "he",
  hungarian: "hu", hun: "hu",
  icelandic: "is", ice: "is", isl: "is",
  kannada: "kn", kan: "kn",
  latvian: "lv", lav: "lv",
  lithuanian: "lt", lit: "lt",
  macedonian: "mk", mac: "mk", mkd: "mk",
  malay: "ms", may: "ms", msa: "ms",
  malayalam: "ml", mal: "ml",
  norwegian: "no", nor: "no", "norwegian bokmål": "no", "norwegian bokmal": "no", nob: "no", nb: "no", nn: "no",
  persian: "fa", farsi: "fa", per: "fa", fas: "fa",
  romanian: "ro", rum: "ro", ron: "ro",
  serbian: "sr", srp: "sr",
  slovak: "sk", slo: "sk", slk: "sk",
  slovenian: "sl", slovene: "sl", slv: "sl",
  tamil: "ta", tam: "ta",
  telugu: "te", tel: "te",
  ukrainian: "uk", ukr: "uk",
  urdu: "ur", urd: "ur",
};
const KNOWN = new Set(LANGUAGES.map((l) => l.code));
for (const l of LANGUAGES) ALIASES[l.name.toLowerCase()] = l.code;

/** Region variants worth their own label. */
function regionOf(code: string, tag: string): string {
  const t = tag.toLowerCase();
  if (code === "pt" && /^(br|bra|brazil|brazilian|brasil)$/.test(t)) return "BR";
  if (code === "es" && /^(la|lat|latam|419|mx|latin america|latino|latinoamérica|latinoamerica)$/.test(t)) return "LA";
  if (code === "zh" && /^(hant|tw|hk|traditional|cht|zht|繁體|繁体)$/.test(t)) return "Hant";
  if (code === "zh" && /^(hans|cn|sg|simplified|chs|zhs|简体)$/.test(t)) return "Hans";
  return "";
}

const REGION_LABEL: Record<string, string> = {
  BR: "Brazil",
  LA: "Latin America",
  Hant: "Traditional",
  Hans: "Simplified",
};

/** "English", "en", "eng", "en-US", "Português (BR)", "Brazilian",
 * "Spanish (LA)", "English 2", "English [CC]" … → ISO 639-1 code (""
 * when unknown) and a region tag for the variants that get a label. */
export function parseLang(raw: string): { code: string; region: string } {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return { code: "", region: "" };
  // Trailing duplicates/qualifiers: "English 2", "English [CC]", "(SDH)", "- Forced".
  s = s
    .replace(/[[(](cc|sdh|hi|forced|full|default|signs?)[\])]/g, " ")
    .replace(/\b(sdh|cc|forced)\b/g, " ")
    .replace(/[-–—:]\s*$/, "")
    .replace(/\s+\d+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // BCP 47 / ISO codes: "en", "eng", "pt-br", "zh_hant", "es-419".
  const bcp = s.match(/^([a-z]{2,3})(?:[-_]([a-z]{2,4}|\d{3}))?(?:[-_][a-z0-9]+)*$/);
  if (bcp) {
    const p = bcp[1];
    const code = p.length === 2 ? (p === "iw" ? "he" : p === "nb" || p === "nn" ? "no" : p) : (ALIASES[p] ?? "");
    if (code && (p.length === 2 || ALIASES[p])) {
      return { code, region: bcp[2] ? regionOf(code, bcp[2]) : "" };
    }
  }
  // Names, with an optional "(region)" or trailing qualifier word.
  const paren = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const base = (paren ? paren[1] : s).trim();
  const tag = paren ? paren[2].trim() : "";
  let code = ALIASES[base] ?? "";
  let rest = tag;
  if (!code) {
    const words = base.split(/[\s,/|]+/).filter(Boolean);
    for (let i = 0; i < words.length && !code; i++) {
      const w = words[i];
      if (ALIASES[w]) {
        code = ALIASES[w];
        rest = rest || words.slice(i + 1).join(" ") || (i > 0 ? words[0] : "");
      }
    }
  }
  if (!code) return { code: "", region: "" };
  let region = rest ? regionOf(code, rest) : "";
  if (!region && base === "brazilian") region = "BR";
  if (!region && code === "es" && /\blatino\b/.test(base)) region = "LA";
  return { code, region };
}

/** Lowercase ISO 639-1 code for a label or language attribute ("" when unknown). */
export function langCode(raw: string): string {
  return parseLang(raw).code;
}

/** A clean display name: "English", "Portuguese (Brazil)". Unknown
 * languages keep their own label, tidied ("Track 1" stays). */
export function cleanLangLabel(raw: string, code?: string, region?: string): string {
  const p = code !== undefined ? { code, region: region ?? "" } : parseLang(raw);
  if (p.code) {
    const name = KNOWN.has(p.code) ? languageName(p.code) : p.code.toUpperCase();
    const r = REGION_LABEL[p.region];
    return r ? `${name.replace(/\s*\(.*\)$/, "")} (${r})` : name;
  }
  let t = String(raw ?? "").trim().replace(/\s+/g, " ");
  // "Icelandic 2" → "Icelandic"; "Track 1" keeps its number.
  if (!/^track\s+\d+$/i.test(t)) t = t.replace(/\s+\d+$/, "");
  if (!t) return "Unknown";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// --- Cue text ---------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "",
};

/** Raw cue payload (VTT/SRT markup) → the wire form: tags stripped
 * except italics (\u0001 / \u0002) and line breaks, ASS overrides
 * ({\an8}) removed, entities decoded, blank lines dropped, at most 3
 * lines. */
export function cleanCueText(raw: string): string {
  let s = String(raw ?? "").replace(/[\u0001\u0002]/g, "");
  s = s.replace(/\{\\[^}]*\}/g, "").replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<(\/?)([a-z][a-z0-9]*)?[^>]*>/gi, (_m, close: string, name: string | undefined) => {
    if ((name ?? "").toLowerCase() === "i") return close ? "\u0002" : "\u0001";
    return "";
  });
  // Unclosed italics close at the end of the cue.
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 2 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    const v = ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
  const lines = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.replace(/[\u0001\u0002]/g, "").trim() !== "");
  return lines.slice(0, 3).join("\n");
}

// --- Parser -----------------------------------------------------------------------

const TS = "(?:(\\d{1,3}):)?(\\d{1,2}):(\\d{2})[.,](\\d{1,3})";
const TIMING = new RegExp(`^\\s*${TS}\\s*-->\\s*${TS}(?:\\s+.*)?$`);

function secs(h: string | undefined, m: string, s: string, ms: string): number {
  const frac = Number(ms.padEnd(3, "0")) / 1000;
  return (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s) + frac;
}

/** Parses WebVTT (header required, NOTE/STYLE/REGION blocks and cue ids
 * skipped, cue settings ignored) or SRT (index lines optional, ","
 * millis, missing blank lines tolerated). BOM and CRLF/CR are handled.
 * Cues come back sorted by start; overlapping cues are kept; cues with
 * no text or no duration are dropped. */
export function parseSubtitles(text: string, hint?: SubFormat): Cue[] {
  let s = String(text ?? "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, "\n");
  const vtt = /^WEBVTT(?:[ \t\n]|$)/.test(s);
  if (hint === "vtt" && !vtt && !TIMING.test(s.split("\n").find((l) => l.includes("-->")) ?? "")) return [];
  const lines = s.split("\n");
  const out: Cue[] = [];
  let cur: { s: number; e: number; lines: string[] } | null = null;
  // VTT: a NOTE/STYLE/REGION block runs to the next blank line.
  let skipping = false;
  const flush = () => {
    if (!cur) return;
    const t = cleanCueText(cur.lines.join("\n"));
    if (t && cur.e > cur.s) out.push({ s: cur.s, e: cur.e, t });
    cur = null;
  };
  for (let i = vtt ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (skipping) {
      if (line.trim() === "") skipping = false;
      continue;
    }
    const m = TIMING.exec(line);
    if (m) {
      if (cur) {
        // SRT without a blank line: the index of this cue ended up as
        // the previous cue's last line.
        const c = cur as { lines: string[] };
        if (!vtt && c.lines.length && /^\d+$/.test(c.lines[c.lines.length - 1].trim())) c.lines.pop();
        flush();
      }
      cur = {
        s: secs(m[1], m[2], m[3], m[4]),
        e: secs(m[5], m[6], m[7], m[8]),
        lines: [],
      };
      continue;
    }
    if (cur) {
      if (line.trim() === "") flush();
      else cur.lines.push(line);
      continue;
    }
    if (vtt && /^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(line)) skipping = true;
  }
  flush();
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  return out;
}

// --- Fetching ---------------------------------------------------------------------

const TIMEOUT_MS = 6000;

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/** GET with a hard timeout; resolves to the raw bytes (or text when the
 * response has no arrayBuffer). Throws HttpError for non-2xx. */
async function getBytes(
  url: string,
  ms = TIMEOUT_MS,
  headers: Record<string, string> = {},
): Promise<Uint8Array | string> {
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      try {
        ac?.abort();
      } catch {}
      rej(new Error("timed out"));
    }, ms);
  });
  try {
    const res = await Promise.race([
      fetch(url, { headers: { Accept: "*/*", ...headers }, ...(ac ? { signal: ac.signal } : {}) }),
      timeout,
    ]);
    if (!res.ok) throw new HttpError(res.status);
    const body = typeof res.arrayBuffer === "function"
      ? Promise.resolve(res.arrayBuffer()).then((b) => new Uint8Array(b))
      : Promise.resolve(res.text());
    return await Promise.race([body, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bytes → text: UTF-8 (BOM-aware), UTF-16 by BOM, else windows-1252
 * when the bytes are not valid UTF-8. A raw gzip body (a .gz file; the
 * HTTP stack itself already decodes Content-Encoding: gzip) is inflated
 * first. */
export function decodeText(b: Uint8Array | string): string {
  if (typeof b === "string") return b;
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) b = gunzip(b);
  const dec = (enc: string, fatal = false) => new TextDecoder(enc, { fatal }).decode(b);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return dec("utf-16le");
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return dec("utf-16be");
  try {
    return dec("utf-8", true);
  } catch {
    try {
      return dec("windows-1252");
    } catch {
      return dec("utf-8");
    }
  }
}

async function getText(url: string, ms = TIMEOUT_MS, headers?: Record<string, string>): Promise<string> {
  return decodeText(await getBytes(url, ms, headers));
}


// --- Inflate (RFC 1951) + gzip + zip ---------------------------------------------
//
// NSH's JS runtime has fetch → arrayBuffer() and TextDecoder, but no
// DecompressionStream and no zlib, so archives are inflated here.

type Huff = { counts: Uint16Array; symbols: Uint16Array };

function buildHuff(lengths: Uint8Array, off: number, n: number): Huff {
  const counts = new Uint16Array(16);
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[off + i]]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let i = 0; i < n; i++) {
    const l = lengths[off + i];
    if (l) symbols[offs[l]++] = i;
  }
  return { counts, symbols };
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedLit: Huff | null = null;
let fixedDist: Huff | null = null;

/** Raw DEFLATE → bytes. `max` caps the output (a zip bomb guard). */
export function inflateRaw(src: Uint8Array, max = 64 << 20): Uint8Array {
  let pos = 0, bit = 0, bits = 0;
  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let n = 0;
  const need = (k: number) => {
    if (n + k <= out.length) return;
    if (n + k > max) throw new Error("archive too large");
    let size = out.length * 2;
    while (size < n + k) size *= 2;
    const o = new Uint8Array(Math.min(size, max));
    o.set(out.subarray(0, n));
    out = o;
  };
  const getBit = () => {
    if (!bits) {
      if (pos >= src.length) throw new Error("truncated deflate stream");
      bit = src[pos++];
      bits = 8;
    }
    const b = bit & 1;
    bit >>>= 1;
    bits--;
    return b;
  };
  const getBits = (k: number) => {
    let v = 0;
    for (let i = 0; i < k; i++) v |= getBit() << i;
    return v;
  };
  const decode = (h: Huff) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= getBit();
      const c = h.counts[len];
      if (code - c < first) return h.symbols[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("bad huffman code");
  };
  for (;;) {
    const last = getBit();
    const type = getBits(2);
    if (type === 0) {
      bits = 0;
      if (pos + 4 > src.length) throw new Error("truncated deflate stream");
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error("truncated deflate stream");
      need(len);
      out.set(src.subarray(pos, pos + len), n);
      n += len;
      pos += len;
    } else if (type === 1 || type === 2) {
      let lit: Huff, dist: Huff;
      if (type === 1) {
        if (!fixedLit || !fixedDist) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
          fixedLit = buildHuff(l, 0, 288);
          const d = new Uint8Array(30).fill(5);
          fixedDist = buildHuff(d, 0, 30);
        }
        lit = fixedLit;
        dist = fixedDist;
      } else {
        const hlit = getBits(5) + 257;
        const hdist = getBits(5) + 1;
        const hclen = getBits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = getBits(3);
        const clh = buildHuff(cl, 0, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist; ) {
          const sym = decode(clh);
          if (sym < 16) lens[i++] = sym;
          else {
            let rep = 0, val = 0;
            if (sym === 16) {
              if (!i) throw new Error("bad code lengths");
              val = lens[i - 1];
              rep = 3 + getBits(2);
            } else if (sym === 17) rep = 3 + getBits(3);
            else rep = 11 + getBits(7);
            if (i + rep > hlit + hdist) throw new Error("bad code lengths");
            while (rep--) lens[i++] = val;
          }
        }
        lit = buildHuff(lens, 0, hlit);
        dist = buildHuff(lens, hlit, hdist);
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          need(1);
          out[n++] = sym;
        } else if (sym === 256) break;
        else {
          const li = sym - 257;
          if (li >= 29) throw new Error("bad length symbol");
          const len = LEN_BASE[li] + getBits(LEN_EXTRA[li]);
          const di = decode(dist);
          if (di >= 30) throw new Error("bad distance symbol");
          const d = DIST_BASE[di] + getBits(DIST_EXTRA[di]);
          if (d > n) throw new Error("bad distance");
          need(len);
          for (let k = 0; k < len; k++, n++) out[n] = out[n - d];
        }
      }
    } else {
      throw new Error("bad deflate block type");
    }
    if (last) break;
  }
  return out.subarray(0, n);
}

/** A .gz body → its content (the first member). */
export function gunzip(b: Uint8Array): Uint8Array {
  if (b.length < 18 || b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw new Error("not gzip");
  const flg = b[3];
  let p = 10;
  if (flg & 4) p += 2 + (b[p] | (b[p + 1] << 8));
  if (flg & 8) while (p < b.length && b[p++] !== 0);
  if (flg & 16) while (p < b.length && b[p++] !== 0);
  if (flg & 2) p += 2;
  return inflateRaw(b.subarray(p));
}

export type ZipEntry = { name: string; data: () => Uint8Array };

/** Largest subtitle file taken out of an archive. */
const ZIP_MAX = 10 << 20;

/** Entries of a zip archive (central directory; stored + deflate). */
export function unzip(b: Uint8Array): ZipEntry[] {
  const u16 = (o: number) => b[o] | (b[o + 1] << 8);
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return unzipLocal(b);
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  const latin = (o: number, len: number) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(b[o + i]);
    return s;
  };
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(p) !== 0x02014b50) break;
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const csize = u32(p + 20);
    const nlen = u16(p + 28);
    const xlen = u16(p + 30);
    const clen = u16(p + 32);
    const local = u32(p + 42);
    let name = latin(p + 46, nlen);
    if (flags & 0x800) {
      try {
        name = new TextDecoder("utf-8").decode(b.subarray(p + 46, p + 46 + nlen));
      } catch {}
    }
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    out.push({
      name,
      data: () => {
        if (u32(local) !== 0x04034b50) throw new Error("bad zip entry");
        const start = local + 30 + u16(local + 26) + u16(local + 28);
        const raw = b.subarray(start, start + csize);
        if (flags & 1) throw new Error("encrypted zip entry");
        if (method === 0) return raw;
        if (method === 8) return inflateRaw(raw, ZIP_MAX);
        throw new Error(`zip method ${method} not supported`);
      },
    });
  }
  return out;
}

/** No central directory (a truncated archive): walk the local file
 * headers, as Streambert does (entries with sizes in the header only). */
function unzipLocal(b: Uint8Array): ZipEntry[] {
  const u16 = (o: number) => b[o] | (b[o + 1] << 8);
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 30 <= b.length && u32(p) === 0x04034b50) {
    const flags = u16(p + 6);
    const method = u16(p + 8);
    const csize = u32(p + 18);
    const nlen = u16(p + 26);
    const xlen = u16(p + 28);
    let name = "";
    for (let i = 0; i < nlen; i++) name += String.fromCharCode(b[p + 30 + i]);
    const start = p + 30 + nlen + xlen;
    if ((flags & 8) && !csize) break;
    const raw = b.subarray(start, start + csize);
    if (!name.endsWith("/")) {
      out.push({
        name,
        data: () => {
          if (flags & 1) throw new Error("encrypted zip entry");
          if (method === 0) return raw;
          if (method === 8) return inflateRaw(raw, ZIP_MAX);
          throw new Error(`zip method ${method} not supported`);
        },
      });
    }
    p = start + csize;
  }
  if (!out.length) throw new Error("not a zip archive");
  return out;
}

/** The subtitle file to use from an archive: .srt/.vtt only; for TV the
 * one whose name matches the episode (S01E02, 1x02, E02), else the
 * first; non-SDH names preferred. */
export function pickArchiveEntry(entries: ZipEntry[], season?: number, episode?: number): ZipEntry | null {
  const subs = entries.filter((e) => /\.(srt|vtt)$/i.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name));
  if (!subs.length) return null;
  const score = (name: string) => {
    let sc = 0;
    if (episode != null) {
      const s = season ?? 1;
      const pad = (x: number) => String(x).padStart(2, "0");
      const re = new RegExp(
        `(s0*${s}[ ._-]*e0*${episode}(?!\\d))|(\\b0*${s}x0*${episode}(?!\\d))|(\\be(p|pisode)?[ ._-]*0*${episode}(?!\\d))`,
        "i",
      );
      if (re.test(name)) sc += 10;
      else if (new RegExp(`[^\\d]${pad(episode)}[^\\d]`).test(name)) sc += 3;
    }
    if (/\b(sdh|hi|cc)\b/i.test(name)) sc -= 1;
    return sc;
  };
  return subs.map((e, i) => ({ e, i, sc: score(e.name) })).sort((a, b) => b.sc - a.sc || a.i - b.i)[0].e;
}

// --- Providers ----------------------------------------------------------------------

const VIDRIFT = "https://embed.vidrift.net";

/** Vidrift (keyless): its embed page inlines `subtitleTracks = [...]`
 * ({code,label,lang,url}) for the title; files are WebVTT under
 * /api/subtitles/movie/<id>/<code> or /api/subtitles/tv/<id>/<s>/<e>/<code>.
 * "x…" codes are per-title, so the list is always read from the page. */
async function vidrift(q: SubQuery): Promise<SubResult[]> {
  if (q.type === "anime" || !q.tmdbId) return [];
  const page =
    q.type === "movie"
      ? `${VIDRIFT}/embed/movie/${q.tmdbId}`
      : `${VIDRIFT}/embed/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode ?? 1}`;
  let html: string;
  try {
    html = await getText(page);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return [];
    throw e;
  }
  return parseVidriftTracks(html);
}

/** The `subtitleTracks` list inlined in a Vidrift embed page. */
export function parseVidriftTracks(html: string): SubResult[] {
  const at = html.indexOf("subtitleTracks");
  if (at < 0) return [];
  const open = html.indexOf("[", at);
  if (open < 0 || open - at > 40) return [];
  // The array is plain JSON; find its matching bracket (strings may hold "]").
  let depth = 0;
  let end = -1;
  let inStr = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  let list: unknown;
  try {
    list = JSON.parse(html.slice(open, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: SubResult[] = [];
  for (const it of list as Record<string, unknown>[]) {
    if (!it || typeof it !== "object") continue;
    const url = typeof it.url === "string" ? it.url : "";
    if (!url || !/^\/api\/subtitles\//.test(url)) continue;
    const rawLabel = typeof it.label === "string" ? it.label : "";
    const attr = typeof it.lang === "string" ? it.lang : "";
    const p = parseLang(rawLabel);
    const code = p.code || langCode(attr);
    out.push({
      lang: code,
      label: cleanLangLabel(rawLabel, code, p.region),
      url: `${VIDRIFT}${url}`,
      format: "vtt",
      provider: "vidrift",
    });
  }
  return out;
}

// --- From the source: the page's own subtitles ----------------------------------------

/** "track_0_English__Full_Subtitle__eng.vtt", "English.vtt", "/en.vtt",
 * "spa-forced.srt" → a language code from the file name ("" if none). */
export function langFromUrl(url: string): string {
  let name = "";
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
  name = name.replace(/\.(vtt|webvtt|srt|ass|ssa|gz|txt)$/gi, "");
  if (!name) return "";
  // The whole name: "en", "pt-BR", "English", "Portuguese (Brazil)".
  const whole = parseLang(name.replace(/[_]+/g, " "));
  if (whole.code) return whole.code;
  // Words: names and ISO 639-2 codes only (two-letter words are too
  // often something else inside a longer name).
  for (const w of name.split(/[^A-Za-z\u00c0-\u024f]+/).filter((x) => x.length >= 3)) {
    const c = ALIASES[w.toLowerCase()];
    if (c) return c;
  }
  return "";
}

/** The page's subtitles (resolver capture) as subtitle results, provider
 * "source": language normalised to ISO 639-1 (label, language attribute,
 * then the file name), a clean label, headers kept for the fetch. ASS/SSA
 * files are left out (no parser). */
export function pageSubtitleResults(list: PageSubtitle[]): SubResult[] {
  const out: SubResult[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    if (!s || typeof s.url !== "string" || seen.has(s.url)) continue;
    const fmt = (s.format || "").toLowerCase();
    if (fmt === "ass" || fmt === "ssa") continue;
    seen.add(s.url);
    const p = parseLang(s.label || "");
    const fromAttr = parseLang(s.lang || "");
    const code = p.code || fromAttr.code || langFromUrl(s.inner || s.url) || langFromUrl(s.url);
    const region = p.code ? p.region : fromAttr.region;
    const raw = s.label || s.lang || "";
    const label = code ? cleanLangLabel(raw || code, code, region) : cleanLangLabel(raw || "Subtitles");
    out.push({
      lang: code,
      label,
      url: s.url,
      format: fmt === "srt" ? "srt" : "vtt",
      provider: "source",
      hi: /\b(sdh|cc)\b|hearing/i.test(raw) || undefined,
      headers: s.headers && Object.keys(s.headers).length ? s.headers : undefined,
      def: s.def || undefined,
    });
  }
  return out;
}

/** `type:id:season:episode` of a title, as the player's routes give it. */
export function pageSubKey(type: string, id: number, season?: number, episode?: number): string {
  const se = type === "tv" ? (season ?? 1) : 0;
  const ep = type === "movie" ? 0 : (episode ?? 1);
  return `${type}:${id}:${se}:${ep}`;
}

const pageSubs = new Map<string, SubResult[]>();
const pageSubFns: ((key: string, list: SubResult[]) => void)[] = [];

/** The resolver hands over what the page offered (again, as more arrive). */
export function setPageSubtitles(key: string, list: SubResult[]) {
  if (!list.length && !pageSubs.has(key)) return;
  pageSubs.delete(key);
  pageSubs.set(key, list);
  while (pageSubs.size > 40) pageSubs.delete(pageSubs.keys().next().value as string);
  for (const fn of pageSubFns) {
    try {
      fn(key, list);
    } catch {}
  }
}

/** What the page of this title offered (empty when unknown). */
export function pageSubtitles(key: string): SubResult[] {
  return pageSubs.get(key) ?? [];
}

/** `list` (provider results) with the page's own subtitles for `key` merged
 * in first ("from the source": ahead of the others within a language). */
export function withPageSubtitles(list: SubResult[], key: string, langs: string[]): SubResult[] {
  const page = pageSubtitles(key);
  const rest = list.filter((x) => x.provider !== "source" && x.provider !== "downloaded");
  return page.length ? mergeResults([page, rest], langs) : rest;
}

/** Called when a page's list arrives or grows (late arrivals). */
export function onPageSubtitles(fn: (key: string, list: SubResult[]) => void): () => void {
  pageSubFns.push(fn);
  return () => {
    const i = pageSubFns.indexOf(fn);
    if (i >= 0) pageSubFns.splice(i, 1);
  };
}

const WYZIE = "https://sub.wyzie.io";
/** Hosts Wyzie result files may live on (the documented one plus the
 * old domains that redirect to it). Anything else is dropped and logged. */
const WYZIE_FILE_HOSTS = /^https:\/\/(sub\.wyzie\.io|subs\.wyzie\.io|subs\.wyzie\.ru)\//;
let wyzieLogged = false;

/** Logs a response's shape once per provider (field names and short
 * values; never URLs or keys) so an unverified mapping can be checked
 * from one real run. */
function logShape(provider: string, body: unknown, list: unknown[]) {
  const first = list[0];
  log(`subs: ${provider} first response shape`, {
    top: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body as object) : Array.isArray(body) ? "array" : typeof body,
    n: list.length,
    keys: first && typeof first === "object" ? Object.keys(first as object) : typeof first,
    sample:
      first && typeof first === "object"
        ? Object.fromEntries(
            Object.entries(first as Record<string, unknown>)
              .filter(([k]) => !/url|key|link/i.test(k))
              .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 60) : v]),
          )
        : undefined,
  });
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return isFinite(n) ? n : undefined;
};

const str = (...vs: unknown[]): string => {
  for (const v of vs) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
};

/** Wyzie request (Streambert subtitles.js + docs.wyzie.io): /search with
 * id=<TMDB id>, format=srt, language=<iso 639-1, comma-joined>,
 * season+episode for TV, key. Anime: anilist=<id>&episode=<n> (docs). */
export function wyzieRequest(q: SubQuery, key: string, langs = q.langs): string {
  const p = new URLSearchParams();
  if (q.type === "anime") {
    p.set("anilist", String(q.tmdbId));
    p.set("episode", String(q.episode ?? 1));
  } else {
    p.set("id", String(q.tmdbId));
    if (q.type === "tv") {
      p.set("season", String(q.season ?? 1));
      p.set("episode", String(q.episode ?? 1));
    }
  }
  p.set("format", "srt");
  const ls = langs.filter((l) => /^[a-z]{2,3}$/.test(l));
  if (ls.length) p.set("language", ls.join(","));
  p.set("key", key);
  return `${WYZIE}/search?${p.toString()}`;
}

/** Wyzie response (UNVERIFIED live): a top-level array; per entry `url`
 * (relative → resolved on sub.wyzie.io), `language`, a display name
 * (display_name/name/release_name/title/SubFileName/fileName, or the
 * documented `display`), `isHearingImpaired`, `isAiTranslated`,
 * `source`, `downloadCount`. */
export function wyzieMap(body: unknown): SubResult[] {
  const list = Array.isArray(body) ? body : [];
  if (!wyzieLogged) {
    wyzieLogged = true;
    logShape("wyzie", body, list);
  }
  const out: SubResult[] = [];
  for (const it of list as Record<string, unknown>[]) {
    if (!it || typeof it !== "object") continue;
    const raw = typeof it.url === "string" ? it.url : "";
    if (!raw) continue;
    const url = /^https?:\/\//.test(raw) ? raw : `${WYZIE}${raw.startsWith("/") ? "" : "/"}${raw}`;
    if (!WYZIE_FILE_HOSTS.test(url)) {
      log("subs: wyzie result on an unlisted host", url.replace(/^https?:\/\/([^/]+).*$/, "$1"));
      continue;
    }
    const fmt = String(it.format ?? "srt").toLowerCase();
    if (fmt !== "srt" && fmt !== "vtt") continue;
    const attr = typeof it.language === "string" ? it.language : "";
    const display = str(it.display, it.display_name);
    const lp = parseLang(attr);
    const dp = parseLang(display);
    const code = lp.code || dp.code;
    out.push({
      lang: code,
      label: cleanLangLabel(display || attr, code, lp.region || dp.region),
      url,
      format: fmt as SubFormat,
      provider: "wyzie",
      hi: it.isHearingImpaired === true,
      // AI translations rank last within a language.
      score: it.isAiTranslated === true ? -1 : num(it.downloadCount ?? it.downloads),
      release: str(it.release_name, it.release, it.name, it.title, it.SubFileName, it.fileName) || undefined,
    });
  }
  return out;
}

async function wyzie(q: SubQuery, langs = q.langs): Promise<SubResult[]> {
  const key = wyzieKey();
  if (!key) return [];
  let body: unknown;
  try {
    body = JSON.parse(await getText(wyzieRequest(q, key, langs), 12_000));
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      keyRefused("wyzie", "Wyzie");
      return [];
    }
    if (e instanceof HttpError && e.status === 404) return [];
    throw e instanceof HttpError ? new Error(`wyzie HTTP ${e.status}`) : e;
  }
  return wyzieMap(body);
}

const SUBDL_API = "https://api.subdl.com/api/v1/subtitles";
const SUBDL_DL = "https://dl.subdl.com";
const SUBDL_HEADERS = { "User-Agent": "rustflix" };
let subdlLogged = false;

/** ISO 639-1 → SubDL's code: the first part, upper-cased ("pt-BR" → "PT"). */
export const toSubdlLang = (c: string) => c.split("-")[0].toUpperCase();

/** SubDL request (Streambert subtitles.js): api_key, tmdb_id,
 * type=movie|tv, subs_per_page=30, season_number/episode_number for
 * TV, languages=<EN,FR,…>. */
export function subdlRequest(q: SubQuery, key: string, langs = q.langs): string | null {
  if (q.type === "anime") return null;
  const p = new URLSearchParams();
  p.set("api_key", key);
  p.set("tmdb_id", String(q.tmdbId));
  p.set("type", q.type === "tv" ? "tv" : "movie");
  p.set("subs_per_page", "30");
  if (q.type === "tv") {
    p.set("season_number", String(q.season ?? 1));
    p.set("episode_number", String(q.episode ?? 1));
  }
  const ls = langs.filter((l) => /^[a-z]{2,3}$/.test(l)).map(toSubdlLang);
  if (ls.length) p.set("languages", ls.join(","));
  return `${SUBDL_API}?${p.toString()}`;
}

/** SubDL response (UNVERIFIED live): `status` must be truthy;
 * `subtitles[]` with `url` (a zip path on dl.subdl.com), `lang`
 * (language name or code; lower-cased), `language` (code), `name` /
 * `release_name`, `author`, `hi`, `downloads`, `sd_id`, `season`,
 * `episode`. */
export function subdlMap(body: unknown, q?: SubQuery): SubResult[] {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const list = b.status && Array.isArray(b.subtitles) ? b.subtitles : [];
  if (!subdlLogged) {
    subdlLogged = true;
    logShape("subdl", body, list);
  }
  const out: SubResult[] = [];
  for (const it of list as Record<string, unknown>[]) {
    if (!it || typeof it !== "object") continue;
    const rel = typeof it.url === "string" ? it.url : "";
    const url = /^\/subtitle\//.test(rel)
      ? `${SUBDL_DL}${rel}`
      : /^https:\/\/dl\.subdl\.com\//.test(rel)
        ? rel
        : "";
    if (!url) continue;
    const name = str(it.lang).toLowerCase();
    const attr = str(it.language);
    const np = parseLang(name);
    const code = np.code || (attr.toUpperCase() === "BR_PT" ? "pt" : langCode(attr));
    const region = attr.toUpperCase() === "BR_PT" ? "BR" : np.region;
    const episode = num(it.episode);
    // Another episode of the season (not a full-season pack) is no use.
    if (q?.type === "tv" && episode != null && episode > 0 && q.episode != null && episode !== q.episode && it.full_season !== true) continue;
    out.push({
      lang: code,
      label: cleanLangLabel(name || attr, code, region),
      url,
      format: "srt",
      provider: "subdl",
      archive: "zip",
      hi: !!it.hi,
      score: num(it.downloads),
      release: str(it.release_name, it.name) || undefined,
      season: q?.season,
      episode: q?.episode,
    });
  }
  return out;
}

async function subdl(q: SubQuery, langs = q.langs): Promise<SubResult[]> {
  const key = subdlKey();
  if (!key) return [];
  const url = subdlRequest(q, key, langs);
  if (!url) return [];
  let text: string;
  try {
    text = await getText(url, 12_000, SUBDL_HEADERS);
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) {
      keyRefused("subdl", "SubDL");
      return [];
    }
    if (e instanceof HttpError && e.status === 404) return [];
    throw e instanceof HttpError ? new Error(`subdl HTTP ${e.status}`) : e;
  }
  if (/cannot consume/i.test(text)) {
    keyRefused("subdl", "SubDL");
    return [];
  }
  return subdlMap(JSON.parse(text), q);
}

/** Tagalog: Streambert's tables have none. Send "tl"; when that finds
 * nothing, try "fil" once (and log which one answered). */
async function withTagalogRetry(
  name: string,
  run: (langs: string[]) => Promise<SubResult[]>,
  langs: string[],
): Promise<SubResult[]> {
  const res = await run(langs);
  if (!langs.includes("tl")) return res;
  if (res.some((r) => r.lang === "tl")) {
    log(`subs: ${name} answered Tagalog for "tl"`);
    return res;
  }
  try {
    const more = (await run(["fil"])).map((r) => (r.lang ? r : { ...r, lang: "tl", label: languageName("tl") }));
    log(`subs: ${name} Tagalog retry with "fil"`, { results: more.length });
    return [...res, ...more];
  } catch {
    return res;
  }
}

/** At most this many results per language survive the merge. */
const PER_LANG = 4;

/** Merges provider lists (already in provider order): de-duplicated by
 * URL; within a language non-SDH first, then the provider order, then
 * the provider's own score; at most PER_LANG per language (region
 * variants count separately). The user's languages (`langs` order)
 * come first, then the rest in first-seen order. */
export function mergeResults(lists: SubResult[][], langs: string[]): SubResult[] {
  const seen = new Set<string>();
  const all: { r: SubResult; p: number; i: number }[] = [];
  lists.forEach((l, p) =>
    l.forEach((r, i) => {
      if (seen.has(r.url)) return;
      seen.add(r.url);
      all.push({ r, p, i });
    }),
  );
  const groups = new Map<string, typeof all>();
  for (const x of all) {
    const k = x.r.lang ? `${x.r.lang}|${x.r.label}` : `?${x.r.label}`;
    const g = groups.get(k);
    if (g) g.push(x);
    else groups.set(k, [x]);
  }
  const keys = [...groups.keys()];
  const rank = (k: string) => {
    const i = langs.indexOf(k.split("|")[0]);
    return i < 0 ? langs.length : i;
  };
  const first = new Map(keys.map((k, i) => [k, i]));
  keys.sort((a, b) => rank(a) - rank(b) || first.get(a)! - first.get(b)!);
  const out: SubResult[] = [];
  for (const k of keys) {
    const g = groups.get(k)!;
    g.sort(
      (a, b) =>
        Number(!!a.r.hi) - Number(!!b.r.hi) ||
        a.p - b.p ||
        (b.r.score ?? 0) - (a.r.score ?? 0) ||
        a.i - b.i,
    );
    out.push(...g.slice(0, PER_LANG).map((x) => x.r));
  }
  return out;
}

/** Searches the providers in order — SubDL (key), Wyzie (key), then the
 * keyless Vidrift fallback — and merges them (`mergeResults`). The
 * keyed providers are asked for the user's languages; Vidrift lists
 * every language of the title. Best-effort: a failing provider
 * contributes nothing; this only rejects when every provider that ran
 * failed. (Keyless Wyzie, subs.wyzie.ru, now redirects to the keyed
 * host and answers 401, so it is not used.) */
export async function searchSubtitles(q: SubQuery): Promise<SubResult[]> {
  const runs: Promise<SubResult[]>[] = [];
  // From the source first: within a language it ranks before the others.
  if (q.page) runs.push(Promise.resolve(pageSubtitles(pageSubKey(q.type, q.tmdbId, q.season, q.episode))));
  if (subdlKey()) runs.push(withTagalogRetry("subdl", (l) => subdl(q, l), q.langs));
  if (wyzieKey()) runs.push(withTagalogRetry("wyzie", (l) => wyzie(q, l), q.langs));
  runs.push(vidrift(q));
  const settled = await Promise.all(
    runs.map((p) =>
      p.then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      ),
    ),
  );
  let failed = 0;
  const lists: SubResult[][] = [];
  for (const r of settled) {
    if (r.ok) lists.push(r.v);
    else {
      failed++;
      lists.push([]);
      log("subs: provider failed", String(r.e instanceof Error ? r.e.message : r.e));
    }
  }
  if (failed === settled.length) throw new Error("subtitle search failed");
  return mergeResults(lists, q.langs);
}

/** A file from the source's page: through the host's own HTTP client
 * (`sys.webFetch`: any host, the page's headers) — the app's fetch only
 * reaches the hosts in nsh.json. Falls back to fetch where the host has
 * no such call. */
async function sourceBytes(r: SubResult): Promise<Uint8Array | string> {
  let available = false;
  try {
    available = host.available();
  } catch {}
  if (available) {
    type Fetched = { ok?: boolean; status?: number; b64?: string; error?: string };
    let res = null as Fetched | null;
    try {
      res = (await host.call("sys.webFetch", { url: r.url, headers: r.headers ?? {}, max: 8 << 20 })) as Fetched | null;
    } catch (e) {
      log("subs: sys.webFetch unavailable", String(e instanceof Error ? e.message : e));
    }
    if (res && res.ok && typeof res.b64 === "string") {
      const bin = atob(res.b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (res && !res.ok) throw new HttpError(res.status ?? 0);
  }
  return getBytes(r.url, 30_000, r.headers ?? {});
}

const cueCache = new Map<string, Cue[]>();

/** Downloads and parses one result (cached by URL); zip archives are
 * unpacked and the best .srt/.vtt inside is used. Throws on network
 * failure or when the file holds no cues. */
export async function loadCues(result: SubResult): Promise<Cue[]> {
  const hit = cueCache.get(result.url);
  if (hit) return hit;
  const bytes =
    result.provider === "source"
      ? await sourceBytes(result)
      : await getBytes(result.url, 30_000, result.provider === "subdl" ? SUBDL_HEADERS : {});
  let text: string;
  let format: SubFormat | undefined = result.format;
  const isZip = typeof bytes !== "string" && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (result.archive === "zip" || isZip) {
    if (typeof bytes === "string") throw new Error("archive arrived as text");
    const entry = pickArchiveEntry(unzip(bytes), result.season, result.episode);
    if (!entry) throw new Error("no subtitle file in the archive");
    format = /\.vtt$/i.test(entry.name) ? "vtt" : "srt";
    text = decodeText(entry.data());
  } else {
    text = decodeText(bytes);
  }
  const cues = parseSubtitles(text, format);
  if (!cues.length) throw new Error("no cues in the subtitle file");
  if (cueCache.size > 20) cueCache.clear();
  cueCache.set(result.url, cues);
  return cues;
}
