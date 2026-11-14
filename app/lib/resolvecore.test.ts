// `bun test app/lib/resolvecore.test.ts` — candidates from page reports,
// ranking, and the headers the stream proxy must send. Not bundled.

import { describe, expect, mock, test } from "bun:test";

mock.module("nsh", () => ({
  host: { available: () => false, call: async () => null },
  Storage: { getItem: async () => null, setItem: async () => {} },
}));

const { CandidateSet, headersFor, score, sameSite } = await import("./resolvecore");

const UA = "UA-Test";
const sniff = (o: Record<string, unknown>) => ({
  fo: "https://player.example",
  fr: "https://player.example/e/abc?x=1",
  ref: "https://top.example/",
  ck: "a=1",
  ua: "Mozilla/5.0 Page",
  rp: "",
  via: "xhr",
  ms: 100,
  ...o,
});

describe("candidates", () => {
  test("master beats media beats file; DASH last", () => {
    const s = new CandidateSet();
    s.addSniff(sniff({ u: "https://cdn.example/v/720/index.m3u8", k: "hls", r: "media" }));
    s.addSniff(sniff({ u: "https://cdn.example/v/file.mp4", k: "mp4", r: "file" }));
    s.addSniff(sniff({ u: "https://cdn.example/v/manifest.mpd", k: "dash", r: "" }));
    s.addSniff(sniff({ u: "https://cdn.example/v/master.m3u8", k: "hls", r: "master" }));
    const r = s.ranked();
    expect(r.map((c) => c.url)).toEqual([
      "https://cdn.example/v/master.m3u8",
      "https://cdn.example/v/720/index.m3u8",
      "https://cdn.example/v/file.mp4",
      "https://cdn.example/v/manifest.mpd",
    ]);
    expect(s.hasMaster()).toBe(true);
  });

  test("higher variant first among media playlists", () => {
    const s = new CandidateSet();
    s.addSniff(sniff({ u: "https://c.example/480p/a.m3u8", k: "hls", r: "media" }));
    s.addSniff(sniff({ u: "https://c.example/1080p/a.m3u8", k: "hls", r: "media" }));
    expect(s.ranked()[0].url).toContain("1080p");
    expect(score(s.ranked()[0])).toBeGreaterThan(score(s.ranked()[1]));
  });

  test("segments, clicks and ad hosts are not candidates", () => {
    const s = new CandidateSet();
    expect(s.addSniff(sniff({ u: "https://c.example/seg1.ts", k: "seg", r: "segment" }))).toBeNull();
    expect(s.addSniff(sniff({ u: "https://p.example/", k: "note", r: "click", el: "DIV#pl_but" }))).toBeNull();
    expect(s.addSniff(sniff({ u: "https://vinnyvower.cfd/x.m3u8", k: "hls" }))).toBeNull();
    expect(s.addSniff(sniff({ u: "http://127.0.0.1:5000/a.m3u8", k: "hls" }))).toBeNull();
    expect(s.size()).toBe(0);
    expect(s.notes.length).toBe(2);
  });

  test("a page-side proxy keeps the wrapper URL and the inner one", () => {
    const s = new CandidateSet();
    const w = "https://upcloud.animanga.fun/proxy?url=https%3A%2F%2Fmegap.shiora.top%2Fa%2Fmaster.m3u8&headers=%7B%7D";
    const c = s.addSniff(sniff({ u: w, k: "hls", r: "master", inner: "https://megap.shiora.top/a/master.m3u8" }))!;
    expect(c.url).toBe(w);
    expect(c.inner).toBe("https://megap.shiora.top/a/master.m3u8");
  });

  test("bridge and Android reports; a sniffer record enriches the same URL", () => {
    const s = new CandidateSet();
    const got = s.addStreams(
      { streams: ["https://cdn.example/m.m3u8", "https://cdn.example/s1.ts"], hdrs: { "https://cdn.example/m.m3u8": { "X-Token": "t" } }, ua: "UA2" },
      "https://vidfast.vc/movie/1",
    );
    expect(got.length).toBe(1);
    expect(got[0].frameOrigin).toBe("https://vidfast.vc");
    const a = s.addStreams(
      { src: "android", streams: ["https://cdn2.example/x.m3u8"], hdrs: { "https://cdn2.example/x.m3u8": { Referer: "https://inner.example/e/1" } } },
      "https://vidsrc.example/",
    );
    expect(a[0].frameOrigin).toBe("https://inner.example");
    s.addSniff(sniff({ u: "https://cdn.example/m.m3u8", k: "hls", r: "master" }));
    const m = s.all().find((c) => c.url === "https://cdn.example/m.m3u8")!;
    expect(m.role).toBe("master");
    expect(m.frameOrigin).toBe("https://player.example");
    expect(m.pageHeaders["X-Token"]).toBe("t");
  });
});

describe("headers", () => {
  test("cross-origin XHR from an inner frame: Referer = frame origin, Origin set, page UA", () => {
    const s = new CandidateSet();
    const c = s.addSniff(sniff({ u: "https://cdn.example/master.m3u8", k: "hls", h: { Authorization: "Bearer x", Range: "bytes=0-" } }))!;
    const h = headersFor(c, UA);
    expect(h.Referer).toBe("https://player.example/");
    expect(h.Origin).toBe("https://player.example");
    expect(h["User-Agent"]).toBe("Mozilla/5.0 Page");
    expect(h.Authorization).toBe("Bearer x");
    expect(h.Range).toBeUndefined();
  });

  test("same-origin request: full frame URL as Referer, no Origin", () => {
    const s = new CandidateSet();
    const c = s.addSniff(sniff({ u: "https://player.example/hls/master.m3u8", k: "hls" }))!;
    const h = headersFor(c, UA);
    expect(h.Referer).toBe("https://player.example/e/abc?x=1");
    expect(h.Origin).toBeUndefined();
  });

  test("referrer policies", () => {
    const s = new CandidateSet();
    const nr = s.addSniff(sniff({ u: "https://cdn.example/a.m3u8", k: "hls", rp: "no-referrer" }))!;
    expect(headersFor(nr, UA).Referer).toBeUndefined();
    const uu = s.addSniff(sniff({ u: "https://cdn.example/b.m3u8", k: "hls", rp: "unsafe-url" }))!;
    expect(headersFor(uu, UA).Referer).toBe("https://player.example/e/abc?x=1");
  });

  test("a page-set Referer wins; media element loads get no Origin", () => {
    const s = new CandidateSet();
    const c = s.addSniff(sniff({ u: "https://cdn.example/f.mp4", k: "mp4", via: "video", h: { Referer: "https://x.example/" } }))!;
    const h = headersFor(c, UA);
    expect(h.Referer).toBe("https://x.example/");
    expect(h.Origin).toBeUndefined();
  });

  test("sameSite", () => {
    expect(sameSite("https://a.cdn.example/x", "https://www.example/y")).toBe(false);
    expect(sameSite("https://a.player.example/x", "https://player.example/y")).toBe(true);
  });
});
