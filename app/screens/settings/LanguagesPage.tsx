// Subtitles & audio → My languages: an ordered list (move up / down,
// remove) with a searchable "Add a language". The search field calls
// focusContent() on focus (macOS: after a web view held the keyboard, plain
// keys otherwise reach no text field).

import { computed, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { LANGUAGES, languageName, saveSettings, settings } from "../../lib/store";
import { focusContent } from "../../lib/system";
import { Button } from "../../lib/ui";
import { INPUT_CLASS } from "./rows";

const addOpen = signal(false);
const langQuery = signal("");

/** "1st", "2nd", "3rd", "4th", ... "11th", "21st". */
function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function myLangs(): string[] {
  const l = settings().myLanguages;
  return l && l.length ? l : ["en"];
}

function moveLang(i: number, dir: -1 | 1) {
  const l = [...myLangs()];
  const j = i + dir;
  if (j < 0 || j >= l.length) return;
  [l[i], l[j]] = [l[j], l[i]];
  void saveSettings({ myLanguages: l });
}

function removeLang(i: number) {
  const l = myLangs();
  if (l.length <= 1) return;
  void saveSettings({ myLanguages: l.filter((_, k) => k !== i) });
}

function addLang(code: string) {
  const l = myLangs();
  if (!l.includes(code)) void saveSettings({ myLanguages: [...l, code] });
  langQuery.set("");
  addOpen.set(false);
}

/** The languages not chosen yet whose name (or code) holds the query. */
const langResults = computed(() => {
  const q = langQuery().trim().toLowerCase();
  const chosen = myLangs();
  return LANGUAGES.filter(
    (l) =>
      !chosen.includes(l.code) &&
      (!q || l.name.toLowerCase().includes(q) || l.code.toLowerCase() === q),
  );
});

/** A square icon button: 44 pt, hover and press states, dimmed when off. */
function IconButton(props: {
  label: string;
  glyph: string;
  disabled: () => boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={() => {
        if (!props.disabled()) props.onPress();
      }}
      class={
        props.disabled()
          ? "h-11 w-11 items-center justify-center rounded-lg opacity-30"
          : "h-11 w-11 cursor-pointer items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
      }
    >
      <Text class="text-lg font-semibold text-foreground">{props.glyph}</Text>
    </View>
  );
}

// Accessors, not values: a row is kept by its code while the list is
// reordered, so its position changes under it.
function LanguageRow(props: { code: () => string; index: () => number }) {
  const name = () => languageName(props.code());
  const count = () => myLangs().length;
  return (
    <View class="min-h-14 flex-row items-center gap-2 border-b border-border py-1.5 pl-4 pr-2">
      <View class="flex-1 gap-0.5">
        <Text class="text-sm font-medium text-foreground" style={{ numberOfLines: 1 }}>
          {name()}
        </Text>
        <Text class="text-xs text-muted-foreground">{ordinal(props.index() + 1)}</Text>
      </View>
      <IconButton
        label={`Move ${name()} up`}
        glyph="↑"
        disabled={() => props.index() === 0}
        onPress={() => moveLang(props.index(), -1)}
      />
      <IconButton
        label={`Move ${name()} down`}
        glyph="↓"
        disabled={() => props.index() >= count() - 1}
        onPress={() => moveLang(props.index(), 1)}
      />
      <View
        role="button"
        accessibilityLabel={`Remove ${name()}`}
        onPress={() => removeLang(props.index())}
        class={
          count() <= 1
            ? "h-11 items-center justify-center rounded-lg px-3 opacity-30"
            : "h-11 cursor-pointer items-center justify-center rounded-lg px-3 hover:bg-muted active:bg-muted"
        }
      >
        <Text class="text-sm font-medium text-muted-foreground">Remove</Text>
      </View>
    </View>
  );
}

function AddLanguage() {
  return (
    <If
      when={addOpen()}
      else={
        <View
          role="button"
          accessibilityLabel="Add a language"
          onPress={() => addOpen.set(true)}
          class="min-h-12 cursor-pointer flex-row items-center gap-2 px-4 py-2 hover:bg-muted active:bg-muted"
        >
          <Text class="text-lg font-semibold text-primary">+</Text>
          <Text class="text-sm font-semibold text-primary">Add a language</Text>
        </View>
      }
    >
      <View class="gap-2 p-3">
        <View class="flex-row items-center gap-2">
          <Input
            value={langQuery()}
            onChange={({ value }) => langQuery.set(value)}
            placeholder="Search languages"
            autoFocus
            onFocus={focusContent}
            autoCorrect={false}
            autoCapitalize="none"
            class={`flex-1 ${INPUT_CLASS}`}
          />
          <Button
            label="Cancel"
            onPress={() => {
              langQuery.set("");
              addOpen.set(false);
            }}
          />
        </View>
        <View class="overflow-hidden rounded-lg border border-border">
          <If
            when={langResults().length > 0}
            else={<Text class="px-3 py-3 text-sm text-muted-foreground">No language matches.</Text>}
          >
            <Scroll style={{ maxHeight: 264 }}>
              <Each of={langResults()} key={(l: { code: string; name: string }) => l.code}>
                {(l) => (
                  <View
                    role="button"
                    accessibilityLabel={`Add ${l().name}`}
                    onPress={() => addLang(l().code)}
                    class="min-h-11 cursor-pointer justify-center border-b border-border px-3 py-2 hover:bg-muted active:bg-muted"
                  >
                    <Text class="text-sm text-foreground">{l().name}</Text>
                  </View>
                )}
              </Each>
            </Scroll>
          </If>
        </View>
      </View>
    </If>
  );
}

/** The ordered list and the add field (the "languages" custom row). */
export function LanguagesList() {
  return (
    <View>
      <Each of={myLangs()}>{(code, i) => <LanguageRow code={code} index={i} />}</Each>
      <AddLanguage />
    </View>
  );
}
