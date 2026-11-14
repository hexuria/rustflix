// Ad blocking for the player's (and the hidden resolver's) web views.
//
// The embed pages (lib/sources.ts) and the ad scripts they load draw ad
// cards, fake notifications, click-catchers and pop-unders over the video.
// Four layers, strongest first:
//
// 1. Network (native, ads never load): `contentRules()` is a WebKit content
//    blocker list (WKContentRuleList) the hosts compile once and attach to
//    every web view at creation, before its first navigation — macOS
//    src/webguard.rs, iOS ios/Rustflix/WebGuard.swift. Android's
//    WebGuard.java answers `shouldInterceptRequest` from the same data
//    (`AD_HOSTS`, `AD_PATTERNS`, `MEDIA_ALLOW`).
// 2. Navigation and windows (native + in page): the hosts refuse main-frame
//    navigations away from the source's embed hosts (`embedHosts()`) and
//    non-web schemes, and media-capture prompts; pop-ups never open (no
//    native window is ever created). In every frame the guard script
//    (`GUARD_JS`) at document start locks `window.open` (a stub window —
//    some players test it), off-site link clicks and programmatic clicks,
//    off-site form posts, JS dialogs, beforeunload, notification /
//    geolocation / camera prompts, service workers and history traversal.
// 3. Isolation (in page, every frame): once a frame has its video, only the
//    video's own rendering path stays visible — the chain of ancestors (and
//    iframes, reported child → parent by postMessage) that contains it;
//    every other element painting around or over it is made invisible and
//    non-interactive (never removed), continuously (MutationObserver +
//    a low-rate sweep, shadow roots included). Where the app drives the
//    video (top document) the video alone is kept, so the embed's own
//    control bar goes too; in inner frames (the "blind" case, where the
//    page's own controls are the user's) the player container is kept.
//    Before any video nothing of the page shows (black; by opacity only, so
//    layout and autoplay are untouched). Escape hatch: a page with no video
//    after 10 s (or called blind by the app) shows only its play element,
//    for the one real click it needs, or else the page minus ad-like layers
//    (outside <body>, max z-index overlays, ad-host frames).
// 4. Diagnostics: per page, while Settings → Diagnostics is on, counts of
//    blocked requests by host, pop-ups / navigations / dialogs / prompts
//    refused and the hidden elements (a few described) go to the debug log
//    and to Storage `rustflix.adblock.diag`.
//
// Kill switch: Settings → Diagnostics → "Block ads in player" (Storage
// `rustflix.adblock` = "0" turns every ad layer off: no content rules, the
// guard stands down in every frame). The injected script itself stays: it
// also carries the media sniffer (SNIFF_JS) the stream resolver needs.
//
// Provenance of the lists (no list is fetched at runtime):
// - Hosts seen loading ad/tracker code in these embed pages on the iPhone
//   simulator (resource timing per frame, Nov 2026; see the comments).
// - Streambert's player-session block list (index.js BLOCKED_HOSTS, GPL-3.0
//   like this app), minus entries that serve media or fonts for the
//   players (cloudnestra / neonhorizonworkshops stream hosts, fonts.*,
//   gstatic, cdn77 rsc buckets, cloudfront, alloha.tv, videasy).
// - A compact set of well-known ad, pop-under and tracker networks (the
//   largest exchanges and pop/push networks of the EasyList / Peter Lowe
//   lists).

import { host, Storage } from "nsh";
import { PLAYER_SOURCES } from "./sources";

// --- Data ------------------------------------------------------------------------

/** Blocked hosts: the host and every subdomain of it. */
export const AD_HOSTS: string[] = [
  // Seen in the embed pages (simulator captures, Nov 2026).
  "vinnyvower.cfd", // vidnest / vidfast / vidsrc: ad user-id beacon (/cuid/)
  "ensoberevicteefideism.cfd", // same three: ad decision fetch (/gd/<id>)
  "efji4wl5ouowgv1r.cfd", // same three: ad loader script
  "whorishcropped.rest", // vidnest anime: in-page push ad creatives
  "chiripaethenes.com", // vidnest anime: in-page push loader (proxied)
  "gamutscrewed.com", // aether: in-page push loader
  "histats.com", // vidsrc: counter
  "dtscout.com", // vidsrc: tracker iframe + script
  "dtscdn.com",
  "tynt.com", // vidsrc: copy tracker
  "crwdcntrl.net", // vidsrc: Lotame
  "onaudience.com",
  "eyeota.net",
  "mrktmtrcs.net",
  "ltmsphrcl.net",
  // Analytics every embed loads.
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "cloudflareinsights.com",
  // Streambert's list (curated; "vdrk.site" left out: sub./cache.vdrk.site
  // serve vidnest's and aether's subtitles).
  "doubleclick.net",
  "adservice.google.com",
  "adservice.google.de",
  "googlesyndication.com",
  "adx1.com",
  "intelligenceadx.com",
  "adsco.re",
  "mc.yandex.com",
  "mc.yandex.ru",
  "bvtpk.com",
  "rtmark.net",
  "b7510.com",
  "unbrownunflat.com",
  "malocacomals.com",
  "sixmossin.com",
  "realizationnewestfangs.com",
  "acscdn.com",
  "taloseempest.com",
  "profitableratecpm.com",
  "preferencenail.com",
  "protrafficinspector.com",
  "weirdopt.com",
  "kettledroopingcontinuation.com",
  "wayfarerorthodox.com",
  "woxaglasuy.net",
  "adeptspiritual.com",
  "calculating-laugh.com",
  "amavhxdlofklxjg.xyz",
  "u3qleufcm6vure326ktfpbj.cfd",
  "get64t9vqg8pnbex1y463o.rest",
  "usrpubtrk.com",
  "usrpubtrck.com",
  "adexchangeclear.com",
  "rzjzjnavztycv.online",
  "hameltnoummos.com",
  "ancillammmm.com",
  "hubeamily.com",
  "llvpn.com",
  "gillyspencie.com",
  "soakysecrets.com",
  "mdstats.info",
  "ads-twitter.com",
  "connatix.com",
  "imasdk.googleapis.com",
  "jwpltx.com",
  "improving.duckduckgo.com",
  "openfpcdn.io",
  "phruk.org",
  "welcomingexpulsion.com",
  "pgo99.com",
  "todditehexarch.com",
  "uniolaicecaps.com",
  "alloviewroll.com",
  "yadro.ru",
  "getaim.org",
  "myangular.life",
  "rstprgapipt.com",
  "veselchaga.link",
  "webvisor.org",
  "datariaarpent.com",
  "gamesrevenue.com",
  "73ed366d3137ec936bd60b1184467776.com",
  "908df012d9bb72e6d26b41054588d758.com",
  "e89d45b16370ee7e43daeaf6ce8d9547.com",
  "shankedunwindy.cyou",
  "asemquips.cfd",
  "epicgameshubham.com",
  "tantrajoni.cfd",
  "thatdisform.cyou",
  "aarems.org",
  "aerionvel.com",
  "aelwynvel.com",
  "cdn4ads.com",
  "directyp.org",
  "fakerstoterframing.qpon",
  "karthliunstagy.com",
  "nresystems.com",
  "sainwertapr.com",
  "pxltag.com",
  "runative-syndicate.com",
  "saidairakas.com",
  "coiffesreal.qpon",
  "solarcyclonesky.com",
  "bawrelcuttail.com",
  "tabaxirethnize.cyou",
  "thyriswh.cyou",
  "ukankingwithea.com",
  "uuidksinc.net",
  "blockadsnot.com",
  "canseealltheugline.org",
  "eifitcannotke.org",
  "embercascademaple.com",
  "bancadeltempoidea.org",
  "tryedesign.com",
  "ahacdn.me",
  "cometslourdy.cfd",
  "pusleybrand.cyou",
  "luugy.com",
  "nimbusgrovelodge.com",
  "brushetenglandagacant.qpon",
  "hyaloidsatury.com",
  "stummelbeelbow.com",
  "mgid.com",
  "deedwaifpleas.org",
  "pushaffiliate.net",
  "imp-mintads.site",
  "oceanicdreamcove.com",
  "xadsmart.com",
  "srvqk3.com",
  "adright.xml-v4.ak-is2.net",
  "csp-reporting.cloudflare.com",
  "facebook.com",
  "facebook.net",
  "cysyjucymudity.com",
  "pncloudfl.com",
  "cruzswim.org",
  "darnobedienceupscale.com",
  "derricknationtop.com",
  "tsyndicate.com",
  "rapidadexchange.com",
  "cepesbritons.qpon",
  "sarplerlacunes.qpon",
  "ixiondartman.com",
  "varnishtala.cyou",
  // Well-known ad exchanges, pop-under / push networks and trackers.
  "googleadservices.com",
  "adnxs.com",
  "amazon-adsystem.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "casalemedia.com",
  "adsrvr.org",
  "scorecardresearch.com",
  "quantserve.com",
  "moatads.com",
  "adform.net",
  "smartadserver.com",
  "yieldmo.com",
  "sharethrough.com",
  "media.net",
  "zedo.com",
  "popads.net",
  "popcash.net",
  "propellerads.com",
  "propellerclick.com",
  "onclickads.net",
  "onclkds.com",
  "onclickalgo.com",
  "adsterra.com",
  "adsterratools.com",
  "highperformanceformat.com",
  "effectiveratecpm.com",
  "effectivecpmgate.com",
  "effectivegatecpm.com",
  "highcpmgate.com",
  "highrevenuegate.com",
  "highrevenuenetwork.com",
  "a-ads.com",
  "exoclick.com",
  "exosrv.com",
  "exdynsrv.com",
  "juicyads.com",
  "trafficjunky.net",
  "hilltopads.net",
  "clickadu.com",
  "adcash.com",
  "admaven.com",
  "ad-maven.com",
  "monetag.com",
  "al5sm.com",
  "richpartners.co",
  "pushame.com",
  "pushwhy.com",
  "notix.io",
  "realsrv.com",
  "bidgear.com",
  "clickaine.com",
  "adspyglass.com",
  "galaksion.com",
  "ad-delivery.net",
  "statcounter.com",
  "hotjar.com",
  "clarity.ms",
  "mixpanel.com",
  "segment.io",
  "amplitude.com",
  "newrelic.com",
  "nr-data.net",
  "disqusads.com",
];

export type ResourceType =
  | "document"
  | "image"
  | "style-sheet"
  | "script"
  | "font"
  | "raw"
  | "svg-document"
  | "media"
  | "popup"
  | "ping"
  | "fetch"
  | "websocket"
  | "other";

/** Blocked URL patterns (WebKit content-blocker regex subset: no `|`, no
 * `{n}`), case-insensitive, for the listed resource types only. */
