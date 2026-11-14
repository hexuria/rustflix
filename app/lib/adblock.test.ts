// `bun test app/lib/adblock.test.ts` — the content blocker list is valid
// for WebKit and decides real URLs right. The sample URLs were captured
// from the embed pages on the iPhone simulator (Nov 2026): ad and tracker
// loads must be blocked; streams, segments, subtitles, the embeds' own
// pages, scripts and APIs must not. Not bundled (nothing imports it).

import { describe, expect, mock, test } from "bun:test";

mock.module("nsh", () => ({
  host: { available: () => false, call: async () => null },
  Storage: { getItem: async () => null, setItem: async () => {} },
}));

const { contentRules, ruleBlocks, embedHosts, AD_HOSTS, GUARD_JS } = await import("./adblock");

type T = "document" | "script" | "image" | "raw" | "fetch" | "media" | "popup" | "style-sheet" | "other";

const VIDFAST = "https://vidfast.vc/movie/27205?autoPlay=true";
const VIDNEST = "https://vidnest.fun/anime/205909/4/sub";
const VIDSRC = "https://vsembed.su/embed/tv/1396/1/1?autoplay=1";
const AETHER = "https://aether.ist/media/tmdb-tv-1396/3572/62085";

const BLOCKED: [string, T, string][] = [
  // The reported in-page push ad (vidnest anime) and its network.
  ["https://tiny-frog-85f0.money-9.workers.dev/fetch?url=https%3A%2F%2Fbb.chiripaethenes.com%2Frz63yIY8itxcu%2F130989%3Fr%3Da508", "script", VIDNEST],
  ["https://bb.chiripaethenes.com/rz63yIY8itxcu/130989", "script", VIDNEST],
  ["https://mr.gamutscrewed.com/rfCGFwitpB2QNaUw/131425", "script", AETHER],
  ["https://other-rotated-domain.com/AbCdEf123/140001", "script", AETHER],
  ["https://ky78t8rnb3ttllek.efji4wl5ouowgv1r.cfd/k9Vipw5I9f4G3/JLkLJ", "script", VIDFAST],
  ["https://some-new-name.whatever.cfd/abc/def", "script", VIDFAST],
  ["https://vinnyvower.cfd/cuid/?f=https%3A%2F%2Fvidfast.vc", "fetch", VIDFAST],
  ["https://rotated.example/cuid/?f=https%3A%2F%2Fvidnest.fun", "raw", VIDNEST],
  ["https://systyle.ensoberevicteefideism.cfd/gd/137978?md=eyJ0dmMiOjAsImYiOmZhbHNl", "fetch", VIDFAST],
  ["https://cursive.whorishcropped.rest/q7i_gTjezXgAF0ZPMaU_mwuQjBomn0u10", "other", VIDNEST],
  // vidsrc's trackers.
  ["https://s10.histats.com/js15_as.js", "script", VIDSRC],
  ["https://t.dtscout.com/idg/?su=51A0179460860151C829683FE32AD760", "document", VIDSRC],
  ["https://cdn.tynt.com/afwu.js", "script", VIDSRC],
  ["https://tags.crwdcntrl.net/lt/c/3825/lt.min.js", "script", VIDSRC],
  ["https://ps.eyeota.net/pixel?pid=c9gd671&t=gif", "image", VIDSRC],
  // Analytics on every embed.
  ["https://www.googletagmanager.com/gtag/js?id=G-JMWN78FZNK", "script", VIDFAST],
  ["https://www.google-analytics.com/g/collect?v=2&tid=G-JMWN78FZNK", "fetch", VIDFAST],
  ["https://static.cloudflareinsights.com/beacon.min.js/vce70182", "script", VIDNEST],
  // Well-known networks; third-party pop-ups.
  ["https://securepubads.g.doubleclick.net/tag/js/gpt.js", "script", VIDFAST],
  ["https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "script", VIDFAST],
  ["https://imasdk.googleapis.com/js/sdkloader/ima3.js", "script", VIDFAST],
  ["https://landing.example-shop.com/deal", "popup", VIDFAST],
];

const ALLOWED: [string, T, string][] = [
  // Streams and segments (resolver results and page requests).
  ["https://moon.goldenkite.top/vd/OXN3d0w5Q1pyVGNmVFNmZFpLeERhQTo0VTdCeWtXM2Q2UEJyb2M5bm91UnhB/sd/148/index-s1080p-v1-a1.m3u8?s=s1.1794597885.4", "raw", VIDFAST],
  ["https://stormhive.top/vd/czN4MEdZVFNJbldWTmlURTVPcmZmZzpRY0Q3OHVOMWl4NlBTVnc4bDFuWEhB/init-v1-a1.mp4", "raw", VIDFAST],
  ["https://olivewave.top/vd/ZVQwNjVpX1NpaU03c19ZRmdlenN0dzpDYmRtcXVwemhTRklWZGNtS1ZuVDhCb2FfbD/seg-12-v1-a1.m4s", "fetch", VIDFAST],
  ["https://pwcloud.animanga.fun/hls/aHR0cHM6Ly9oZ3BsYXljZG4uY29tL3N0cmVhbS9aR0RaWnlQYWFHbHE2TUdUdG4wM", "raw", VIDNEST],
  ["https://upcloud.animanga.fun/hls/aHR0cHM6Ly9zZWcuanBn/seg-3.jpg", "raw", VIDNEST],
  ["https://cdn1018.cdn-tnmr.org/hls2/05/02536/m81v06p7ttsj_h/index-v1-a1.m3u8?t=6kxGAyNCAL9OK22fZAKH7", "raw", AETHER],
  ["https://cflul.bw3.workers.dev/vid/d9cNLUm4oR4cXdnLbS3Fkr6DvtIjTPtUrFrJNc6eEigZXkPWMGRGHg", "raw", AETHER],
  ["https://some.cdn.cfd/stream/segment-5.ts", "raw", VIDFAST],
  // vidnest anime's segments: on TikTok's ad-creative CDN, posing as images.
  ["https://p16-ad-site-sign-sg.tiktokcdn.com/ad-site-i18n-sg/202611135d0dcec861c5ede04c49b462~tplv-d5opwmad15-ttam-origin.image?lk3s=6d71dd51&x-expires=1826125892", "raw", VIDNEST],
  ["https://upcloud.animanga.fun/ts-proxy?url=https%3A%2F%2Fp16-ad-site-sign-sg.tiktokcdn.com%2Fad-site-i18n-sg%2F2026.image", "raw", VIDNEST],
  ["https://upcloud.animanga.fun/proxy?url=https%3A%2F%2Fmegap.shiora.top%2F70f8%2F8b03%2Fmaster.m3u8", "fetch", VIDNEST],
  ["https://upcloud.animanga.fun/fetch?url=https://mjmff.mysubsplay.com/anime/70f8/8b03/subtitles/track_0_English__Full_Subtitle__eng.vtt&ref=https://megaplay.buzz/", "other", VIDNEST],
  ["https://blob-host.example/video.mp4", "media", VIDFAST],
  // Subtitles.
  ["https://sub.wyzie.io/search?id=27205&key=k", "fetch", VIDNEST],
  ["https://sub.vdrk.site/v2/movie/27205", "fetch", VIDNEST],
  ["https://cache.vdrk.site/v3/movie/27205/English.vtt", "other", VIDNEST],
  ["https://rest.opensubtitles.org/search/episode-1/imdbid-0903747/season-1", "fetch", AETHER],
  // The embeds' own pages, frames, scripts and APIs.
  [VIDFAST, "document", VIDFAST],
  [VIDNEST, "document", VIDNEST],
  [VIDSRC, "document", VIDSRC],
  ["https://stellarconductornexus.com/embed/tv/1396/1/1?vs=hV4S6IkVFwDEmZi5AXRzO8", "document", VIDSRC],
  ["https://vidfast.vc/_next/static/chunks/webpack-c8347190eff03.js", "script", VIDFAST],
  ["https://umami.vidfast.vc/script.js", "script", VIDFAST],
  ["https://vidnest.fun/_next/static/chunks/a3f6c22d97a69088.js", "script", VIDNEST],
  ["https://new.vidnest.fun/yflix/movie/27205?_n=CP0eTBgRbDJt_r5F7hoPnQ", "fetch", VIDNEST],
  ["https://cdn.jsdelivr.net/npm/hls.js@%5E1.5.0/dist/hls.min.js", "script", VIDNEST],
  ["https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1", "script", VIDFAST],
  ["https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap", "style-sheet", VIDSRC],
  ["https://vsembed.su/assets/sbx.js?v=1786671805", "script", VIDSRC],
  ["https://aether.ist/assets/manifest-D6ZPoVba.json", "fetch", AETHER],
  ["https://lul.raccoonunbutteredbagel.zip/tv/1396/1/1", "fetch", AETHER],
  ["https://api.themoviedb.org/3/tv/1396?append_to_response=external_ids", "fetch", AETHER],
  ["https://image.tmdb.org/t/p/original/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg", "image", VIDFAST],
  ["https://wsrv.nl/?url=https://image.tmdb.org/t/p/w500/x.jpg", "image", VIDFAST],
  ["https://web.kino.bz/assets/index.js", "script", "https://on.kinohub.vip/movie/27205"],
  ["https://api.kinobox.tv/api/movies/27205?ts=9349", "fetch", "https://on.kinohub.vip/movie/27205"],
  ["https://cdn.example-player.com/player/v3/player.js", "script", VIDFAST],
  // Same-site pop-up (a player's own window): not a third-party one.
  ["https://vidfast.vc/help", "popup", VIDFAST],
];

describe("content rules", () => {
  const rules = contentRules();

  test("valid JSON in WebKit's regex subset", () => {
    const json = JSON.parse(JSON.stringify(rules));
    expect(Array.isArray(json)).toBe(true);
    expect(rules.length).toBeGreaterThan(AD_HOSTS.length);
    for (const r of rules) {
      const f = r.trigger["url-filter"];
      expect(typeof f).toBe("string");
      expect(() => new RegExp(f)).not.toThrow();
      // No alternation, counted repetition, shorthand classes or
      // look-arounds (WKContentRuleList rejects them).
      expect(f.replace(/\[[^\]]*\]/g, "")).not.toMatch(/\||\{|\\[dDwWsSbB]|\(\?/);
      expect(["block", "ignore-previous-rules"]).toContain(r.action.type);
    }
    // Exceptions come after every block.
    const firstAllow = rules.findIndex((r) => r.action.type === "ignore-previous-rules");
    expect(rules.slice(firstAllow).every((r) => r.action.type === "ignore-previous-rules")).toBe(true);
  });

  for (const [url, type, page] of BLOCKED) {
    test(`blocks ${type} ${url.slice(0, 80)}`, () => expect(ruleBlocks(rules, url, type, page)).toBe(true));
  }
  for (const [url, type, page] of ALLOWED) {
    test(`allows ${type} ${url.slice(0, 80)}`, () => expect(ruleBlocks(rules, url, type, page)).toBe(false));
  }

  test("every source's embed host is allowed", () => {
    for (const h of embedHosts()) expect(ruleBlocks(rules, `https://${h}/embed/movie/1`, "document", `https://${h}/`)).toBe(false);
  });

  test("guard script parses", () => {
    expect(() => new Function(GUARD_JS)).not.toThrow();
  });
});
