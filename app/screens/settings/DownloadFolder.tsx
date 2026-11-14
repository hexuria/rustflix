// Downloads → Download folder (desktop). Changing it moves the finished
// downloads with it, so it only ever changes through changeDownloadDir —
// never on a keystroke: Change… opens the native folder picker where the
// host has one (else a path field, applied with Apply), Use default goes
// back to the default; when finished downloads will move, the confirm
// dialog asks first.

import { computed, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import {
  canChangeDownloadDir,
  changeDownloadDir,
  defaultDownloadDir,
  downloadDir,
  downloadList,
} from "../../lib/downloads";
import { notify } from "../../lib/player";
import { canPickFolder, focusContent, pickFolder } from "../../lib/system";
import { Button } from "../../lib/ui";
import { askConfirm, INPUT_CLASS, RowText } from "./rows";
import type { RowDef } from "./schema";

/** "1 download", "3 downloads". */
function downloadsLabel(n: number): string {
  return `${n} download${n === 1 ? "" : "s"}`;
}

/** A Button that can be off: dimmed, and its press does nothing. */
function MaybeButton(props: { label: string; primary?: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <View class={props.disabled ? "opacity-40" : ""}>
      <Button
        primary={props.primary}
        size="sm"
        label={props.label}
        onPress={() => {
          if (!props.disabled) props.onPress();
        }}
      />
    </View>
  );
}

const dirEditing = signal(false);
const dirDraft = signal("");
const dirBusy = signal(false);
const dirError = signal("");

/** Finished downloads: the files a folder change moves. */
const movableCount = computed(() => downloadList().filter((e) => e.state === "done").length);

async function runDirChange(path: string) {
  dirBusy.set(true);
  dirError.set("");
  try {
    const res = await changeDownloadDir(path);
    if (res.ok) {
      dirEditing.set(false);
      notify(res.moved > 0 ? `Moved ${downloadsLabel(res.moved)}` : "Download folder changed", "success");
      // A partial move: the folder changed, some downloads stayed behind.
      if (res.error) dirError.set(res.error);
    } else {
      dirError.set(res.error || "The download folder could not be changed.");
    }
  } catch (e) {
    dirError.set(String((e as Error)?.message ?? e) || "The download folder could not be changed.");
  } finally {
    dirBusy.set(false);
  }
}

/** Asks first when downloads will move, else changes at once. */
async function requestDirChange(path: string) {
  const p = path.trim();
  dirError.set("");
  if (!p) {
    dirError.set("Enter the folder's full path.");
    return;
  }
  if (p === downloadDir()) {
    dirEditing.set(false);
    return;
  }
  if (!canChangeDownloadDir() || dirBusy()) return;
  const n = movableCount();
  if (n > 0) {
    const ok = await askConfirm({
      title: `Move ${downloadsLabel(n)}?`,
      body: `Your finished downloads move to the new folder: ${p}`,
      confirm: "Move",
      destructive: false,
    });
    if (!ok) return;
  }
  await runDirChange(p);
}

let picking = false;

/** Change…: the native folder picker where the host has one (then the
 * same confirm and move), else the path field. */
async function chooseFolder() {
  dirError.set("");
  if (picking) return;
  if (canPickFolder()) {
    picking = true;
    try {
      const path = await pickFolder(downloadDir());
      if (path) {
        await requestDirChange(path);
        return;
      }
      if (path === null) return; // cancelled
    } finally {
      picking = false;
    }
  }
  dirDraft.set(downloadDir());
  dirEditing.set(true);
}

/** The "downloadFolder" custom row. */
export function DownloadFolderRow(props: { row: RowDef }) {
  const locked = computed(() => !canChangeDownloadDir() || dirBusy());
  const isDefault = computed(() => downloadDir() === defaultDownloadDir());
  return (
    <View class="gap-2 px-4 py-3">
      <View class="min-h-11 flex-row items-center gap-3">
        <RowText row={props.row} />
        <If when={!dirEditing()}>
          <MaybeButton label="Change…" disabled={locked()} onPress={() => void chooseFolder()} />
          <MaybeButton
            label="Use default"
            disabled={locked() || isDefault()}
            onPress={() => void requestDirChange(defaultDownloadDir())}
          />
        </If>
      </View>
      <Text class="text-xs text-foreground" style={{ numberOfLines: 2 }}>
        {downloadDir()}
      </Text>
      <If when={dirEditing()}>
        <View class="gap-2">
          <Text class="text-xs text-muted-foreground">
            The full path of the new folder. It is made if it does not exist.
          </Text>
          <Input
            value={dirDraft()}
            onChange={({ value }) => dirDraft.set(value)}
            onSubmit={() => void requestDirChange(dirDraft())}
            placeholder={defaultDownloadDir()}
            accessibilityLabel="New download folder"
            onFocus={focusContent}
            autoCorrect={false}
            autoCapitalize="none"
            class={INPUT_CLASS}
          />
          <View class="flex-row justify-end gap-2">
            <MaybeButton
              label="Cancel"
              disabled={dirBusy()}
              onPress={() => {
                dirEditing.set(false);
                dirError.set("");
              }}
            />
            <MaybeButton
              primary
              label={dirBusy() ? "Moving…" : "Apply"}
              disabled={locked()}
              onPress={() => void requestDirChange(dirDraft())}
            />
          </View>
        </View>
      </If>
      <If when={dirBusy()}>
        <Text class="text-sm text-muted-foreground">Moving your downloads…</Text>
      </If>
      <If when={dirError()}>
        <Text class="text-sm text-red-500">{dirError()}</Text>
      </If>
      <If when={!canChangeDownloadDir() && !dirBusy()}>
        <Text class="text-xs text-muted-foreground">Wait for the current download to finish.</Text>
      </If>
    </View>
  );
}
