// First-run setup: asks for the TMDB key, like Streambert's SetupScreen.

import { signal, Text, View, type InputRef } from "nsh";
import { Input } from "nsh/base";
import { navigate } from "../lib/router";
import { saveKey } from "../lib/tmdb";
import { tvFocus, tvMode, useFocusable } from "../lib/tv";
import { Button, Section } from "../lib/ui";

const key = signal("");
const error = signal("");

async function finish() {
  const k = key().trim();
  if (!k) {
    error.set("Paste a TMDB API key or read access token first.");
    return;
  }
  await saveKey(k);
  navigate({ name: "home" });
}

export function Setup() {
  // TV: the field is a focusable (select opens the keyboard; up / down
  // leave it), then Continue, then Skip.
  let input: InputRef | undefined;
  const field = useFocusable({ onPress: () => input?.focus() });
  const skip = useFocusable({ onPress: () => navigate({ name: "home" }) });
  return (
    <View class="flex-1 items-center justify-center p-8">
      <View class="w-full max-w-md gap-4">
        <Text class="text-3xl font-extrabold text-foreground">rustflix</Text>
        <Text class="text-base text-muted-foreground">
          Stream movies, shows and anime. First, add a free TMDB API key —
          movies and series metadata come from TMDB.
        </Text>
        <Section title="TMDB API Read Access Token or API Key">
          <View
            ref={field.ref}
            onMouseEnter={field.onMouseEnter}
            class={`rounded-lg ${field.focused() ? "outline-4 outline-offset-2 outline-white" : ""}`}
          >
            <Input
              ref={(r: InputRef) => (input = r)}
              value={key()}
              onChange={({ value }) => key.set(value)}
              onFocus={() => field.claim()}
              placeholder="Paste your key"
              class="rounded-lg border border-input bg-background px-3 py-2 text-foreground"
            />
          </View>
          <If when={error()}>
            {(e) => <Text class="text-sm text-red-400">{e()}</Text>}
          </If>
          <Button primary label="Continue" onPress={finish} />
          <Text class={tvMode() ? "text-sm text-muted-foreground" : "text-xs text-muted-foreground"}>
            Get one at themoviedb.org → Settings → API → create a v3 key or
            request a v4 read access token. It's stored locally only.
          </Text>
        </Section>
        <View
          ref={skip.ref}
          role="button"
          onMouseEnter={skip.onMouseEnter}
          onPressIn={skip.onPressIn}
          onPress={() => navigate({ name: "home" })}
          class={`${tvMode() ? "self-start rounded-lg px-2 py-1" : ""} ${skip.focused() ? tvFocus.row : ""}`}
        >
          <Text class="text-sm text-muted-foreground underline">
            Skip for now (anime still works)
          </Text>
        </View>
      </View>
    </View>
  );
}
