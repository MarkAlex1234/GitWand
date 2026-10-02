/**
 * useLazyRepoTree — tree logic only. `listDir` is an in-memory stand-in for
 * the `listRepoDir` IPC wrapper (not for git: listings themselves are pinned
 * by the Rust tests on real repos and by tests/parity/list-repo-dir.test.mjs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { effectScope, nextTick, ref, type EffectScope, type Ref } from "vue";
import {
  useLazyRepoTree,
  buildStatusMap,
  WATCH_DEBOUNCE_MS,
  EXPLORER_TREE_STORAGE_PREFIX,
  type LazyTreeRow,
  type ListDirFn,
  type TreeWatcher,
} from "../useLazyRepoTree";
import type { RepoFileEntry } from "../useGitRepo";
import type { RepoChangeEvent, RepoDirEntry, RepoDirListing } from "../../utils/backend";

function leaf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
function file(path: string, size = 1, ignored = false): RepoDirEntry {
  return { name: leaf(path), path, kind: "file", ignored, size };
}
function dir(path: string, ignored = false): RepoDirEntry {
  return { name: leaf(path), path, kind: "dir", ignored, size: 0 };
}

const FS: Record<string, RepoDirEntry[]> = {
  "": [dir("docs"), dir("src"), file("README.md")],
  src: [dir("src/lib"), file("src/main.ts")],
  "src/lib": [file("src/lib/util.ts")],
  docs: [file("docs/guide.md")],
};

/** Reads `fs` at call time, so a test can change the "disk" between calls. */
function fakeLister(fs: Record<string, RepoDirEntry[]>) {
  return vi.fn<ListDirFn>(async (d, includeIgnored) => {
    const entries = fs[d];
    if (!entries) throw new Error(`Directory not found: ${d}`);
    return { entries: includeIgnored ? entries : entries.filter((e) => !e.ignored), truncated: false };
  });
}

function fakeWatcher() {
  const handlers = new Set<(ev: RepoChangeEvent) => void>();
  const watcher: TreeWatcher = {
    on: (_kinds, h) => {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },
  };
  return { watcher, emit: (ev: RepoChangeEvent) => handlers.forEach((h) => h(ev)), count: () => handlers.size };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

function shape(rows: readonly LazyTreeRow[]): string[] {
  return rows.map(
    (r) => `${"  ".repeat(r.depth)}${r.kind}:${r.kind === "folder" || r.kind === "file" ? r.name : r.path}`,
  );
}

interface Setup {
  listDir: ListDirFn;
  repoPath?: Ref<string>;
  root?: Ref<string>;
  repoFiles?: Ref<RepoFileEntry[]>;
  watcher?: TreeWatcher | null;
  onRootError?: (message: string) => void;
}

let scopes: EffectScope[] = [];
function setup(s: Setup) {
  const scope = effectScope();
  scopes.push(scope);
  const repoPath = s.repoPath ?? ref("/repo");
  const root = s.root ?? ref("");
  const repoFiles = s.repoFiles ?? ref<RepoFileEntry[]>([]);
  const tree = scope.run(() =>
    useLazyRepoTree({
      repoPath,
      root,
      repoFiles,
      listDir: s.listDir,
      watcher: s.watcher ?? null,
      onRootError: s.onRootError,
    }),
  )!;
  return { tree, repoPath, root, repoFiles, scope };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  scopes.forEach((s) => s.stop());
  scopes = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useLazyRepoTree — lazy listing", () => {
  it("lists the root on start, and only the root", async () => {
    const listDir = fakeLister(FS);
    const { tree } = setup({ listDir });
    expect(listDir).toHaveBeenCalledTimes(1);
    expect(listDir).toHaveBeenCalledWith("", false);
    expect(shape(tree.rows.value)).toEqual(["loading:"]);
    await flush();
    expect(shape(tree.rows.value)).toEqual(["folder:docs", "folder:src", "file:README.md"]);
  });

  it("lists a folder the first time it is expanded, and keeps it when collapsed", async () => {
    const listDir = fakeLister(FS);
    const { tree } = setup({ listDir });
    await flush();
    await tree.expand("src");
    expect(listDir).toHaveBeenLastCalledWith("src", false);
    expect(shape(tree.rows.value)).toEqual([
      "folder:docs", "folder:src", "  folder:lib", "  file:main.ts", "file:README.md",
    ]);
    tree.collapse("src");
    expect(shape(tree.rows.value)).toEqual(["folder:docs", "folder:src", "file:README.md"]);
    await tree.expand("src");
    expect(listDir).toHaveBeenCalledTimes(2);
  });

  it("shows an error row under a folder that cannot be listed, and retries it", async () => {
    const failing = new Set(["src"]);
    const base = fakeLister(FS);
    const listDir = vi.fn<ListDirFn>(async (d, inc) => {
      if (failing.has(d)) throw new Error("permission denied");
      return base(d, inc);
    });
    const { tree } = setup({ listDir });
    await flush();
    await tree.expand("src");
    expect(tree.rows.value.find((r) => r.kind === "error")).toMatchObject({
      kind: "error", path: "src", depth: 1, message: "permission denied",
    });
    expect(shape(tree.rows.value)).toContain("file:README.md");
    failing.clear();
    await tree.retry("src");
    expect(shape(tree.rows.value)).toContain("  file:main.ts");
  });

  it("adds a placeholder row under a truncated folder", async () => {
    const listDir = vi.fn<ListDirFn>(async () => ({ entries: [file("a.txt")], truncated: true }));
    const { tree } = setup({ listDir });
    await flush();
    expect(shape(tree.rows.value)).toEqual(["file:a.txt", "truncated:"]);
  });
});

