// First-run setup: asks for the TMDB key, like Streambert's SetupScreen.

import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { navigate } from "../lib/router";
import { saveKey } from "../lib/tmdb";
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
  return (
    <View class="flex-1 items-center justify-center p-8">
      <View class="w-full max-w-md gap-4">
        <Text class="text-3xl font-extrabold text-foreground">rustflix</Text>
        <Text class="text-base text-muted-foreground">
          Stream movies, shows and anime. First, add a free TMDB API key —
          movies and series metadata come from TMDB.
        </Text>
        <Section title="TMDB API Read Access Token or API Key">
          <Input
            value={key()}
            onChange={({ value }) => key.set(value)}
            placeholder="Paste your key"
            class="rounded-lg border border-input bg-background px-3 py-2 text-foreground"
          />
          <If when={error()}>
            {(e) => <Text class="text-sm text-red-400">{e()}</Text>}
          </If>
          <Button primary label="Continue" onPress={finish} />
          <Text class="text-xs text-muted-foreground">
            Get one at themoviedb.org → Settings → API → create a v3 key or
            request a v4 read access token. It's stored locally only.
          </Text>
        </Section>
        <View role="button" onPress={() => navigate({ name: "home" })}>
          <Text class="text-sm text-muted-foreground underline">
            Skip for now (anime still works)
          </Text>
        </View>
      </View>
    </View>
  );
}
