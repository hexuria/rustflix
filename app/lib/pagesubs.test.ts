// `bun test app/lib/pagesubs.test.ts` — the source page's subtitles:
// capture records → PageSubtitle (resolvecore SubtitleSet) → subtitle
// results (subtitles.ts), language normalisation, ranking with the online
// providers. Not bundled. Record shapes: the sniffer's {t:-11, m} with
// k:"sub" (see adblock.ts SNIFF_JS); API shapes as the captured pages use
// them (hianime-style `tracks`, Wyzie search, OpenSubtitles REST).

import { describe, expect, mock, test } from "bun:test";

mock.module("nsh", () => {
  const signal = <T,>(v: T) => {
    const f = (() => v) as unknown as { (): T; set(x: T): void };
    f.set = (x: T) => {
      v = x;
    };
    return f;
  };
  return {
    signal,
    host: { available: () => false, call: async () => null },
    Storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
  };
});

const { SubtitleSet } = await import("./resolvecore");
const S = await import("./subtitles");

const UA = "UA-Test";
const rec = (o: Record<string, unknown>) => ({
  k: "sub",
  r: "vtt",
  via: "json",
  fo: "https://vidnest.fun",
  fr: "https://vidnest.fun/anime/205909/4/sub",
  ua: "Mozilla/5.0 Page",
  rp: "",
  lang: "",
  label: "",
  def: false,
  ...o,
});

describe("capture → page subtitles", () => {
  test("hianime-style tracks list, plus the one file the page fetched through its own proxy", () => {
    const s = new SubtitleSet();
    const base = "https://mjmff.mysubsplay.com/anime/70f8/8b03/subtitles/";
    // From the JSON API answer (tracks: [{file, label, kind:"captions", default}]).
    s.add(rec({ u: base + "track_0_English__Full_Subtitle__eng.vtt", label: "English (Full Subtitle)", def: true }), UA);
    s.add(rec({ u: base + "track_1_English__Signs__eng.vtt", label: "English (Signs)" }), UA);
    s.add(rec({ u: base + "track_2_Spanish_spa.vtt", label: "Spanish" }), UA);
    s.add(rec({ u: base + "track_3_Portuguese__Brazilian__por.vtt", label: "Portuguese (Brazil)" }), UA);
    // The page fetched track 0 through upcloud's /fetch?url=…&ref=…
    const wrapped = `https://upcloud.animanga.fun/fetch?url=${base}track_0_English__Full_Subtitle__eng.vtt&ref=https://megaplay.buzz/`;
    s.add(rec({ u: wrapped, via: "fetch", inner: base + "track_0_English__Full_Subtitle__eng.vtt" }), UA);
    const list = s.list();
    expect(list.length).toBe(4);
    // Every listed file goes through the same page-side proxy.
    expect(list.every((x) => x.url.startsWith("https://upcloud.animanga.fun/fetch?url="))).toBe(true);
    expect(list.find((x) => x.url === wrapped)!.label).toBe("English (Full Subtitle)");
    expect(list.find((x) => x.url.includes("Spanish"))!.url).toBe(
      `https://upcloud.animanga.fun/fetch?url=${base}track_2_Spanish_spa.vtt&ref=https://megaplay.buzz/`,
    );
    // Headers per the requesting frame: Referer/Origin of vidnest.fun.
    const h = list[0].headers;
    expect(h.Referer).toBe("https://vidnest.fun/");
    expect(h.Origin).toBe("https://vidnest.fun");
    expect(h["User-Agent"]).toBe("Mozilla/5.0 Page");

    const res = S.pageSubtitleResults(list);
    expect(res.map((r) => r.lang)).toEqual(["en", "en", "es", "pt"]);
    expect(res[0].provider).toBe("source");
    expect(res[0].def).toBe(true);
    expect(res.find((r) => r.lang === "pt")!.label).toBe(S.cleanLangLabel("Portuguese (Brazil)"));
  });

  test("an encoded inner URL in the wrapper is re-encoded for the others", () => {
    const s = new SubtitleSet();
    const a = "https://cdn.subs.example/a/en.vtt";
    const b = "https://cdn.subs.example/a/fr.vtt";
    s.add(rec({ u: a, label: "English" }), UA);
    s.add(rec({ u: b, label: "French" }), UA);
    s.add(rec({ u: `https://p.example/proxy?url=${encodeURIComponent(a)}`, via: "xhr", inner: a }), UA);
    const l = s.list();
    expect(l.map((x) => x.url).sort()).toEqual(
      [`https://p.example/proxy?url=${encodeURIComponent(a)}`, `https://p.example/proxy?url=${encodeURIComponent(b)}`].sort(),
    );
  });

  test("<track> elements; repeats merge; localhost and non-http dropped", () => {
    const s = new SubtitleSet();
    expect(s.add(rec({ u: "https://vidfast.vc/subs/1/en.vtt", via: "track", lang: "en", label: "" }), UA)).toBe(true);
    expect(s.add(rec({ u: "https://vidfast.vc/subs/1/en.vtt", via: "player", label: "English" }), UA)).toBe(true);
    expect(s.add(rec({ u: "http://127.0.0.1:9/x.vtt" }), UA)).toBe(false);
    expect(s.add(rec({ u: "blob:https://x/1" }), UA)).toBe(false);
    expect(s.add({ k: "hls", u: "https://x/a.m3u8" }, UA)).toBe(false);
    const l = s.list();
    expect(l.length).toBe(1);
    expect(l[0].lang).toBe("en");
    expect(l[0].label).toBe("English");
    // Another origin than the frame's: the frame's origin as Referer, plus Origin.
    expect(l[0].headers.Referer).toBe("https://vidnest.fun/");
    expect(l[0].headers.Origin).toBe("https://vidnest.fun");
  });
});