describe("useLazyRepoTree — status", () => {
  it("folds a file that is both staged and modified into one status", () => {
    const map = buildStatusMap([
      { path: "a.ts", status: "added", section: "staged" },
      { path: "a.ts", status: "modified", section: "unstaged" },
      { path: "nested/", status: "added", section: "untracked" },
      { path: "gone.ts", status: "deleted", section: "unstaged" },
    ]);
    expect(map.get("a.ts")).toEqual({
      status: "modified", staged: true, unstaged: true, untracked: false, conflicted: false, deletedOnDisk: false,
    });
    expect(map.has("nested")).toBe(true);
    expect(map.get("gone.ts")?.deletedOnDisk).toBe(true);
  });

  it("puts badges on folders that were never listed", async () => {
    const listDir = fakeLister(FS);
    const repoFiles = ref<RepoFileEntry[]>([
      { path: "src/lib/util.ts", status: "modified", section: "unstaged" },
      { path: "src/main.ts", status: "modified", section: "conflicted" },
    ]);
    const { tree } = setup({ listDir, repoFiles });
    await flush();
    expect(tree.rows.value.find((r) => r.path === "src")).toMatchObject({
      kind: "folder", badge: { changed: 2, conflicted: true },
    });
    expect(tree.folderBadge("src/lib")).toEqual({ changed: 1, conflicted: false });
    expect(tree.folderBadge("docs")).toBeNull();
    expect(listDir).toHaveBeenCalledTimes(1);
  });

  it("merges tracked files deleted on disk into their folder, including a folder that is gone", async () => {
    const listDir = fakeLister(FS);
    const repoFiles = ref<RepoFileEntry[]>([
      { path: "src/gone.ts", status: "deleted", section: "unstaged" },
      { path: "old/a.ts", status: "deleted", section: "unstaged" },
      { path: "old/deep/b.ts", status: "deleted", section: "staged" },
    ]);
    const { tree } = setup({ listDir, repoFiles });
    await flush();
    expect(shape(tree.rows.value)).toEqual(["folder:docs", "folder:old", "folder:src", "file:README.md"]);
    expect(tree.rows.value.find((r) => r.path === "old")).toMatchObject({ kind: "folder", deleted: true });

    await tree.expand("old");
    expect(listDir).not.toHaveBeenCalledWith("old", expect.anything());
    expect(shape(tree.rows.value)).toEqual([
      "folder:docs", "folder:old", "  folder:deep", "  file:a.ts", "folder:src", "file:README.md",
    ]);

    await tree.expand("src");
    expect(tree.rows.value.find((r) => r.path === "src/gone.ts")).toMatchObject({
      kind: "file", deleted: true, status: { status: "deleted" },
    });
  });

  it("lists the changed paths below a folder", () => {
    const repoFiles = ref<RepoFileEntry[]>([
      { path: "src/a.ts", status: "modified", section: "unstaged" },
      { path: "src/lib/b.ts", status: "added", section: "untracked" },
      { path: "docs/c.md", status: "modified", section: "staged" },
    ]);
    const { tree } = setup({ listDir: fakeLister(FS), repoFiles });
    expect(tree.changedUnder("src")).toEqual(["src/a.ts", "src/lib/b.ts"]);
    expect(tree.changedUnder("")).toEqual(["docs/c.md", "src/a.ts", "src/lib/b.ts"]);
  });
});

