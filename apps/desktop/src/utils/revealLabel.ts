/**
 * The wording of "reveal in the file manager", per platform (v3.11.2): users
 * look for "Finder" on macOS and "Explorer" on Windows. Linux has no portable
 * "select", so the backend opens the containing folder, and the label says so.
 */
export type RevealLabelKey =
  | "filesView.ctxRevealMac"
  | "filesView.ctxRevealWindows"
  | "filesView.ctxRevealLinux";

export function revealLabelKey(
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent || "",
): RevealLabelKey {
  if (/Mac/i.test(platform)) return "filesView.ctxRevealMac";
  if (/Win/i.test(platform)) return "filesView.ctxRevealWindows";
  return "filesView.ctxRevealLinux";
}