describe("language normalisation", () => {
  test("labels, attributes and file names", () => {
    const res = S.pageSubtitleResults([
      { url: "https://a.example/x/1.vtt", format: "vtt", lang: "spa", label: "", via: "track", def: false, headers: {}, frameOrigin: "" },
      { url: "https://a.example/x/English.vtt", format: "", lang: "", label: "", via: "fetch", def: false, headers: {}, frameOrigin: "" },
      { url: "https://a.example/x/2.srt", format: "srt", lang: "", label: "Deutsch", via: "json", def: false, headers: {}, frameOrigin: "" },
      { url: "https://a.example/x/3.vtt", format: "vtt", lang: "pt-BR", label: "", via: "json", def: false, headers: {}, frameOrigin: "" },
      { url: "https://a.example/x/4.vtt", format: "vtt", lang: "", label: "English [CC]", via: "json", def: false, headers: {}, frameOrigin: "" },
      { url: "https://a.example/x/5.ass", format: "ass", lang: "en", label: "English", via: "json", def: false, headers: {}, frameOrigin: "" },
      { url: "https://a.example/x/6.vtt", format: "vtt", lang: "", label: "Track 7", via: "json", def: false, headers: {}, frameOrigin: "" },
    ]);
    expect(res.map((r) => r.lang)).toEqual(["es", "en", "de", "pt", "en", ""]);
    expect(res.map((r) => r.format)).toEqual(["vtt", "vtt", "srt", "vtt", "vtt", "vtt"]);
    expect(res[4].hi).toBe(true);
    expect(res[5].label).toBe("Track 7");
  });

  test("langFromUrl", () => {
    expect(S.langFromUrl("https://x/track_0_English__Full_Subtitle__eng.vtt")).toBe("en");
    expect(S.langFromUrl("https://x/v3/movie/27205/English.vtt")).toBe("en");
    expect(S.langFromUrl("https://x/subs/fr.vtt")).toBe("fr");
    expect(S.langFromUrl("https://x/subs/pt-BR.srt")).toBe("pt");
    expect(S.langFromUrl("https://x/subs/12345.vtt")).toBe("");
    expect(S.langFromUrl("https://x/a/hd/index.vtt")).toBe("");
  });
});

describe("delivery", () => {
  test("registry + merge: the source first within a language, user languages first", () => {
    const key = S.pageSubKey("tv", 1396, 1, 1);
    expect(key).toBe("tv:1396:1:1");
    expect(S.pageSubKey("movie", 5, 3, 4)).toBe("movie:5:0:0");
    expect(S.pageSubKey("anime", 9, undefined, 4)).toBe("anime:9:0:4");
    const page = S.pageSubtitleResults([
      { url: "https://p/en.vtt", format: "vtt", lang: "en", label: "English", via: "track", def: true, headers: { Referer: "https://p/" }, frameOrigin: "https://p" },
      { url: "https://p/ja.vtt", format: "vtt", lang: "ja", label: "Japanese", via: "track", def: false, headers: {}, frameOrigin: "https://p" },
    ]);
    let heard = 0;
    const off = S.onPageSubtitles((k) => {
      if (k === key) heard++;
    });
    S.setPageSubtitles(key, page);
    off();
    expect(heard).toBe(1);
    expect(S.pageSubtitles(key).length).toBe(2);
    const online: import("./subtitles").SubResult[] = [
      { lang: "en", label: "English", url: "https://wyzie/en1.srt", format: "srt", provider: "wyzie" },
      { lang: "fr", label: "French", url: "https://wyzie/fr1.srt", format: "srt", provider: "wyzie" },
    ];
    const merged = S.withPageSubtitles(online, key, ["en", "fr"]);
    expect(merged.map((r) => r.url)).toEqual(["https://p/en.vtt", "https://wyzie/en1.srt", "https://wyzie/fr1.srt", "https://p/ja.vtt"]);
    // Again with the merged list as input: nothing doubles.
    expect(S.withPageSubtitles(merged, key, ["en", "fr"]).length).toBe(4);
    // No page list: the online ones unchanged.
    expect(S.withPageSubtitles(online, "movie:1:0:0", ["en"]).length).toBe(2);
  });

  test("searchSubtitles: page:true includes them even when every provider fails", async () => {
    const key = S.pageSubKey("movie", 4242);
    S.setPageSubtitles(key, S.pageSubtitleResults([
      { url: "https://p/de.vtt", format: "vtt", lang: "de", label: "German", via: "track", def: false, headers: {}, frameOrigin: "" },
    ]));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    try {
      const withPage = await S.searchSubtitles({ type: "movie", tmdbId: 4242, langs: ["de"], page: true });
      expect(withPage.map((r) => r.provider)).toEqual(["source"]);
      await expect(S.searchSubtitles({ type: "movie", tmdbId: 4242, langs: ["de"] })).rejects.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
