// Moving between Settings pages: in the split layouts (desktop, tablet
// landscape) the page beside the column changes; on phones and tablets in
// portrait the page is pushed on the Settings tab's stack (router route
// `settingsPage`), so the system's back leaves it.

import { untracked } from "nsh";
import { goBack, navigate } from "../../lib/router";
import { flashRow, selectedPage, settingsQuery, splitLayout } from "./state";

/** Shows page `page`: a category id, or "pick:<row id>". */
export function openPage(page: string) {
  if (untracked(splitLayout)) selectedPage.set(page);
  else navigate({ name: "settingsPage", page });
}

/** A search result picked: its category, the row highlighted. */
export function openResult(category: string, rowId?: string) {
  settingsQuery.set("");
  openPage(category);
  if (rowId) flashRow(rowId);
}

/** Leaves a picker back to its category. */
export function closePicker(category: string) {
  if (untracked(splitLayout)) selectedPage.set(category);
  else goBack();
}
