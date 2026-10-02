// @vitest-environment jsdom
/**
 * FilePreviewPane — one assertion per row of the spec §7 table, plus the
 * error/retry path and the Working tree | Index switch. `utils/backend` is
 * mocked (the IPC wrapper, as in FileExplorerPanel.test.ts), and DiffViewer /
 * CodeEditor are stubbed so the test sees which body was chosen, not how a
 * diff renders (DiffViewer has its own suites).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import en from "../../locales/en";
import type { PreviewTarget } from "../../composables/useFilePreview";
import type { FileStatusInfo } from "../../composables/useLazyRepoTree";

vi.mock("../../utils/backend", () => ({ readFileAtRevision: vi.fn(), getGitDiff: vi.fn() }));
vi.mock("../DiffViewer.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { diff: Object, filePath: String, diffMode: String },
      setup: (p) => () => h("div", { class: "stub-diff", "data-mode": p.diffMode }, String(p.filePath)),
    }),
  };
});
vi.mock("../CodeEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: String, filePath: String, readonly: Boolean },
      setup: (p) => () => h("pre", { class: "stub-code", "data-readonly": String(p.readonly) }, p.modelValue),
    }),
  };
});

import FilePreviewPane from "../FilePreviewPane.vue";
import { getGitDiff, readFileAtRevision } from "../../utils/backend";

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const DIFF = {
  path: "a.ts",
  hunks: [{ header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{ type: "add", content: "x", newLineNo: 1 }] }],
};
function st(p: Partial<FileStatusInfo>): FileStatusInfo {
  return { status: "modified", staged: false, unstaged: false, untracked: false, conflicted: false, deletedOnDisk: false, ...p };
}
function file(path: string, status: FileStatusInfo | null, size = 10): PreviewTarget {
  return { kind: "file", path, size, symlink: false, status };
}

let app: App | null = null;
let container: HTMLElement;

beforeEach(() => {
  vi.mocked(readFileAtRevision).mockReset().mockResolvedValue({ bytesBase64: b64("hello"), byteLength: 5, mime: "text/plain", absent: false });
  vi.mocked(getGitDiff).mockReset().mockResolvedValue(DIFF as never);
});
afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mount(target: PreviewTarget | null, changedBelow: string[] = []) {
  const events: Array<[string, ...unknown[]]> = [];
  const on = (name: string) => (...args: unknown[]) => {
    events.push([name, ...args]);
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(FilePreviewPane, {
          cwd: "/repo",
          target,
          changedBelow,
          watcher: null,
          onSelectPath: on("select-path"),
          onOpenInEditor: on("open-in-editor"),
          onReveal: on("reveal"),
          onOpenMergeEditor: on("open-merge-editor"),
        }),
    }),
  );
  app.mount(container);
  await settle();
  return events;
}

const text = () => container.textContent ?? "";

describe("FilePreviewPane — body per §7 row", () => {
  it("nothing selected", async () => {
    await mount(null);
    expect(text()).toContain(en.filesView.preview.noSelection);
  });

  it("unchanged file: read-only CodeEditor with the working-tree content", async () => {
    await mount(file("a.ts", null));
    expect(readFileAtRevision).toHaveBeenCalledWith("/repo", "", "a.ts");
    const code = container.querySelector(".stub-code")!;
    expect(code.textContent).toBe("hello");
    expect(code.getAttribute("data-readonly")).toBe("true");
  });

  it("modified, unstaged: inline diff of the working tree", async () => {
    await mount(file("a.ts", st({ unstaged: true })));
    expect(getGitDiff).toHaveBeenCalledWith("/repo", "a.ts", false);
    expect(container.querySelector(".stub-diff")?.getAttribute("data-mode")).toBe("inline");
  });

  it("staged only: the index diff, no switch", async () => {
    await mount(file("a.ts", st({ staged: true })));
    expect(getGitDiff).toHaveBeenCalledWith("/repo", "a.ts", true);
    expect(container.querySelector("[role=radiogroup]")).toBeNull();
  });

  it("staged and modified: Working tree | Index switch, defaulting to the working tree", async () => {
    await mount(file("a.ts", st({ staged: true, unstaged: true })));
    expect(getGitDiff).toHaveBeenLastCalledWith("/repo", "a.ts", false);
    const radios = [...container.querySelectorAll<HTMLElement>("[role=radio]")];
    expect(radios.map((r) => r.textContent?.trim())).toEqual([en.filesView.preview.sideWorktree, en.filesView.preview.sideIndex]);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    radios[1]!.click();
    await settle();
    expect(getGitDiff).toHaveBeenLastCalledWith("/repo", "a.ts", true);
  });

  it("untracked: the --no-index diff through getGitDiff", async () => {
    await mount(file("new.ts", st({ status: "added", untracked: true })));
    expect(getGitDiff).toHaveBeenCalledWith("/repo", "new.ts", false);
  });

  it("deleted: the deletion diff", async () => {
    await mount(file("gone.ts", st({ status: "deleted", unstaged: true, deletedOnDisk: true })));
    expect(getGitDiff).toHaveBeenCalledWith("/repo", "gone.ts", false);
    expect(container.querySelector(".stub-diff")).not.toBeNull();
  });

  it("conflicted: a banner with Open in merge editor, no diff", async () => {
    const events = await mount(file("c.ts", st({ conflicted: true })));
    expect(getGitDiff).not.toHaveBeenCalled();
    expect(text()).toContain(en.filesView.preview.conflicted);
    const btn = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(en.filesView.preview.openMergeEditor))!;
    btn.click();
    expect(events[events.length - 1]).toEqual(["open-merge-editor", "c.ts"]);
  });

  it("binary: a placeholder with the size and Open in editor", async () => {
    vi.mocked(readFileAtRevision).mockResolvedValue({ bytesBase64: b64(new Uint8Array([0, 1])), byteLength: 2, mime: "", absent: false });
    await mount(file("a.bin", null, 2));
    expect(text()).toContain(en.filesView.preview.binary.replace("{0}", "2 B"));
    expect(text()).toContain(en.filesView.ctxOpenInEditor);
  });

  it("over 5 MB: a placeholder, without reading the file", async () => {
    await mount(file("dump.sql", null, 6 * 1024 * 1024));
    expect(readFileAtRevision).not.toHaveBeenCalled();
    expect(text()).toContain(en.filesView.preview.tooLarge.replace("{0}", "6.0 MB"));
  });

  it("folder: the count of changed files below and their clickable list", async () => {
    const events = await mount({ kind: "folder", path: "src" }, ["src/a.ts", "src/lib/b.ts"]);
    expect(text()).toContain(en.filesView.preview.folderChanged.replace("{0}", "2"));
    const link = [...container.querySelectorAll<HTMLButtonElement>(".fpp__link")].find((b) => b.textContent === "src/lib/b.ts")!;
    link.click();
    expect(events[events.length - 1]).toEqual(["select-path", "src/lib/b.ts"]);
  });
});

describe("FilePreviewPane — errors and header", () => {
  it("shows a load error inline with Retry, never an empty body", async () => {
    vi.mocked(readFileAtRevision).mockRejectedValueOnce(new Error("EACCES"));
    await mount(file("a.ts", null));
    expect(container.querySelector("[role=alert]")?.textContent).toContain(en.filesView.preview.error.replace("{0}", "EACCES"));
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === en.filesView.retry)!;
    retry.click();
    await settle();
    expect(container.querySelector(".stub-code")?.textContent).toBe("hello");
  });

  it("path segments select their folder", async () => {
    const events = await mount(file("src/lib/a.ts", null));
    const crumb = [...container.querySelectorAll<HTMLButtonElement>(".fpp__crumb")].find((b) => b.textContent === "lib")!;
    crumb.click();
    expect(events[events.length - 1]).toEqual(["select-path", "src/lib"]);
  });
});
