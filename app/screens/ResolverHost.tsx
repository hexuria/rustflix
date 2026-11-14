// The hidden web view of lib/resolver.ts: ONE for the whole session.
// Mounted at the app root (outside the page stack, so navigation never
// unmounts it), made once shortly after launch (`ensureResolverHost`,
// while the app is in front) and kept: on macOS wry asks the OS to
// activate the app every time a web view is CREATED (lb-wry 0.53.3
// src/wkwebview/mod.rs, "make sure the window is always on top when we
// create a new webview"), never when it navigates.
//
// Its `src` is "about:blank" for good and no other prop ever changes, so
// NSH never rebuilds the native view (a rebuild happens only when the
// injected scripts, the user agent or javaScriptEnabled change). Resolves
// navigate it through the ref (lib/resolver.ts `navigateHidden`).
//
// Hidden by a full-size container at opacity 0. Desktop: NSH's geometry()
// is None for a transparent ancestor, so the wry view is built with
// `with_visible(false)` and never shown; it gets no hitbox and no input.
// iOS: alpha 0 on the UIView, which UIKit does not hit-test. The container
// also ignores the pointer. Nothing here focuses the web view; its ref is
// only used for postMessage / injectJavaScript.
//
// This module also loads the download queue engine (lib/downloads.ts): it
// is the one screen App.tsx mounts that may import it, and player.ts
// cannot import it (downloads.ts imports player.ts).

import { cleanup, View, WebView } from "nsh";
import { webBackground } from "../lib/system";
import { downloadEngineLoaded } from "../lib/downloads";
import {
  RESOLVER_BRIDGE,
  RESOLVER_UA,
  resolverEvent,
  resolverHostGone,
  resolverHostOn,
  setResolverRef,
} from "../lib/resolver";

function HiddenView() {
  // Only when the view itself goes (a crash path, the window recreated):
  // lib/resolver.ts makes it again once the app is active.
  cleanup(resolverHostGone);
  return (
    <View
      class="pointer-events-none absolute"
      style={{ left: 0, top: 0, right: 0, bottom: 0, opacity: 0 }}
    >
      <WebView
        ref={(node) => setResolverRef(node)}
        src="about:blank"
        class="flex-1 bg-black"
        style={{ backgroundColor: "#000" }}
        userAgent={RESOLVER_UA}
        injectedJavaScriptBeforeContentLoaded={RESOLVER_BRIDGE}
        onMessage={(e: { data: unknown }) => resolverEvent("message", e)}
        onLoadStart={(e: unknown) => {
          // macOS: never a white web view (it is hidden, but cheap).
          webBackground();
          resolverEvent("loadStart", e);
        }}
        onLoad={(e: unknown) => resolverEvent("load", e)}
        onError={(e: unknown) => resolverEvent("error", e)}
      />
    </View>
  );
}

export function ResolverHost() {
  downloadEngineLoaded();
  return (
    <If when={resolverHostOn()}>
      <HiddenView />
    </If>
  );
}
