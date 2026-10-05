/**
 * useFilePreview — what a File Explorer tab's Diff side shows (v3.11.2).
 *
 * `planPreview` is the spec §7 table as a pure function: a selection and a
 * Working tree | Index side in, a plan out. `useFilePreview` runs the plan
 * through injected loaders and guards against the race that matters while
 * switching tabs or sides: every load carries a request id, and a response
 * for an earlier selection is dropped. It reloads through the watcher when the
 * previewed file changes on disk, stale-while-revalidate: a reload of what is
 * already shown keeps it on screen until the new response lands, so a save in
 * the editor neither blanks the pane nor scrolls it back to the top. An error
 * is always shown as an error, never as an empty body.
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import type { FileAtRevision, GitDiff } from "../utils/backend";
import { WATCH_DEBOUNCE_MS, type FileStatusInfo, type TreeWatcher } from "./useLazyRepoTree";

/** Same threshold as the Rust `git_diff` truncation (P2.4). */
export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
/** Like git: a NUL in the first 8,000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;

export type PreviewTarget =
  | { kind: "folder"; path: string }
  | { kind: "file"; path: string; size: number; symlink: boolean; status: FileStatusInfo | null };

export type DiffSide = "worktree" | "index";

export type PreviewPlan =
  | { kind: "folder" }
  | { kind: "conflicted" }
  | { kind: "symlink" }
  | { kind: "too-large"; size: number }
  | { kind: "content" }
  | { kind: "diff"; staged: boolean; canSwitch: boolean };

export type PreviewBody =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "folder" }
  | { kind: "conflicted" }
  | { kind: "symlink" }
  | { kind: "gone" }
  | { kind: "placeholder"; reason: "too-large" | "binary" | "non-utf8" | "no-text-diff"; size: number }
  | { kind: "text"; content: string }
  | { kind: "diff"; diff: GitDiff };

export interface PreviewLoaders {
  readFile: (cwd: string, path: string) => Promise<FileAtRevision>;
  getDiff: (cwd: string, path: string, staged: boolean) => Promise<GitDiff>;
}

export interface UseFilePreviewOptions {
  cwd: Readonly<Ref<string>>;
  target: Readonly<Ref<PreviewTarget | null>>;
  loaders: PreviewLoaders;
  watcher?: TreeWatcher | null;
  debounceMs?: number;
}

export function planPreview(target: PreviewTarget, side: DiffSide): PreviewPlan {
  if (target.kind === "folder") return { kind: "folder" };
  const s = target.status;
  if (s?.conflicted) return { kind: "conflicted" };
  if (!s) {
    if (target.symlink) return { kind: "symlink" };
    if (target.size > PREVIEW_MAX_BYTES) return { kind: "too-large", size: target.size };
    return { kind: "content" };
  }
  const worktreeSide = s.unstaged || s.untracked;
  if (s.staged && worktreeSide) return { kind: "diff", staged: side === "index", canSwitch: true };
  if (s.staged) return { kind: "diff", staged: true, canSwitch: false };
  // An untracked diff is the whole file (`--no-index`): refuse a huge one up front.
  if (s.untracked && target.size > PREVIEW_MAX_BYTES) return { kind: "too-large", size: target.size };
  return { kind: "diff", staged: false, canSwitch: false };
}

export function decodeText(
  bytesBase64: string,
): { ok: true; text: string } | { ok: false; reason: "binary" | "non-utf8" } {
  const bin = atob(bytesBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const sniff = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniff; i++) if (bytes[i] === 0) return { ok: false, reason: "binary" };
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "non-utf8" };
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function useFilePreview(opts: UseFilePreviewOptions) {
  const debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;
  const side = ref<DiffSide>("worktree");
  const body = shallowRef<PreviewBody>({ kind: "idle" });
  let requestId = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The load key `body` was produced for; "" while nothing loaded is shown. */
  let shownKey = "";

  const plan = computed<PreviewPlan | null>(() =>
    opts.target.value ? planPreview(opts.target.value, side.value) : null,
  );
  /** Primitive, so the load watcher never needs to be deep. */
  const loadKey = computed(() => {
    const t = opts.target.value;
    const p = plan.value;
    return t && p ? `${opts.cwd.value}\u0000${t.path}\u0000${JSON.stringify(p)}` : "";
  });

  /** Only a settled body counts as "shown": loading or an error never revalidates in place. */
  function show(next: PreviewBody, key: string): void {
    body.value = next;
    shownKey = next.kind === "idle" || next.kind === "loading" || next.kind === "error" ? "" : key;
  }

  async function load(): Promise<void> {
    const id = ++requestId;
    const key = loadKey.value;
    const t = opts.target.value;
    const p = plan.value;
    if (!t || !p) {
      show({ kind: "idle" }, key);
      return;
    }
    if (p.kind === "folder" || p.kind === "conflicted" || p.kind === "symlink") {
      show({ kind: p.kind }, key);
      return;
    }
    if (p.kind === "too-large") {
      show({ kind: "placeholder", reason: "too-large", size: p.size }, key);
      return;
    }
    // Same selection, side and plan as what is on screen: revalidate in place.
    if (shownKey !== key) show({ kind: "loading" }, key);
    const commit = (next: PreviewBody) => show(next, key);
    try {
      if (p.kind === "content") {
        const file = await opts.loaders.readFile(opts.cwd.value, t.path);
        if (id !== requestId) return;
        if (file.absent) {
          commit({ kind: "gone" });
          return;
        }
        if (file.byteLength > PREVIEW_MAX_BYTES) {
          commit({ kind: "placeholder", reason: "too-large", size: file.byteLength });
          return;
        }
        const decoded = decodeText(file.bytesBase64);
        commit(
          decoded.ok
            ? { kind: "text", content: decoded.text }
            : { kind: "placeholder", reason: decoded.reason, size: file.byteLength },
        );
        return;
      }
      const diff = await opts.loaders.getDiff(opts.cwd.value, t.path, p.staged);
      if (id !== requestId) return;
      if (diff.truncatedFromBytes) {
        commit({ kind: "placeholder", reason: "too-large", size: diff.truncatedFromBytes });
      } else if (diff.hunks.length === 0) {
        commit({ kind: "placeholder", reason: "no-text-diff", size: t.kind === "file" ? t.size : 0 });
      } else {
        commit({ kind: "diff", diff });
      }
    } catch (err) {
      if (id !== requestId) return;
      commit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Declared before the load watcher so a new selection loads once, on the working tree.
  watch(
    [() => opts.cwd.value, () => opts.target.value?.path ?? null],
    () => {
      side.value = "worktree";
    },
  );
  watch(loadKey, () => void load(), { immediate: true });
  // A reload queued for the previous file or repo must not fire on the next one.
  watch([() => opts.cwd.value, () => opts.target.value?.path ?? null], () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });

  const unsubscribe =
    opts.watcher?.on(["worktree", "index"], (ev) => {
      const t = opts.target.value;
      if (!t || t.kind !== "file") return;
      if (!ev.truncated && !ev.kinds.includes("index") && !ev.paths.includes(t.path)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, debounceMs);
    }) ?? null;

  function dispose(): void {
    unsubscribe?.();
    requestId++;
    if (timer) clearTimeout(timer);
    timer = null;
  }
  if (getCurrentScope()) onScopeDispose(dispose);

  return { side, plan, body, retry: load, dispose };
}
