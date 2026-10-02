# v3.11.2 Finder-like navigation: converge on the File Explorer panel

**Date:** 2026-10-02
**Amends:** `2026-10-01-finder-folder-navigation-design.md`. Everything in that spec stands unless this addendum changes it.
**Why:** after building the full-screen "Browse" view and testing it in the app, the user found it duplicates the File Explorer panel, which is better for daily use: it can edit, it has tabs and blame. Browse's real additions are the ignored-files toggle, the context menu (Finder / editor / copy path / scope), keyboard navigation and the inline diff of changed files. The decision (2026-10-02, user) is one surface: the panel gains those additions and the Browse view is removed.

---

## 1. Decisions

| Question | Decision |
|---|---|
| Surface | The File Explorer panel (`FileExplorerPanel.vue`) is the only file browser. The full-screen Browse view is removed. |
| Panel tree | Replaced by `FileTreePane` (virtualized, ARIA tree, `fileTreeKeymap`, context menu, Show ignored toggle). |
| Changed file | A tab on a changed file opens on its **diff** (DiffViewer, inline), with the Working tree \| Index switch when the file is both staged and modified. A **Diff \| File** toggle in the panel toolbar switches to the editor (edit, save, blame). An unchanged file opens in the editor, as today. |
| Dirty buffer | While the tab's editor buffer has unsaved changes, the Diff side of the toggle is disabled, with the tooltip "Save to see the diff". The diff always reflects the file on disk. |
| Context menu | File: Open in editor, Copy path, Reveal in Finder/Explorer/file manager. Folder: Scope here, Copy path, Reveal. Right click or ⇧F10 / context-menu key. |
| Keyboard | `fileTreeKeymap` as specified. Enter opens a preview tab (= single click today); pinning stays on double click. |
| Scope active | The panel's tree is rooted at the scope folder, with a "Whole repo" chip to clear it. Same fallback as before: if the scope folder is gone, the tree shows the whole repo with a notice; the scope is kept when the folder exists but failed to list (`pathExists`). |
| Conflicted file | The tab shows a banner with "Open in merge editor" (reuses `handleOpenResidual`), no diff. |
| Deleted file | Stays visible, struck through, not openable (as shipped in Task 12). |
| Persistence | The panel keeps `gitwand-explorer-tree:<repoPath>`. The `gitwand-files-view:` prefix is no longer used. |

## 2. Kept as built

- Rust `list_repo_dir` (libgit2 ignore classification, 5,000 cap) and `reveal_in_file_manager` (forge tokens stripped), with wrappers, registry entries, dev routes and parity.
- `useLazyRepoTree`, `fileTreeKeymap`, `revealLabel`.
- `useFilePreview`'s diff logic: `planPreview`, `decodeText`, `formatBytes`, the side switch, the request-id race guard, the stale-while-revalidate watcher reload. Its API may be trimmed to what the panel uses.
- The `getGitDiff` Tauri-path fix and the `useVirtualRows` fix.

## 3. Removed

- `FilesView.vue`, `FilePreviewPane.vue` and their tests.
- `ViewMode` `"files"`, `DockEntryId` `"files-view"` and `dockEntryViewMode()`, the AppDock entry/label/icon, `view-files` in the palette, `openFilesView` in `useAppMenu.ts`, App.vue's view branch and async import.
- The `dockHideFilesView` setting, from both `useSettings.ts` and `SettingsPanel.vue` (same commit). A stored value is simply ignored on load (settings merge over defaults).
- Locale keys no longer referenced, removed from all 5 locales.
- `normalizeDockOrder` must drop a stored `"files-view"` id (verify it does; add a test).

## 4. Errors and races

Unchanged from the base spec §8, applied to the panel: an inline error row with retry for a failed folder listing; a failed diff load shows an inline error with retry in the tab; responses for an earlier tab or side are dropped; a watcher reload of the open file keeps the current body until the response arrives. If the open file is deleted on disk, the tab shows "Deleted from disk".

## 5. Testing

- Keep the `FileTreePane`, `useLazyRepoTree`, `fileTreeKeymap` and `useFilePreview` tests (trim only what tests removed API).
- Panel tests: a changed file opens on the diff; the Diff \| File toggle switches to the editor and back; the Diff side is disabled with a dirty buffer; an unchanged file opens in the editor; Working tree \| Index for a staged+modified file; conflicted banner; context menu actions (reveal, open in editor, copy path, scope here → `setScope`); Show ignored; scope rooting and the "Whole repo" chip; scope-gone fallback.
- Settings/dock: `"files-view"` dropped by `normalizeDockOrder`; no `dockHideFilesView` left in either settings file.
- The source-level wiring test is rewritten for the panel's props and handlers in App.vue (watcher, open-in-editor, open-merge-editor, file history).
- Manual QA: `dev:web` and the debug app — reveal, watcher, keyboard, diff toggle, dirty-buffer guard.

## 6. Docs

CHANGELOG `[Unreleased]`: the `Added` entry describes the File Explorer panel's new capabilities, not a Browse view; the `Changed` entry for the panel's lazy tree stays. The website guide's section is rewritten around the panel. ROADMAP follow-ups: drop those that only applied to the Browse view; keep editing/staging/file operations/tree-wide search/no-watcher refresh as relevant to the panel.

## 7. Not in scope

Unchanged from the base spec §10, minus "editing in the view" (the panel already edits).