export const AD_PATTERNS: { re: string; types: ResourceType[]; third?: boolean; why: string }[] = [
  {
    // vidnest's in-page push loader comes through a Cloudflare worker
    // proxy (…workers.dev/fetch?url=https%3A%2F%2F<ad host>…) to dodge
    // host lists. Players never load their script this way.
    re: "/fetch\\?url=https?%3a%2f%2f",
    types: ["script", "document"],
    why: "proxied ad loader",
  },
  {
    // The push-ad network behind vinnyvower / ensoberevicteefideism and
    // whatever domain it rotates to next: its id beacon and ad decision.
    re: "/cuid/\\?f=https?%3a",
    types: ["raw", "fetch", "other", "script", "image"],
    why: "push-ad id beacon",
  },
  {
    re: "/gd/[0-9]+\\?md=",
    types: ["raw", "fetch", "other", "script", "image"],
    why: "push-ad decision",
  },
  {
    // Its loader: /<token>/<zone id>, no extension, from a third party
    // (chiripaethenes.com/rz63yIY8itxcu/130989, gamutscrewed.com/
    // rfCGFwitpB2QNaUw/131425). Player scripts always have a .js path.
    re: "^https?://[^/]+/[a-z0-9]+/[0-9]+$",
    types: ["script"],
    third: true,
    why: "push-ad loader",
  },
  // Not blocked although it looks like ads: p16-ad-site-sign-sg.tiktokcdn.com
  // (TikTok's ad-creative CDN) serves vidnest anime's HLS segments,
  // disguised as images. Block by what a request does, never by its look.
  // Throw-away ad domains on the cheap TLDs the pop/push networks rotate
  // through: third-party scripts only (media and players never load a
  // script from them; stream hosts on such TLDs are fetched, not scripted).
  ...["cfd", "rest", "qpon", "cyou", "sbs"].map((tld) => ({
    re: `^https?://[^/]*\\.${tld}[:/]`,
    types: ["script", "popup"] as ResourceType[],
    third: true,
    why: `third-party script on .${tld}`,
  })),
  {
    re: ".*",
    types: ["popup"],
    third: true,
    why: "third-party pop-up",
  },
];

/** Never blocked, whatever matched before: the media itself and its
 * subtitles (WebKit `ignore-previous-rules`). */
export const MEDIA_ALLOW: { re: string; types?: ResourceType[] }[] = [
  { re: ".*", types: ["media"] },
  { re: "\\.m3u8" },
  { re: "\\.mpd" },
  { re: "\\.m4s" },
  { re: "\\.mp4" },
  { re: "\\.ts$" },
  { re: "\\.ts\\?" },
  { re: "\\.vtt" },
  { re: "\\.srt" },
];

/** Embed hosts the main frame may navigate between, beyond each source's
 * own (`PLAYER_SOURCES`): mirrors seen redirecting. */
const EMBED_EXTRA: string[] = ["vsembed.ru", "vidsrc.to", "vidsrc.xyz", "vidsrc.net", "vidsrc.cc"];

/** The registrable part of a host ("a.b.example.co.uk" → "example.co.uk"). */
export function siteOf(h: string): string {
  const p = h.toLowerCase().replace(/\.$/, "").split(".");
  if (p.length <= 2) return p.join(".");
  const sl = p[p.length - 2];
  const tl = p[p.length - 1];
  if (tl.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go)$/.test(sl)) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}

/** The sites of every embed source (main-frame navigation allow list). */
export function embedHosts(): string[] {
  const out = new Set<string>();
  for (const s of PLAYER_SOURCES) {
    try {
      out.add(siteOf(new URL(s.movieUrl("1")).hostname));
    } catch {}
  }
  for (const h of EMBED_EXTRA) out.add(siteOf(h));
  return [...out].sort();
}

// --- WebKit content rules ------------------------------------------------------

const esc = (h: string) => h.replace(/[.\\+*?^$()[\]{}|/]/g, (c) => `\\${c}`);
const hostRe = (h: string) => `^[a-z][-a-z0-9+.]*://([^/:]*\\.)?${esc(h)}[:/]`;

export interface ContentRule {
  trigger: {
    "url-filter": string;
    "resource-type"?: ResourceType[];
    "load-type"?: ("first-party" | "third-party")[];
  };
  action: { type: "block" | "ignore-previous-rules" };
}

/** The content blocker (WKContentRuleList JSON): blocks first, then the
 * exceptions (media, subtitles, the embed hosts themselves). */
export function contentRules(): ContentRule[] {
  const rules: ContentRule[] = [];
  for (const h of AD_HOSTS) rules.push({ trigger: { "url-filter": hostRe(h) }, action: { type: "block" } });
  for (const p of AD_PATTERNS) {
    const trigger: ContentRule["trigger"] = { "url-filter": p.re, "resource-type": p.types };
    if (p.third) trigger["load-type"] = ["third-party"];
    rules.push({ trigger, action: { type: "block" } });
  }
  for (const a of MEDIA_ALLOW) {
    const trigger: ContentRule["trigger"] = { "url-filter": a.re };
    if (a.types) trigger["resource-type"] = a.types;
    rules.push({ trigger, action: { type: "ignore-previous-rules" } });
  }
  for (const h of embedHosts()) {
    rules.push({ trigger: { "url-filter": hostRe(h) }, action: { type: "ignore-previous-rules" } });
  }
  return rules;
}

/** The hidden resolver's extra content rules: it only needs the page's
 * scripts, XHR/fetch and the media — no images, fonts, SVG or pings (style
 * sheets stay: players lay out and size-check their elements). */
export function resolverRules(): ContentRule[] {
  return [
    { trigger: { "url-filter": ".*", "resource-type": ["image", "font", "svg-document", "ping"] }, action: { type: "block" } },
  ];
}

/** What WebKit would do with `url` (a reference evaluation of
 * `contentRules()` for tests and diagnostics): true when blocked. */
export function ruleBlocks(
  rules: ContentRule[],
  url: string,
  type: ResourceType,
  pageUrl: string,
): boolean {
  let third = false;
  try {
    third = siteOf(new URL(url).hostname) !== siteOf(new URL(pageUrl).hostname);
  } catch {}
  let blocked = false;
  for (const r of rules) {
    const t = r.trigger;
    if (t["resource-type"] && !t["resource-type"].includes(type)) continue;
    if (t["load-type"] && !t["load-type"].includes(third ? "third-party" : "first-party")) continue;
    if (!new RegExp(t["url-filter"], "i").test(url)) continue;
    blocked = r.action.type === "block";
  }
  return blocked;
}

// --- The in-page guard (every frame, document start) -----------------------------

// --- The media sniffer (every frame, document start) ------------------------------

/**
 * Finds the stream a page plays, in every frame (macOS/iOS: the native
 * all-frames user script; Android: the top document, the Android Sniffer
 * sees the inner frames' requests natively). Independent of ad blocking:
 * it runs on every web page that is not one of the app's own (localhost,
 * about:).
 *
 * - Sources: fetch and XHR (request URL, the headers the page set, then the
 *   response's content-type and first bytes), resource timing
 *   (PerformanceObserver), `<video>`/`<source>` src, hls.js `loadSource`,
 *   MediaSource / createObjectURL (a hint only).
 * - Classified by extension, content-type and body prefix (`#EXTM3U`,
 *   `<MPD`, ftyp/moof, MPEG-TS sync) so extension-less and disguised
 *   playlists count; a page-side proxy (`…?url=<encoded m3u8>`, base64 path)
 *   is reported as the wrapper the page fetched plus the decoded inner URL.
 * - Each record carries the frame's origin, URL, referrer, readable cookies,
 *   the referrer policy, the user agent and the page-set request headers.
 * - Inner frames never talk to the native message handlers (a frame without
 *   a URL can upset wry): they post `"__rfs:" + JSON` to `window.top`, and
 *   the top frame hands records to the app as `{t:-11, m}`.
 * - Resolver mode (`window.__rf_sniff.resolver()`, called by the resolver's
 *   bridge; passed down to every frame): media is muted, and paused once a
 *   playlist was seen; the page is told it is visible (document.hidden,
 *   IntersectionObserver, requestAnimationFrame keep running in the hidden
 *   view); a frame with no media after a while gets one synthetic click on
 *   its play element; the ad guard's isolation stands down.
 */
