# rustflix on macOS

The desktop app is a thin Rust shell (`src/`) that opens a GPUI window and
runs the TSX interface in `app/` on NSH (`nsh-platform-gpui` 0.4.0 from
crates.io). Video pages play in a native web view.

## Develop

```sh
cargo run                          # build app/ (build.rs) and open the window
cargo run -- path/to/bundle.nshc   # run another bundle, or a directory holding one
```

The binary picks its bundle in this order: a path given on the command
line, then `Contents/Resources/nsh/bundle.nshc` when it runs inside
`rustflix.app`, then the copy `build.rs` wrote to `$OUT_DIR/app`.

A debug build (`cargo run`) bundles `app/` unminified. A release build
(`cargo build --release`) minifies and strips the bytecode, as
`nsh build --release` does.

## Package

```sh
./package-macos.sh [output-dir]   # default: ~/Applications
```

The script:

1. reads `WYZIE_API_KEY` / `SUBDL_API_KEY` from the Keychain through
   `secret get` when the `secret` command exists and the variables are not
   already set (see the README's "API keys");
2. runs `cargo build --profile release` (or `--profile perf` with `PERF=1`);
3. finds the bundle under `target/<profile>` or
   `~/.cargo/targets/rustflix-*/<profile>`;
4. writes `rustflix.app`: the binary in `Contents/MacOS/`, the bundle in
   `Contents/Resources/nsh/`, an `Info.plist` (bundle id
   `com.hexuria.rustflix`, version 0.1.0, minimum macOS 13.0) and the icon
   from `$ICNS` (default `/tmp/rustflix.icns`) if that file exists;
5. ad-hoc signs the app (`codesign --sign -`).

For distribution, re-sign with a Developer ID certificate and notarize;
the script does not do this.

### Perf profile

```sh
PERF=1 ./package-macos.sh
```

Builds with the `perf` Cargo profile (release, plus line tables and the
symbol table) so the FPS monitor's spike stacks resolve to file and line.

## Where the app keeps its data

| What | Path |
| --- | --- |
| Library, settings (NSH storage), download records, perf recordings | `~/Library/Application Support/com.hexuria.rustflix/` |
| Download records | `.../com.hexuria.rustflix/rustflix-downloads.json` |
| Downloaded videos (default; change in Settings → Downloads) | `~/Downloads/rustflix/` |
| Image cache | `~/Library/Caches/com.hexuria.rustflix/images` |
| Web view network cache | `~/Library/Caches/com.hexuria.rustflix/WebKit` |
| Video sites' cookies and site data | `~/Library/WebKit/com.hexuria.rustflix/WebsiteData` |

Settings → Storage shows the size of the three caches and clears each.
In the packaged app clearing web and site data applies at once; under
`cargo run` WebKit names its directories after the executable, so the
directories above are emptied on disk and a running packaged app sees the
change after relaunch.

Removing a download moves its folder to the Trash.

## Diagnostics

- **FPS monitor**: ⌘⇧F, or Settings → Diagnostics → Show FPS monitor. A
  panel over the window shows frames per second, frame times and JS time.
- **Recorder**: while the monitor shows, it writes one line a second to
  `perf.jsonl` and slow or late frames to `perf-spikes.jsonl` in the data
  directory above (rolled at 2 MB). ⌘⇧R, or Settings → Diagnostics → Save
  performance recording, renames both to timestamped files
  (`perf-<stamp>.jsonl`, `perf-spikes-<stamp>.jsonl`); a toast names them.
- **Diagnostics switch** (Settings → Diagnostics) records player bridge
  events to storage for troubleshooting.

## Keyboard shortcuts

These are the defaults. Change them in Settings → Keyboard shortcuts:
click a key, press the new keys (Esc cancels, ⌫ removes the key); a key
another action has is flagged (Replace or Cancel), keys the app or the
system needs (⌘C, ⌘V, ⌘X, ⌘A, ⌘Z, ⌘⇧Z, ⌘Q, ⌘W, ⌘H, ⌘M, the palette's
typing keys) are refused, and Reset to defaults brings these back. The
palette's filter keys and ⌘1–⌘9 picking its items are fixed.

Anywhere:

| Keys | Action |
| --- | --- |
| ⌘1 | Home (in the player palette: item 1) |
| ⌘F | Search, with the field focused |
| ⌘L | My List |
| ⌘D | Downloads |
| ⌘, | Settings |
| ⌘[ / ⌘] | Back / forward through the places you visited (across tabs, and back into the player) |
| Esc | Close the palette, a picker or a popup; in the player, close it; else go back |
| ⌘⇧F | Toggle the FPS monitor |
| ⌘⇧R | Save the performance recording |

The tab shortcuts (⌘1, ⌘F, ⌘L, ⌘D, ⌘,) toggle: pressed again while their
tab shows, they return to where you were before the first of them — from
the player, ⌘L shows My List and ⌘L again resumes the video where it was.
Each tab keeps its own pages: switching tabs shows a tab as you left it
(click a tab in the sidebar while it shows to go to its top page).

In the player:

| Keys | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Back / forward by the seek step, 10 seconds by default (repeats while held) |
| ↑ / ↓ | Volume up / down |
| ⌘= (⌘+) / ⌘− | Volume up / down (repeats while held) |
| M | Mute |
| F | Full screen |
| ⌘K | Command palette: episodes, play/pause, ±10 s, speed, subtitles, download, choose source |
| ⌘1–⌘9 | Pick a palette item while the palette is open (fixed) |
| ⌘N / ⌘P | Next / previous episode |
| ⌘E | Episodes (series) |
| ⌘⇧S | Sources |
| ⌘⇧D | Download what is playing |

In the palette's filter: type to filter, ⌫ deletes a character, ⌥⌫ a
word, ⌘⌫ everything; ⌘A selects the filter (typing replaces it), ⌘V
pastes; ↵ runs the first item.

The plain player keys are off while the palette, the source picker or the
episode picker is open, and while you type in a text field.
