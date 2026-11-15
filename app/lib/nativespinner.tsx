// The platform's own activity indicator: UIActivityIndicatorView on iOS
// (ios/Rustflix/NativeSpinner.swift), the indeterminate ProgressBar on
// Android (NativeSpinner.java), as the native component `rustflix.spinner`.
// The desktop has no native one to borrow: it draws the app's spinner.

import { nativeComponent, platform } from "nsh";
import { Spinner } from "../screens/PlayerControls";

const Native = nativeComponent<{ color?: string; large?: boolean }, Record<string, never>>("rustflix.spinner", {
  props: ["color", "large"],
  events: [],
});

/** A loading indicator the size of `size` points (28 by default). */
export function ActivitySpinner(props: { size?: number; color?: string }) {
  const s = props.size ?? 28;
  if (platform.os !== "ios" && platform.os !== "android") return <Spinner size={s} />;
  return <Native large={s >= 32} color={props.color ?? "#d4d4d8"} style={{ width: s, height: s }} />;
}
