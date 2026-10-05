/**
 * useLazyRepoTree — the working-tree model behind the File Explorer panel (v3.11.2).
 *
 * One directory is listed at a time, through an injected `listDir`, the first
 * time it is expanded; the root (the whole repo, or the active scope) is
 * listed on start. Badges never wait for a listing: they come from
 * `repoFiles`, so a collapsed, never-loaded folder still shows that something
 * changed below it.
 *
 * `listDir` is injected rather than imported so the tree logic is testable
 * without a backend. What a real directory lists as, ignored files included,
 * is pinned by the Rust tests and by tests/parity/list-repo-dir.test.mjs.
 *
 * Reactivity is deliberately shallow: the per-directory cache is a plain Map
 * bumped through a version counter, and the expansion set is replaced, never
 * mutated, so a 5,000-entry listing is never deep-proxied and nothing here
 * needs a deep watcher (apps/desktop/CLAUDE.md P6.4).
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import type { RepoFileEntry } from "./useGitRepo";
import type { RepoChangeKind } from "./useRepoWatcher";
import type { RepoChangeEvent, RepoDirEntry, RepoDirListing } from "../utils/backend";

/** Per-directory cap of both backends (MAX_REPO_DIR_ENTRIES in files.rs and dev-server.mjs). */
export const DIR_ENTRY_CAP = 5000;
export const WATCH_DEBOUNCE_MS = 300;
export const EXPLORER_TREE_STORAGE_PREFIX = "gitwand-explorer-tree:";

export type ListDirFn = (dir: string, includeIgnored: boolean) => Promise<RepoDirListing>;

/** The slice of `useRepoWatcher()` this model needs. */
export interface TreeWatcher {
  on: (kinds: RepoChangeKind[], handler: (ev: RepoChangeEvent) => void) => () => void;
}

export interface FileStatusInfo {
  /** Badge status: "modified" when conflicted, else the unstaged, staged, or untracked ("added") one. */
  status: RepoFileEntry["status"];
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  /** Tracked, and missing from the working tree: `read_dir` will not list it. */
  deletedOnDisk: boolean;
}

export interface FolderBadge {
  changed: number;
  conflicted: boolean;
}

interface RowBase {
  path: string;
  name: string;
  depth: number;
}
export interface FolderRow extends RowBase {
  kind: "folder";
  expanded: boolean;
  ignored: boolean;
  /** Gone from disk but holding deleted tracked files: listed from `repoFiles` only. */
  deleted: boolean;
  badge: FolderBadge | null;
}
export interface FileRow extends RowBase {
  kind: "file";
  ignored: boolean;
  symlink: boolean;
  deleted: boolean;
  size: number;
  status: FileStatusInfo | null;
}
/** `path` is the directory the placeholder belongs to; `name` is "". */
export interface PlaceholderRow extends RowBase {
  kind: "loading" | "truncated";
}
export interface ErrorRow extends RowBase {
  kind: "error";
  message: string;
}
export type LazyTreeRow = FolderRow | FileRow | PlaceholderRow | ErrorRow;

export interface UseLazyRepoTreeOptions {
  repoPath: Readonly<Ref<string>>;
  /** "" for the whole repo, or the active scope folder. */
  root: Readonly<Ref<string>>;
  repoFiles: Readonly<Ref<RepoFileEntry[]>>;
  listDir: ListDirFn;
  watcher?: TreeWatcher | null;
  /** The root itself failed to list: the caller decides whether the scope is gone. */
  onRootError?: (message: string) => void;
  debounceMs?: number;
  /** Defaults to `EXPLORER_TREE_STORAGE_PREFIX`; `null` turns persistence off. */
  storageKeyPrefix?: string | null;
}

interface DirState {
  status: "loading" | "loaded" | "error";
  entries: RepoDirEntry[];
  truncated: boolean;
  /** At least one listing landed: a reload keeps showing it instead of a placeholder. */
  hasData: boolean;
  error: string;
  includeIgnored: boolean;
  token: number;
}

