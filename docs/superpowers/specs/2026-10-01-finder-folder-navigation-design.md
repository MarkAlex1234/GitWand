# v3.11.2 Finder-like folder navigation: design

**Date:** 2026-10-01
**Roadmap:** `ROADMAP.md` § "v3.11.2 — Finder-like folder navigation"
**Out of scope:** editing, staging, file operations, tree-wide search. See §10.

---

## 1. What exists today

The roadmap frames this feature against `FolderDiffTree`. The code tells a different story:

- **`FolderDiffTree.vue` is dead code.** Nothing imports it or calls `folderDiff()` (`src/utils/backend.ts:315`). What is worth keeping from it is its keyboard model (`FolderDiffTree.vue:120-210`): a cursor index into the row array, ←/→ to collapse/expand or move to the parent/first child, and `role="tree"`.
- **A working-tree explorer already exists:** `FileExplorerPanel.vue` (v3.2.0). It is a dockable panel (floating/bottom/fullscreen) with the full repo tree, status dots and CodeMirror tabs with a Lock/Edit toggle. Its model is `useRepoFileTree.ts`. It has no keyboard navigation, no virtualization, no diff, no watcher refresh (`FileExplorerPanel.vue:33` reloads only when `repoPath` changes) and no context menu.
- **`list_repo_tree`** (`src-tauri/src/commands/files.rs:370`) is a one-shot `git ls-files --cached --others --exclude-standard`. It is capped at 20,000 entries and never returns ignored files.
- **No command lists one directory of the working tree.** `list_dir` is the absolute-path FolderPicker browser, which does not use `safe_repo_path` and is not git-aware.
- **Diffs are not CodeMirror.** `DiffViewer.vue` is a custom table, and `@codemirror/merge` is not installed. CodeMirror (`CodeEditor.vue`, `useCodeMirror.ts`) renders file contents.
- **Scope filters status.** With a scope active, `repoFiles` (`useGitRepo.ts:92`) only covers the scope, so badges outside it would be missing. No "Scope here" entry point exists; setting a scope is `useWorkspaceScope().setScope(path)`.

## 2. Scope

**In scope.** A full-screen "Files" view: a lazy, keyboard-operable, virtualized working-tree tree on the left with per-file and per-folder status badges, and a read-only preview on the right (content for unchanged files, inline diff for changed ones). It includes an optional display of ignored files, live refresh from the Live Repo watcher, and a context menu with "Scope here". The tree model is a new composable that the existing `FileExplorerPanel` can adopt.

**Not in scope.** See §10.

## 3. Decisions

| Question | Decision |
|---|---|
| Primary job | Explore the repository, Finder-style. Badges are landmarks, not the focus. |
| Editing | Read-only. "Open in editor" hands off to the external editor. |
| Ignored files | Hidden by default. A "Show ignored" toggle shows them greyed out, loaded per folder. |
| Relation to `FileExplorerPanel` | Approach A: new view, shared tree model. The panel stays. |
| Tabs | None. One preview, as in the Finder. Tabs remain the panel's. |
| Scope active | The tree is rooted at the scope folder, with a breadcrumb and "Whole repo" to clear it. Badges stay consistent with the scoped status. |
| Diff of a file both staged and modified | A "Working tree \| Index" switch, defaulting to working tree, mirroring the Changes view. No new HEAD-vs-worktree command. |

## 4. Backend: `list_repo_dir` and `reveal_in_file_manager`

```rust
#[tauri::command]
fn list_repo_dir(cwd: String, dir: String, include_ignored: bool) -> Result<RepoDirListing, String>
// RepoDirListing { entries: Vec<RepoDirEntry>, truncated: bool }
// RepoDirEntry   { name, path /* repo-relative */, kind: "file" | "dir" | "symlink", ignored: bool }
```

- `dir` is repo-relative (`""` for the root) and resolved through `safe_repo_path`. A path escaping the repo is refused.
- **One level only:** `std::fs::read_dir` on the resolved directory. `.git` is always skipped. Symlinks are reported as `symlink` and not followed.
- **Ignore classification, in process with libgit2** (`git2` 0.20, already a dependency). An entry is ignored when `repo.is_path_ignored(rel)` is true **and** it is not tracked: for a file, `index.get_path(rel, 0)` is `None`; for a directory, `index.find_prefix("<rel>/")` finds nothing. `is_path_ignored` applies the rules regardless of the index, so without this check a force-added file would show as ignored. The repo and its index are opened once per call. Verified on 2026-10-01 against `git check-ignore`, with the same results:
  - ignored: `node_modules`, `debug.log`, and an untracked file inside an ignored directory;
  - not ignored: a tracked file inside an ignored directory, and an ignored directory that contains tracked files (`build/` holding a force-added file).