export const SNIFF_JS = `(function () {
  if (window.__rf_sniff) return;
  var SN = window.__rf_sniff = { mode: '' };
  try {
  var proto = '';
  try { proto = String(location.protocol); } catch (e) {}
  var host0 = '';
  try { host0 = String(location.hostname); } catch (e) {}
  var TOP = false;
  try { TOP = window.top === window; } catch (e) {}
  // The app's own pages: nothing at all. Inner about:blank/srcdoc frames
  // still sniff (their parent's page drives them) but never post natively.
  if (TOP && (proto !== 'http:' && proto !== 'https:')) { SN.mode = 'off'; return; }
  if (host0 === '127.0.0.1' || host0 === 'localhost' || host0 === '[::1]') { SN.mode = 'off'; return; }
  // The frame's origin and URL as a request from it carries them: an
  // about:srcdoc / about:blank frame acts with its parent's origin, and its
  // requests carry the parent's URL as Referer.
  var origin = '', fhref = '';
  try { origin = String(window.origin || location.origin); } catch (e) {}
  try { fhref = String(location.href); } catch (e) {}
  if (proto === 'about:' || proto === 'data:') {
    try { fhref = String(window.parent.location.href); } catch (e) { fhref = origin && origin !== 'null' ? origin + '/' : ''; }
    try { if (!origin || origin === 'null') origin = String(window.parent.location.origin); } catch (e) {}
  }
  var t0 = Date.now();
  var seen = {}, nRec = 0, nSeg = 0, nPeek = 0, gotPlaylist = false;
  var lc = function (s) { return String(s || '').toLowerCase(); };
  var abs = function (u) { try { return new URL(u, location.href).href; } catch (e) { return ''; } };
  // A URL hidden in a page-side proxy: a query value or a base64 path part
  // that decodes to an http(s) URL.
  var innerOf = function (u) {
    var x;
    try { x = new URL(u); } catch (e) { return ''; }
    var out = '';
    try {
      x.searchParams.forEach(function (v) {
        if (out) return;
        if (/^https?:[/][/]/i.test(v)) out = v;
      });
    } catch (e) {}
    if (out) return out;
    var parts = x.pathname.split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.indexOf('aHR0c') !== 0 || p.length < 12) continue;
      try {
        var b = p.replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        var d = atob(b);
        if (/^https?:[/][/]/i.test(d)) return d;
      } catch (e) {}
    }
    return '';
  };
  // By URL: what the extension (of the URL or of its inner URL) says.
  var byExt = function (u) {
    var s = lc(u).split('#')[0];
    var path = s.split('?')[0];
    var test = function (t) {
      if (/[.]m3u8?$/.test(t) || t.indexOf('.m3u8') >= 0) return 'hls';
      if (/[.]mpd$/.test(t) || t.indexOf('.mpd?') >= 0) return 'dash';
      if (/[.](m4s|ts|aac|m4a|m4v-seg)$/.test(t)) return 'seg';
      if (/[.](mp4|m4v|mov|webm|mkv)$/.test(t)) return 'mp4';
      return '';
    };
    var k = test(path);
    if (k) return k;
    var inner = innerOf(u);
    if (inner) { k = test(lc(inner).split('#')[0].split('?')[0]); if (k) return k; if (lc(inner).indexOf('.m3u8') >= 0) return 'hls'; }
    if (s.indexOf('.m3u8') >= 0) return 'hls';
    return '';
  };
  var byType = function (ct) {
    ct = lc(ct);
    if (!ct) return '';
    if (ct.indexOf('mpegurl') >= 0) return 'hls';
    if (ct.indexOf('dash+xml') >= 0) return 'dash';
    if (ct.indexOf('video/mp2t') >= 0 || ct.indexOf('video/iso.segment') >= 0) return 'seg';
    if (ct.indexOf('video/') === 0 || ct.indexOf('audio/mp4') === 0) return 'mp4';
    return '';
  };
  var peekable = function (ct) {
    ct = lc(ct);
    return !ct || ct.indexOf('octet') >= 0 || ct.indexOf('text/plain') >= 0 || ct.indexOf('binary') >= 0 ||
      ct.indexOf('text/html') >= 0 || ct.indexOf('image/') === 0 || ct.indexOf('application/x-') === 0;
  };
  // By body: the first bytes (string or Uint8Array).
  var byBody = function (b) {
    if (!b) return '';
    if (typeof b === 'string') {
      var t = b.replace(/^[\\s\\ufeff]+/, '').slice(0, 64);
      if (t.indexOf('#EXTM3U') === 0) return b.indexOf('#EXT-X-STREAM-INF') >= 0 ? 'hls-master' : 'hls-media';
      if (t.indexOf('<?xml') === 0 && b.slice(0, 600).indexOf('<MPD') >= 0) return 'dash';
      if (t.indexOf('<MPD') === 0) return 'dash';
      return '';
    }
    var a = b;
    if (a.length >= 8) {
      var s7 = String.fromCharCode(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
      if (s7 === '#EXTM3U') return 'hls';
      var box = String.fromCharCode(a[4], a[5], a[6], a[7]);
      if (box === 'ftyp' || box === 'moof' || box === 'styp' || box === 'moov') return 'mp4box';
    }
    if (a.length > 188 && a[0] === 0x47 && a[188] === 0x47) return 'seg';
    if (a.length >= 4 && a[0] === 0x89 && a[1] === 0x50 && a[2] === 0x4e && a[3] === 0x47) {
      for (var i = 8; i < a.length - 188; i++) if (a[i] === 0x47 && a[i + 188] === 0x47) return 'seg';
    }
    return '';
  };
  // --- Subtitles ---------------------------------------------------------------
  // By URL (the extension of the URL or of its inner URL).
  var subExt = function (u) {
    var t = function (x) {
      var m = lc(x).split('#')[0].split('?')[0].match(/[.](vtt|webvtt|srt|ass|ssa)$/);
      return m ? (m[1] === 'webvtt' ? 'vtt' : m[1]) : '';
    };
    var k = t(u);
    if (k) return k;
    var inner = innerOf(u);
    return inner ? t(inner) : '';
  };
  // By body: WebVTT, SubRip, ASS.
  var subBody = function (b) {
    if (typeof b !== 'string') return '';
    var x = b.replace(/^[\\s\\ufeff]+/, '').slice(0, 120);
    if (x.indexOf('WEBVTT') === 0) return 'vtt';
    if (/^[0-9]+[ \\t]*\\r?\\n[0-9]{1,2}:[0-9]{2}:[0-9]{2}[,.][0-9]+[ \\t]*-->/.test(x)) return 'srt';
    if (x.indexOf('[Script Info]') === 0) return 'ass';
    return '';
  };
  var nSub = 0, nJson = 0;
  var subRec = function (u, fmt, lang, label, via, hdrs, def) {
    rec(u, 'sub', fmt || 'vtt', via, '', hdrs, { lang: String(lang || '').slice(0, 40), label: String(label || '').slice(0, 120), def: !!def });
  };
  // Subtitle lists inside JSON API answers and player set-up objects:
  // objects with a URL-ish field that looks like a subtitle file, plus a
  // label/language when they have one.
  var URLK = ['file', 'url', 'src', 'link', 'path', 'SubDownloadLink', 'download', 'uri', 'href'];
  var LABK = ['label', 'display', 'name', 'title', 'LanguageName', 'languageName', 'language_name', 'lang_name'];
  var LANGK = ['srclang', 'lang', 'language', 'code', 'ISO639', 'iso639', 'iso', 'languageCode', 'langCode', 'lang_code', 'locale'];
  var firstStr = function (o, ks) {
    for (var i = 0; i < ks.length; i++) {
      var v = o[ks[i]];
      if (typeof v === 'string' && v && v.length < 200) return v;
    }
    return '';
  };
  var walk = function (x, base, depth, out) {
    if (!x || typeof x !== 'object' || depth > 8 || out.n > 4000 || out.l.length >= 150) return;
    out.n++;
    if (x.nodeType || x === window) return;
    if (Array.isArray(x)) {
      for (var i = 0; i < x.length && i < 600; i++) walk(x[i], base, depth + 1, out);
      return;
    }
    var pr = null;
    try { pr = Object.getPrototypeOf(x); } catch (e) { return; }
    if (pr && pr !== Object.prototype && !Array.isArray(x.tracks) && !x.subtitle && !x.subtitles) return;
    var u = '';
    for (var a = 0; a < URLK.length; a++) {
      var v = x[URLK[a]];
      if (typeof v === 'string' && v.length < 3000 && /^(https?:|[/]|[.][.]?[/])/i.test(v)) { u = v; break; }
    }
    if (u) {
      var kind = lc(typeof x.kind === 'string' ? x.kind : '');
      var named = kind === 'captions' || kind === 'subtitles' || kind === 'subtitle';
      if (kind !== 'thumbnails' && kind !== 'chapters' && kind !== 'metadata' && kind !== 'descriptions' &&
        (named || subExt(u) || /subtitle|caption|[/]subs?[/]|[.]vtt|[.]srt/i.test(u)) && !byExt(u)) {
        var full = '';
        try { full = new URL(u, base).href; } catch (e) {}
        if (full) {
          var fmt = subExt(full) || lc(firstStr(x, ['format', 'SubFormat', 'type'])).replace(/[^a-z]/g, '');
          if (!/^(vtt|srt|ass|ssa)$/.test(fmt)) fmt = '';
          out.l.push({ u: full, fmt: fmt, lang: firstStr(x, LANGK), label: firstStr(x, LABK), def: !!(x['default'] || x.isDefault) });
        }
      }
    }
    for (var k in x) {
      if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
      var w = null;
      try { w = x[k]; } catch (e) {}
      if (w && typeof w === 'object') walk(w, base, depth + 1, out);
    }
  };
  var scanObj = function (obj, base, via, hdrs) {
    var out = { n: 0, l: [] };
    try { walk(obj, base, 0, out); } catch (e) {}
    for (var i = 0; i < out.l.length; i++) {
      var it = out.l[i];
      subRec(it.u, it.fmt, it.lang, it.label, via, hdrs, it.def);
    }
    return out.l.length;
  };
  SN.scanObj = scanObj;
  var isJson = function (ct) { ct = lc(ct); return ct.indexOf('json') >= 0; };
  var scanText = function (tx, base, via, hdrs) {
    if (typeof tx !== 'string' || tx.length > 3000000) return;
    var t = tx.replace(/^[\\s\\ufeff]+/, '');
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return;
    try { scanObj(JSON.parse(t), base, via, hdrs); } catch (e) {}
  };
  var refPolicy = function () {
    try {
      var m = document.querySelector('meta[name=referrer]');
      if (m) return lc(m.getAttribute('content'));
    } catch (e) {}
    return '';
  };
  var ck = function () { try { return String(document.cookie || '').slice(0, 2000); } catch (e) { return ''; } };
  var relay = function (s) {
    if (TOP) {
      try { if (window.nsh && window.nsh.postMessage) { window.nsh.postMessage(s); return; } } catch (e) {}
      try { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(s); } catch (e) {}
    }
  };
  var mediaPause = null;
  // One media URL the page requested (or was given).
  var rec = function (u, kind, role, via, ct, hdrs, extra) {
    if (SN.mode === 'off') return;
    u = abs(u);
    if (!/^https?:/i.test(u)) return;
    if (kind === 'seg') { if (nSeg >= 3) return; }
    var key = u + '|' + role;
    if (seen[key]) return;
    seen[key] = 1;
    if (kind === 'sub') { if (nSub >= 150) return; nSub++; }
    else { if (nRec >= 60) return; nRec++; }
    if (kind === 'seg') nSeg++;
    var r = { u: u, k: kind, r: role, via: via, ct: ct || '', fo: origin, fr: fhref.slice(0, 500),
      ref: String(document.referrer || '').slice(0, 500), ck: ck(), ua: navigator.userAgent || '', rp: refPolicy(),
      top: TOP, ms: Date.now() - t0 };
    var inner = innerOf(u);
    if (inner) r.inner = inner;
    if (hdrs) {
      var h = {}, any = false;
      for (var k in hdrs) { if (hdrs[k] != null) { h[k] = String(hdrs[k]); any = true; } }
      if (any) r.h = h;
    }
    if (extra) for (var x in extra) r[x] = extra[x];
    if (kind === 'hls' || kind === 'dash' || kind === 'mp4') {
      if (!gotPlaylist) { gotPlaylist = true; if (SN.mode === 'resolver' && mediaPause) setTimeout(mediaPause, 1500); }
    }
    SN.last = r;
    var s = JSON.stringify(r);
    if (TOP) relay(JSON.stringify({ t: -11, m: r }));
    else { try { window.top.postMessage('__rfs:' + s, '*'); } catch (e) {} }
  };
  SN.rec = rec;
  // Classifies a finished request: URL first, then content-type, then the
  // body's first bytes (peek, when the type says nothing).
  var judge = function (u, via, hdrs, ct, body) {
    var sb = typeof body === 'string' ? subBody(body) : '';
    var lct = lc(ct);
    if (sb || (!byExt(u) && (subExt(u) || lct.indexOf('text/vtt') >= 0 || lct.indexOf('subrip') >= 0))) {
      subRec(u, sb || subExt(u) || (lct.indexOf('subrip') >= 0 ? 'srt' : 'vtt'), '', '', via, hdrs);
      return;
    }
    var k = byExt(u);
    var t = byType(ct);
    var b = body !== undefined ? byBody(body) : '';
    var role = '';
    if (b === 'hls-master') { k = 'hls'; role = 'master'; }
    else if (b === 'hls-media') { k = 'hls'; role = 'media'; }
    else if (b === 'hls') k = 'hls';
    else if (b === 'dash') k = 'dash';
    else if (b === 'seg') k = 'seg';
    else if (b === 'mp4box') k = k === 'seg' || /init|seg|frag|chunk/i.test(u) ? 'seg' : (k || 'mp4');
    if (!k) k = t;
    if (!k) return;
    if (!role) role = k === 'seg' ? 'segment' : (k === 'mp4' ? 'file' : '');
    rec(u, k, role, via, ct, hdrs);
  };
  var hdrObj = function (h) {
    var o = {};
    try {
      if (!h) return o;
      if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach(function (v, k) { o[k] = v; });
      else if (Array.isArray(h)) for (var i = 0; i < h.length; i++) o[h[i][0]] = h[i][1];
      else if (typeof h === 'object') for (var k2 in h) o[k2] = h[k2];
    } catch (e) {}
    return o;
  };
  var interesting = function (u, ct) {
    return !!byExt(u) || !!byType(ct) || !!subExt(u) || lc(ct).indexOf('text/vtt') >= 0 ||
      (isJson(ct) && nJson < 30) || (peekable(ct) && nPeek < 40);
  };
  // fetch
  try {
    var oF = window.fetch;
    if (oF) window.fetch = function (a, init) {
      var p = oF.apply(this, arguments);
      try {
        var u = typeof a === 'string' ? a : (a && a.url) || String(a || '');
        var hd = hdrObj(init && init.headers !== undefined ? init.headers : (a && a.headers));
        if (p && p.then) p.then(function (resp) {
          try {
            if (!resp) return;
            var ct = resp.headers && resp.headers.get ? resp.headers.get('content-type') || '' : '';
            var fu = resp.url || u;
            if (!interesting(fu, ct)) return;
            if (isJson(ct) && !byExt(fu)) {
              nJson++;
              resp.clone().text().then(function (tx) { scanText(tx, fu, 'json', hd); }, function () {});
              return;
            }
            if (subExt(fu) && !byExt(fu)) { judge(fu, 'fetch', hd, ct); return; }
            // A file/segment/DASH extension is enough: never tee a segment's body.
            if (byExt(fu) && byExt(fu) !== 'hls') { judge(fu, 'fetch', hd, ct); return; }
            if (byType(ct) === 'hls') {
              resp.clone().text().then(function (tx) { judge(fu, 'fetch', hd, ct, tx.slice(0, 200000)); }, function () { judge(fu, 'fetch', hd, ct); });
              return;
            }
            if (!peekable(ct) || !resp.clone || !resp.body) { judge(fu, 'fetch', hd, ct); return; }
            nPeek++;
            var rd = resp.clone().body.getReader();
            rd.read().then(function (r) {
              try { rd.cancel(); } catch (e) {}
              var v = r && r.value ? r.value : null;
              var body = v;
              // Text-looking bytes (#EXTM3U, WEBVTT, SubRip numbers, JSON, a BOM).
              if (v && v.length && (v[0] === 0x23 || v[0] === 0x57 || (v[0] >= 0x30 && v[0] <= 0x39) || v[0] === 0x7b || v[0] === 0x5b || v[0] === 0xef)) {
                try { body = new TextDecoder().decode(v); } catch (e) {}
                if (typeof body === 'string' && (body.charAt(0) === '{' || body.charAt(0) === '[') && nJson < 30) {
                  nJson++;
                  resp.clone().text().then(function (tx) { scanText(tx, fu, 'json', hd); }, function () {});
                }
              }
              judge(fu, 'fetch', hd, ct, body);
            }, function () { judge(fu, 'fetch', hd, ct); });
          } catch (e) {}
        }, function () {});
      } catch (e) {}
      return p;
    };
  } catch (e) {}
  // XMLHttpRequest
  try {
    var XP = XMLHttpRequest.prototype, oO = XP.open, oH = XP.setRequestHeader, oS = XP.send;
    XP.open = function (m, u) {
      try { this.__rfs = { u: String(u || ''), h: {} }; } catch (e) {}
      return oO.apply(this, arguments);
    };
    XP.setRequestHeader = function (k, v) {
      try { if (this.__rfs) this.__rfs.h[k] = v; } catch (e) {}
      return oH.apply(this, arguments);
    };
    XP.send = function () {
      var x = this;
      try {
        if (x.__rfs && !x.__rfsl) {
          x.__rfsl = 1;
          x.addEventListener('load', function () {
            try {
              var info = x.__rfs;
              var u = x.responseURL || info.u;
              var ct = '';
              try { ct = x.getResponseHeader('content-type') || ''; } catch (e) {}
              if (!interesting(u, ct)) return;
              var body;
              var rt = x.responseType;
              if (isJson(ct) && !byExt(u)) {
                nJson++;
                if (rt === 'json') { try { scanObj(x.response, u, 'json', info.h); } catch (e) {} }
                else if (rt === '' || rt === 'text') { try { scanText(String(x.responseText || ''), u, 'json', info.h); } catch (e) {} }
                return;
              }
              if (rt === '' || rt === 'text') { try { body = String(x.responseText || '').slice(0, 200000); } catch (e) {} }
              else if (rt === 'arraybuffer' && x.response) { try { body = new Uint8Array(x.response, 0, Math.min(x.response.byteLength, 4096)); } catch (e) {} }
              judge(u, 'xhr', info.h, ct, body);
            } catch (e) {}
          });
        }
      } catch (e) {}
      return oS.apply(this, arguments);
    };
  } catch (e) {}
  // Resource timing: requests no hook saw (native <video> HLS, workers'
  // results are not visible). URL-only.
  try {
    if (window.PerformanceObserver) {
      var po = new PerformanceObserver(function (l) {
        var es = l.getEntries();
        for (var i = 0; i < es.length; i++) {
          var k = byExt(es[i].name);
          if (k) rec(es[i].name, k, k === 'seg' ? 'segment' : (k === 'mp4' ? 'file' : ''), 'perf:' + (es[i].initiatorType || ''));
        }
      });
      po.observe({ type: 'resource', buffered: true });
      SN.po = po;
    }
  } catch (e) {}
  // Media elements: a direct src (native HLS on iOS, progressive files).
  var srcOf = function (el) {
    var s = '';
    try { s = el.currentSrc || el.src || el.getAttribute('src') || ''; } catch (e) {}
    return s;
  };
  var noteMedia = function (el) {
    try {
      if (!el || !el.tagName) return;
      var s = srcOf(el);
      if (!s || s.indexOf('blob:') === 0) { if (s) SN.mse = true; return; }
      var k = byExt(s) || 'mp4';
      rec(s, k, k === 'mp4' ? 'file' : '', el.tagName.toLowerCase());
    } catch (e) {}
  };
  try {
    var MP = HTMLMediaElement.prototype;
    var sd = Object.getOwnPropertyDescriptor(MP, 'src');
    if (sd && sd.set) Object.defineProperty(MP, 'src', { configurable: true, enumerable: sd.enumerable, get: sd.get,
      set: function (v) { sd.set.call(this, v); var self = this; setTimeout(function () { noteMedia(self); }, 0); } });
    document.addEventListener('loadstart', function (e) { var t = e.target; if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) noteMedia(t); }, true);
  } catch (e) {}
  // src attributes from the parser or set later (a hidden view may never
  // start loading them, so the element is read, not its network request).
  var noteSrcEl = function (n) {
    try {
      if (!n || n.nodeType !== 1) return;
      var tg = n.tagName;
      if (tg === 'VIDEO' || tg === 'AUDIO') { if (n.getAttribute('src')) noteMedia(n); }
      else if (tg === 'TRACK') {
        var kd = lc(n.getAttribute('kind'));
        var ts = n.getAttribute('src');
        if (!ts || ts.indexOf('blob:') === 0 || ts.indexOf('data:') === 0) return;
        if (kd && kd !== 'subtitles' && kd !== 'captions') return;
        subRec(ts, subExt(ts) || 'vtt', n.getAttribute('srclang') || '', n.getAttribute('label') || '', 'track', null, n.hasAttribute('default'));
      } else if (tg === 'SOURCE') {
        var s = n.getAttribute('src'), ty = lc(n.getAttribute('type'));
        if (!s || s.indexOf('blob:') === 0) return;
        var k = byExt(s) || (ty.indexOf('mpegurl') >= 0 ? 'hls' : ty.indexOf('dash') >= 0 ? 'dash' : 'mp4');
        rec(s, k, k === 'mp4' ? 'file' : '', 'source');
      } else if (n.querySelectorAll && n.firstElementChild) {
        var l = n.querySelectorAll('video[src],audio[src],source[src],track[src]');
        for (var i = 0; i < l.length; i++) noteSrcEl(l[i]);
      }
    } catch (e) {}
  };
  try {
    var smo = new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (m.type === 'attributes') noteSrcEl(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) noteSrcEl(m.addedNodes[j]);
      }
    });
    smo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    SN.mo = smo;
  } catch (e) {}
  try {
    var oC = URL.createObjectURL;
    URL.createObjectURL = function (o) {
      try { if (o && window.MediaSource && o instanceof MediaSource) SN.mse = true; } catch (e) {}
      try { if (o && window.ManagedMediaSource && o instanceof ManagedMediaSource) SN.mse = true; } catch (e) {}
      return oC.apply(this, arguments);
    };
  } catch (e) {}
  // hls.js as a global: loadSource(url) names the master playlist.
  try {
    var hookHls = function (H) {
      try {
        if (!H || !H.prototype || H.prototype.__rfs) return;
        var oL = H.prototype.loadSource;
        if (!oL) return;
        H.prototype.__rfs = 1;
        H.prototype.loadSource = function (u) { try { rec(u, 'hls', 'master?', 'hls.js'); } catch (e) {} return oL.apply(this, arguments); };
      } catch (e) {}
    };
    var curH = window.Hls;
    if (curH) hookHls(curH);
    else Object.defineProperty(window, 'Hls', { configurable: true, enumerable: true,
      get: function () { return curH; }, set: function (v) { curH = v; hookHls(v); } });
  } catch (e) {}
  // Players' set-up calls carry their subtitle lists (JW Player 'setup',
  // video.js options / addRemoteTextTrack, Plyr / ArtPlayer / DPlayer /
  // Clappr options): the globals are wrapped when the page defines them and
  // every argument object is scanned (read only; the call goes through).
  try {
    var scanArgs = function (args) {
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a && typeof a === 'object' && !a.nodeType) scanObj(a, location.href, 'player', null);
      }
    };
    var wrapInst = function (o) {
      if (!o || typeof o !== 'object' || o.__rfsw) return o;
      try {
        o.__rfsw = 1;
        var ms = ['setup', 'load', 'addRemoteTextTrack', 'setSubtitle', 'switchSubtitle'];
        for (var i = 0; i < ms.length; i++) (function (m) {
          var f = o[m];
          if (typeof f !== 'function') return;
          o[m] = function () {
            try { scanArgs(arguments); } catch (e) {}
            var r = f.apply(this, arguments);
            return r === o || !r ? r : wrapInst(r);
          };
        })(ms[i]);
      } catch (e) {}
      return o;
    };
    var wrapGlobal = function (name) {
      var cur = window[name];
      var make = function (f) {
        if (typeof f !== 'function' || f.__rfsw) return f;
        var W = function () {
          try { scanArgs(arguments); } catch (e) {}
          var r = new.target ? Reflect.construct(f, arguments, new.target === W ? f : new.target) : f.apply(this, arguments);
          return wrapInst(r);
        };
        try { Object.setPrototypeOf(W, f); W.prototype = f.prototype; W.__rfsw = 1; } catch (e) {}
        return W;
      };
      if (cur) { try { window[name] = make(cur); } catch (e) {} return; }
      Object.defineProperty(window, name, { configurable: true, enumerable: true,
        get: function () { return cur; }, set: function (v) { cur = make(v); } });
    };
    var PG = ['jwplayer', 'videojs', 'Plyr', 'Artplayer', 'DPlayer', 'Clappr'];
    for (var pg = 0; pg < PG.length; pg++) wrapGlobal(PG[pg]);
  } catch (e) {}
  // --- Resolver mode ---------------------------------------------------------
  var kidsWins = function () {
    var out = [];
    try { for (var i = 0; i < window.frames.length; i++) out.push(window.frames[i]); } catch (e) {}
    return out;
  };
  var tell = function (w, o) { try { w.postMessage('__rfs:' + JSON.stringify(o), '*'); } catch (e) {} };
  var mute = function (v) {
    try { if (!v.muted) v.muted = true; if (v.volume) v.volume = 0; } catch (e) {}
  };
  var allMedia = function () {
    try { return document.querySelectorAll('video,audio'); } catch (e) { return []; }
  };
  mediaPause = function () {
    var vs = allMedia();
    for (var i = 0; i < vs.length; i++) { try { mute(vs[i]); vs[i].pause(); } catch (e) {} }
    SN.paused = true;
  };
  var clicks = 0;
  // Timers of a hidden view's cross-origin frames can be throttled for
  // seconds; the app's polls (a message to the top frame every ~1.5 s) are
  // passed down as ticks so a frame still gets its click on time.
  var maybeClick = function () {
    var age = Date.now() - t0;
    if (clicks === 0 && age >= 2500) tryClick();
    else if (clicks === 1 && age >= 7000) tryClick();
  };
  var tickKids = function () {
    var ks = kidsWins();
    for (var i = 0; i < ks.length; i++) tell(ks[i], { tick: 1 });
  };
  var tryClick = function () {
    if (SN.mode !== 'resolver' || gotPlaylist || clicks >= 2) return;
    var el = null;
    try { if (window.__rf_guard && window.__rf_guard.findPlay) el = window.__rf_guard.findPlay(); } catch (e) {}
    if (!el) {
      var sel = ['#pl_but', '.jw-display-icon-display', '.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid',
        '[aria-label="Play"]', '.play-button', '.play-btn', '.btn-play', '#play', '.play', '[class*="play-button"]', '[class*="PlayButton"]'];
      for (var i = 0; i < sel.length && !el; i++) { try { el = document.querySelector(sel[i]); } catch (e) {} }
    }
    if (!el) return;
    clicks++;
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    var ev = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var j = 0; j < ev.length; j++) {
      try {
        var E = ev[j].indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
        el.dispatchEvent(new E(ev[j], o));
      } catch (e) {}
    }
    SN.clicked = (SN.clicked || 0) + 1;
    rec(location.href, 'note', 'click', 'resolver', '', null, { el: (el.tagName || '') + (el.id ? '#' + el.id : '') + '.' + String(el.className || '').slice(0, 40) });
  };
  SN.resolver = function () {
    if (SN.mode === 'resolver' || SN.mode === 'off') return;
    SN.mode = 'resolver';
    var vs = allMedia();
    for (var i = 0; i < vs.length; i++) mute(vs[i]);
    if (gotPlaylist) setTimeout(mediaPause, 1500);
    try { if (window.__rf_guard && window.__rf_guard.resolver) window.__rf_guard.resolver(); } catch (e) {}
    var ks = kidsWins();
    for (var k = 0; k < ks.length; k++) tell(ks[k], { mode: 'resolver' });
    setTimeout(tryClick, 2500);
    setTimeout(tryClick, 7000);
  };
  var onMediaEv = function (e) {
    if (SN.mode !== 'resolver') return;
    var v = e.target;
    if (!v || (v.tagName !== 'VIDEO' && v.tagName !== 'AUDIO')) return;
    mute(v);
    if (SN.paused && e.type === 'play') { try { v.pause(); } catch (x) {} }
  };
  var MEVS = ['loadstart', 'loadedmetadata', 'play', 'playing', 'volumechange'];
  for (var mi = 0; mi < MEVS.length; mi++) document.addEventListener(MEVS[mi], onMediaEv, true);
  try {
    var oPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (SN.mode === 'resolver') mute(this);
      return oPlay.apply(this, arguments);
    };
  } catch (e) {}
  // Visible to the page while the resolver view is hidden.
  try {
    var dp = Document.prototype;
    var hd0 = Object.getOwnPropertyDescriptor(dp, 'hidden');
    var vs0 = Object.getOwnPropertyDescriptor(dp, 'visibilityState');
    if (hd0 && hd0.get) Object.defineProperty(document, 'hidden', { configurable: true,
      get: function () { return SN.mode === 'resolver' ? false : hd0.get.call(document); } });
    if (vs0 && vs0.get) Object.defineProperty(document, 'visibilityState', { configurable: true,
      get: function () { return SN.mode === 'resolver' ? 'visible' : vs0.get.call(document); } });
  } catch (e) {}
  try {
    var IO = window.IntersectionObserver;
    if (IO) {
      var RIO = function (cb, opts) {
        var io = new IO(cb, opts);
        var oObs = io.observe;
        io.observe = function (el) {
          var r = oObs.apply(io, arguments);
          if (SN.mode === 'resolver') setTimeout(function () {
            try {
              var b = el.getBoundingClientRect();
              cb([{ target: el, isIntersecting: true, intersectionRatio: 1, boundingClientRect: b, intersectionRect: b,
                rootBounds: null, time: performance.now() }], io);
            } catch (e) {}
          }, 50);
          return r;
        };
        return io;
      };
      RIO.prototype = IO.prototype;
      window.IntersectionObserver = RIO;
    }
  } catch (e) {}
  try {
    // A hidden view may never paint: frames also run on a timer there.
    var oRAF = window.requestAnimationFrame, oCAF = window.cancelAnimationFrame, gone = {};
    if (oRAF) window.requestAnimationFrame = function (cb) {
      if (SN.mode !== 'resolver') return oRAF.call(window, cb);
      var done = false, id = 0;
      var run = function (ts) {
        if (done || gone[id]) return;
        done = true;
        try { cb(ts || performance.now()); } catch (e) { setTimeout(function () { throw e; }, 0); }
      };
      id = oRAF.call(window, run);
      setTimeout(function () { run(performance.now()); delete gone[id]; }, 100);
      return id;
    };
    if (oCAF) window.cancelAnimationFrame = function (id) {
      if (SN.mode === 'resolver') gone[id] = 1;
      return oCAF.call(window, id);
    };
  } catch (e) {}
  // --- Messages ----------------------------------------------------------------
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (typeof d !== 'string' || d.indexOf('__rfs:') !== 0) return;
    try { e.stopImmediatePropagation(); } catch (x) {}
    var m;
    try { m = JSON.parse(d.slice(6)); } catch (x) { return; }
    if (!m) return;
    if (m.u && TOP) { relay(JSON.stringify({ t: -11, m: m })); return; }
    if (m.hi) { if (SN.mode === 'resolver' && e.source) tell(e.source, { mode: 'resolver' }); return; }
    if (m.mode === 'resolver' && e.source === window.parent && !TOP) SN.resolver();
    if (m.tick && e.source === window.parent && !TOP && SN.mode === 'resolver') { tickKids(); maybeClick(); }
  }, true);
  // The app's messages to the top frame (its polls) drive the ticks.
  if (TOP) window.addEventListener('message', function (e) {
    if (e.source || SN.mode !== 'resolver' || typeof e.data !== 'string' || e.data.charAt(0) !== '{') return;
    tickKids();
    maybeClick();
  }, true);
  if (!TOP) { try { window.parent.postMessage('__rfs:' + JSON.stringify({ hi: 1 }), '*'); } catch (e) {} }
  } catch (err) {
    try { if (window.nsh && window.nsh.postMessage) window.nsh.postMessage(JSON.stringify({ t: -8, msg: 'sniffer threw: ' + String(err && err.stack || err).slice(0, 300) })); } catch (e) {}
  }
})();
`;