interface Persisted {
  expanded: string[];
  selected: string | null;
  showIgnored: boolean;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Strict descendant: `isUnder("a/b", "a")`, never `isUnder("a", "a")`. */
function isUnder(path: string, dir: string): boolean {
  return dir === "" ? path !== "" : path.startsWith(`${dir}/`);
}

function leafName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Child {
  name: string;
  path: string;
  isDir: boolean;
  entry: RepoDirEntry | null;
}

/** Directories first, then case-insensitively by name (the backends' order). */
function compareChildren(a: Child, b: Child): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function buildStatusMap(files: readonly RepoFileEntry[]): Map<string, FileStatusInfo> {
  type Acc = { staged?: RepoFileEntry["status"]; unstaged?: RepoFileEntry["status"]; untracked: boolean; conflicted: boolean };
  const acc = new Map<string, Acc>();
  for (const f of files) {
    // Untracked nested repos arrive as "dir/".
    const path = f.path.replace(/\/+$/, "");
    const a = acc.get(path) ?? { untracked: false, conflicted: false };
    if (f.section === "staged") a.staged = f.status;
    else if (f.section === "unstaged") a.unstaged = f.status;
    else if (f.section === "untracked") a.untracked = true;
    else a.conflicted = true;
    acc.set(path, a);
  }
  const out = new Map<string, FileStatusInfo>();
  for (const [path, a] of acc) {
    out.set(path, {
      status: a.conflicted ? "modified" : (a.unstaged ?? a.staged ?? "added"),
      staged: a.staged !== undefined,
      unstaged: a.unstaged !== undefined,
      untracked: a.untracked,
      conflicted: a.conflicted,
      deletedOnDisk: a.unstaged === "deleted" || (a.staged === "deleted" && !a.unstaged && !a.untracked),
    });
  }
  return out;
}

function buildFolderBadges(statuses: ReadonlyMap<string, FileStatusInfo>): Map<string, FolderBadge> {
  const out = new Map<string, FolderBadge>();
  for (const [path, info] of statuses) {
    let d = parentOf(path);
    for (;;) {
      const b = out.get(d) ?? { changed: 0, conflicted: false };
      b.changed += 1;
      b.conflicted ||= info.conflicted;
      out.set(d, b);
      if (d === "") break;
      d = parentOf(d);
    }
  }
  return out;
}

/** For every directory, the names of its children that only exist as deleted tracked paths. */
function buildDeletedIndex(
  statuses: ReadonlyMap<string, FileStatusInfo>,
): Map<string, { files: Set<string>; dirs: Set<string> }> {
  const out = new Map<string, { files: Set<string>; dirs: Set<string> }>();
  for (const [path, info] of statuses) {
    if (!info.deletedOnDisk) continue;
    let child = path;
    let d = parentOf(path);
    let isFile = true;
    for (;;) {
      const slot = out.get(d) ?? { files: new Set<string>(), dirs: new Set<string>() };
      (isFile ? slot.files : slot.dirs).add(leafName(child));
      out.set(d, slot);
      if (d === "") break;
      child = d;
      d = parentOf(d);
      isFile = false;
    }
  }
  return out;
}

export function useLazyRepoTree(opts: UseLazyRepoTreeOptions) {
  const debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;
  const prefix = opts.storageKeyPrefix === undefined ? EXPLORER_TREE_STORAGE_PREFIX : opts.storageKeyPrefix;

  const cache = new Map<string, DirState>();
  const version = ref(0);
  const bump = () => {
    version.value++;
  };
  const expanded = shallowRef<Set<string>>(new Set());
  const selected = ref<string | null>(null);
  const showIgnored = ref(false);

  let generation = 0;
  let disposed = false;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const statusByPath = computed(() => buildStatusMap(opts.repoFiles.value));
  const folderBadges = computed(() => buildFolderBadges(statusByPath.value));
  const deletedIndex = computed(() => buildDeletedIndex(statusByPath.value));

  // ── Persistence ────────────────────────────────────────
  function readPersisted(repo: string): Persisted | null {
    if (prefix === null) return null;
    try {
      const raw = localStorage.getItem(prefix + repo);
      if (!raw) return null;
      const p = JSON.parse(raw) as Partial<Persisted>;
      return {
        expanded: Array.isArray(p.expanded) ? p.expanded.filter((x): x is string => typeof x === "string") : [],
        selected: typeof p.selected === "string" ? p.selected : null,
        showIgnored: p.showIgnored === true,
      };
    } catch {
      return null;
    }
  }

  const persistedJson = computed(() =>
    JSON.stringify({
      expanded: [...expanded.value].sort(),
      selected: selected.value,
      showIgnored: showIgnored.value,
    }),
  );

  watch(persistedJson, (json) => {
    const repo = opts.repoPath.value;
    if (!repo || prefix === null) return;
    try {
      localStorage.setItem(prefix + repo, json);
    } catch {
      /* storage unavailable: the view works without it */
    }
  });

  // ── Loading ────────────────────────────────────────────
  async function load(dir: string): Promise<void> {
    if (disposed) return;
    const gen = generation;
    const prev = cache.get(dir);
    const token = (prev?.token ?? 0) + 1;
    const includeIgnored = showIgnored.value;
    cache.set(dir, {
      status: "loading",
      entries: prev?.entries ?? [],
      truncated: prev?.truncated ?? false,
      hasData: prev?.hasData ?? false,
      error: "",
      includeIgnored,
      token,
    });
    bump();
    try {
      const listing = await opts.listDir(dir, includeIgnored);
      if (gen !== generation || cache.get(dir)?.token !== token) return;
      cache.set(dir, {
        status: "loaded",
        entries: listing.entries,
        truncated: listing.truncated,
        hasData: true,
        error: "",
        includeIgnored,
        token,
      });
      bump();
      // Restore persisted expansion below this directory, one level at a time.
      for (const e of listing.entries) {
        if (e.kind === "dir" && expanded.value.has(e.path) && !cache.has(e.path)) void load(e.path);
      }
    } catch (err) {
      if (gen !== generation || cache.get(dir)?.token !== token) return;
      const message = errorMessage(err);
      cache.set(dir, { status: "error", entries: [], truncated: false, hasData: false, error: message, includeIgnored, token });
      bump();
      if (dir === opts.root.value) {
        opts.onRootError?.(message);
      } else if (cache.has(parentOf(dir))) {
        // Most often the folder was deleted: re-listing its parent drops it.
        scheduleReload(parentOf(dir));
      }
    }
  }

  function scheduleReload(dir: string): void {
    pending.add(dir);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushReloads, debounceMs);
  }

