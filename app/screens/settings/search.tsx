// Search in Settings. Desktop: a field in the app's title bar while
// Settings shows (App.tsx `TitleBar`), focused by "/" when no field has the
// keyboard (⌘F keeps opening the Search tab) or by a click. Phones and
// tablets: a field over the category list. Either way the results are
// every setting whose label, description or keywords hold the words,
// grouped by category; picking one opens its category and highlights it.

import { computed, keymap, Text, View, type InputRef } from "nsh";
import { Input } from "nsh/base";
import { focusContent } from "../../lib/system";
import { tvFocus, tvMode, useFocusable } from "../../lib/tv";
import { settingsCtx } from "./ctx";
import { openResult } from "./nav";
import { CategoryIcon, Chevron } from "./rows";
import { searchSettings, type RowDef, type SearchHit } from "./schema";
import { settingsQuery } from "./state";

const hits = computed<SearchHit[]>(() => searchSettings(settingsQuery(), settingsCtx()));

/** The title bar's field (desktop). */
export function SettingsSearchField() {
  let ref: InputRef | undefined;
  keymap.bind("/", () => ref?.focus(), { when: "notEditing" });
  return (
    <View class="flex-row items-center" style={{ width: 240 }}>
      <Input
        ref={(r: InputRef) => (ref = r)}
        value={settingsQuery()}
        onChange={({ value }) => settingsQuery.set(value)}
        onFocus={focusContent}
        placeholder="Search settings   /"
        accessibilityLabel="Search settings"
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        class="h-7 flex-1 rounded-md border border-border bg-background px-2.5 text-sm text-foreground"
      />
      <If when={settingsQuery()}>
        <View
          role="button"
          accessibilityLabel="Clear search"
          onPress={() => settingsQuery.set("")}
          class="absolute right-1 h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-white/20"
        >
          <Text class="text-[10px] font-bold text-foreground">✕</Text>
        </View>
      </If>
    </View>
  );
}

/** The field over the category list (phones, tablets, TVs). TV: a
 * focusable around it: select opens the keyboard, up / down leave it. */
export function SearchBox() {
  let ref: InputRef | undefined;
  const tv = useFocusable({ onPress: () => ref?.focus() });
  const input = (
    <Input
      ref={(r: InputRef) => (ref = r)}
      value={settingsQuery()}
      onChange={({ value }) => settingsQuery.set(value)}
      onFocus={() => {
        focusContent();
        tv.claim();
      }}
      placeholder="Search settings"
      accessibilityLabel="Search settings"
      autoCorrect={false}
      autoCapitalize="none"
      returnKeyType="search"
      class="min-h-10 rounded-xl bg-white/10 px-3 py-2 text-foreground"
    />
  );
  if (!tvMode()) return input;
  return (
    <View
      ref={tv.ref}
      onMouseEnter={tv.onMouseEnter}
      class={`rounded-xl ${tv.focused() ? "outline-4 outline-offset-2 outline-white" : ""}`}
    >
      {input}
    </View>
  );
}

function ResultRow(props: { category: string; row: RowDef }) {
  const tv = useFocusable({ onPress: () => openResult(props.category, props.row.id) });
  return (
    <View
      ref={tv.ref}
      role="button"
      accessibilityLabel={props.row.label}
      onMouseEnter={tv.onMouseEnter}
      onPressIn={tv.onPressIn}
      onPress={() => openResult(props.category, props.row.id)}
      class={`min-h-12 cursor-pointer flex-row items-center gap-3 px-4 py-2.5 ${
        tv.focused() ? tvFocus.row : "hover:bg-muted/50 active:bg-muted"
      }`}
    >
      <View class="flex-1 gap-0.5">
        <Text class="text-sm font-medium text-foreground">{props.row.label}</Text>
        <If when={props.row.description}>
          {(d) => (
            <Text class={tvMode() ? "text-sm text-muted-foreground" : "text-xs text-muted-foreground"} style={{ numberOfLines: 2 }}>
              {d()}
            </Text>
          )}
        </If>
      </View>
      <Chevron />
    </View>
  );
}

/** A result group's heading: opens its category. */
function HitHeader(props: { category: SearchHit["category"] }) {
  const tv = useFocusable({ onPress: () => openResult(props.category.id) });
  return (
    <View
      ref={tv.ref}
      role="button"
      accessibilityLabel={`Open ${props.category.label}`}
      onMouseEnter={tv.onMouseEnter}
      onPressIn={tv.onPressIn}
      onPress={() => openResult(props.category.id)}
      class={`cursor-pointer flex-row items-center gap-2 rounded-lg px-1 ${tv.focused() ? tvFocus.row : ""}`}
    >
      <CategoryIcon category={props.category} size={20} />
      <Text
        class={`${tvMode() ? "text-sm" : "text-xs"} font-semibold uppercase text-muted-foreground`}
        style={{ letterSpacing: 0.4 }}
      >
        {props.category.label}
      </Text>
    </View>
  );
}

/** The results, grouped by category. */
export function SearchResults() {
  return (
    <View class="gap-5">
      <If
        when={hits().length > 0}
        else={
          <Text class="px-1 py-6 text-center text-sm text-muted-foreground">
            {`No settings match “${settingsQuery().trim()}”.`}
          </Text>
        }
      >
        <Each of={hits()} key={(h: SearchHit) => h.category.id}>
          {(h) => (
            <View class="gap-1.5">
              <HitHeader category={h().category} />
              <If when={h().rows.length > 0}>
                <View class="overflow-hidden rounded-xl border border-border bg-card">
                  <Each of={h().rows} key={(r: RowDef) => r.id}>
                    {(r, i) => (
                      <>
                        <If when={i() > 0}>
                          <View class="ml-4 h-px bg-border" />
                        </If>
                        <ResultRow category={h().category.id} row={r()} />
                      </>
                    )}
                  </Each>
                </View>
              </If>
            </View>
          )}
        </Each>
      </If>
    </View>
  );
}
