// Settings' building blocks: the grouped section card, the rows (switch,
// segmented, value + chevron, key field with its Saved mark, action and
// destructive action), the confirm dialog and the category icon tile.
// Rows put their control on the right on wide screens and under the label
// on phones (`stackedRows`); switches and value rows stay on one line.

import { computed, effect, Image, signal, Text, untracked, View, type JSX, type ViewRef } from "nsh";
import { Dialog, Input, Switch } from "nsh/base";
import { notify } from "../../lib/player";
import { focusContent } from "../../lib/system";
import { BUNDLED_SUBDL_KEY, BUNDLED_WYZIE_KEY } from "../../lib/subtitles";
import { clearCache, hasBundledKey, loadKey, savedKey, saveKey } from "../../lib/tmdb";
import { saveSettings, settings } from "../../lib/store";
import { Button } from "../../lib/ui";
import { Glyph, icon } from "../PlayerControls";
import { openPage } from "./nav";
import type { CategoryDef, Confirm, Control, RowDef, SectionDef } from "./schema";
import { highlightRow, stackedRows } from "./state";

export const INPUT_CLASS =
  "min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-foreground";

const TRACK_CLASS = "h-7 w-12 justify-center rounded-full bg-muted px-0.5 checked:bg-primary";
const THUMB_CLASS = "h-6 w-6 rounded-full bg-white checked:translate-x-5";

// --- Category icon --------------------------------------------------------------------

/** The category's icon: its drawing on a rounded tile of its colour. */
export function CategoryIcon(props: { category: CategoryDef; size?: number }) {
  const s = props.size ?? 28;
  return (
    <View
      class="items-center justify-center"
      style={{ width: s, height: s, borderRadius: Math.round(s * 0.26), backgroundColor: props.category.color }}
    >
      <Image
        src={icon(props.category.icon, Math.round(s * 0.64))}
        style={{ width: Math.round(s * 0.64), height: Math.round(s * 0.64) }}
      />
    </View>
  );
}

/** The chevron of rows that open a page. */
export function Chevron() {
  return <Glyph d="forward" size={14} color="#8e8e93" />;
}

// --- Sections ----------------------------------------------------------------------------

/** Custom rows' views, by `render` name (filled by screens/settings/index.tsx). */
export const customRows: Record<string, (row: RowDef) => JSX.Element> = {};

/** One section: its heading, a card of its rows (hairlines between), its
 * small print. Rows whose `visible` is off are left out. */
export function SectionView(props: { section: SectionDef }) {
  const rows = computed(() => props.section.rows.filter((r) => !r.visible || r.visible()));
  return (
    <View class="gap-1.5">
      <If when={props.section.title}>
        {(t) => (
          <Text class="px-4 text-xs font-semibold uppercase text-muted-foreground" style={{ letterSpacing: 0.4 }}>
            {t()}
          </Text>
        )}
      </If>
      <If
        when={!props.section.bare}
        else={
          <Each of={rows()} key={(r: RowDef) => r.id}>
            {(r) => <RowFor row={r()} />}
          </Each>
        }
      >
        <View class="overflow-hidden rounded-xl border border-border bg-card">
          <Each of={rows()} key={(r: RowDef) => r.id}>
            {(r, i) => (
              <>
                <If when={i() > 0}>
                  <View class="ml-4 h-px bg-border" />
                </If>
                <RowFor row={r()} />
              </>
            )}
          </Each>
        </View>
      </If>
      <If when={props.section.footer}>
        {(t) => (
          <Text class="px-4 text-xs text-muted-foreground" style={{ flexShrink: 0 }}>
            {t()}
          </Text>
        )}
      </If>
    </View>
  );
}

/** Rows' views by id, for scrolling a highlighted one into view. */
export const rowRefs = new Map<string, ViewRef>();

/** A row by its control's kind, highlighted while a search result points
 * at it. */
export function RowFor(props: { row: RowDef }) {
  const r = props.row;
  return (
    <View
      ref={(v: ViewRef) => rowRefs.set(r.id, v)}
      class={highlightRow() === r.id ? "bg-primary/20" : ""}
    >
      {controlView(r, r.control)}
    </View>
  );
}

