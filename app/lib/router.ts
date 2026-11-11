// Router: the whole interface is one signal; screens navigate by name.

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

export function navigate(to: Route) {
  route.set(to);
}

export function goTitle(type: MediaType, id: number) {
  navigate({ name: "title", type, id });
}