  function flushReloads(): void {
    timer = null;
    const dirs = [...pending];
    pending.clear();
    for (const d of dirs) if (cache.has(d)) void load(d);
  }

  function onWatchEvent(ev: RepoChangeEvent): void {
    if (ev.truncated) {
      for (const d of cache.keys()) scheduleReload(d);
      return;
    }
    for (const raw of ev.paths) {
      const p = raw.replace(/\/+$/, "");
      const parent = parentOf(p);
      if (cache.has(parent)) scheduleReload(parent);
      if (cache.has(p)) scheduleReload(p);
    }
  }
  const unsubscribe = opts.watcher?.on(["worktree"], onWatchEvent) ?? null;

  // ── Root / repo changes ────────────────────────────────
  function resetCache(): void {
    generation++;
    cache.clear();
    pending.clear();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    bump();
  }

  watch(
    [() => opts.repoPath.value, () => opts.root.value],
    ([repo, root], old) => {
      const repoChanged = !old || old[0] !== repo;
      resetCache();
      if (repoChanged) {
        const p = repo ? readPersisted(repo) : null;
        expanded.value = new Set(p?.expanded ?? []);
        selected.value = p?.selected ?? null;
        showIgnored.value = p?.showIgnored ?? false;
      } else {
        expanded.value = new Set();
        selected.value = null;
      }
      if (repo) void load(root);
    },
    { immediate: true },
  );

  // Re-list whatever was listed with the other flag; expansion is kept.
  watch(showIgnored, (now) => {
    for (const [d, st] of cache) if (st.includeIgnored !== now) void load(d);
  });

  // ── Rows ───────────────────────────────────────────────
  function childrenOf(dir: string, entries: readonly RepoDirEntry[]): Child[] {
    const kids: Child[] = entries.map((e) => ({ name: e.name, path: e.path, isDir: e.kind === "dir", entry: e }));
    const del = deletedIndex.value.get(dir);
    if (!del) return kids;
    const present = new Set(entries.map((e) => e.name));
    let added = false;
    for (const n of del.dirs) {
      if (!present.has(n)) {
        kids.push({ name: n, path: joinPath(dir, n), isDir: true, entry: null });
        added = true;
      }
    }
    for (const n of del.files) {
      if (!present.has(n)) {
        kids.push({ name: n, path: joinPath(dir, n), isDir: false, entry: null });
        added = true;
      }
    }
    if (added) kids.sort(compareChildren);
    return kids;
  }

