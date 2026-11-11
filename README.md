# rustflix

A native streaming app: **Rust + GPUI + NSH**. Reverse-engineered from
[Streambert](https://github.com/truelockmc/streambert) — browse movies,
TV and anime (TMDB + AniList), pick an embed playback source, keep a
watchlist and continue-watching progress. No ads, no trackers.

The UI is a TSX app (`app/`) running on
[NSH](https://github.com/longbridge/nsh) inside a GPUI window
(`nsh-platform-gpui`); `build.rs` bundles it like `nsh build` does.
See `docs/REVERSE-ENGINEERING.md` for the feature map.

## Run

```sh
cargo run            # builds app/ and opens the window
cargo run -- path/to/bundle.nshc   # run another bundle
```

First run: add a free TMDB API key (v3 key or v4 read access token) in
Settings or the setup screen.

## Layout

- `src/main.rs` — thin GPUI shell (`run_app`)
- `build.rs` — NSH bundler + QuickJS bytecode pipeline
- `app/` — the TSX interface
  - `lib/tmdb.ts` — TMDB client + image URLs
  - `lib/anilist.ts` — AniList GraphQL client
  - `lib/sources.ts` — player embed sources (ported from Streambert)
  - `lib/store.ts` — watchlist / progress / settings (`nsh/storage`)
  - `lib/router.ts` — signal router
  - `screens/` — Home, Search, Title, Player, Library, Settings, Setup