function controlView(r: RowDef, c: Control): JSX.Element {
  switch (c.kind) {
    case "switch":
      return <SwitchRow row={r} get={c.get} set={c.set} />;
    case "segmented":
      return <SegmentedRow row={r} options={c.options} get={c.get} set={c.set} />;
    case "picker":
      return (
        <ValueRow
          row={r}
          value={() =>
            c.display ? c.display(c.get()) : c.options().find((o) => o.value === c.get())?.label ?? ""
          }
          onPress={() => openPage(`pick:${r.id}`)}
        />
      );
    case "key":
      return <FieldRow row={r} keyId={c.key} />;
    case "action":
      return <ActionRow row={r} control={c} />;
    case "custom": {
      const view = customRows[c.render];
      return view ? view(r) : <Row row={r} />;
    }
  }
}

// --- Rows ------------------------------------------------------------------------------

/** The label, its description and the changing detail line. */
export function RowText(props: { row: RowDef; trailing?: JSX.Element }) {
  return (
    <View class="flex-1 gap-0.5" style={{ minWidth: 0 }}>
      <View class="flex-row items-center gap-2">
        <Text class="text-sm font-medium text-foreground" style={{ flexShrink: 1 }}>
          {props.row.label}
        </Text>
        {props.trailing}
      </View>
      <If when={props.row.description}>
        {(d) => <Text class="text-xs text-muted-foreground">{d()}</Text>}
      </If>
      <If when={props.row.detail?.()}>
        {(d) => <Text class="text-xs text-muted-foreground">{d()}</Text>}
      </If>
    </View>
  );
}

/** A row: its text and, beside it (wide) or under it (`stack` on phones),
 * a control. */
export function Row(props: { row: RowDef; control?: JSX.Element; stack?: boolean; trailing?: JSX.Element }) {
  const stacked = () => !!props.stack && stackedRows();
  return (
    <View
      class={stacked() ? "min-h-12 gap-2.5 px-4 py-3" : "min-h-12 flex-row items-center gap-3 px-4 py-2.5"}
    >
      <RowText row={props.row} trailing={props.trailing} />
      <If when={props.control}>{props.control}</If>
    </View>
  );
}

export function SwitchRow(props: { row: RowDef; get: () => boolean; set: (on: boolean) => void }) {
  return (
    <Switch
      checked={props.get()}
      onChange={({ checked }) => props.set(checked)}
      accessibilityLabel={props.row.label}
      class="min-h-12 cursor-pointer flex-row-reverse items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
      trackClass={TRACK_CLASS}
      thumbClass={THUMB_CLASS}
    >
      <RowText row={props.row} />
    </Switch>
  );
}

