// Router: the whole interface is one signal; screens navigate by name.
// `navigate` keeps a back/forward history so the title bar can move
// through it like a browser's.

import { signal } from "nsh";
import type { MediaType } from "./sources";

export type Route =
  | { name: "home" }
  | { name: "search" }
  | { name: "library" }
  | { name: "settings" }
  | { name: "setup" }
  | { name: "title"; type: MediaType; id: number }
  | {
      name: "player";
      type: MediaType;
      id: number;
      season?: number;
      episode?: number;
      title?: string;
      poster?: string;
      lang?: "sub" | "dub";
      next?: { season?: number; episode?: number };
    };

export const route = signal<Route>({ name: "home" });

const history: Route[] = [{ name: "home" }];
const pos = signal(0);

// Runs once whenever navigation leaves the player (back, forward or a
// fresh navigate): the player uses it to save progress and pause the
// page so nothing keeps playing off-screen.
let leaveHook: (() => void) | null = null;
export function setLeaveHook(fn: (() => void) | null) {
  leaveHook = fn;
}

function fireLeave(to: Route) {
  if (route().name === "player" && to.name !== "player") leaveHook?.();
}

export function navigate(to: Route) {
  fireLeave(to);
  history.length = pos() + 1;
  history.push(to);
  pos.set(pos() + 1);
  route.set(to);
}

export function canGoBack(): boolean {
  return pos() > 0;
}

export function canGoForward(): boolean {
  return pos() < history.length - 1;
}

export function goBack() {
  if (!canGoBack()) return;
  const to = history[pos() - 1];
  fireLeave(to);
  pos.set(pos() - 1);
  route.set(to);
}

export function goForward() {
  if (!canGoForward()) return;
  const to = history[pos() + 1];
  fireLeave(to);
  pos.set(pos() + 1);
  route.set(to);
}

export function goTitle(type: MediaType, id: number) {
  navigate({ name: "title", type, id });
}
