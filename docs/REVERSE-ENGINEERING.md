# Reverse-engineering notes: Streambert → rustflix

Method: craft-anything's study → build → check loop. Streambert
(`github.com/truelockmc/streambert`, GPL-3.0, v2.7.0) was cloned and its
architecture mapped from source; rustflix re-implements the same product
surface on Rust + GPUI + NSH (`longbridge/nsh`), with the UI authored in
TSX and hosted by a thin GPUI shell (`nsh-platform-gpui`).

## What Streambert is

A cross-platform desktop streaming app (Electron + React + Vite). Users
enter a TMDB API key on first run, then browse trending/popular movies,
shows and anime, pick a playback "source" (embed provider), watch in an
Electron webview-ish player, save to a watchlist, track progress, download
subtitles, and download video via an external helper (`vid-dl-cli-only` +
ffmpeg).

## Architecture map (evidence)

- `index.js` — Electron main: window creation, IPC handlers, the
  `webRequest` intercept used by `NEEDS_INTERCEPT` sources, clean-UA
  builder, auto-update, vid-dl spawn for downloads.
- `preload.js` / `popout-preload.js` — contextBridge surface to the
  renderer (`window.electron.*`).
- `src/App.jsx` (~1.4k lines) — screen switching (home / movie / tv /
  library / downloads / settings), modals (search, download, subtitles,
  keyboard shortcuts, Wyzie key, blocked stats, update, trailer, cast).
- `src/pages/*` — HomePage (trending carousel + rows), MoviePage, TVPage
  (seasons/episodes, source picker, progress), LibraryPage, DownloadsPage,
  SettingsPage (~4.5k lines: appearance, playback, sources, subtitles,
  downloads, Discord RPC, gamepad, blocked-site stats).
- `src/utils/api.js` (~770 lines) — TMDB client: `api_key`/Bearer token,
  5-minute in-memory cache, max-4 in-flight throttle, `imgUrl`, language
  override, `PLAYER_SOURCES` table (10 embed providers), `getSourceUrl`,
  IMDb/Kinopoisk ID resolution helpers, AniList helpers.
- `src/utils/*` — aniSkip (skip-intro timings), subtitles, episode
  mappings, appearance, gamepad nav, discord presence, backup/restore,
  storage (localStorage-backed settings).
- `src/ipc/*` — main-process side: `player.js` (~1k lines: stream URL
  resolution, progress tracking via executeJavaScript, quality handling),
  `hianime.js` (~1k lines: HiAnime scraping for anime streams),
  `downloads.js` (~1k lines), `subtitles.js`, `blockStats.js`,
  `discordRpc.js`, `storage.js`, `siteTweaks.js`.

## Feature inventory → rustflix coverage

| Streambert feature | rustflix v0.1 |
|---|---|
| TMDB browse (trending, popular, top rated, upcoming, now playing) | ✅ Home rows |
| Multi search (movies/TV) | ✅ Search screen |
| Anime metadata via AniList | ✅ Home/Search/Title |
| Title pages w/ seasons & episodes (TV), episode grid (anime) | ✅ Title screen |
| Player source picker (10 embed providers) | ✅ Player screen (WebView) |
| Watchlist ("My List") | ✅ Library screen |
| Watch progress / continue watching | ✅ progress store + player probe |
| Settings: API key, accent, sources | ✅ Settings screen (key, source, subtitle lang) |
| Local persistence | ✅ `nsh/storage` (storage.json in app data dir) |
| Privacy: no ads/trackers | ✅ same posture (no telemetry) |
| Subtitles download/manage | ⬜ not yet |
| Video downloads (vid-dl + ffmpeg) | ⬜ not yet |
| HiAnime direct scraping for anime streams | ⬜ vidnest anime route used instead |
| AniSkip intro skipping | ⬜ not yet |
| Discord RPC, gamepad, blocked stats, auto-update, trailer/cast modals | ⬜ not yet |

## Key technical mappings

- **Embed playback**: Streambert loads provider embed pages in Electron
  and (for `NEEDS_INTERCEPT` sources) rewrites requests via
  `webRequest`. rustflix loads the same URLs in nsh's `<WebView>`
  (wry/WKWebView). The four intercept sources (`vidsrc`, `devideosrc`,
  `frembed`, `kinohub`) are kept in the source list but flagged "may not
  load" — wry has no request interception.
- **Progress tracking**: Streambert polls `video.currentTime` via
  `executeJavaScript`. rustflix polls the same way through
  `WebViewRef.evaluate()` every 10 s and persists to `nsh/storage`.
- **Anime**: Streambert scrapes AllManga/HiAnime for direct mp4s; rustflix
  uses AniList for metadata and the vidnest provider's dedicated anime
  route (`/anime/{anilistId}/{ep}/{sub|dub}`) for playback.
- **Storage**: Streambert uses localStorage + JSON files; rustflix uses
  `nsh/storage` (`Storage.getItem/setItem`), one `storage.json` under the
  app data dir.
- **Capabilities**: `app/nsh.json` grants `network` to TMDB/AniList/
  AniSkip/HiAnime hosts, `webview` to all hosts (embed providers navigate
  to arbitrary CDNs), and `openUrl` for https.

## Stack

- Rust host: `nsh-platform-gpui` 0.4.0 (`run_app`, `AppSource::Bundle`),
  `build.rs` bundles `app/` with `nsh-bundler` + compiles QuickJS
  bytecode with `nsh-js` — same pipeline as `nsh build`.
- UI: TSX on `nsh` primitives + Tailwind tokens + `nsh/base` Input,
  Solid-style `signal`/`computed`/`effect`, global `If`/`Each`.
- No custom Rust modules needed for v0.1: `fetch`, `Storage`, `WebView`
  cover the whole product surface.