/** Two to four short values side by side, the chosen one filled. */
export function Segmented(props: {
  label: string;
  options: { value: string; label: string }[];
  value: () => string;
  onChange: (v: string) => void;
  fill?: boolean;
}) {
  return (
    <View
      role="radiogroup"
      accessibilityLabel={props.label}
      class="flex-row rounded-lg bg-white/10 p-0.5"
      style={{ alignSelf: props.fill ? "stretch" : "center", flexShrink: 0 }}
    >
      <Each of={props.options}>
        {(o) => (
          <View
            role="radio"
            accessibilityLabel={o().label}
            accessibilityState={{ selected: props.value() === o().value, checked: props.value() === o().value }}
            onPress={() => props.onChange(o().value)}
            class={
              props.value() === o().value
                ? "h-8 cursor-pointer items-center justify-center rounded-md bg-zinc-600 px-3"
                : "h-8 cursor-pointer items-center justify-center rounded-md px-3 hover:bg-white/5 active:bg-white/10"
            }
            style={props.fill ? { flexGrow: 1, flexBasis: 0 } : undefined}
          >
            <Text
              class={props.value() === o().value ? "font-semibold text-white" : "font-medium text-zinc-300"}
              allowFontScaling={false}
              style={{ fontSize: 13, lineHeight: 16, numberOfLines: 1 }}
            >
              {o().label}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

export function SegmentedRow(props: {
  row: RowDef;
  options: { value: string; label: string }[];
  get: () => string;
  set: (v: string) => void;
}) {
  return (
    <Row
      row={props.row}
      stack
      control={
        <Segmented
          label={props.row.label}
          options={props.options}
          value={props.get}
          onChange={props.set}
          fill={stackedRows()}
        />
      }
    />
  );
}

/** A value and a chevron: opens a picker. */
export function ValueRow(props: { row: RowDef; value: () => string; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={`${props.row.label}, ${props.value()}`}
      onPress={props.onPress}
      class="min-h-12 cursor-pointer flex-row items-center gap-3 px-4 py-2.5 hover:bg-muted/50 active:bg-muted"
    >
      <RowText row={props.row} />
      <Text class="text-sm text-muted-foreground" style={{ numberOfLines: 1, maxWidth: stackedRows() ? 130 : 220 }}>
        {props.value()}
      </Text>
      <Chevron />
    </View>
  );
}

// --- Key fields ---------------------------------------------------------------------------

/** How long typing must pause before a key saves by itself. */
const KEY_PAUSE_MS = 1200;

const KEYS = {
  tmdb: {
    stored: () => savedKey(),
    save: async (v: string) => {
      await saveKey(v);
      clearCache();
    },
    builtIn: () => hasBundledKey(),
  },
  wyzie: {
    stored: () => settings().subtitleKey ?? "",
    save: (v: string) => saveSettings({ subtitleKey: v }),
    builtIn: () => !!BUNDLED_WYZIE_KEY,
  },
  subdl: {
    stored: () => settings().subdlKey ?? "",
    save: (v: string) => saveSettings({ subdlKey: v }),
    builtIn: () => !!BUNDLED_SUBDL_KEY,
  },
} as const;

/** Debug (`rustflix.opensettings` "key"): types `value` into a key field. */
const debugKey = signal<{ id: string; value: string } | null>(null);
export function setDebugKey(id: string, value: string) {
  debugKey.set({ id, value });
}

/** A key field: saves on Enter, when it loses focus, or after a pause in
 * typing; then a brief "Saved" (or "Using the built-in key" once emptied). */
export function FieldRow(props: { row: RowDef; keyId: keyof typeof KEYS }) {
  const k = KEYS[props.keyId];
  const draft = signal(untracked(k.stored));
  const mark = signal("");
  let edited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let markSeq = 0;
  if (props.keyId === "tmdb") {
    void loadKey().then(() => {
      if (!edited) draft.set(savedKey());
    });
  }
  const show = (text: string) => {
    const n = ++markSeq;
    mark.set(text);
    setTimeout(() => {
      if (n === markSeq) mark.set("");
    }, 3000);
  };
  const commit = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!edited) return;
    const v = draft().trim();
    edited = false;
    if (v === k.stored()) return;
    await k.save(v);
    show(v ? "Saved" : k.builtIn() ? "Using the built-in key" : "Key removed");
  };
  effect(() => {
    const d = debugKey();
    if (!d || d.id !== props.keyId) return;
    debugKey.set(null);
    edited = true;
    draft.set(d.value);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void commit(), KEY_PAUSE_MS);
  });
  const field = (
    <Input
      value={draft()}
      onChange={({ value }) => {
        edited = true;
        draft.set(value);
        mark.set("");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void commit(), KEY_PAUSE_MS);
      }}
      onSubmit={() => void commit()}
      onBlur={() => void commit()}
      onFocus={focusContent}
      placeholder={k.builtIn() ? "Leave empty to use the built-in key" : "Paste your key"}
      accessibilityLabel={`${props.row.label} key`}
      autoCorrect={false}
      autoCapitalize="none"
      class={INPUT_CLASS}
      style={stackedRows() ? undefined : { width: 340 }}
    />
  );
  return (
    <Row
      row={props.row}
      stack
      trailing={
        <If when={mark()}>
          <View class="flex-row items-center gap-1">
            <Glyph d="check" size={13} color="#34d399" />
            <Text class="text-xs font-medium text-emerald-400">{mark()}</Text>
          </View>
        </If>
      }
      control={field}
    />
  );
}

// --- Actions --------------------------------------------------------------------------------

