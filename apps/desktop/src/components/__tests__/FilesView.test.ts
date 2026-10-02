// @vitest-environment jsdom
/**
 * FilesView — the wiring only it does: "Scope here" sets the workspace scope,
 * a scope folder that disappears falls back to the whole repo, Reveal reports
 * its failure, and a selection reaches the preview. `utils/backend` is mocked
 * (the IPC wrapper, as in FileExplorerPanel.test.ts); listings themselves are
 * pinned by the Rust tests and the list-repo-dir parity test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import en from "../../locales/en";
import type { RepoDirEntry } from "../../utils/backend";

const FS: Record<string, RepoDirEntry[]> = {
  "": [
    { name: "src", path: "src", kind: "dir", ignored: false, size: 0 },
    { name: "README.md", path: "README.md", kind: "file", ignored: false, size: 5 },
  ],
  src: [{ name: "main.ts", path: "src/main.ts", kind: "file", ignored: false, size: 3 }],
};

vi.mock("../../utils/backend", () => ({
  listRepoDir: vi.fn(async (_cwd: string, dir: string) => {
    if (!FS[dir]) throw new Error(`Directory not found: ${dir}`);
    return { entries: FS[dir], truncated: false };
  }),
  pathExists: vi.fn(async () => false),
  revealInFileManager: vi.fn(async () => {}),
  clipboardWriteText: vi.fn(async () => {}),
  workspaceRead: vi.fn(async () => {
    throw new Error("no workspace file");
  }),
  workspaceWrite: vi.fn(async () => {}),
  readFileAtRevision: vi.fn(async () => ({ bytesBase64: Buffer.from("hello").toString("base64"), byteLength: 5, mime: "text/plain", absent: false })),
  getGitDiff: vi.fn(async () => ({ path: "x", hunks: [] as unknown[] })),
}));
vi.mock("@tanstack/vue-virtual", async () => {
  const { shallowRef, triggerRef } = await import("vue");
  return {
    useVirtualizer: (options: { count: number }) => {
      const inst = {
        options,
        setOptions(next: { count: number }) {
          Object.assign(inst.options, next);
          triggerRef(r);
        },
        getVirtualItems: () => Array.from({ length: inst.options.count }, (_, i) => ({ index: i, key: i, start: i * 24, size: 24 })),
        getTotalSize: () => inst.options.count * 24,
        measureElement: () => {},
        scrollToIndex: () => {},
      };
      const r = shallowRef(inst);
      return r;
    },
  };
});
vi.mock("../DiffViewer.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { filePath: String },
      emits: ["open-file-history"],
      setup: (p, { emit }) => () =>
        h("div", { class: "stub-diff" }, [
          h("button", { class: "stub-history", onClick: () => emit("open-file-history", p.filePath) }),
        ]),
    }),
  };
});
vi.mock("../CodeEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ props: { modelValue: String }, setup: (p) => () => h("pre", { class: "stub-code" }, p.modelValue) }) };
});

import FilesView from "../FilesView.vue";
import { clipboardWriteText, getGitDiff, listRepoDir, pathExists, readFileAtRevision, revealInFileManager } from "../../utils/backend";
import type { RepoFileEntry } from "../../composables/useGitRepo";
import { useWorkspaceScope } from "../../composables/useWorkspaceScope";
import { useLogs } from "../../composables/useLogs";

let app: App | null = null;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listRepoDir).mockClear();
  vi.mocked(pathExists).mockReset().mockResolvedValue(false);
  vi.mocked(revealInFileManager).mockReset().mockResolvedValue(undefined);
  useWorkspaceScope().activeScope.value = null;
  useLogs().clearLogs();
});
afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  useWorkspaceScope().activeScope.value = null;
});

async function settle() {
  for (let i = 0; i < 12; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mount(repoFiles: RepoFileEntry[] = []) {
  const events: Array<[string, ...unknown[]]> = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(FilesView, {
          repoPath: "/repo",
          repoFiles,
          watcher: null,
          "onOpenFileHistory": (p: string) => events.push(["open-file-history", p]),
        }),
    }),
  );
  app.mount(container);
  await settle();
  return events;
}

const row = (name: string) =>
  [...container.querySelectorAll<HTMLElement>("[role=treeitem]")].find((r) => r.textContent?.includes(name))!;
function menuItem(label: string) {
  return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((b) => b.textContent?.trim() === label)!;
}

describe("FilesView", () => {
  it("lists the root of the repo", async () => {
    await mount();
    expect(listRepoDir).toHaveBeenCalledWith("/repo", "", false);
    expect(row("README.md")).toBeTruthy();
  });

  it("'Scope here' sets the workspace scope and re-roots the tree on it", async () => {
    await mount();
    row("src").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    menuItem(en.filesView.ctxScopeHere).click();
    await settle();
    expect(useWorkspaceScope().activeScope.value).toBe("src");
    expect(listRepoDir).toHaveBeenLastCalledWith("/repo", "src", false);
    expect(container.querySelector(".fv__crumbs")?.textContent).toContain("src");
    expect(row("main.ts")).toBeTruthy();
  });

  it("falls back to the whole repo when the scope folder is gone", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    await mount();
    expect(pathExists).toHaveBeenCalledWith("/repo", "gone");
    expect(useWorkspaceScope().activeScope.value).toBeNull();
    expect(container.textContent).toContain(en.filesView.scopeGone.replace("{0}", "gone"));
    expect(listRepoDir).toHaveBeenLastCalledWith("/repo", "", false);
  });

  it("keeps the scope when its folder exists but cannot be listed", async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    useWorkspaceScope().activeScope.value = "gone";
    await mount();
    expect(useWorkspaceScope().activeScope.value).toBe("gone");
    expect(container.querySelector("[role=treeitem]")?.textContent).toContain("Directory not found: gone");
  });

  it("reports a failed Reveal in the logs", async () => {
    vi.mocked(revealInFileManager).mockRejectedValue(new Error("Path not found: README.md"));
    await mount();
    row("README.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    const items = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const reveal = items[items.length - 1]!;
    reveal.click();
    await settle();
    expect(revealInFileManager).toHaveBeenCalledWith("/repo", "README.md");
    const logs = useLogs().entries.value;
    expect(logs[logs.length - 1]).toMatchObject({
      level: "error",
      message: en.filesView.revealFailed.replace("{0}", "README.md").replace("{1}", "Path not found: README.md"),
    });
  });

  it("previews the selected file", async () => {
    await mount();
    row("README.md").click();
    await settle();
    expect(readFileAtRevision).toHaveBeenCalledWith("/repo", "", "README.md");
    expect(container.querySelector(".stub-code")?.textContent).toBe("hello");
  });

  it("re-emits the diff preview's file-history request", async () => {
    vi.mocked(getGitDiff).mockResolvedValueOnce({
      path: "README.md",
      hunks: [{ header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }],
    } as never);
    const events = await mount([{ path: "README.md", status: "modified", section: "unstaged" }]);
    row("README.md").click();
    await settle();
    container.querySelector<HTMLButtonElement>(".stub-history")!.click();
    expect(events[events.length - 1]).toEqual(["open-file-history", "README.md"]);
  });
});
