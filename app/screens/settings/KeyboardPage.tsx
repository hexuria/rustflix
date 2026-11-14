// Settings → Keyboard shortcuts (desktop): the registry's actions
// (lib/shortcuts.ts) in their groups, each with its keys. Click (or focus
// and press) a key to change it: the next keystroke takes its place, Esc
// cancels, ⌫ clears it. A keystroke another action has is flagged
// ("Already used by …": Replace / Cancel); reserved ones are refused with
// the reason. While a key is captured the app's shortcuts are off, so the
// key never runs the action being changed.

import { cleanup, computed, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Button } from "../../lib/ui";
import { askConfirm, INPUT_CLASS } from "./rows";
import {
  allDefault,
  cancelCapture,
  captureChord,
  chordCaps,
  chordsFor,
  findClash,
  formatChord,
  loadShortcuts,
  rebind,
  removeChord,
  replaceChord,
  resetAllShortcuts,
  resetShortcut,
  shortcutGroups,
  type Clash,
  type ShortcutId,
  type ShortcutRow,
} from "../../lib/shortcuts";

const keys = (list: string[]) => list.map(formatChord).join(", ");
const FIXED_NOTE =
  `Fixed: the command palette's typing keys (letters, digits, ${keys(["backspace", "alt+backspace", "mod+backspace", "mod+a", "mod+v", "enter"])}) ` +
  `and ${formatChord("mod+1")}–${formatChord("mod+9")}, which pick a palette item while it is open. ` +
  `Text editing (${keys(["mod+c", "mod+v", "mod+x", "mod+a", "mod+z"])}) and the system's ${keys(["mod+q", "mod+w", "mod+h", "mod+m"])} cannot be used.`;

/** The slot being captured. */
type Slot = { id: ShortcutId; slot: number };
/** A captured keystroke that clashes, waiting for Replace / Cancel. */
type Pending = Slot & { chord: string; clash: Clash };

const editing = signal<Slot | null>(null);
const pending = signal<Pending | null>(null);

async function startCapture(row: ShortcutRow, slot: number) {
  pending.set(null);
  const token: Slot = { id: row.id, slot };
  editing.set(token);
  const r = await captureChord();
  // Another capture took over.
  if (editing() !== token) return;
  editing.set(null);
  if (r === null) return;
  if (r === "") {
    if (slot < chordsFor(row.id).length) removeChord(row.id, slot);
    return;
  }
  const clash = findClash(r, row.scope, row.id);
  if (!clash) rebind(row.id, slot, r);
  else pending.set({ id: row.id, slot, chord: r, clash });
}

function stopCapture() {
  editing.set(null);
  cancelCapture();
}

/** One key cap. */
function Cap(props: { text: string; accent?: boolean }) {
  return (
    <View
      class={`items-center justify-center rounded-md border bg-background px-1.5 ${
        props.accent ? "border-primary" : "border-border"
      }`}
      style={{ minWidth: 24, height: 24, borderBottomWidth: 2 }}
    >
      <Text
        class="font-semibold text-foreground"
        allowFontScaling={false}
        style={{ fontSize: 12, lineHeight: 16, numberOfLines: 1 }}
      >
        {props.text}
      </Text>
    </View>
  );
}

/** A keystroke's caps, pressable: captures a new keystroke for its slot. */
function ChordButton(props: { row: ShortcutRow; slot: number; chord: string | null }) {
  const active = () => {
    const e = editing();
    return !!e && e.id === props.row.id && e.slot === props.slot;
  };
  return (
    <View
      role="button"
      accessibilityLabel={
        props.chord
          ? `Change ${props.row.label}: ${formatChord(props.chord)}`
          : `Set a key for ${props.row.label}`
      }
      onPress={() => (active() ? stopCapture() : void startCapture(props.row, props.slot))}
      class={`cursor-pointer flex-row items-center gap-1 rounded-lg border px-1.5 py-1 hover:bg-muted focus:border-primary ${
        active() ? "border-primary bg-muted" : "border-transparent"
      }`}
    >
      <If
        when={!active()}
        else={
          <Text class="px-1 text-xs font-semibold text-primary" style={{ lineHeight: 24 }}>
            Press keys…
          </Text>
        }
      >
        <If
          when={props.chord}
          else={
            <Text class="px-1 text-xs text-muted-foreground" style={{ lineHeight: 24 }}>
              Not set
            </Text>
          }
        >
          {(c) => <Each of={chordCaps(c())}>{(k) => <Cap text={k()} />}</Each>}
        </If>
      </If>
    </View>
  );
}

/** A small text button (Reset, Add). */
function Link(props: { label: string; onPress: () => void; accessibilityLabel?: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={props.onPress}
      class="cursor-pointer justify-center rounded-md px-2 hover:bg-muted"
      style={{ height: 28 }}
    >
      <Text class="text-xs font-semibold text-primary" style={{ lineHeight: 16 }}>
        {props.label}
      </Text>
    </View>
  );
}