/** A red-tinted button for actions that throw something away. */
export function DangerButton(props: { label: string; onPress: () => void; busy?: boolean; flex?: boolean; solid?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={() => {
        if (!props.busy) props.onPress();
      }}
      class={`h-9 cursor-pointer flex-row items-center justify-center rounded-[10px] px-4 ${
        props.solid ? "bg-red-600 hover:bg-red-500 active:bg-red-700" : "bg-red-500/15 hover:bg-red-500/25 active:bg-red-500/30"
      } ${props.busy ? "opacity-50" : ""}`}
      style={props.flex ? { flexGrow: 1, flexBasis: 0 } : { flexShrink: 0 }}
    >
      <Text
        class={props.solid ? "font-semibold text-white" : "font-semibold text-red-400"}
        allowFontScaling={false}
        style={{ fontSize: 14, lineHeight: 18, numberOfLines: 1 }}
      >
        {props.label}
      </Text>
    </View>
  );
}

/** Runs an action: asks first when it has a confirm, toasts when done. */
export async function runAction(c: Extract<Control, { kind: "action" }>): Promise<boolean> {
  if (c.confirm && !(await askConfirm(c.confirm))) return false;
  await c.run();
  if (c.done) notify(c.done, "success");
  return true;
}

export function ActionRow(props: { row: RowDef; control: Extract<Control, { kind: "action" }> }) {
  const busy = signal(false);
  const press = () => {
    if (busy()) return;
    busy.set(true);
    void runAction(props.control).finally(() => busy.set(false));
  };
  return (
    <Row
      row={props.row}
      control={
        props.control.destructive ? (
          <DangerButton label={props.control.button} onPress={press} busy={busy()} />
        ) : (
          <Button label={props.control.button} size="sm" onPress={press} busy={busy()} />
        )
      }
    />
  );
}

/** A destructive row outside the schema's actions (a cache's Clear). */
export function DestructiveRow(props: {
  row: RowDef;
  button: string;
  confirm?: Confirm;
  onConfirm: () => void | Promise<void>;
  trailing?: JSX.Element;
  value?: JSX.Element;
  busy?: boolean;
}) {
  return (
    <Row
      row={props.row}
      trailing={props.trailing}
      control={
        <View class="flex-row items-center gap-3" style={{ flexShrink: 0 }}>
          {props.value}
          <DangerButton
            label={props.button}
            busy={props.busy}
            onPress={async () => {
              if (props.confirm && !(await askConfirm(props.confirm))) return;
              await props.onConfirm();
            }}
          />
        </View>
      }
    />
  );
}

// --- The confirm dialog --------------------------------------------------------------------

type Ask = Confirm & { resolve: (ok: boolean) => void };
const asking = signal<Ask | null>(null);

/** Asks in the confirm dialog (a centred card over a dimmed app: the title,
 * the consequence in plain words, Cancel and a red confirm). Resolves to
 * whether the user confirmed. */
export function askConfirm(c: Confirm): Promise<boolean> {
  const prev = untracked(asking);
  if (prev) prev.resolve(false);
  return new Promise<boolean>((resolve) => asking.set({ ...c, resolve }));
}

function answer(ok: boolean) {
  const a = untracked(asking);
  asking.set(null);
  a?.resolve(ok);
}

/** Where the confirm dialog shows: mount once (Settings' root). */
export function ConfirmHost() {
  return (
    <If when={asking()}>
      {(a) => (
        <Dialog
          open
          animation="fade"
          closeOnBackdropPress={false}
          onOpenChange={(e) => {
            if (!e.open) answer(false);
          }}
          class="absolute inset-0 items-center justify-center bg-black/60 px-6"
        >
          <View
            accessibilityLabel={a().title}
            class="w-full gap-3 rounded-2xl border border-border bg-card p-5"
            style={{ maxWidth: 400 }}
          >
            <Text class="text-lg font-bold text-foreground">{a().title}</Text>
            <Text class="text-sm text-muted-foreground">{a().body}</Text>
            <View class="flex-row justify-end gap-2 pt-2">
              <Button label="Cancel" size="sm" flex={stackedRows()} onPress={() => answer(false)} />
              <If
                when={a().destructive !== false}
                else={<Button primary label={a().confirm} size="sm" flex={stackedRows()} onPress={() => answer(true)} />}
              >
                <DangerButton solid label={a().confirm} flex={stackedRows()} onPress={() => answer(true)} />
              </If>
            </View>
          </View>
        </Dialog>
      )}
    </If>
  );
}
