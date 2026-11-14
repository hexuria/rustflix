// About: the app, its version and build (from the host: `sys.appInfo` —
// src/appkit.rs on the desktops, SystemControls.swift on iOS,
// SystemControls.java on Android), the acknowledgements and TMDB's notice.
// Tapping the version seven times unlocks Diagnostics.

import { host, signal, Text, untracked, View } from "nsh";
import { notify } from "../../lib/player";
import { Row } from "./rows";
import type { RowDef } from "./schema";
import { devMode, setDevMode } from "./state";

/** The bundle's version (as lib/player.ts keys `rustflix.playcaps` with):
 * shown when the host cannot say. */
const BUNDLE_VERSION = "0.1.0";

export const appInfo = signal<{ version: string; build: string }>({ version: BUNDLE_VERSION, build: "" });
let asked = false;

async function loadAppInfo() {
  if (asked) return;
  asked = true;
  try {
    if (!host.available()) return;
    const r = (await host.call("sys.appInfo", {} as never)) as { version?: unknown; build?: unknown } | null;
    if (r && typeof r.version === "string" && r.version) {
      appInfo.set({
        version: r.version,
        build: r.build == null ? "" : String(r.build),
      });
    }
  } catch {
    // An older host: the bundle's version.
  }
}

/** "0.1.0 (12)". */
export function versionLabel(): string {
  const i = appInfo();
  return i.build ? `${i.version} (${i.build})` : i.version;
}

const TAPS = 7;
const TAP_GAP_MS = 1500;
let taps = 0;
let lastTap = 0;

/** One tap on the version: the seventh in a row (each within 1.5 s of the
 * one before) unlocks Diagnostics. */
export function tapVersion() {
  const now = Date.now();
  taps = now - lastTap > TAP_GAP_MS ? 1 : taps + 1;
  lastTap = now;
  if (taps < TAPS) return;
  taps = 0;
  if (untracked(devMode)) {
    notify("Diagnostics are already on");
    return;
  }
  setDevMode(true);
  notify("Diagnostics unlocked", "success");
}

export function VersionRow(props: { row: RowDef }) {
  void loadAppInfo();
  return (
    <View role="button" accessibilityLabel={`Version ${versionLabel()}`} onPress={tapVersion}>
      <Row
        row={props.row}
        control={
          <Text class="text-sm text-muted-foreground" style={{ numberOfLines: 1 }}>
            {versionLabel()}
          </Text>
        }
      />
    </View>
  );
}

export function AcknowledgementsRow(props: { row: RowDef }) {
  return (
    <View class="gap-2 px-4 py-3">
      <Text class="text-sm font-medium text-foreground">{props.row.label}</Text>
      <Text class="text-sm text-muted-foreground">
        Built on NSH and GPUI, with metadata from TMDB and AniList; the embed source list is adapted
        from Streambert.
      </Text>
      <Text class="text-xs text-muted-foreground">
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </Text>
    </View>
  );
}

/** Over About's rows: the app's name and what it is. */
export function AboutHeader() {
  void loadAppInfo();
  return (
    <View class="items-center gap-1.5 py-4">
      <Text class="text-3xl font-extrabold text-foreground">rustflix</Text>
      <Text class="text-sm text-muted-foreground" style={{ textAlign: "center", maxWidth: 440 }}>
        A Rust + GPUI + NSH rebuild of Streambert's interface: TMDB metadata, AniList anime,
        embed-source playback in a native web view, local watchlist and progress.
      </Text>
    </View>
  );
}
