// Search in Settings. Desktop: a field in the app's title bar while
// Settings shows (App.tsx `TitleBar`), focused by "/" when no field has the
// keyboard (⌘F keeps opening the Search tab) or by a click. Phones and
// tablets: a field over the category list. Either way the results are
// every setting whose label, description or keywords hold the words,
// grouped by category; picking one opens its category and highlights it.

import { computed, keymap, Text, View, type InputRef } from "nsh";
import { Input } from "nsh/base";
import { focusContent } from "../../lib/system";
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

/** The field over the category list (phones, tablets). */
export function SearchBox() {
  return (
    <Input
      value={settingsQuery()}
      onChange={({ value }) => settingsQuery.set(value)}
      onFocus={focusContent}
      placeholder="Search settings"
      accessibilityLabel="Search settings"
      autoCorrect={false}
      autoCapitalize="none"
      returnKeyType="search"
      class="min-h-10 rounded-xl bg-white/10 px-3 py-2 text-foreground"
    />
  );
}

function ResultRow(props: { category: string; row: RowDef }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.row.label}
      onPress={() => openResult(props.category, props.row.id)}
      class="min-h-12 cursor-pointer flex-row items-center gap-3 px-4 py-2.5 hover:bg-muted/50 active:bg-muted"
    >
      <View class="flex-1 gap-0.5">
        <Text class="text-sm font-medium text-foreground">{props.row.label}</Text>
        <If when={props.row.description}>
          {(d) => (
            <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 2 }}>
              {d()}
            </Text>
          )}
        </If>
      </View>
      <Chevron />
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
              <View
                role="button"
                accessibilityLabel={`Open ${h().category.label}`}
                onPress={() => openResult(h().category.id)}
                class="cursor-pointer flex-row items-center gap-2 px-1"
              >
                <CategoryIcon category={h().category} size={20} />
                <Text class="text-xs font-semibold uppercase text-muted-foreground" style={{ letterSpacing: 0.4 }}>
                  {h().category.label}
                </Text>
              </View>
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
