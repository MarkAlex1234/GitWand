/**
 * explorerTabView — which side of the File Explorer panel's Diff | File
 * toggle a tab shows (v3.11.2). Pure rules: the panel only stores the side a
 * tab was opened on, or the one the user picked.
 *
 * A changed file opens on its diff. The choice is recorded the first time the
 * panel shows the tab, so a file that becomes changed while its tab is on
 * File (a save) does not flip to the diff under the cursor. A file with no
 * diff to show (unchanged, or deleted from disk) always shows File.
 */
import type { FileStatusInfo } from "./useLazyRepoTree";

export type TabView = "diff" | "file";

/** A diff exists to show: the file is changed (conflicted included) and still on disk. */
export function isDiffable(status: FileStatusInfo | null): status is FileStatusInfo {
  return status !== null && !status.deletedOnDisk;
}

/** The side a tab opens on, the first time the panel shows it. */
export function initialTabView(status: FileStatusInfo | null): TabView {
  return isDiffable(status) ? "diff" : "file";
}

/** The side a tab shows now: its stored choice, but only a diffable file shows a diff. */
export function resolveTabView(stored: TabView | undefined, status: FileStatusInfo | null): TabView {
  if (!isDiffable(status)) return "file";
  return stored ?? "diff";
}

/**
 * The diff always reads the file on disk, so it is refused while the buffer
 * has unsaved edits: it would not show them ("Save to see the diff").
 */
export function canShowDiff(status: FileStatusInfo | null, dirty: boolean): boolean {
  return isDiffable(status) && !dirty;
}