const GUARD_DATA = {
  emb: embedHosts(),
  ad: AD_HOSTS,
  pat: AD_PATTERNS.filter((p) => p.re !== ".*").map((p) => p.re),
};

/**
 * Document-start guard for every frame of the player / resolver pages
 * (layers 2–4 above). Installed natively in every frame on macOS/iOS and,
 * as part of PLAYER_BRIDGE, in the top document everywhere (Android:
 * top document only). Idempotent (`window.__rf_guard`). Talks to its parent
 * frame with `"__rfg:" + JSON` messages, and the top frame to the app with
 * `{t:-10}` reports; the app turns it off with `{t:'guard',on:false}`.
 */
export const GUARD_JS = SNIFF_JS + `(function () {
  if (window.__rf_guard) return;
  var G = window.__rf_guard = { on: true };
  // Diagnostics: parts the app switched off for this page (G.skip).
  G.skip = {};
  var en = function (k) { return G.on && !G.skip[k]; };
  try {
  var D = ${JSON.stringify(GUARD_DATA)};
  var TOP = false;
  try { TOP = window.top === window; } catch (e) {}
  var lc = function (s) { return String(s || '').toLowerCase(); };
  var site = function (h) {
    var p = lc(h).replace(/[.]$/, '').split('.');
    if (p.length <= 2) return p.join('.');
    var sl = p[p.length - 2], tl = p[p.length - 1];
    if (tl.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go)$/.test(sl)) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  };
  var EMB = {}, ADH = {}, PAT = [];
  for (var i0 = 0; i0 < D.emb.length; i0++) EMB[D.emb[i0]] = 1;
  for (var i1 = 0; i1 < D.ad.length; i1++) ADH[D.ad[i1]] = 1;
  for (var i2 = 0; i2 < D.pat.length; i2++) { try { PAT.push(new RegExp(D.pat[i2], 'i')); } catch (e) {} }
  var inList = function (h, set) {
    h = lc(h);
    while (h) {
      if (set[h]) return true;
      var k = h.indexOf('.');
      if (k < 0) return false;
      h = h.slice(k + 1);
    }
    return false;
  };
  // Only an embed source's pages (and the frames inside them) are guarded.
  // The app's own pages - the downloads' localhost player, about:blank, any
  // non-source page - get nothing at all: no patches, observers or sweeps.
  // The top document's host decides (location.ancestorOrigins in frames).
  var topHost = '';
  try {
    var ao = location.ancestorOrigins;
    if (!TOP && ao && ao.length) topHost = new URL(ao[ao.length - 1]).hostname;
    else if (TOP) topHost = location.hostname;
    else topHost = '?';
  } catch (e) { topHost = TOP ? '' : '?'; }
  if (topHost !== '?' && !(topHost && inList(site(topHost), EMB))) {
    G.on = false;
    G.inert = true;
    return;
  }
  var parse = function (u) { try { return new URL(u, location.href); } catch (e) { return null; } };
  var here = function () { try { return lc(location.hostname); } catch (e) { return ''; } };
  // A link/navigation target outside this frame's site and the embed hosts
  // (other schemes than web ones count as outside; javascript: does not).
  var offsite = function (u) {
    var x = parse(u);
    if (!x) return false;
    var pr = x.protocol;
    if (pr === 'javascript:' || pr === 'about:' || pr === 'blob:' || pr === 'data:') return false;
    if (pr !== 'http:' && pr !== 'https:') return true;
    var h = lc(x.hostname);
    if (site(h) === site(here())) return false;
    return !inList(site(h), EMB);
  };
  var isAd = function (u) {
    var x = parse(u);
    if (!x) return false;
    if (inList(x.hostname, ADH)) return true;
    for (var i = 0; i < PAT.length; i++) if (PAT[i].test(x.href)) return true;
    return false;
  };
  // --- Diagnostics -------------------------------------------------------
  var st = { pop: 0, nav: 0, clk: 0, dlg: 0, perm: 0, fix: 0, blk: {}, hid: 0, hd: [], ev: [] };
  var dirty = false;
  var noteEv = function (k, u) {
    st[k]++; dirty = true;
    if (st.ev.length < 12) st.ev.push(k + ' ' + String(u || '').slice(0, 90));
  };
  var blk = function (u) {
    if (!u || !isAd(u)) return;
    var x = parse(u), h = x ? x.hostname : '?';
    st.blk[h] = (st.blk[h] || 0) + 1; dirty = true;
  };
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && t.nodeType === 1) blk(t.src || t.href || '');
  }, true);
  try {
    var oFetch = window.fetch;
    if (oFetch) window.fetch = function (a) {
      var p = oFetch.apply(this, arguments);
      try {
        var u = typeof a === 'string' ? a : (a && a.url) || '';
        if (u && p && p.then) p.then(null, function () { blk(u); });
      } catch (e) {}
      return p;
    };
    var oXo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      try {
        var x = this, uu = String(u || '');
        if (!x.__rfg) { x.__rfg = 1; x.addEventListener('error', function () { blk(uu); }); }
      } catch (e) {}
      return oXo.apply(this, arguments);
    };
  } catch (e) {}
  // --- Windows, links, navigations ---------------------------------------
  var fakeWin = function () {
    var w = { closed: false, opener: null, name: '', length: 0, frames: [] };
    var nop = function () {};
    w.close = function () { w.closed = true; };
    w.focus = nop; w.blur = nop; w.postMessage = nop; w.moveTo = nop; w.resizeTo = nop;
    w.addEventListener = nop; w.removeEventListener = nop; w.stop = nop; w.print = nop;
    w.location = { href: 'about:blank', assign: nop, replace: nop, reload: nop, toString: function () { return 'about:blank'; } };
    w.document = { write: nop, writeln: nop, open: nop, close: nop, title: '', body: null, documentElement: null,
      createElement: function (t) { return document.createElement(t); } };
    w.window = w; w.self = w; w.top = w; w.parent = w;
    return w;
  };
  var oOpen = window.open;
  var gOpen = function (u) {
    if (!en('pop')) return oOpen.apply(window, arguments);
    noteEv('pop', u);
    return fakeWin();
  };
  var lock = function (obj, name, val) {
    try {
      Object.defineProperty(obj, name, { configurable: true, enumerable: true, get: function () { return val; }, set: function () {} });
    } catch (e) { try { obj[name] = val; } catch (e2) {} }
  };
  lock(window, 'open', gOpen);
  try {
    var cwd = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (cwd && cwd.get) Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true, enumerable: cwd.enumerable,
      get: function () {
        var w = cwd.get.call(this);
        try { if (w && G.on && !w.__rf_guard && w.open !== gOpen) lock(w, 'open', gOpen); } catch (e) {}
        return w;
      }
    });
  } catch (e) {}
  var blankish = function (a) {
    var t = lc(a.getAttribute && a.getAttribute('target'));
    return t === '_blank' || t === '_top' || t === '_parent' || t === '_new';
  };
  var badLink = function (a) {
    if (!a || !a.href) return false;
    if (offsite(a.href)) return true;
    var x = parse(a.href);
    return blankish(a) && !!x && lc(x.hostname) !== here();
  };
  var anchorOf = function (e) {
    var p = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < p.length; i++) if (p[i] && p[i].tagName === 'A') return p[i];
    return null;
  };
  var onClk = function (e) {
    if (!en('clk')) return;
    var a = anchorOf(e);
    if (a && badLink(a)) { try { e.preventDefault(); } catch (x) {} noteEv('clk', a.href); }
  };
  window.addEventListener('click', onClk, true);
  window.addEventListener('auxclick', onClk, true);
  try {
    var oClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (en('clk') && this && this.tagName === 'A' && badLink(this)) { noteEv('clk', this.href); return; }
      return oClick.apply(this, arguments);
    };
    var oDisp = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (ev) {
      try {
        if (en('clk') && ev && ev.type === 'click' && this && this.tagName === 'A' && badLink(this)) { noteEv('clk', this.href); return true; }
      } catch (e) {}
      return oDisp.apply(this, arguments);
    };
    var oSub = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      if (en('nav') && offsite(this.action || '')) { noteEv('nav', this.action); return; }
      return oSub.apply(this, arguments);
    };
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (en('nav') && f && offsite(f.action || '')) { e.preventDefault(); noteEv('nav', f.action); }
    }, true);
  } catch (e) {}
  // Dialogs and prompts never show or block.
  var dlg = function (name, r) {
    var o = window[name];
    lock(window, name, function () {
      if (!en('dlg') && o) return o.apply(window, arguments);
      noteEv('dlg', name);
      return r;
    });
  };
  dlg('alert', undefined); dlg('confirm', false); dlg('prompt', null);
  try {
    var oAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (t) {
      if (en('dlg') && t === 'beforeunload' && this === window) { noteEv('dlg', 'beforeunload'); return; }
      return oAdd.apply(this, arguments);
    };
    Object.defineProperty(window, 'onbeforeunload', { configurable: true, get: function () { return null; }, set: function () {} });
  } catch (e) {}
  try {
    if (window.Notification) {
      var oN = window.Notification;
      var N = function () {
        noteEv('perm', 'Notification');
        return { close: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
      };
      N.permission = 'denied';
      N.requestPermission = function (cb) {
        noteEv('perm', 'notifications');
        try { if (cb) cb('denied'); } catch (e) {}
        return Promise.resolve('denied');
      };
      Object.defineProperty(window, 'Notification', { configurable: true, get: function () { return en('perm') ? N : oN; }, set: function () {} });
    }
  } catch (e) {}
  try {
    var geo = navigator.geolocation;
    if (geo) {
      var deny = function (ok, err) {
        noteEv('perm', 'geolocation');
        try { if (err) err({ code: 1, message: 'denied', PERMISSION_DENIED: 1 }); } catch (e) {}
        return 0;
      };
      var oG = geo.getCurrentPosition, oW = geo.watchPosition;
      geo.getCurrentPosition = function () { return en('perm') ? deny.apply(null, arguments) : oG.apply(geo, arguments); };
      geo.watchPosition = function () { return en('perm') ? deny.apply(null, arguments) : oW.apply(geo, arguments); };
    }
  } catch (e) {}
  try {
    var md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      var oU = md.getUserMedia;
      md.getUserMedia = function () {
        if (!en('perm')) return oU.apply(md, arguments);
        noteEv('perm', 'camera/microphone');
        return Promise.reject(new Error('NotAllowedError'));
      };
    }
  } catch (e) {}
  try {
    if (window.ServiceWorkerContainer) {
      var oR = ServiceWorkerContainer.prototype.register;
      ServiceWorkerContainer.prototype.register = function () {
        if (!en('perm')) return oR.apply(this, arguments);
        noteEv('perm', 'service worker');
        return Promise.reject(new Error('blocked'));
      };
    }
    if (window.PushManager) {
      PushManager.prototype.subscribe = function () { noteEv('perm', 'push'); return Promise.reject(new Error('blocked')); };
    }
  } catch (e) {}
  try {
    var hp = History.prototype;
    var trav = function (n) {
      var o = hp[n];
      hp[n] = function () {
        if (en('nav')) { noteEv('nav', 'history.' + n); return; }
        return o.apply(this, arguments);
      };
    };
    trav('back'); trav('forward'); trav('go');
  } catch (e) {}
  if (TOP) {
    try {
      if (window.navigation && navigation.addEventListener) navigation.addEventListener('navigate', function (e) {
        if (!en('nav') || !e.cancelable || !e.destination || e.destination.sameDocument) return;
        if (location.protocol === 'about:') return;
        var u = e.destination.url;
        if (offsite(u)) { e.preventDefault(); noteEv('nav', u); }
      });
    } catch (e) {}
  }
  // --- Isolation ---------------------------------------------------------
  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, NOSCRIPT: 1, TEMPLATE: 1, BASE: 1, SOURCE: 1, TRACK: 1 };
  var ours = function (el) {
    var id = el.id || '';
    return id.indexOf('rf-') === 0 || (el.hasAttribute && el.hasAttribute('data-rf'));
  };
  var roots = [];
  var mo = null;
  var watch = function (r) { try { if (mo) mo.observe(r, { childList: true, subtree: true }); } catch (e) {} };
  try {
    var oAS = Element.prototype.attachShadow;
    if (oAS) Element.prototype.attachShadow = function () {
      var r = oAS.apply(this, arguments);
      try { if (!ours(this)) { roots.push(r); watch(r); } } catch (e) {}
      return r;
    };
  } catch (e) {}
  var up = function (n) {
    var p = n.parentNode;
    if (p && p.nodeType === 11 && p.host) return p.host;
    return p && p.nodeType === 1 ? p : null;
  };
  var HP = ['visibility', 'opacity', 'pointer-events'];
  var hidden = [];
  var desc = function (el) {
    var cs = null;
    try { cs = getComputedStyle(el); } catch (e) {}
    var s = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    var c = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    if (c) s += '.' + c;
    if (cs) s += ' ' + cs.position + ' z' + cs.zIndex;
    try { var r = el.getBoundingClientRect(); s += ' ' + Math.round(r.width) + 'x' + Math.round(r.height); } catch (e) {}
    if (el.src) { var x = parse(el.src); s += ' ' + (x ? x.hostname : ''); }
    var t = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
    if (t) s += ' "' + t + '"';
    return s;
  };
  var noteHide = function (el) {
    st.hid++; dirty = true;
    if (st.hd.length >= 8) return;
    var cs = null;
    try { cs = getComputedStyle(el); } catch (e) {}
    var z = cs ? parseInt(cs.zIndex, 10) || 0 : 0;
    var big = el.tagName === 'IFRAME' || (cs && (cs.position === 'fixed' || cs.position === 'absolute')) || z >= 1000;
    if (big || st.hid <= 3) st.hd.push(desc(el));
  };
  // Hide: invisible + not hit-testable, never removed. 'o' (opacity only)
  // for anything that may hold the video's frame (iframes, elements with
  // iframes/videos inside), so it still counts as visible for autoplay;
  // 'v' adds visibility:hidden otherwise.
  var hasMedia = function (el) {
    try { return el.tagName === 'IFRAME' || el.tagName === 'FRAME' || !!el.querySelector('iframe,frame,video'); } catch (e) { return true; }
  };
  var setHide = function (el, kind) {
    var s = el.style;
    if (!s) return;
    s.setProperty('opacity', '0', 'important');
    s.setProperty('pointer-events', 'none', 'important');
    if (kind === 'v') s.setProperty('visibility', 'hidden', 'important');
    else if (el.__rfh && el.__rfh.k === 'v') {
      var sv = el.__rfh.s.visibility;
      if (sv[0]) s.setProperty('visibility', sv[0], sv[1]); else s.removeProperty('visibility');
    }
  };
  // Invariant: the chosen video (S.target) and every element holding it are
  // never hidden; before a video is chosen, no <video> and nothing holding
  // one is (the next sweep picks it).
  var holdsVideo = function (el) {
    if (el.tagName === 'VIDEO') return true;
    try { return !!el.querySelector('video'); } catch (e) { return false; }
  };
  var hide = function (el, pre) {
    if (!el || el.nodeType !== 1 || SKIP[el.tagName] || ours(el)) return;
    if (S.target && (el === S.target || (el.contains && el.contains(S.target)))) {
      noteEv('fix', 'refused to hide the video chain: ' + desc(el));
      return;
    }
    if (S.mode === 'pre' && holdsVideo(el)) { soon(); return; }
    var kind = pre || hasMedia(el) ? 'o' : 'v';
    if (!el.__rfh) {
      var saved = {};
      for (var i = 0; i < HP.length; i++) saved[HP[i]] = [el.style.getPropertyValue(HP[i]), el.style.getPropertyPriority(HP[i])];
      el.__rfh = { s: saved, k: kind };
      hidden.push(el);
      noteHide(el);
      try { if (amo) amo.observe(el, { attributes: true, attributeFilter: ['style'] }); } catch (e) {}
    }
    var s = el.style;
    if (el.__rfh.k !== kind || s.getPropertyValue('opacity') !== '0' || s.getPropertyPriority('opacity') !== 'important' ||
      s.getPropertyValue('pointer-events') !== 'none' || (kind === 'v' && s.getPropertyValue('visibility') !== 'hidden')) {
      setHide(el, kind);
      el.__rfh.k = kind;
    }
  };
  var unhide = function (el) {
    var h = el.__rfh;
    if (!h) return;
    el.__rfh = null;
    for (var k in h.s) {
      try {
        if (h.s[k][0]) el.style.setProperty(k, h.s[k][0], h.s[k][1]);
        else el.style.removeProperty(k);
      } catch (e) {}
    }
  };
  var amo = null;
  try {
    amo = new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) {
        var el = ms[i].target;
        if (el.__rfh && en('iso')) hide(el, el.__rfh.k === 'o' ? 'o' : null);
      }
    });
  } catch (e) {}
  var kidSeen = false;
  var NOKIDS = false;
  try { NOKIDS = /Android/i.test(navigator.userAgent || ''); } catch (e) {}
  var S = { mode: 'pre', target: null, root: null, chain: [], set: null, driven: false, blind: false, t0: Date.now(), pinned: null, my: -1, sent: -2, sentAt: 0, playAt: 0, cand: null, openAt: 0 };
  var vscore = function (v) {
    var d = 0, rs = 0;
    try { d = v.duration || 0; } catch (e) {}
    try { rs = v.readyState || 0; } catch (e) {}
    if (d === Infinity) d = 1e7;
    return rs >= 1 && d > 0 ? 1e9 + d * 10 + rs : rs;
  };
  var allEls = function (sel) {
    var out = [];
    try { var a = document.querySelectorAll(sel); for (var i = 0; i < a.length; i++) out.push(a[i]); } catch (e) {}
    for (var j = 0; j < roots.length; j++) {
      try { var b = roots[j].querySelectorAll(sel); for (var k = 0; k < b.length; k++) out.push(b[k]); } catch (e) {}
    }
    return out;
  };
  var frameOf = function (src) {
    var fs = allEls('iframe,frame');
    for (var i = 0; i < fs.length; i++) { try { if (fs[i].contentWindow === src) return fs[i]; } catch (e) {} }
    return null;
  };
  var pick = function () {
    var best = null, bs = -1;
    var vs = allEls('video');
    for (var i = 0; i < vs.length; i++) {
      var s = vscore(vs[i]);
      if (s > bs) { bs = s; best = vs[i]; }
    }
    var fs = allEls('iframe,frame'), now = Date.now();
    for (var j = 0; j < fs.length; j++) {
      var f = fs[j];
      if (typeof f.__rfvs !== 'number' || f.__rfvs < 0 || now - (f.__rfvt || 0) > 7000 || !f.isConnected) continue;
      if (f.__rfvs > bs) { bs = f.__rfvs; best = f; }
    }
    // No guard in the child frames (Android: the bridge is top-document
    // only; or the native script is missing): the largest visible frame
    // is taken for the player's.
    if (bs < 0 && !kidSeen && (NOKIDS || now - S.t0 > 3000)) {
      var area = innerWidth * innerHeight * 0.25;
      for (var q = 0; q < fs.length; q++) {
        var fr = fs[q].getBoundingClientRect(), a = fr.width * fr.height;
        if (a >= area && !(fs[q].src && isAd(fs[q].src))) { area = a; best = fs[q]; bs = 0; }
      }
    }
    return { el: best, s: bs };
  };
  // The player container of a video in a frame the app does not drive:
  // the largest ancestor that is about the video's own box.
  var container = function (v) {
    var c = v, vr = null;
    try { vr = v.getBoundingClientRect(); } catch (e) {}
    var va = vr && vr.width * vr.height > 4 ? vr.width * vr.height : (innerWidth * innerHeight);
    for (var n = 0; n < 12; n++) {
      var p = up(c);
      if (!p || p === document.body || p === document.documentElement) break;
      var r = p.getBoundingClientRect();
      if (r.width * r.height > va * 1.6 + 1) break;
      c = p;
    }
    return c;
  };
  var PLAY_RE = /(^|[^a-z])(play|start|watch|lecture|lire|ver|abspielen|смотреть)([^a-z]|$)|play-?btn|btn-?play|playbutton|play_button|big-play|vjs-big-play|jw-display-icon/i;
  var findPlay = function () {
    var els = allEls('button,[role=button],a,div,span,svg,i,img');
    var cx = innerWidth / 2, cy = innerHeight / 2, best = null, bs = -1;
    for (var i = 0; i < els.length && i < 4000; i++) {
      var e = els[i];
      if (ours(e)) continue;
      var r = e.getBoundingClientRect();
      if (r.width < 20 || r.height < 20 || r.width * r.height > innerWidth * innerHeight * 0.5) continue;
      var mx = r.left + r.width / 2, my = r.top + r.height / 2;
      if (Math.abs(mx - cx) > innerWidth * 0.3 || Math.abs(my - cy) > innerHeight * 0.3) continue;
      if (e.tagName === 'A' && badLink(e)) continue;
      var cls = typeof e.className === 'string' ? e.className : ((e.className && e.className.baseVal) || '');
      var key = (e.id || '') + ' ' + cls + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '');
      var txt = (e.textContent || '').trim();
      if (txt.length <= 20) key += ' ' + txt;
      if (!PLAY_RE.test(key)) continue;
      var sc = 1000 - Math.hypot(mx - cx, my - cy) + Math.min(r.width, 200) / 10;
      if (sc > bs) { bs = sc; best = e; }
    }
    return best;
  };
  var pin = function (el) {
    if (S.pinned === el) return;
    unpin();
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { return; }
    if (r.width >= innerWidth * 0.98 && r.height >= innerHeight * 0.98) return;
    var P = ['position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'max-width', 'max-height', 'margin', 'z-index', 'transform'];
    var V = ['fixed', '0', '0', '0', '0', '100%', '100%', 'none', 'none', '0', '2147483000', 'none'];
    var saved = {};
    for (var i = 0; i < P.length; i++) {
      saved[P[i]] = [el.style.getPropertyValue(P[i]), el.style.getPropertyPriority(P[i])];
      el.style.setProperty(P[i], V[i], 'important');
    }
    el.__rfpin = saved;
    S.pinned = el;
  };
  var unpin = function () {
    var el = S.pinned;
    S.pinned = null;
    if (!el || !el.__rfpin) return;
    var h = el.__rfpin;
    el.__rfpin = null;
    for (var k in h) {
      try { if (h[k][0]) el.style.setProperty(k, h[k][0], h[k][1]); else el.style.removeProperty(k); } catch (e) {}
    }
  };
  var kidsOf = function (p) {
    if (!p) return [];
    return p.children || [];
  };
  // Hides every element beside the chain (siblings of each chain node, up
  // to <html>); 'pre' (no video yet): <html>'s and <body>'s children, by
  // opacity only (layout, visibility and autoplay untouched).
  var apply = function () {
    var i, j;
    if (S.mode === 'pre') {
      var de = document.documentElement;
      if (!de) return;
      var tops = kidsOf(de);
      for (i = 0; i < tops.length; i++) if (tops[i] !== document.body) hide(tops[i], 'o');
      var bk = kidsOf(document.body);
      for (j = 0; j < bk.length; j++) hide(bk[j], 'o');
      return;
    }
    var nodes = [S.root].concat(S.chain);
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var par = n.parentNode;
      var ks = kidsOf(par);
      for (j = 0; j < ks.length; j++) {
        var k = ks[j];
        if (k === n || S.set.indexOf(k) >= 0) continue;
        hide(k, null);
      }
    }
    // Inside a kept player container (frames the app does not drive): ad
    // frames and off-site logo links, and max-z overlays anywhere.
    if (!S.driven && S.root && S.root.querySelectorAll) {
      var inner = S.root.querySelectorAll('iframe,a[href]');
      for (i = 0; i < inner.length; i++) {
        var el = inner[i];
        if (el === S.target || S.set.indexOf(el) >= 0) continue;
        if (el.tagName === 'A') { if (badLink(el) && el.querySelector('img,svg')) hide(el, null); }
        else if (!(el.__rfvs >= 0)) hide(el, 'o');
      }
    }
  };
  var unhideAll = function (keep) {
    var rest = [];
    for (var i = 0; i < hidden.length; i++) {
      var el = hidden[i];
      if (!el.__rfh) continue;
      if (keep && keep(el)) { rest.push(el); continue; }
      unhide(el);
    }
    hidden = rest;
  };
  var inChainOrRoot = function (el) {
    if (S.set.indexOf(el) >= 0) return true;
    try { if (S.root && S.root.contains(el)) return true; } catch (e) {}
    return false;
  };
  var setRoot = function (target, root, driven, mode) {
    var changed = S.root !== root || S.mode !== mode;
    S.target = target; S.root = root; S.driven = driven; S.mode = mode;
    var ch = [], n = root;
    while (n && (n = up(n))) ch.push(n);
    S.chain = ch;
    S.set = [root].concat(ch);
    if (changed) {
      unhideAll(function (el) { return !inChainOrRoot(el); });
      if (mode === 'iso' && !driven && root) pin(root); else unpin();
    }
  };
  var post = function (o) { try { window.parent.postMessage('__rfg:' + JSON.stringify(o), '*'); } catch (e) {} };
  var bcast = function (o) {
    var fs = allEls('iframe,frame');
    for (var i = 0; i < fs.length; i++) { try { fs[i].contentWindow.postMessage('__rfg:' + JSON.stringify(o), '*'); } catch (e) {} }
  };
  var sweep = function () {
    if (!en('iso') || !document.documentElement) return;
    var p = pick();
    S.my = p.s;
    if (p.el && p.s >= 0) {
      var driven = TOP && p.el.tagName === 'VIDEO';
      var root = driven ? p.el : (p.el.tagName === 'VIDEO' ? container(p.el) : p.el);
      setRoot(p.el, root, driven, 'iso');
      // Invariant check: nothing on the video's path may be hidden.
      for (var vi = 0; vi < S.set.length; vi++) {
        if (S.set[vi].__rfh) { noteEv('fix', 'unhid video chain: ' + desc(S.set[vi])); unhide(S.set[vi]); }
      }
      if (p.el.__rfh) { noteEv('fix', 'unhid the video: ' + desc(p.el)); unhide(p.el); }
    } else {
      var age = Date.now() - S.t0;
      if (S.blind || age > 10000) {
        var now0 = Date.now();
        if (now0 - S.playAt > 2000) { S.playAt = now0; S.cand = findPlay(); }
        var cand = S.cand && S.cand.isConnected ? S.cand : null;
        if (cand) setRoot(cand, cand, false, 'hatch');
        else if (S.mode !== 'open') {
          S.mode = 'open'; S.root = null; S.chain = []; S.set = [];
          unpin();
          unhideAll(null);
        }
      } else if (S.mode !== 'pre') {
        S.mode = 'pre'; S.root = null; S.chain = []; S.set = [];
        unpin();
      }
    }
    if (S.mode === 'open') { if (Date.now() - S.openAt > 2000) { S.openAt = Date.now(); openPass(); } }
    else apply();
    if (!TOP) {
      var now = Date.now();
      var has = S.my >= 0 ? S.my : -1;
      if (has !== S.sent || (has >= 0 && now - S.sentAt > 2000)) { S.sent = has; S.sentAt = now; post({ k: 'v', s: has }); }
    }
  };
  // No video and no play element found: the page shows, minus what looks
  // like an ad (max-z overlays, layers outside <body>, ad-host frames).
  var openPass = function () {
    var de = document.documentElement;
    var top = kidsOf(de);
    for (var i = 0; i < top.length; i++) if (top[i] !== document.body && top[i].tagName !== 'HEAD') hide(top[i], 'o');
    var els = allEls('body *');
    for (var j = 0; j < els.length && j < 3000; j++) {
      var el = els[j];
      if (el.__rfh || ours(el)) continue;
      if (el.tagName === 'IFRAME' && el.src && isAd(el.src)) { hide(el, 'o'); continue; }
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      var z = parseInt(cs.zIndex, 10) || 0;
      if (z >= 2147483000) hide(el, 'o');
    }
  };
  var soonT = null;
  var soon = function () { if (!soonT) soonT = setTimeout(function () { soonT = null; sweep(); }, 0); };
  try {
    mo = new MutationObserver(function (ms) {
      if (!en('iso')) return;
      var need = false;
      for (var i = 0; i < ms.length; i++) {
        var a = ms[i].addedNodes;
        for (var j = 0; j < a.length; j++) {
          var n = a[j];
          if (!n || n.nodeType !== 1) continue;
          var tg = n.tagName;
          if (tg === 'VIDEO' || tg === 'IFRAME' || tg === 'FRAME' || (n.firstElementChild && n.querySelector && n.querySelector('video,iframe'))) need = true;
          var par = up(n);
          if (S.mode === 'pre') {
            if (par === document.body || par === document.documentElement) { if (n !== document.body) hide(n, 'o'); }
          } else if (S.mode !== 'open' && S.set && S.set.indexOf(par) >= 0 && S.set.indexOf(n) < 0) {
            hide(n, null);
          } else if (S.mode === 'open' && par === document.documentElement && n !== document.body && tg !== 'HEAD') {
            hide(n, 'o');
          }
        }
      }
      if (need) soon();
    });
    mo.observe(document, { childList: true, subtree: true });
    G.mo = mo; G.amo = amo; // kept reachable
  } catch (e) {}
  var MEV = ['loadedmetadata', 'durationchange', 'playing', 'emptied', 'loadstart'];
  for (var me = 0; me < MEV.length; me++) document.addEventListener(MEV[me], soon, true);
  // The hidden resolver (lib/resolver.ts): nothing is ever seen there, so no
  // isolation at all (it could only get in the player's way).
  G.resolver = function () {
    G.skip.iso = 1;
    unpin();
    unhideAll(null);
  };
  G.findPlay = function () { try { return findPlay(); } catch (e) { return null; } };
  try { if (window.__rf_sniff && window.__rf_sniff.mode === 'resolver') G.resolver(); } catch (e) {}
  var setOn = function (on) {
    if (G.on === on) return;
    G.on = on;
    if (!on) { unpin(); unhideAll(null); S.mode = 'pre'; S.root = null; S.chain = []; S.set = []; }
    else soon();
    bcast({ k: on ? 'on' : 'off' });
  };
  // --- Messages: child frames, the parent, the app ------------------------
  var kids = {};
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (typeof d === 'string' && d.indexOf('__rfg:') === 0) {
      try { e.stopImmediatePropagation(); } catch (x) {}
      var m;
      try { m = JSON.parse(d.slice(6)); } catch (x) { return; }
      if (!m) return;
      if (m.k === 'v') {
        kidSeen = true;
        var f = frameOf(e.source);
        if (f) { var old = f.__rfvs; f.__rfvs = m.s; f.__rfvt = Date.now(); if (old !== m.s) soon(); }
      } else if (m.k === 'st') {
        if (m.o) { kids[m.o] = m.d; dirty = true; }
      } else if (m.k === 'hi') {
        // A new child frame: it starts on; tell it when the app said off.
        if (!G.on && e.source) { try { e.source.postMessage('__rfg:' + JSON.stringify({ k: 'off' }), '*'); } catch (x) {} }
      } else if (e.source === window.parent && e.source !== window) {
        if (m.k === 'blind') { S.blind = true; soon(); bcast(m); }
        else if (m.k === 'on' || m.k === 'off') setOn(m.k === 'on');
      }
      return;
    }
    if (TOP && !e.source && typeof d === 'string' && d.charAt(0) === '{') {
      var a;
      try { a = JSON.parse(d); } catch (x) { return; }
      if (!a) return;
      if (a.t === 'guard') {
        if (a.skip && a.skip.length) { for (var si = 0; si < a.skip.length; si++) G.skip[String(a.skip[si])] = 1; if (G.skip.iso) { unpin(); unhideAll(null); } }
        setOn(a.on !== false);
      }
      else if (a.t === 'blind' && a.on) { S.blind = true; soon(); bcast({ k: 'blind' }); }
    }
  }, true);
  var merged = function () {
    var now = [], big = [];
    for (var hi = 0; hi < hidden.length; hi++) {
      var he = hidden[hi];
      if (!he.__rfh || !he.isConnected) continue;
      now.push(he);
    }
    for (var hj = 0; hj < now.length && big.length < 8; hj++) big.push(desc(now[hj]));
    var o = { pop: st.pop, nav: st.nav, clk: st.clk, dlg: st.dlg, perm: st.perm, hid: now.length, hidEver: st.hid, fix: st.fix, blk: {}, hd: big, ev: st.ev.slice(), frames: {} };
    var add = function (src) { for (var h in src.blk) o.blk[h] = (o.blk[h] || 0) + src.blk[h]; };
    add(st);
    for (var k in kids) {
      var c = kids[k];
      if (!c) continue;
      o.pop += c.pop || 0; o.nav += c.nav || 0; o.clk += c.clk || 0; o.dlg += c.dlg || 0; o.perm += c.perm || 0;
      add(c);
      o.frames[k] = { hid: c.hid || 0, hd: (c.hd || []).slice(0, 4), ev: (c.ev || []).slice(0, 4) };
    }
    return o;
  };
  var report = function () {
    if (!dirty) return;
    dirty = false;
    var o = merged();
    if (TOP) {
      o.u = String(location.href).slice(0, 160);
      o.mode = S.mode; o.driven = S.driven;
      var s = JSON.stringify({ t: -10, g: o });
      try { if (window.nsh && window.nsh.postMessage) { window.nsh.postMessage(s); return; } } catch (e) {}
      try { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(s); } catch (e) {}
    } else {
      post({ k: 'st', o: here() + (location.pathname || '').slice(0, 30), d: o });
    }
  };
  if (!TOP) { try { window.parent.postMessage('__rfg:' + JSON.stringify({ k: 'hi' }), '*'); } catch (e) {} }
  var ticks = 0;
  var tick = function () {
    ticks++;
    try { sweep(); } catch (e) {}
    if (ticks % 8 === 0) { try { report(); } catch (e) {} }
    setTimeout(tick, Date.now() - S.t0 < 15000 ? 400 : 1000);
  };
  setTimeout(tick, 0);
  document.addEventListener('DOMContentLoaded', soon, true);
  window.addEventListener('pagehide', function () { dirty = true; try { report(); } catch (e) {} }, true);
  } catch (err) {
    try { if (window.nsh && window.nsh.postMessage) window.nsh.postMessage(JSON.stringify({ t: -8, msg: 'guard threw: ' + String(err && err.stack || err).slice(0, 300) })); } catch (e) {}
  }
})();
`;

