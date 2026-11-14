// The perf self-test's `flood:<n>` step (lib/perf.ts): n plain views made
// in one commit, in an invisible layer over the app; `flood:0` removes
// them. Nothing is mounted otherwise.

import { signal, View } from "nsh";

const count = signal(0);

/** Makes `n` views (0: none). */
export function setFlood(n: number) {
  count.set(Math.max(0, Math.min(20_000, Math.floor(n))));
}

export function PerfFlood() {
  return (
    <If when={count() > 0}>
      <View
        class="pointer-events-none absolute left-0 top-0 flex-row flex-wrap"
        style={{ width: 400, opacity: 0.01 }}
        accessibilityElementsHidden
      >
        <Each of={Array.from({ length: count() }, (_, i) => i)}>
          {() => <View style={{ width: 4, height: 4, backgroundColor: "#202020" }} />}
        </Each>
      </View>
    </If>
  );
}
