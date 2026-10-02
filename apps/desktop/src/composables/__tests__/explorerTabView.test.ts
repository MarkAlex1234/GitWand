import { describe, it, expect } from "vitest";
import { canShowDiff, initialTabView, isDiffable, resolveTabView } from "../explorerTabView";
import type { FileStatusInfo } from "../useLazyRepoTree";

const status = (over: Partial<FileStatusInfo> = {}): FileStatusInfo => ({
  status: "modified",
  staged: false,
  unstaged: true,
  untracked: false,
  conflicted: false,
  deletedOnDisk: false,
  ...over,
});

describe("explorerTabView", () => {
  it("only a changed file still on disk has a diff to show", () => {
    expect(isDiffable(null)).toBe(false);
    expect(isDiffable(status())).toBe(true);
    expect(isDiffable(status({ conflicted: true }))).toBe(true);
    expect(isDiffable(status({ status: "deleted", deletedOnDisk: true }))).toBe(false);
  });

  it("a changed file opens on its diff, an unchanged or deleted one in the editor", () => {
    expect(initialTabView(status())).toBe("diff");
    expect(initialTabView(null)).toBe("file");
    expect(initialTabView(status({ status: "deleted", deletedOnDisk: true }))).toBe("file");
  });

  it("shows the stored choice, but never a diff for a file without one", () => {
    expect(resolveTabView("file", status())).toBe("file");
    expect(resolveTabView("diff", status())).toBe("diff");
    expect(resolveTabView(undefined, status())).toBe("diff");
    expect(resolveTabView("diff", null)).toBe("file");
    expect(resolveTabView("diff", status({ status: "deleted", deletedOnDisk: true }))).toBe("file");
  });

  it("refuses the Diff side while the buffer has unsaved edits", () => {
    expect(canShowDiff(status(), false)).toBe(true);
    expect(canShowDiff(status(), true)).toBe(false);
    expect(canShowDiff(null, false)).toBe(false);
  });
});