describe("useLazyRepoTree — watcher", () => {
  it("reloads only the loaded parent of a changed path, 300 ms after the last event", async () => {
    vi.useFakeTimers();
    const listDir = fakeLister(FS);
    const w = fakeWatcher();
    const { tree } = setup({ listDir, watcher: w.watcher });
    await flush();
    await tree.expand("src");
    listDir.mockClear();
    w.emit({ kinds: ["worktree"], paths: ["src/new.ts"], truncated: false });
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 1);
    w.emit({ kinds: ["worktree"], paths: ["src/other.ts", "unloaded/x.ts"], truncated: false });
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 1);
    expect(listDir).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listDir).toHaveBeenCalledTimes(1);
    expect(listDir).toHaveBeenCalledWith("src", false);
  });

  it("reloads every loaded folder on a truncated event", async () => {
    vi.useFakeTimers();
    const listDir = fakeLister(FS);
    const w = fakeWatcher();
    const { tree } = setup({ listDir, watcher: w.watcher });
    await flush();
    await tree.expand("src");
    await tree.expand("docs");
    listDir.mockClear();
    w.emit({ kinds: ["worktree"], paths: [], truncated: true });
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(listDir.mock.calls.map((c) => c[0]).sort()).toEqual(["", "docs", "src"]);
  });

  it("drops a folder deleted while expanded: its own reload fails, so its parent is reloaded", async () => {
    vi.useFakeTimers();
    const fs: Record<string, RepoDirEntry[]> = { ...FS };
    const listDir = fakeLister(fs);
    const w = fakeWatcher();
    const { tree } = setup({ listDir, watcher: w.watcher });
    await flush();
    await tree.expand("src");
    await tree.expand("src/lib");
    delete fs["src/lib"];
    fs.src = [file("src/main.ts")];
    w.emit({ kinds: ["worktree"], paths: ["src/lib/util.ts"], truncated: false });
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    await flush();
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    await flush();
    expect(shape(tree.rows.value)).toEqual(["folder:docs", "folder:src", "  file:main.ts", "file:README.md"]);
  });

  it("unsubscribes from the watcher when its scope stops", () => {
    const w = fakeWatcher();
    const { scope } = setup({ listDir: fakeLister(FS), watcher: w.watcher });
    expect(w.count()).toBe(1);
    scope.stop();
    expect(w.count()).toBe(0);
  });
});