function ShortcutRowView(props: { id: ShortcutId }) {
  const row = computed(() => {
    for (const g of shortcutGroups()) {
      const a = g.actions.find((x) => x.id === props.id);
      if (a) return a;
    }
    return null;
  });
  const capturingHere = () => editing()?.id === props.id;
  const waiting = () => {
    const p = pending();
    return p && p.id === props.id ? p : null;
  };
  return (
    <If when={row()}>
      {(r) => (
        <View class="min-h-12 gap-2 px-4 py-2.5">
          <View class="flex-row items-center gap-3">
            <View class="flex-1 gap-0.5">
              <Text class="text-sm font-medium text-foreground">{r().label}</Text>
              <If when={r().description}>
                {(d) => <Text class="text-xs text-muted-foreground">{d()}</Text>}
              </If>
            </View>
            <View class="flex-row flex-wrap items-center justify-end gap-1" style={{ flexShrink: 1 }}>
              <If when={r().chords.length > 0} else={<ChordButton row={r()} slot={0} chord={null} />}>
                <Each of={r().chords} key="index">
                  {(c, i) => <ChordButton row={r()} slot={i()} chord={c()} />}
                </Each>
              </If>
              <If when={r().chords.length > 0 && r().chords.length < 3}>
                <If
                  when={!(editing()?.id === props.id && editing()?.slot === r().chords.length)}
                  else={<ChordButton row={r()} slot={r().chords.length} chord={null} />}
                >
                  <Link
                    label="+"
                    accessibilityLabel={`Add a key for ${r().label}`}
                    onPress={() => void startCapture(r(), r().chords.length)}
                  />
                </If>
              </If>
              <If when={!r().isDefault}>
                <Link
                  label="Reset"
                  accessibilityLabel={`Reset ${r().label} to its default`}
                  onPress={() => {
                    stopCapture();
                    pending.set(null);
                    resetShortcut(props.id);
                  }}
                />
              </If>
            </View>
          </View>
          <If when={capturingHere()}>
            <View class="flex-row items-center justify-end gap-3">
              <Text class="text-xs text-muted-foreground">Press keys… Esc to cancel, ⌫ to clear</Text>
              <Button label="Cancel" size="sm" variant="ghost" onPress={stopCapture} />
            </View>
          </If>
          <If when={waiting()}>
            {(p) => (
              <View class="flex-row flex-wrap items-center justify-end gap-2">
                <If
                  when={p().clash.id}
                  else={
                    <Text class="text-xs text-red-400" style={{ flexShrink: 1 }}>
                      {`${formatChord(p().chord)} can't be used: ${p().clash.reason ?? "it is reserved"}.`}
                    </Text>
                  }
                >
                  <Text class="text-xs text-red-400" style={{ flexShrink: 1 }}>
                    {`${formatChord(p().chord)} is already used by ${p().clash.label}.`}
                  </Text>
                </If>
                <If
                  when={p().clash.id}
                  else={
                    <Button
                      label="Try another"
                      size="sm"
                      variant="secondary"
                      onPress={() => void startCapture(r(), p().slot)}
                    />
                  }
                >
                  <Button
                    label="Replace"
                    size="sm"
                    variant="primary"
                    accessibilityLabel={`Replace: ${p().clash.label} loses ${formatChord(p().chord)}`}
                    onPress={() => {
                      const q = p();
                      pending.set(null);
                      replaceChord(q.id, q.slot, q.chord);
                    }}
                  />
                </If>
                <Button label="Cancel" size="sm" variant="ghost" onPress={() => pending.set(null)} />
              </View>
            )}
          </If>
        </View>
      )}
    </If>
  );
}

export function KeyboardPage() {
  void loadShortcuts();
  const filter = signal("");
  // Leaving the page ends a capture (the shortcuts come back).
  cleanup(() => {
    stopCapture();
    pending.set(null);
  });

  const groups = computed(() => {
    const q = filter().trim().toLowerCase();
    return shortcutGroups()
      .map((g) => ({
        group: g.group,
        ids: g.actions
          .filter(
            (a) =>
              !q ||
              a.label.toLowerCase().includes(q) ||
              (a.description ?? "").toLowerCase().includes(q) ||
              g.group.toLowerCase().includes(q) ||
              a.chords.some((c) => formatChord(c).toLowerCase().includes(q)),
          )
          .map((a) => a.id),
      }))
      .filter((g) => g.ids.length > 0);
  });

  return (
    <View class="gap-5">
      <View class="gap-2">
        <Text class="text-sm text-muted-foreground">
          Click a shortcut and press the new keys. Esc cancels, ⌫ removes the key.
        </Text>
        <Input
          value={filter()}
          onChange={({ value }) => filter.set(value)}
          placeholder="Filter shortcuts"
          accessibilityLabel="Filter shortcuts"
          autoCorrect={false}
          autoCapitalize="none"
          class={INPUT_CLASS}
        />
      </View>

      <If
        when={groups().length > 0}
        else={<Text class="text-sm text-muted-foreground">No shortcut matches.</Text>}
      >
        <Each of={groups()} key={(g) => g.group}>
          {(g) => (
            <View class="gap-1.5">
              <Text class="px-4 text-xs font-semibold uppercase text-muted-foreground" style={{ letterSpacing: 0.4 }}>
                {g().group}
              </Text>
              <View class="overflow-hidden rounded-xl border border-border bg-card">
                <Each of={g().ids}>
                  {(id, i) => (
                    <>
                      <If when={i() > 0}>
                        <View class="ml-4 h-px bg-border" />
                      </If>
                      <ShortcutRowView id={id()} />
                    </>
                  )}
                </Each>
              </View>
            </View>
          )}
        </Each>
      </If>

      <Text class="px-4 text-xs text-muted-foreground">{FIXED_NOTE}</Text>

      <View class="flex-row">
        <Button
          label="Reset to defaults"
          variant="outline"
          disabled={allDefault()}
          onPress={() =>
            void askConfirm({
              title: "Reset keyboard shortcuts?",
              body: "Every shortcut goes back to its default keys. Your changes are lost.",
              confirm: "Reset",
            }).then((yes) => {
              if (!yes) return;
              stopCapture();
              pending.set(null);
              resetAllShortcuts();
            })
          }
        />
      </View>
    </View>
  );
}