  function appendChildren(dir: string, depth: number, ghost: boolean, out: LazyTreeRow[]): void {
    const st = ghost ? undefined : cache.get(dir);
    if (!ghost) {
      if (!st || (st.status === "loading" && !st.hasData)) {
        out.push({ kind: "loading", path: dir, name: "", depth });
        return;
      }
      if (st.status === "error") {
        out.push({ kind: "error", path: dir, name: "", depth, message: st.error });
        return;
      }
    }
    for (const c of childrenOf(dir, st?.entries ?? [])) {
      const deleted = c.entry === null;
      if (c.isDir) {
        const isOpen = expanded.value.has(c.path);
        out.push({
          kind: "folder",
          path: c.path,
          name: c.name,
          depth,
          expanded: isOpen,
          ignored: c.entry?.ignored ?? false,
          deleted,
          badge: folderBadges.value.get(c.path) ?? null,
        });
        if (isOpen) appendChildren(c.path, depth + 1, deleted, out);
      } else {
        out.push({
          kind: "file",
          path: c.path,
          name: c.name,
          depth,
          ignored: c.entry?.ignored ?? false,
          symlink: c.entry?.kind === "symlink",
          deleted,
          size: c.entry?.size ?? 0,
          status: statusByPath.value.get(c.path) ?? null,
        });
      }
    }
    if (st?.truncated) out.push({ kind: "truncated", path: dir, name: "", depth });
  }

  const rows = computed<LazyTreeRow[]>(() => {
    void version.value;
    const out: LazyTreeRow[] = [];
    if (!opts.repoPath.value) return out;
    appendChildren(opts.root.value, 0, false, out);
    return out;
  });

  // ── Commands ───────────────────────────────────────────
  function isGhost(dir: string): boolean {
    return rows.value.some((r) => r.kind === "folder" && r.path === dir && r.deleted);
  }

  async function expand(dir: string): Promise<void> {
    if (!expanded.value.has(dir)) {
      const next = new Set(expanded.value);
      next.add(dir);
      expanded.value = next;
    }
    if (isGhost(dir)) return;
    const st = cache.get(dir);
    if (!st || st.status === "error") await load(dir);
  }

  function collapse(dir: string): void {
    if (!expanded.value.has(dir)) return;
    const next = new Set(expanded.value);
    next.delete(dir);
    expanded.value = next;
  }

  async function toggle(dir: string): Promise<void> {
    if (expanded.value.has(dir)) collapse(dir);
    else await expand(dir);
  }

  /** Expand every ancestor of `path` below the root, then select it. */
  async function reveal(path: string): Promise<void> {
    const root = opts.root.value;
    if (path === root) {
      selected.value = null;
      return;
    }
    if (root !== "" && !isUnder(path, root)) return;
    const chain: string[] = [];
    for (let d = parentOf(path); d !== root && d !== ""; d = parentOf(d)) chain.unshift(d);
    for (const d of chain) await expand(d);
    selected.value = path;
  }

  function changedUnder(dir: string): string[] {
    return [...statusByPath.value.keys()].filter((p) => isUnder(p, dir)).sort();
  }

  function dispose(): void {
    disposed = true;
    unsubscribe?.();
    generation++;
    if (timer) clearTimeout(timer);
    timer = null;
    pending.clear();
  }
  if (getCurrentScope()) onScopeDispose(dispose);

  return {
    rows,
    selected,
    showIgnored,
    statusByPath,
    isExpanded: (dir: string) => expanded.value.has(dir),
    expand,
    collapse,
    toggle,
    retry: (dir: string) => load(dir),
    reveal,
    folderBadge: (dir: string): FolderBadge | null => folderBadges.value.get(dir) ?? null,
    changedUnder,
    dispose,
  };
}

export type LazyRepoTree = ReturnType<typeof useLazyRepoTree>;