describe("useLazyRepoTree — root, repo and races", () => {
  it("re-roots on the scope folder and resets the cache and the expansion", async () => {
    const listDir = fakeLister(FS);
    const root = ref("");
    const { tree } = setup({ listDir, root });
    await flush();
    await tree.expand("src");
    root.value = "src";
    await flush();
    expect(listDir).toHaveBeenLastCalledWith("src", false);
    expect(shape(tree.rows.value)).toEqual(["folder:lib", "file:main.ts"]);
    expect(tree.isExpanded("src")).toBe(false);
    root.value = "";
    await flush();
    expect(listDir).toHaveBeenLastCalledWith("", false);
  });

  it("reports a root that cannot be listed", async () => {
    const onRootError = vi.fn();
    setup({ listDir: fakeLister(FS), root: ref("gone"), onRootError });
    await flush();
    expect(onRootError).toHaveBeenCalledWith("Directory not found: gone");
  });

  it("drops a listing that resolves after a repo switch", async () => {
    const repoPath = ref("/a");
    const pending: Array<(l: RepoDirListing) => void> = [];
    const listDir = vi.fn<ListDirFn>(() => new Promise((resolve) => pending.push(resolve)));
    const { tree } = setup({ listDir, repoPath });
    repoPath.value = "/b";
    await flush();
    expect(listDir).toHaveBeenCalledTimes(2);
    pending[1]!({ entries: [file("b.txt")], truncated: false });
    await flush();
    pending[0]!({ entries: [file("a.txt")], truncated: false });
    await flush();
    expect(shape(tree.rows.value)).toEqual(["file:b.txt"]);
  });

  it("reveal expands every ancestor and selects the path", async () => {
    const { tree } = setup({ listDir: fakeLister(FS) });
    await flush();
    await tree.reveal("src/lib/util.ts");
    expect(tree.isExpanded("src")).toBe(true);
    expect(tree.isExpanded("src/lib")).toBe(true);
    expect(tree.selected.value).toBe("src/lib/util.ts");
    expect(shape(tree.rows.value)).toContain("    file:util.ts");
  });
});

describe("useLazyRepoTree — Show ignored and persistence", () => {
  it("re-lists loaded folders when Show ignored changes, keeping the expansion", async () => {
    const listDir = fakeLister({ ...FS, "": [...FS[""]!, dir("node_modules", true)] });
    const { tree } = setup({ listDir });
    await flush();
    await tree.expand("src");
    expect(shape(tree.rows.value)).not.toContain("folder:node_modules");
    tree.showIgnored.value = true;
    await flush();
    expect(listDir).toHaveBeenCalledWith("", true);
    expect(listDir).toHaveBeenCalledWith("src", true);
    expect(tree.rows.value.find((r) => r.path === "node_modules")).toMatchObject({ kind: "folder", ignored: true });
    expect(tree.isExpanded("src")).toBe(true);
  });

  it("restores expanded folders, the selection and Show ignored per repo", async () => {
    const first = setup({ listDir: fakeLister(FS) });
    await flush();
    await first.tree.expand("src");
    await first.tree.expand("src/lib");
    first.tree.selected.value = "src/lib/util.ts";
    first.tree.showIgnored.value = true;
    await flush();
    expect(JSON.parse(localStorage.getItem(`${EXPLORER_TREE_STORAGE_PREFIX}/repo`)!)).toEqual({
      expanded: ["src", "src/lib"], selected: "src/lib/util.ts", showIgnored: true,
    });
    first.scope.stop();

    const listDir2 = fakeLister(FS);
    const second = setup({ listDir: listDir2 });
    await flush();
    expect(listDir2.mock.calls).toEqual([["", true], ["src", true], ["src/lib", true]]);
    expect(second.tree.selected.value).toBe("src/lib/util.ts");
    expect(shape(second.tree.rows.value)).toContain("    file:util.ts");
  });

  it("works when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { tree } = setup({ listDir: fakeLister(FS) });
    await flush();
    await tree.expand("src");
    tree.selected.value = "src/main.ts";
    await flush();
    expect(shape(tree.rows.value)).toContain("  file:main.ts");
  });
});