// --- App side --------------------------------------------------------------------

const KEY = "rustflix.adblock";
const DIAG_KEY = "rustflix.adblock.diag";

let enabled = true;
let loaded = false;
const changeFns: ((on: boolean) => void)[] = [];

let skip: string[] = [];
/** Diagnostics: guard parts switched off for every page (Storage
 * `rustflix.adblock.skip`, comma-separated: iso, pop, clk, nav, dlg, perm). */
export function adblockSkip(): string[] {
  return skip;
}

/** Whether "Block ads in player" is on (default on). */
export function adblockOn(): boolean {
  return enabled;
}

/** Called with the new state when the switch changes. */
export function onAdblockChange(fn: (on: boolean) => void) {
  changeFns.push(fn);
}

async function configureHost(attempt = 0) {
  let available = false;
  try {
    available = host.available();
  } catch {}
  if (!available) return;
  try {
    await host.call("sys.webGuard", {
      on: enabled,
      rules: JSON.stringify(contentRules()),
      script: GUARD_JS,
      embeds: embedHosts(),
      hosts: AD_HOSTS,
      patterns: AD_PATTERNS.filter((p) => p.re !== ".*").map((p) => ({ re: p.re, types: p.types, third: !!p.third })),
      allow: MEDIA_ALLOW.map((a) => a.re),
    });
  } catch {
    // The host may register its handler a moment after the bundle starts.
    if (attempt < 5) setTimeout(() => void configureHost(attempt + 1), 1000);
  }
}

