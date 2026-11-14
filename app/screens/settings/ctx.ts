// The device the Settings lists are made for (schema.ts `Ctx`), reactive.

import { computed, platform } from "nsh";
import { cacheAvailable } from "../../lib/cache";
import { canDownload } from "../../lib/downloads";
import { fpsMonitorAvailable } from "../../lib/perf";
import type { Ctx } from "./schema";
import { devMode, isTablet, keyboardAttached } from "./state";

export const settingsCtx = computed<Ctx>(() => ({
  platform: platform.desktop ? "desktop" : isTablet() ? "tablet" : "phone",
  download: canDownload(),
  cache: cacheAvailable(),
  fps: fpsMonitorAvailable(),
  devmode: devMode(),
  keyboard: platform.desktop || keyboardAttached(),
  android: platform.os === "android",
}));