- `include_ignored = false` drops ignored entries; `true` keeps them with `ignored: true`.
- Sorted directories first, then case-insensitive by name.
- **Cap: 5,000 entries per directory**, then `truncated: true`. This keeps the IPC payload well under 1 MB (`apps/desktop/CLAUDE.md`).
- **Measured on 2026-10-01** on a shallow clone of `microsoft/vscode` (19,736 tracked files) with an added 3,000-package `node_modules` and a 6,000-file flat directory (git 2.50.1, Apple Silicon, `read_dir` + classification, median of 7):

| Directory | Entries | libgit2 | `git check-ignore --stdin` | `git ls-files --others --ignored --directory` |
|---|---|---|---|---|
| root | 44 | 0.5 ms | ~145 ms | 440 ms |
| `src/vs/workbench/contrib` | 100 | 2.0 ms | ~93 ms | 117 ms |
| a 728-file generated dir | 728 | 25 ms | ~219 ms | n/m |
| `node_modules` (all ignored) | 3,000 | 37 ms | ~818 ms | 49 ms |
| flat `big/` | 6,000 | 66 ms | ~1,630 ms | 59 ms |

  `check-ignore` costs ~0.27 ms per path, and `ls-files` walks every non-ignored subdirectory (the whole repo from the root). Neither is acceptable on the expand path. `git ls-files --cached` is not used either: limited to a directory, it still lists every tracked file below it recursively.
- Wiring: wrapper in `backend.ts`, entry in `commandRegistry.ts`, route in `dev-server.mjs` (which has no libgit2: `read_dir` + one `git check-ignore -z --stdin` call, slow but dev-only, with the same results as verified above), and parity coverage in `tests/parity/`.
- `list_repo_tree` is not changed.

**A second command, `reveal_in_file_manager(cwd, path)`.** Nothing reveals a file in the OS file manager today: `openInEditor` exists (`backend.ts:1503`), but `tauri-plugin-opener` is not installed. The command resolves `path` through `safe_repo_path`, then spawns, with args as an array:
- macOS: `open -R <abs>`;
- Windows: `explorer /select,<abs>`;
- Linux: `xdg-open <parent dir>` (no portable "select" exists).

It gets a dev-server route that logs and does nothing, in the same way as `openInEditor`'s dev fallback, and a registry entry giving the reason it cannot be exercised for real in `dev:web`. It has no parity test, because it has no output.

## 5. Tree model: `useLazyRepoTree`

`src/composables/useLazyRepoTree.ts`, used as `useLazyRepoTree({ repoPath, root, repoFiles, showIgnored, watcher })`.

- **Cache:** `Map<dir, { state: "idle" | "loading" | "loaded" | "error", entries, truncated, error? }>`. A directory is listed when it is first expanded. The root is listed on mount.
- **Expansion state:** `Set<dir>`.
- **Output:** `rows: TreeRow[]` (the type from `useFileTree.ts`), flattened from the expanded directories. Placeholder rows cover "loading", "error" (retry) and "N more entries not shown" (truncated).
- **Deleted files:** tracked files deleted on disk are missing from `read_dir`. They are merged into their parent directory's rows from `repoFiles` (`status: "deleted"`) and shown struck through.
- **Badges:** `statusByPath` comes from `repoFiles`. `folderBadge(dir)` comes from one pass over `repoFiles` that marks every ancestor of a changed path, memoized on the `repoFiles` value. Folder badges are therefore right even for collapsed and never-loaded folders.
- **Root:** `root` is `""` or the active scope. Changing it resets the cache and the expansion state.
- **Watcher:** the composable subscribes to `["worktree"]`. Every loaded directory that is a parent of an event path is reloaded, after a 300 ms debounce. A `truncated` event reloads every loaded directory. It unsubscribes on unmount.
- **Persistence:** expanded folders, selection and `showIgnored` are saved per repo in `localStorage` under `gitwand-files-view:<repoPath>`. Every access is wrapped in try/catch and the view works without storage.

## 6. Keyboard: `fileTreeKeymap.ts`

A pure resolver, `resolveFileTreeShortcut(e, ctx) → action | null`, in the style of `usePrReviewKeymap.ts`. The view owns the listener, and `isEditableTarget` guards it.

