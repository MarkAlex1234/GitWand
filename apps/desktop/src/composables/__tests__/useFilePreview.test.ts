/**
 * useFilePreview — the spec §7 decision table, text decoding, the selection
 * race guard and the watcher reload. Loaders are injected stand-ins for the
 * `readFileAtRevision` / `getGitDiff` IPC wrappers, whose own outputs are
 * covered by the git-diff and read-file parity suites.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { effectScope, nextTick, ref, watch, type EffectScope, type Ref } from "vue";
import {
  type PreviewBody,
  planPreview,
  decodeText,
  formatBytes,
  useFilePreview,
  PREVIEW_MAX_BYTES,
  type PreviewLoaders,
  type PreviewTarget,
} from "../useFilePreview";
import { WATCH_DEBOUNCE_MS, type FileStatusInfo, type TreeWatcher } from "../useLazyRepoTree";
import type { FileAtRevision, GitDiff, RepoChangeEvent } from "../../utils/backend";

function st(p: Partial<FileStatusInfo>): FileStatusInfo {
  return { status: "modified", staged: false, unstaged: false, untracked: false, conflicted: false, deletedOnDisk: false, ...p };
}
function fileTarget(path: string, status: FileStatusInfo | null, size = 10, symlink = false): PreviewTarget {
  return { kind: "file", path, size, symlink, status };
}
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
function textFile(s: string): FileAtRevision {
  return { bytesBase64: b64(s), byteLength: Buffer.byteLength(s), mime: "text/plain", absent: false };
}
const DIFF: GitDiff = {
  path: "a.ts",
  hunks: [{
    header: "@@ -1 +1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
    lines: [{ type: "delete", content: "a", oldLineNo: 1 }, { type: "add", content: "b", newLineNo: 1 }],
  }],
};

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

let scopes: EffectScope[] = [];
afterEach(() => {
  scopes.forEach((s) => s.stop());
  scopes = [];
  vi.useRealTimers();
});

function loaders(over: Partial<PreviewLoaders> = {}): PreviewLoaders {
  return {
    readFile: vi.fn(async () => textFile("hello\n")),
    getDiff: vi.fn(async () => DIFF),
    ...over,
  };
}
function run(
  target: Ref<PreviewTarget | null>,
  l: PreviewLoaders,
  watcher: TreeWatcher | null = null,
  cwd: Ref<string> = ref("/repo"),
) {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => useFilePreview({ cwd, target, loaders: l, watcher }))!;
}

describe("planPreview", () => {
  it("covers every row of the spec §7 table", () => {
    expect(planPreview({ kind: "folder", path: "src" }, "worktree")).toEqual({ kind: "folder" });
    expect(planPreview(fileTarget("a", null), "worktree")).toEqual({ kind: "content" });
    expect(planPreview(fileTarget("a", st({ unstaged: true })), "worktree")).toEqual({ kind: "diff", staged: false, canSwitch: false });
    expect(planPreview(fileTarget("a", st({ staged: true })), "worktree")).toEqual({ kind: "diff", staged: true, canSwitch: false });
    expect(planPreview(fileTarget("a", st({ staged: true, unstaged: true })), "worktree")).toEqual({ kind: "diff", staged: false, canSwitch: true });
    expect(planPreview(fileTarget("a", st({ staged: true, unstaged: true })), "index")).toEqual({ kind: "diff", staged: true, canSwitch: true });
    expect(planPreview(fileTarget("a", st({ status: "added", untracked: true })), "worktree")).toEqual({ kind: "diff", staged: false, canSwitch: false });
    expect(planPreview(fileTarget("a", st({ status: "deleted", unstaged: true, deletedOnDisk: true })), "worktree")).toEqual({ kind: "diff", staged: false, canSwitch: false });
    expect(planPreview(fileTarget("a", st({ conflicted: true })), "worktree")).toEqual({ kind: "conflicted" });
  });

  it("refuses an unchanged or untracked file over 5 MB before reading it", () => {
    const big = PREVIEW_MAX_BYTES + 1;
    expect(planPreview(fileTarget("a", null, big), "worktree")).toEqual({ kind: "too-large", size: big });
    expect(planPreview(fileTarget("a", st({ status: "added", untracked: true }), big), "worktree")).toEqual({ kind: "too-large", size: big });
  });

  it("never reads through an unchanged symlink, which may point outside the repo", () => {
    expect(planPreview(fileTarget("link", null, 0, true), "worktree")).toEqual({ kind: "symlink" });
  });
});

describe("decodeText / formatBytes", () => {
  it("decodes UTF-8 text and refuses binary and non-UTF-8 bytes", () => {
    expect(decodeText(b64("héllo\n"))).toEqual({ ok: true, text: "héllo\n" });
    expect(decodeText(b64(new Uint8Array([0x61, 0x00, 0x62])))).toEqual({ ok: false, reason: "binary" });
    expect(decodeText(b64(new Uint8Array([0x61, 0xff, 0xfe])))).toEqual({ ok: false, reason: "non-utf8" });
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(PREVIEW_MAX_BYTES)).toBe("5.0 MB");
  });
});

describe("useFilePreview — bodies", () => {
  it("shows the content of an unchanged file", async () => {
    const l = loaders();
    const p = run(ref(fileTarget("a.ts", null)), l);
    await flush();
    expect(l.readFile).toHaveBeenCalledWith("/repo", "a.ts");
    expect(p.body.value).toEqual({ kind: "text", content: "hello\n" });
  });

  it("says 'Deleted from disk' when the file is gone, never an empty body", async () => {
    const l = loaders({ readFile: vi.fn(async () => ({ bytesBase64: "", byteLength: 0, mime: "", absent: true })) });
    const p = run(ref(fileTarget("a.ts", null)), l);
    await flush();
    expect(p.body.value).toEqual({ kind: "gone" });
  });

  it("shows a placeholder for binary content and for content over 5 MB", async () => {
    const bin = loaders({ readFile: vi.fn(async () => ({ bytesBase64: b64(new Uint8Array([0, 1, 2])), byteLength: 3, mime: "", absent: false })) });
    const p1 = run(ref(fileTarget("a.bin", null, 3)), bin);
    await flush();
    expect(p1.body.value).toEqual({ kind: "placeholder", reason: "binary", size: 3 });

    const big = loaders({ readFile: vi.fn(async () => ({ bytesBase64: "", byteLength: PREVIEW_MAX_BYTES + 1, mime: "", absent: false })) });
    const p2 = run(ref(fileTarget("a.log", null, 1)), big);
    await flush();
    expect(p2.body.value).toEqual({ kind: "placeholder", reason: "too-large", size: PREVIEW_MAX_BYTES + 1 });
  });

  it("shows the diff of a modified file, and the index side on demand", async () => {
    const l = loaders();
    const p = run(ref(fileTarget("a.ts", st({ staged: true, unstaged: true }))), l);
    await flush();
    expect(l.getDiff).toHaveBeenLastCalledWith("/repo", "a.ts", false);
    expect(p.body.value).toEqual({ kind: "diff", diff: DIFF });
    p.side.value = "index";
    await flush();
    expect(l.getDiff).toHaveBeenLastCalledWith("/repo", "a.ts", true);
  });

  it("resets the side to the working tree when the selection changes", async () => {
    const target = ref<PreviewTarget | null>(fileTarget("a.ts", st({ staged: true, unstaged: true })));
    const l = loaders();
    const p = run(target, l);
    p.side.value = "index";
    await flush();
    target.value = fileTarget("b.ts", st({ staged: true, unstaged: true }));
    await flush();
    expect(p.side.value).toBe("worktree");
    expect(l.getDiff).toHaveBeenLastCalledWith("/repo", "b.ts", false);
  });

  it("resets the side to the working tree when the repo changes, even for the same path", async () => {
    const cwd = ref("/repo");
    const l = loaders();
    const p = run(ref(fileTarget("a.ts", st({ staged: true, unstaged: true }))), l, null, cwd);
    p.side.value = "index";
    await flush();
    cwd.value = "/other";
    await flush();
    expect(p.side.value).toBe("worktree");
    expect(l.getDiff).toHaveBeenLastCalledWith("/other", "a.ts", false);
  });

  it("turns a truncated or empty diff into a placeholder", async () => {
    const trunc = loaders({ getDiff: vi.fn(async () => ({ path: "a", hunks: [], truncatedFromBytes: 9_000_000 })) });
    const p1 = run(ref(fileTarget("a", st({ unstaged: true }))), trunc);
    await flush();
    expect(p1.body.value).toEqual({ kind: "placeholder", reason: "too-large", size: 9_000_000 });

    const empty = loaders({ getDiff: vi.fn(async () => ({ path: "b", hunks: [] })) });
    const p2 = run(ref(fileTarget("b", st({ unstaged: true }), 1234)), empty);
    await flush();
    expect(p2.body.value).toEqual({ kind: "placeholder", reason: "no-text-diff", size: 1234 });
  });

  it("does not load anything for a conflicted file or a folder", async () => {
    const l = loaders();
    const p = run(ref(fileTarget("a", st({ conflicted: true }))), l);
    const f = run(ref<PreviewTarget | null>({ kind: "folder", path: "src" }), l);
    await flush();
    expect(p.body.value).toEqual({ kind: "conflicted" });
    expect(f.body.value).toEqual({ kind: "folder" });
    expect(l.readFile).not.toHaveBeenCalled();
    expect(l.getDiff).not.toHaveBeenCalled();
  });

  it("shows an error inline and retries", async () => {
    let fail = true;
    const l = loaders({
      readFile: vi.fn(async () => {
        if (fail) throw new Error("EACCES");
        return textFile("ok");
      }),
    });
    const p = run(ref(fileTarget("a", null)), l);
    await flush();
    expect(p.body.value).toEqual({ kind: "error", message: "EACCES" });
    fail = false;
    await p.retry();
    expect(p.body.value).toEqual({ kind: "text", content: "ok" });
  });
});

describe("useFilePreview — races and refresh", () => {
  it("drops a response for an earlier selection", async () => {
    const resolvers: Record<string, (f: FileAtRevision) => void> = {};
    const l = loaders({
      readFile: vi.fn((_cwd: string, path: string) => new Promise<FileAtRevision>((r) => { resolvers[path] = r; })),
    });
    const target = ref<PreviewTarget | null>(fileTarget("a.ts", null));
    const p = run(target, l);
    target.value = fileTarget("b.ts", null);
    await flush();
    resolvers["b.ts"]!(textFile("B"));
    await flush();
    resolvers["a.ts"]!(textFile("A"));
    await flush();
    expect(p.body.value).toEqual({ kind: "text", content: "B" });
  });

  it("reloads the previewed file when the watcher reports it, and only then", async () => {
    vi.useFakeTimers();
    const handlers = new Set<(ev: RepoChangeEvent) => void>();
    const watcher: TreeWatcher = {
      on: (_k, h) => {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
    };
    const l = loaders();
    run(ref(fileTarget("a.ts", null)), l, watcher);
    await flush();
    expect(l.readFile).toHaveBeenCalledTimes(1);
    handlers.forEach((h) => h({ kinds: ["worktree"], paths: ["b.ts"], truncated: false }));
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(l.readFile).toHaveBeenCalledTimes(1);
    handlers.forEach((h) => h({ kinds: ["worktree"], paths: ["a.ts"], truncated: false }));
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 1);
    expect(l.readFile).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(l.readFile).toHaveBeenCalledTimes(2);
  });

  function fakeWatcher() {
    const handlers = new Set<(ev: RepoChangeEvent) => void>();
    const watcher: TreeWatcher = {
      on: (_k, h) => {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
    };
    const emit = (path: string) => handlers.forEach((h) => h({ kinds: ["worktree"], paths: [path], truncated: false }));
    return { watcher, emit };
  }
  /** Every body the composable passes through, synchronously. */
  function recordBodies(p: { body: Ref<PreviewBody> }): PreviewBody[] {
    const seen: PreviewBody[] = [];
    watch(p.body, (b) => seen.push(b), { flush: "sync" });
    return seen;
  }

  it("keeps the shown content while a watcher reload of the same file is in flight", async () => {
    vi.useFakeTimers();
    const { watcher, emit } = fakeWatcher();
    const pending: Array<(f: FileAtRevision) => void> = [];
    const l = loaders({
      readFile: vi.fn(() => new Promise<FileAtRevision>((r) => pending.push(r))),
    });
    const p = run(ref(fileTarget("a.ts", null)), l, watcher);
    await flush();
    pending.shift()!(textFile("v1"));
    await flush();
    const shown = p.body.value;
    expect(shown).toEqual({ kind: "text", content: "v1" });

    const seen = recordBodies(p);
    emit("a.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    await flush();
    expect(l.readFile).toHaveBeenCalledTimes(2);
    expect(p.body.value).toBe(shown);
    pending.shift()!(textFile("v2"));
    await flush();
    expect(p.body.value).toEqual({ kind: "text", content: "v2" });
    expect(seen.map((b) => b.kind)).toEqual(["text"]);
  });

  it("keeps the shown diff while a watcher reload of the same diff is in flight", async () => {
    vi.useFakeTimers();
    const { watcher, emit } = fakeWatcher();
    const pending: Array<(d: GitDiff) => void> = [];
    const l = loaders({ getDiff: vi.fn(() => new Promise<GitDiff>((r) => pending.push(r))) });
    const p = run(ref(fileTarget("a.ts", st({ unstaged: true }))), l, watcher);
    await flush();
    pending.shift()!(DIFF);
    await flush();
    const seen = recordBodies(p);
    emit("a.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    await flush();
    expect(p.body.value.kind).toBe("diff");
    pending.shift()!({ ...DIFF });
    await flush();
    expect(seen.every((b) => b.kind === "diff")).toBe(true);
  });

  it("still shows loading for a new selection", async () => {
    const l = loaders({
      readFile: vi.fn((_c: string, path: string) =>
        path === "a.ts" ? Promise.resolve(textFile("A")) : new Promise<FileAtRevision>(() => {}),
      ),
    });
    const target = ref<PreviewTarget | null>(fileTarget("a.ts", null));
    const p = run(target, l);
    await flush();
    expect(p.body.value).toEqual({ kind: "text", content: "A" });
    target.value = fileTarget("b.ts", null);
    await flush();
    expect(p.body.value).toEqual({ kind: "loading" });
  });

  it("drops a pending watcher reload of the previous file when the selection changes", async () => {
    vi.useFakeTimers();
    const { watcher, emit } = fakeWatcher();
    const l = loaders();
    const target = ref<PreviewTarget | null>(fileTarget("a.ts", null));
    run(target, l, watcher);
    await flush();
    emit("a.ts");
    target.value = fileTarget("b.ts", null);
    await flush();
    expect(l.readFile).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 2);
    await flush();
    expect(l.readFile).toHaveBeenCalledTimes(2);
  });
});