/** Boot: reads the switch and hands the lists and the guard to the native
 * host (compiled once, attached to every web view as it is made). */
export async function initWebGuard() {
  if (loaded) return;
  loaded = true;
  try {
    enabled = (await Storage.getItem(KEY)) !== "0";
    skip = ((await Storage.getItem("rustflix.adblock.skip")) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  } catch {}
  await configureHost();
}

/** Settings switch. Pages already open drop the in-page layers at once
 * (the app sends `{t:'guard'}`); the content rules follow on the native
 * side for every later request. */
export function setAdblock(on: boolean) {
  enabled = on;
  void Storage.setItem(KEY, on ? "1" : "0").catch(() => {});
  void configureHost();
  for (const fn of changeFns) {
    try {
      fn(on);
    } catch {}
  }
}

// --- Diagnostics ------------------------------------------------------------------

let diagOn = false;
void Storage.getItem("rustflix.debug")
  .then((v) => {
    diagOn = v === "1";
  })
  .catch(() => {});
/** Follows Settings → Diagnostics. */
export function setAdblockDiag(on: boolean) {
  diagOn = on;
}

const diag: unknown[] = [];
let diagTimer: ReturnType<typeof setTimeout> | undefined;
let nativeAt = 0;

/** A guard report from the top frame ({t:-10}): logged per page while
 * Diagnostics is on (the latest report of each page replaces the one
 * before). */
export function onGuardReport(v: { g?: Record<string, unknown> }, log: (e: string, d?: unknown) => void) {
  if (!diagOn || !v || !v.g) return;
  const g = v.g;
  const blk = (g.blk ?? {}) as Record<string, number>;
  const blocked = Object.entries(blk).sort((a, b) => b[1] - a[1]);
  const line = {
    t: Date.now(),
    page: g.u,
    mode: g.mode,
    driven: g.driven,
    blocked: Object.fromEntries(blocked.slice(0, 12)),
    blockedTotal: blocked.reduce((n, [, c]) => n + c, 0),
    popups: g.pop,
    navigations: g.nav,
    links: g.clk,
    dialogs: g.dlg,
    prompts: g.perm,
    hidden: g.hid,
    videoFixes: g.fix,
    hiddenEver: g.hidEver,
    hiddenTop: g.hd,
    events: g.ev,
    frames: g.frames,
  };
  log("adblock: page", line);
  const i = diag.findIndex((d) => (d as { page?: unknown }).page === line.page);
  if (i >= 0) diag.splice(i, 1);
  diag.push(line);
  if (diag.length > 30) diag.shift();
  diagTimer ??= setTimeout(() => {
    diagTimer = undefined;
    void flushDiag();
  }, 2000);
}

async function flushDiag() {
  // The native side's counts (main-frame navigations refused, rules state).
  let native: unknown = null;
  if (Date.now() - nativeAt > 5000) {
    nativeAt = Date.now();
    try {
      if (host.available()) native = await host.call("sys.webGuard", { stats: true });
    } catch {}
  }
  const out = native ? [...diag, { t: Date.now(), native }] : diag;
  void Storage.setItem(DIAG_KEY, JSON.stringify(out)).catch(() => {});
}
