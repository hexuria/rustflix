// Settings: TMDB key, default source, subtitle language, data controls.

import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { clearCache, hasKey, loadKey, saveKey } from "../lib/tmdb";
import { PLAYER_SOURCES } from "../lib/sources";
import { libraryReady, progress, saveSettings, settings, watchlist } from "../lib/store";
import { Button, Section } from "../lib/ui";

const keyDraft = signal("");
const saved = signal(false);

async function persistKey() {
  await saveKey(keyDraft());
  clearCache();
  saved.set(true);
}

export function Settings() {
  // Prefill once with the stored key.
  if (!keyDraft()) {
    loadKey().then((k) => {
      if (!keyDraft()) keyDraft.set(k);
    });
  }

  return (
    <View class="flex-1 gap-6 p-4">
      <Section title="TMDB API Key">
        <Text class="text-sm text-muted-foreground">
          A TMDB API Read Access Token (v4) or v3 API key. Stored locally in the app's
          storage; get one at themoviedb.org settings → API.
        </Text>
        <Input
          value={keyDraft()}
          onChange={({ value }) => {
            keyDraft.set(value);
            saved.set(false);
          }}
          placeholder={hasKey() ? "••• saved key •••" : "Paste your TMDB key"}
          class="rounded-lg border border-input bg-background px-3 py-2 text-foreground"
        />
        <View class="flex-row gap-3">
          <Button primary label="Save Key" onPress={persistKey} />
          <If when={saved()}>
            <Text class="self-center text-sm text-green-500">Saved</Text>
          </If>
        </View>
      </Section>

      <Section title="Playback">
        <Text class="text-sm text-muted-foreground">Default player source</Text>
        <View class="flex-row flex-wrap gap-2">
          <Each of={PLAYER_SOURCES}>
            {(src) => (
              <View
                role="button"
                onPress={() => saveSettings({ defaultSource: src().id })}
                class={
                  settings().defaultSource === src().id
                    ? "rounded-lg bg-primary px-3 py-1.5"
                    : "rounded-lg bg-muted px-3 py-1.5"
                }
              >
                <Text
                  class={
                    settings().defaultSource === src().id
                      ? "text-sm font-semibold text-primary-foreground"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {src().label}
                </Text>
              </View>
            )}
          </Each>
        </View>
        <Text class="pt-2 text-sm text-muted-foreground">Subtitle language hint</Text>
        <View class="flex-row gap-2">
          <Each of={["en", "es", "fr", "de", "pt", "ja", "none"]}>
            {(lang) => (
              <View
                role="button"
                onPress={() => saveSettings({ subtitleLang: lang() === "none" ? "" : lang() })}
                class={
                  (settings().subtitleLang || "") === (lang() === "none" ? "" : lang())
                    ? "rounded-lg bg-primary px-3 py-1.5"
                    : "rounded-lg bg-muted px-3 py-1.5"
                }
              >
                <Text
                  class={
                    (settings().subtitleLang || "") === (lang() === "none" ? "" : lang())
                      ? "text-sm font-semibold text-primary-foreground"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {lang()}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </Section>

      <Section title="Library Data">
        <Text class="text-sm text-muted-foreground">
          {`${watchlist().length} watchlist items · ${progress().length} progress entries`}
          {libraryReady() ? "" : " (loading…)"}
        </Text>
      </Section>

      <Section title="About">
        <Text class="text-sm text-muted-foreground">
          rustflix — a Rust + GPUI + NSH rebuild of Streambert's interface:
          TMDB metadata, AniList anime, embed-source playback in a native
          web view, local watchlist and progress.
        </Text>
      </Section>
    </View>
  );
}
