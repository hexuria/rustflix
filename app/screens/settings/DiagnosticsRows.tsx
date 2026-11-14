// Diagnostics (hidden until the version in About is tapped seven times):
// the FPS monitor, saving its recording, and the player's diagnostics log.
// ⌘⇧F / ⌘⇧R and the two-finger triple tap work whether or not this shows.

import { platform, signal, Storage } from "nsh";
import { savePerfRecording, fpsMonitorOn, setFpsMonitor } from "../../lib/perf";
import { setDebugEnabled } from "../../lib/player";
import { Button } from "../../lib/ui";
import { Row, SwitchRow } from "./rows";
import type { RowDef } from "./schema";

const dbgOn = signal(false);
void Storage.getItem("rustflix.debug")
  .then((v) => dbgOn.set(v === "1"))
  .catch(() => {});

export function FpsRow(props: { row: RowDef }) {
  const row: RowDef = {
    ...props.row,
    description: platform.desktop
      ? "Frame rate and frame times over the app (⌘⇧F)."
      : "Frame rate and frame times over the app. A two-finger triple tap anywhere toggles it.",
  };
  return <SwitchRow row={row} get={() => fpsMonitorOn()} set={(on) => setFpsMonitor(on)} />;
}

export function RecordingRow(props: { row: RowDef }) {
  const row: RowDef = {
    ...props.row,
    description: platform.desktop
      ? "The monitor records while it shows; this saves it (⌘⇧R)."
      : "The monitor records while it shows; this saves and shares it.",
  };
  return (
    <Row
      row={row}
      control={<Button label="Save" size="sm" onPress={() => void savePerfRecording(!platform.desktop)} />}
    />
  );
}

export function DebugLogRow(props: { row: RowDef }) {
  return (
    <SwitchRow
      row={props.row}
      get={() => dbgOn()}
      set={(on) => {
        dbgOn.set(on);
        setDebugEnabled(on);
      }}
    />
  );
}