| Key | Action |
|---|---|
| ↑ / ↓ | Previous / next row |
| → | Expand a folder; on an expanded folder, go to its first child |
| ← | Collapse a folder; otherwise go to the parent |
| Enter | Open the file (preview) or toggle the folder; on an error row, retry |
| Home / End | First / last row |
| Printable characters | Type-ahead: jump to the next visible row whose name starts with the typed prefix (reset after 700 ms) |
| ⇧F10 / context-menu key | Open the context menu on the current row |

The tree is `role="tree"`, rows are `role="treeitem"` with `aria-expanded`, `aria-level` and `aria-selected`, and a single tab stop uses `aria-activedescendant`.

## 7. View

**Integration.** `ViewMode` gains `"files"`. `DockEntryId` gains `"files-view"`, which goes through `DEFAULT_DOCK_ORDER`, `normalizeDockOrder` and the hidden-entry settings. Any settings field is added to both `useSettings.ts` and `SettingsPanel.vue`. The view also gets a `view-files` case in the palette (`App.vue:2103`) and in the native menu (`useAppMenu.ts`). It is loaded with `defineAsyncComponent`. The existing Files tile, which opens the panel, is kept.

**`FilesView.vue`** (layout, scope breadcrumb, split pane) contains:

- **`FileTreePane.vue`:** the virtualized tree (`useVirtualRows`), the "Show ignored" toggle and the context menu (component-local, following the existing `ctxMenu` pattern).
  - Context menu on a folder: Scope here, Copy path, Reveal in Finder/Explorer.
  - Context menu on a file: Open in editor, Copy path, Reveal.
- **`FilePreviewPane.vue`:** a header (path whose segments select the folder in the tree, status badge, Open in editor, Reveal) and a body chosen by status:

| Selection | Body |
|---|---|
| Unchanged file | `CodeEditor` `readonly`, content from `readFileAtRevision(cwd, "", path)` |
| Modified, unstaged | `DiffViewer` inline, not `editable`, from `getGitDiff(cwd, path, false)` |
| Staged only | `DiffViewer` from `getGitDiff(cwd, path, true)` |
| Staged and modified | The same, with the Working tree \| Index switch |
| Untracked | `getGitDiff` (it already falls back to `--no-index`) |
| Deleted | The deletion diff |
| Conflicted | A banner with "Open in merge editor". No diff. |
| Binary, non-UTF-8, or diff over 5 MB | A placeholder with the size and Open in editor |
| Folder | A summary: the count of changed files below, and their flat clickable list |

All UI strings are added to the five locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`) with the `i18n-sync` skill.

## 8. Errors and races

- **A directory listing fails:** an error row appears under that folder (tooltip, Enter to retry). The rest of the tree keeps working, and no global toast is shown.
- **The scope root disappears:** the tree falls back to the whole repo, with a notice.
- **A preview load fails:** an inline error with retry. An empty body is never shown in place of an error.
- **Selection race:** every preview load carries a request id, and a response for an earlier selection is dropped.
- **The previewed file changes on disk:** the preview reloads through the watcher. If the file is deleted, the preview shows "Deleted from disk" rather than stale content.

## 9. Testing

All tests use real temporary git repos, with no mock of the git layer.

- **Rust `list_repo_dir`:** tracked files; untracked files; ignored files with and without `include_ignored`; an ignored directory containing a tracked file; a nested repo or submodule; a symlink; `.git` skipped; the 5,000 cap with `truncated`; `..` refused through `safe_repo_path`.
- **Parity:** `list_repo_dir` Rust vs `dev-server.mjs` on a fixture repo.
- **`useLazyRepoTree` (vitest):** lazy loading; expand and collapse; deleted files merged in; folder badges on unloaded folders; targeted reload on a watcher event; full reload on `truncated`; re-rooting on scope; persistence with storage throwing.
- **`fileTreeKeymap`:** a unit test per key, type-ahead, and the editable-target guard.
- **Components:** the preview body for each row of the §7 table, the selection race, "Scope here" calling `setScope`, and the tree's ARIA attributes.
- **Manual QA:** `dev:web`, then the Tauri app for Reveal, the native menu and the watcher, which the dev-server does not cover.

## 10. Not in scope (to add to the roadmap as follow-ups)

- Editing in the view.
- Stage/unstage from the view.
- File operations (rename, delete, create).
- Tree-wide name search, beyond type-ahead in the visible rows.
- Moving `FileExplorerPanel` onto `useLazyRepoTree`, which lifts its 20,000-entry cap and gives it live refresh. It is done in this release if the plan has room, otherwise it becomes a follow-up.
