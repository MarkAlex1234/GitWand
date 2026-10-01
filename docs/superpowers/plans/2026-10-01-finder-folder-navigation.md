# v3.11.2 Finder-like folder navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-screen "Files" view (dock label "Browse") that browses the working tree like the Finder. On the left is a lazy, virtualized, keyboard-operable folder tree with per-file and per-folder status badges, an optional display of ignored files, live refresh and a context menu with "Scope here". On the right is a read-only preview: file content when unchanged, an inline diff when changed.

**Architecture:** A new Rust command, `list_repo_dir`, lists one directory per call. It classifies ignored entries in process with libgit2: an entry is ignored when `is_path_ignored` is true and the index does not track it. The command has a matching dev-server route and parity coverage. A second command, `reveal_in_file_manager`, hands a path to the OS file manager. On the frontend, three pure modules hold the logic:
- `useLazyRepoTree` (tree model, injected lister and watcher);
- `fileTreeKeymap` (keyboard resolver);
- `useFilePreview` (what to show for a selection, with a request-id race guard).

Three thin components render them: `FileTreePane`, `FilePreviewPane` and `FilesView`. `FilesView` is lazy-loaded behind a new `ViewMode` `"files"` and a new dock entry, `"files-view"`.

**Tech Stack:** Rust (Tauri 2, `git2` 0.20 already in `Cargo.toml`), TypeScript, Vue 3 `<script setup>`, `@tanstack/vue-virtual` through `useVirtualRows`, Vitest (node by default, jsdom per file), the Node `dev-server.mjs`, and the parity harness in `apps/desktop/tests/parity/`.

**Spec:** docs/superpowers/specs/2026-10-01-finder-folder-navigation-design.md

## Global Constraints

- Every filesystem path from the frontend goes through `safe_repo_path()` (`apps/desktop/src-tauri/src/git/cmd.rs:73`) in Rust and through `safeRepoPath()` (`apps/desktop/dev-server.mjs:42`) in the dev-server. Never inline your own path validation.
- Pass git and process arguments as discrete arrays (`.arg()` / `.args([...])`, `execFileSync`/`spawnSync` arrays). Never build a command string by interpolation.
- Every new `#[tauri::command]` gets, in the same task, a typed wrapper in `apps/desktop/src/utils/backend.ts`, an entry in `apps/desktop/src/utils/commandRegistry.ts` and a route in `apps/desktop/dev-server.mjs`. Never call `invoke()` from a component or composable, and always pass the command name to `tauriInvoke` as a string literal.
- `list_repo_dir` caps each directory at **5,000 entries**, then sets `truncated: true`.
- Watcher-driven reloads use a **300 ms** trailing debounce.
- Type-ahead resets after **700 ms**.
- Tree state persists in `localStorage` under the key **`gitwand-files-view:<repoPath>`**. Every access is wrapped in `try/catch`, and the view works without storage.
- Every user-visible string needs a key in all **5 locales**: `en`, `fr`, `es`, `pt-BR`, `zh-CN` (`apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`). Prefer the `i18n-sync` skill. Every task below also gives the exact strings.
- A new settings field goes into **both** `apps/desktop/src/composables/useSettings.ts` (`AppSettings` + `defaultAppSettings`) **and** `apps/desktop/src/components/SettingsPanel.vue` (`Settings` + defaults), in the same commit.
- Load `FilesView` with `defineAsyncComponent(() => import(...))` in `App.vue`.
- No `{ deep: true }` watcher anywhere. Watch primitives, computed strings or array identities.
- Tests needing git use **real temporary git repos**. Never mock the git layer. The only stand-ins allowed are the IPC wrapper (`utils/backend`, as 60+ existing component tests already do), injected `listDir` / loader functions for pure logic, and `@tanstack/vue-virtual` (jsdom has no layout). Listing correctness itself is pinned by the Rust tests on real repos and by the parity test.
- Run `cargo fmt` (then `cargo clippy --all-targets -- -D warnings`) from `apps/desktop/src-tauri` before committing any Rust.
- New components use `<script setup lang="ts">` only.
- The preview is **read-only**: no editing, staging or file operations anywhere in this view.
- Never hand-edit a version field (`package.json`, `Cargo.toml`, `tauri.conf.json`). Use `pnpm` only.
- Do not touch the user's uncommitted WIP: `benchmark/corpus.json`, `benchmark/results/v3.11.1-corpus3-baseline.json` and `.github/workflows/benchmark-gate.yml`. Always `git add` named files, never `git add -A` or `git add .`.
- The desktop type-check needs `packages/core/dist`. Run `pnpm --filter @gitwand/core build` before `vue-tsc`.

## Review Focus

These are the five failure modes most likely to bite a user that the tasks' main-path tests would not catch on their own. Each one is pinned by a named test in the task that owns it.

1. **A repo path or an entry name with spaces, non-ASCII or non-UTF-8 bytes.** A name that cannot round-trip through IPC as a string would produce a path nothing can open.
   - Task 1, `names_with_spaces_and_unicode_round_trip`: the repo directory itself is named `… space é …`.
   - Task 1, `names_that_are_not_utf8_are_skipped`: Linux only, because APFS refuses such names.
   - Task 2, parity fixture `fixtureListRepoDir()`: its repo path contains `list dir é`, and it holds `café.txt` and `docs/guide one.md`.
2. **A folder deleted while it is expanded.** Its reload fails, and the tree must drop it rather than keep a stale or error row forever.
   - Task 5, "drops a folder deleted while expanded: its own reload fails, so its parent is reloaded".
   - Task 1, `a_missing_directory_or_a_file_is_reported_plainly`.
3. **The scope is set to a folder that is then deleted.** The tree must fall back to the whole repo with a notice. It must not show an empty tree, and it must not clear the scope when the folder merely failed to list.
   - Task 5, "reports a root that cannot be listed".
   - Task 10, "falls back to the whole repo when the scope folder is gone" and "keeps the scope when its folder exists but cannot be listed".
4. **A symlink pointing outside the repo.** It must never be listed through, previewed through or revealed through.
   - Task 1, `symlinks_are_reported_and_never_followed`.
   - Task 3, `reveal_target_refuses_paths_outside_the_repo`.
   - Task 8, "never reads through an unchanged symlink, which may point outside the repo".
5. **Switching repos (or selections) while a request is in flight.** A late response must not paint repo A's tree into repo B, or file A's content into file B's preview.
   - Task 5, "drops a listing that resolves after a repo switch".
   - Task 8, "drops a response for an earlier selection".

---

## File Structure

| File | Status | Single responsibility |
|---|---|---|
| `apps/desktop/src-tauri/src/types.rs` | modify | `RepoDirEntry`, `RepoDirListing` (camelCase serde) |
| `apps/desktop/src-tauri/src/commands/files.rs` | modify | `MAX_REPO_DIR_ENTRIES`, `build_repo_dir_listing`, `is_ignored_untracked`, `list_repo_dir` command, its tests. `TempRepo` helper made `pub(super)` |
| `apps/desktop/src-tauri/src/commands/ops.rs` | modify | `reveal_target`, `reveal_in_file_manager` command (next to `open_url`/`open_in_editor`, to reuse `try_open_linux`), its tests |
| `apps/desktop/src-tauri/src/lib.rs` | modify | register both commands; `list_repo_dir_parity` entry point |
| `apps/desktop/src-tauri/examples/parity_probe.rs` | modify | `list-repo-dir` arm |
| `apps/desktop/dev-server.mjs` | modify | `devListRepoDir()`, `/api/list-repo-dir`, `/api/reveal-in-file-manager` |
| `apps/desktop/src/utils/backend.ts` | modify | `RepoDirEntry`, `RepoDirListing`, `listRepoDir`, `revealInFileManager`; `getGitDiff` forwards the optional fields on the Tauri path |
| `apps/desktop/src/utils/commandRegistry.ts` | modify | `list_repo_dir`, `reveal_in_file_manager` entries |
| `apps/desktop/src/utils/__tests__/backend-files-view.test.ts` | create | wrapper tests for `listRepoDir`, `revealInFileManager`, `getGitDiff` field forwarding |
| `apps/desktop/tests/parity/fixtures.mjs` | modify | `fixtureListRepoDir()` |
| `apps/desktop/tests/parity/list-repo-dir.test.mjs` | create | Rust vs dev-server parity for `list_repo_dir` |
| `apps/desktop/src/composables/fileTreeKeymap.ts` | create | pure `resolveFileTreeShortcut` |
| `apps/desktop/src/composables/__tests__/fileTreeKeymap.test.ts` | create | one test per key, type-ahead, editable guard |
| `apps/desktop/src/composables/useLazyRepoTree.ts` | create | lazy tree model: cache, expansion, rows, badges, deleted merge, watcher, persistence |
| `apps/desktop/src/composables/__tests__/useLazyRepoTree.test.ts` | create | model tests with an injected lister and watcher |
| `apps/desktop/src/utils/revealLabel.ts` | create | `revealLabelKey()`: Finder / Explorer / file-manager wording per platform |
| `apps/desktop/src/utils/__tests__/revealLabel.test.ts` | create | platform → key |
| `apps/desktop/src/components/FileTreePane.vue` | create | virtualized tree, ARIA, keyboard dispatch, Show ignored toggle, context menu |
| `apps/desktop/src/components/__tests__/FileTreePane.test.ts` | create | ARIA, keys, menus, emits |
| `apps/desktop/src/composables/useFilePreview.ts` | create | `planPreview`, `decodeText`, `formatBytes`, `useFilePreview` (race guard, side switch, watcher reload) |
| `apps/desktop/src/composables/__tests__/useFilePreview.test.ts` | create | §7 table, decoding, race, watcher |
| `apps/desktop/src/components/FilePreviewPane.vue` | create | preview header (path crumbs, badge, side switch, actions) and body by kind |
| `apps/desktop/src/components/__tests__/FilePreviewPane.test.ts` | create | body per §7 row, error + retry, switch |
| `apps/desktop/src/components/FilesView.vue` | create | scope breadcrumb, split layout, wiring to scope, clipboard, reveal, App hand-offs |
| `apps/desktop/src/components/__tests__/FilesView.test.ts` | create | Scope here → `setScope`, scope-gone fallback, reveal failure, selection → preview |
| `apps/desktop/src/composables/useGitRepo.ts` | modify | `ViewMode` gains `"files"` |
| `apps/desktop/src/composables/useSettings.ts` | modify | `DockEntryId` `"files-view"`, `DEFAULT_DOCK_ORDER`, `isDockEntryHidden`, `dockEntryViewMode`, `dockHideFilesView` |
| `apps/desktop/src/components/SettingsPanel.vue` | modify | `dockHideFilesView` in `Settings` + defaults + checkbox; dock label |
| `apps/desktop/src/components/AppDock.vue` | modify | label, icon, active state, removal, startup exclusion for `"files-view"` |
| `apps/desktop/src/composables/useAppMenu.ts` | modify | `openFilesView` action + View menu item |
| `apps/desktop/src/App.vue` | modify | async `FilesView`, view branch, palette `view-files`, menu action, startup-view mapping |
| `apps/desktop/src/composables/__tests__/useSettings-filesView.test.ts` | create | dock order, hidden flag, view mapping, locale keys |
| `apps/desktop/src/__tests__/filesView-wiring.test.ts` | create | source-level pin of the App.vue call sites |
| `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` | modify | `filesView.*`, `header.paletteViewFiles`, `menu.openFilesView`, `settings.dock.itemFilesView` / `showFilesView` |
| `CHANGELOG.md`, `ROADMAP.md`, `website/guide/desktop.md` | modify | Unreleased entries, follow-ups, user docs |
| `apps/desktop/src/components/FileExplorerPanel.vue` | modify (optional Task 12) | panel tree on `useLazyRepoTree` |
| `apps/desktop/src/composables/useRepoFileTree.ts` + its test | delete (optional Task 12) | superseded |

**Order, and why it differs from the suggested one.** The tasks follow the suggested order, with three changes.
- **A `getGitDiff` fix comes before the preview (Task 7).** The Tauri branch of `getGitDiff` drops every optional field the Rust command sends, including `truncatedFromBytes`, and the "diff over 5 MB" row of §7 is unreachable without that field. The fix is independent and testable on its own, so it gets its own reviewer gate.
- **The preview is split into logic (Task 8) and rendering (Task 9),** because the logic carries the race guard that Review Focus #5 depends on.
- **Docs (Task 11) come before the optional panel migration (Task 12),** so Task 12 can be dropped without leaving the docs wrong. Task 12 updates the docs it changes itself.

---

### Task 1: Rust `list_repo_dir` with libgit2 ignore classification

**Files:**
- Modify: `apps/desktop/src-tauri/src/types.rs:195` (after `RepoTreeResult`, before `// ─── Directory listing types`)
- Modify: `apps/desktop/src-tauri/src/commands/files.rs:1-14` (module doc), `:367-372` (after `list_repo_tree`), `:374-433` (`TempRepo` visibility), append a test module after `:476`
- Modify: `apps/desktop/src-tauri/src/lib.rs:732` (`generate_handler!`)
- Test: `apps/desktop/src-tauri/src/commands/files.rs` (`mod list_repo_dir_tests`)

**Interfaces:**
- Consumes: `safe_repo_path(cwd: &str, rel_path: &str) -> Result<PathBuf, String>` (`git/cmd.rs:73`; refuses an empty `rel_path`, so the root is resolved as `"."`), `git2::Repository::open`, `Repository::is_path_ignored`, `Index::get_path(&Path, i32) -> Option<IndexEntry>`, `Index::find_prefix(&str) -> Result<usize, Error>` (`Err` = `GIT_ENOTFOUND`, verified in libgit2-sys 0.18.5 `index.c:1766`).
- Produces:
  ```rust
  pub struct RepoDirEntry { pub name: String, pub path: String, pub kind: String /* "file" | "dir" | "symlink" */, pub ignored: bool, pub size: u64 }
  pub struct RepoDirListing { pub entries: Vec<RepoDirEntry>, pub truncated: bool }
  pub(crate) const MAX_REPO_DIR_ENTRIES: usize = 5_000;
  fn build_repo_dir_listing(cwd: &str, dir: &str, include_ignored: bool) -> Result<RepoDirListing, String>;
  #[tauri::command] pub(crate) async fn list_repo_dir(cwd: String, dir: String, include_ignored: bool) -> Result<RepoDirListing, String>;
  ```
  Error strings that later tasks rely on (they are pinned at parity in Task 2): `"Directory not found: <dir>"`, `"Not a directory: <dir>"`, `"Refusing to list inside .git: <dir>"`, plus `safe_repo_path`'s own `"path escapes cwd (…)"`.

- [ ] **Step 1: Make the existing `TempRepo` test helper reusable by a sibling test module**

In `apps/desktop/src-tauri/src/commands/files.rs`, inside `mod list_repo_tree_tests`, change only the visibility, nothing else:

```rust
    pub(super) struct TempRepo {
        pub(super) path: PathBuf,
    }
```

Also prefix the four helper methods with `pub(super)`: `pub(super) fn new(label: &str) -> Self`, `pub(super) fn cwd(&self) -> String`, `pub(super) fn write(&self, rel: &str, content: &str)`, and `pub(super) fn git(&self, args: &[&str])`.

- [ ] **Step 2: Write the failing tests**

Append to `apps/desktop/src-tauri/src/commands/files.rs`:

```rust
#[cfg(test)]
mod list_repo_dir_tests {
    use super::list_repo_tree_tests::TempRepo;
    use super::*;
    use crate::types::{RepoDirEntry, RepoDirListing};

    /// A repo whose ignore rules come only from its own `.gitignore`: the
    /// developer's global excludes file must not leak into the assertions.
    /// The path does not need to exist; git and libgit2 skip a missing one.
    fn hermetic(label: &str) -> TempRepo {
        let repo = TempRepo::new(label);
        let none = repo.path.join(".git").join("no-global-excludes");
        repo.git(&["config", "core.excludesFile", &none.to_string_lossy()]);
        repo
    }

    fn names(l: &RepoDirListing) -> Vec<&str> {
        l.entries.iter().map(|e| e.name.as_str()).collect()
    }

    fn entry<'a>(l: &'a RepoDirListing, name: &str) -> &'a RepoDirEntry {
        l.entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("no entry {name} in {:?}", names(l)))
    }

    #[test]
    fn lists_one_level_sorted_dirs_first_case_insensitively() {
        let repo = hermetic("sort");
        repo.write("src/main.rs", "fn main() {}");
        repo.write("alpha.md", "a");
        repo.write("Beta.txt", "b");
        repo.write("zeta.txt", "z");
        repo.write("Docs/readme.md", "d");
        repo.git(&["add", "alpha.md", "src/main.rs"]);
        repo.git(&["commit", "-q", "-m", "init"]);

        let l = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(
            names(&l),
            vec!["Docs", "src", "alpha.md", "Beta.txt", "zeta.txt"]
        );
        assert!(!l.truncated);
        let src = entry(&l, "src");
        assert_eq!((src.kind.as_str(), src.path.as_str(), src.size), ("dir", "src", 0));
        let alpha = entry(&l, "alpha.md");
        assert_eq!((alpha.kind.as_str(), alpha.size, alpha.ignored), ("file", 1, false));
        // Untracked and not ignored.
        assert!(!entry(&l, "Beta.txt").ignored);
        // One level only: nothing from inside src/ or Docs/.
        assert!(l.entries.iter().all(|e| !e.path.contains('/')));
    }

    #[test]
    fn lists_a_subdirectory_with_repo_relative_paths() {
        let repo = hermetic("subdir");
        repo.write("src/lib/a.rs", "");
        repo.write("src/b.rs", "");
        let l = build_repo_dir_listing(&repo.cwd(), "src", false).unwrap();
        assert_eq!(names(&l), vec!["lib", "b.rs"]);
        assert_eq!(entry(&l, "lib").path, "src/lib");
        assert_eq!(entry(&l, "b.rs").path, "src/b.rs");
        // A trailing slash names the same directory.
        let slashed = build_repo_dir_listing(&repo.cwd(), "src/", false).unwrap();
        assert_eq!(slashed.entries, l.entries);
    }

    #[test]
    fn ignored_entries_are_dropped_unless_requested() {
        let repo = hermetic("ignored");
        repo.write(".gitignore", "node_modules/\n*.log\n");
        repo.write("node_modules/pkg/index.js", "");
        repo.write("debug.log", "x");
        repo.write("notes.txt", "n");
        repo.git(&["add", ".gitignore"]);
        repo.git(&["commit", "-q", "-m", "ignore"]);

        let hidden = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(names(&hidden), vec![".gitignore", "notes.txt"]);

        let shown = build_repo_dir_listing(&repo.cwd(), "", true).unwrap();
        assert_eq!(
            names(&shown),
            vec!["node_modules", ".gitignore", "debug.log", "notes.txt"]
        );
        assert!(entry(&shown, "node_modules").ignored);
        assert!(entry(&shown, "debug.log").ignored);
        assert!(!entry(&shown, "notes.txt").ignored);

        // Inside an ignored directory every untracked entry is ignored.
        let inside = build_repo_dir_listing(&repo.cwd(), "node_modules", true).unwrap();
        assert_eq!(names(&inside), vec!["pkg"]);
        assert!(entry(&inside, "pkg").ignored);
        assert!(build_repo_dir_listing(&repo.cwd(), "node_modules", false)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn tracked_paths_under_ignore_rules_are_not_ignored() {
        let repo = hermetic("tracked-ignored");
        // Committed before the rule exists: a build output checked in on purpose.
        repo.write("build/keep.txt", "k");
        repo.git(&["add", "build/keep.txt"]);
        repo.git(&["commit", "-q", "-m", "keep"]);
        repo.write(".gitignore", "build/\n*.log\n");
        repo.write("build/out.bin", "o");
        repo.write("forced.log", "f");
        repo.git(&["add", ".gitignore"]);
        repo.git(&["add", "-f", "forced.log"]);
        repo.git(&["commit", "-q", "-m", "rules"]);

        let root = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert!(
            !entry(&root, "build").ignored,
            "a directory holding a tracked file is not ignored"
        );
        assert!(
            !entry(&root, "forced.log").ignored,
            "a force-added file is not ignored"
        );

        let build = build_repo_dir_listing(&repo.cwd(), "build", true).unwrap();
        assert!(!entry(&build, "keep.txt").ignored);
        assert!(entry(&build, "out.bin").ignored);
        assert_eq!(
            names(&build_repo_dir_listing(&repo.cwd(), "build", false).unwrap()),
            vec!["keep.txt"]
        );
    }

    #[test]
    fn git_dir_is_never_listed() {
        let repo = hermetic("gitdir");
        repo.write("a.txt", "");
        let root = build_repo_dir_listing(&repo.cwd(), "", true).unwrap();
        assert!(!names(&root).contains(&".git"));
        assert_eq!(
            build_repo_dir_listing(&repo.cwd(), ".git", true).unwrap_err(),
            "Refusing to list inside .git: .git"
        );
        let err = build_repo_dir_listing(&repo.cwd(), ".git/refs", true).unwrap_err();
        assert!(err.starts_with("Refusing to list inside .git"), "{err}");
    }

    #[test]
    fn a_nested_repository_is_a_plain_directory_whose_git_dir_is_skipped() {
        let repo = hermetic("nested");
        repo.write("nested/inner.txt", "i");
        let status = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path.join("nested"))
            .status()
            .unwrap();
        assert!(status.success());

        let root = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        let nested = entry(&root, "nested");
        assert_eq!((nested.kind.as_str(), nested.ignored), ("dir", false));
        let inside = build_repo_dir_listing(&repo.cwd(), "nested", false).unwrap();
        assert_eq!(names(&inside), vec!["inner.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_reported_and_never_followed() {
        let repo = hermetic("symlink");
        repo.write("real/file.txt", "r");
        std::os::unix::fs::symlink(repo.path.join("real"), repo.path.join("link-in")).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), repo.path.join("link-out")).unwrap();

        let root = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(names(&root), vec!["real", "link-in", "link-out"]);
        for n in ["link-in", "link-out"] {
            let e = entry(&root, n);
            assert_eq!((e.kind.as_str(), e.size), ("symlink", 0), "{n}");
        }
        let err = build_repo_dir_listing(&repo.cwd(), "link-out", false).unwrap_err();
        assert!(err.contains("path escapes cwd"), "{err}");
    }

    #[test]
    fn caps_a_directory_at_5000_entries() {
        let repo = hermetic("cap");
        let big = repo.path.join("big");
        std::fs::create_dir_all(&big).unwrap();
        for i in 0..=MAX_REPO_DIR_ENTRIES {
            std::fs::write(big.join(format!("f{:05}.txt", i)), "").unwrap();
        }
        let l = build_repo_dir_listing(&repo.cwd(), "big", false).unwrap();
        assert!(l.truncated);
        assert_eq!(l.entries.len(), MAX_REPO_DIR_ENTRIES);
        assert_eq!(l.entries.last().unwrap().name, "f04999.txt");

        std::fs::remove_file(big.join("f05000.txt")).unwrap();
        let exact = build_repo_dir_listing(&repo.cwd(), "big", false).unwrap();
        assert!(!exact.truncated, "exactly 5,000 entries is not truncated");
        assert_eq!(exact.entries.len(), MAX_REPO_DIR_ENTRIES);
    }

    #[test]
    fn refuses_paths_that_escape_the_repo() {
        let repo = hermetic("escape");
        repo.write("src/a.rs", "");
        for dir in ["..", "../..", "src/../.."] {
            let err = build_repo_dir_listing(&repo.cwd(), dir, false).unwrap_err();
            assert!(err.contains("path escapes cwd"), "{dir}: {err}");
        }
    }

    #[test]
    fn a_missing_directory_or_a_file_is_reported_plainly() {
        let repo = hermetic("missing");
        repo.write("a.txt", "");
        assert_eq!(
            build_repo_dir_listing(&repo.cwd(), "gone", false).unwrap_err(),
            "Directory not found: gone"
        );
        assert_eq!(
            build_repo_dir_listing(&repo.cwd(), "a.txt", false).unwrap_err(),
            "Not a directory: a.txt"
        );
    }

    #[test]
    fn names_with_spaces_and_unicode_round_trip() {
        let repo = hermetic("space é");
        repo.write("docs/guide one.md", "g");
        repo.write("café.txt", "c");
        let root = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(names(&root), vec!["docs", "café.txt"]);
        let docs = build_repo_dir_listing(&repo.cwd(), "docs", false).unwrap();
        assert_eq!(entry(&docs, "guide one.md").path, "docs/guide one.md");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn names_that_are_not_utf8_are_skipped() {
        use std::os::unix::ffi::OsStrExt;
        let repo = hermetic("non-utf8");
        repo.write("ok.txt", "");
        let bad = std::ffi::OsStr::from_bytes(b"bad\xff.txt");
        std::fs::write(repo.path.join(bad), "").unwrap();
        let l = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(names(&l), vec!["ok.txt"]);
    }

    #[test]
    fn rejects_empty_cwd() {
        assert_eq!(
            build_repo_dir_listing("", "", false).unwrap_err(),
            "cwd must not be empty"
        );
    }

    /// Perf sanity, not a benchmark. Run with
    /// `cargo test list_repo_dir_perf -- --ignored`. The spec measured 66 ms in
    /// release for this shape; the bound is 15x that, so neither a debug build
    /// nor a loaded CI box can flake it.
    #[test]
    #[ignore = "perf sanity: run explicitly with --ignored"]
    fn list_repo_dir_perf_6000_files_under_one_second() {
        let repo = hermetic("perf");
        repo.write(".gitignore", "*.tmp\n");
        let big = repo.path.join("big");
        std::fs::create_dir_all(&big).unwrap();
        for i in 0..6_000 {
            let ext = if i % 3 == 0 { "tmp" } else { "txt" };
            std::fs::write(big.join(format!("f{:05}.{}", i, ext)), "").unwrap();
        }
        let start = std::time::Instant::now();
        let l = build_repo_dir_listing(&repo.cwd(), "big", true).unwrap();
        let elapsed = start.elapsed();
        assert!(l.truncated);
        assert_eq!(l.entries.len(), MAX_REPO_DIR_ENTRIES);
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "listing took {elapsed:?}"
        );
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test list_repo_dir`
Expected: compile errors `cannot find function build_repo_dir_listing in this scope`, `cannot find type RepoDirListing`, `cannot find value MAX_REPO_DIR_ENTRIES`.

- [ ] **Step 4: Add the types**

In `apps/desktop/src-tauri/src/types.rs`, after `pub struct RepoTreeResult { … }` (line 195), insert:

```rust

// ─── One working-tree directory (Files view, v3.11.2) ─────────────

/// One entry of `list_repo_dir`. `path` is repo-relative with `/` separators.
/// `ignored` means "matched by an ignore rule and not tracked". `size` is the
/// byte length for files, and 0 for directories and symlinks, which are never
/// followed. The preview reads it to refuse a huge file without reading it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoDirEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // "file" | "dir" | "symlink"
    pub ignored: bool,
    pub size: u64,
}

/// Result of `list_repo_dir`. `truncated` is set when the directory had more
/// than `MAX_REPO_DIR_ENTRIES` listable entries.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoDirListing {
    pub entries: Vec<RepoDirEntry>,
    pub truncated: bool,
}
```

- [ ] **Step 5: Implement the listing**

In `apps/desktop/src-tauri/src/commands/files.rs`, extend the module doc (lines 3-10) with one bullet after the `list_dir` bullet:

```rust
//!   - `list_repo_dir` — one level of the working tree for the Files view
//!     (v3.11.2), git-aware: ignored entries are classified with libgit2.
```

Then insert after `list_repo_tree` (after line 372, before `#[cfg(test)] mod list_repo_tree_tests`):

```rust

// ─── One working-tree directory (Files view, v3.11.2) ──────

/// Per-directory cap for `list_repo_dir`, keeping the IPC payload well under
/// the 1 MB budget of apps/desktop/CLAUDE.md (P6.4). Mirrored by
/// `MAX_REPO_DIR_ENTRIES` in dev-server.mjs and `DIR_ENTRY_CAP` in
/// useLazyRepoTree.ts.
pub(crate) const MAX_REPO_DIR_ENTRIES: usize = 5_000;

struct RawDirEntry {
    name: String,
    kind: &'static str,
    size: u64,
}

/// Ignored means "matched by an ignore rule AND not tracked". libgit2's
/// `is_path_ignored` applies the rules without looking at the index, so a
/// force-added file, or a directory holding a tracked file, would otherwise
/// read as ignored. Measured against `git check-ignore` on 2026-10-01 (spec §4).
fn is_ignored_untracked(
    repo: &git2::Repository,
    index: &git2::Index,
    rel: &str,
    is_dir: bool,
) -> bool {
    if !repo.is_path_ignored(rel).unwrap_or(false) {
        return false;
    }
    if is_dir {
        index.find_prefix(format!("{}/", rel)).is_err()
    } else {
        index.get_path(std::path::Path::new(rel), 0).is_none()
    }
}

/// Pure, synchronously-testable core of `list_repo_dir`.
///
/// One level only (`read_dir`). `.git` is always skipped, symlinks are
/// reported as `symlink` and never followed, and names that are not UTF-8 are
/// skipped because no path built from them could round-trip through IPC.
/// Entries are sorted directories first, then case-insensitively by name,
/// *before* classification, so the cap keeps the same first 5,000 entries on
/// both backends and classification stops as soon as the cap is passed.
fn build_repo_dir_listing(
    cwd: &str,
    dir: &str,
    include_ignored: bool,
) -> Result<RepoDirListing, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }
    let dir = dir.trim_matches('/');
    if dir.split('/').any(|c| c == ".git") {
        return Err(format!("Refusing to list inside .git: {}", dir));
    }
    // `safe_repo_path` refuses an empty path; "." resolves to the canonical
    // repo root through the same checks.
    let resolved = safe_repo_path(cwd, if dir.is_empty() { "." } else { dir })?;
    if !resolved.is_dir() {
        return Err(if resolved.exists() {
            format!("Not a directory: {}", dir)
        } else {
            format!("Directory not found: {}", dir)
        });
    }
    let label = if dir.is_empty() { "." } else { dir };
    let read = std::fs::read_dir(&resolved).map_err(|e| format!("Failed to list {}: {}", label, e))?;

    let mut raw: Vec<RawDirEntry> = Vec::new();
    for entry in read.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name == ".git" {
            continue;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let (kind, size) = if ft.is_symlink() {
            ("symlink", 0)
        } else if ft.is_dir() {
            ("dir", 0)
        } else {
            ("file", entry.metadata().map(|m| m.len()).unwrap_or(0))
        };
        raw.push(RawDirEntry { name, kind, size });
    }
    raw.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    // Opened once per call: the repo for its ignore rules, the index for
    // "is this tracked?".
    let repo = git2::Repository::open(cwd).map_err(|e| format!("git2 open: {}", e))?;
    let index = repo.index().map_err(|e| format!("git2 index: {}", e))?;
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{}/", dir)
    };

    let mut entries: Vec<RepoDirEntry> = Vec::new();
    let mut truncated = false;
    for e in raw {
        let rel = format!("{}{}", prefix, e.name);
        let ignored = is_ignored_untracked(&repo, &index, &rel, e.kind == "dir");
        if ignored && !include_ignored {
            continue;
        }
        if entries.len() == MAX_REPO_DIR_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(RepoDirEntry {
            name: e.name,
            path: rel,
            kind: e.kind.to_string(),
            ignored,
            size: e.size,
        });
    }
    Ok(RepoDirListing { entries, truncated })
}

#[tauri::command]
pub(crate) async fn list_repo_dir(
    cwd: String,
    dir: String,
    include_ignored: bool,
) -> Result<RepoDirListing, String> {
    build_repo_dir_listing(&cwd, &dir, include_ignored)
}
```

- [ ] **Step 6: Register the command**

In `apps/desktop/src-tauri/src/lib.rs`, inside `tauri::generate_handler![`, after `commands::files::list_repo_tree,` (line 732), add:

```rust
            commands::files::list_repo_dir,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test list_repo_dir && cargo test list_repo_dir_perf -- --ignored`
Expected: every `list_repo_dir_tests::*` test passes. The Linux-only non-UTF-8 test does not run on macOS, and the perf test reports `1 passed` in the second command. `list_repo_tree_tests::*` still passes (run `cargo test list_repo_tree`).

- [ ] **Step 8: Format, lint, commit**

```bash
cd apps/desktop/src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ../../..
git add apps/desktop/src-tauri/src/types.rs apps/desktop/src-tauri/src/commands/files.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): list_repo_dir lists one working-tree directory with libgit2 ignore classification"
```

---

### Task 2: `listRepoDir` wrapper, dev-server route, registry entry and parity

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:256-258` (after `read_file_parity`)
- Modify: `apps/desktop/src-tauri/examples/parity_probe.rs:35-44` (imports), `:52` (usage line), `:231-241` (after the `read-file` arm)
- Modify: `apps/desktop/dev-server.mjs:13` (fs import), after `:110` (helper), after `:2053` (route)
- Modify: `apps/desktop/src/utils/backend.ts:412` (after `listRepoTree`)
- Modify: `apps/desktop/src/utils/commandRegistry.ts:145` (after `list_repo_tree`)
- Modify: `apps/desktop/tests/parity/fixtures.mjs:20` (fs import), append a fixture
- Create: `apps/desktop/tests/parity/list-repo-dir.test.mjs`
- Create: `apps/desktop/src/utils/__tests__/backend-files-view.test.ts`

**Interfaces:**
- Consumes: Task 1's `list_repo_dir`, `RepoDirListing`; `assertParity(dev, { command, args, httpPath, method, body })` (`tests/parity/harness.mjs`), `runProbe(command, args) -> { ok, value, error }` (`tests/parity/probe.mjs`), `mkTempRepo`, `commitFile` (`tests/parity/fixtures.mjs:53,68`).
- Produces:
  ```ts
  export interface RepoDirEntry { name: string; path: string; kind: "file" | "dir" | "symlink"; ignored: boolean; size: number }
  export interface RepoDirListing { entries: RepoDirEntry[]; truncated: boolean }
  export async function listRepoDir(cwd: string, dir: string, includeIgnored: boolean): Promise<RepoDirListing>
  ```
  ```rust
  pub fn list_repo_dir_parity(cwd: String, dir: String, include_ignored: bool) -> Result<types::RepoDirListing, String>
  ```
  Dev route: `POST /api/list-repo-dir { cwd, dir, includeIgnored }` → `{ entries, truncated }`, or `400 { error }`.

- [ ] **Step 1: Write the failing wrapper test**

Create `apps/desktop/src/utils/__tests__/backend-files-view.test.ts`:

```ts
/**
 * v3.11.2 Files view — IPC wrappers. Locks the argument names each backend
 * receives (Tauri converts `includeIgnored` to the Rust `include_ignored`)
 * and that a dev-server refusal surfaces the server's own message, which the
 * tree shows on its error row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const devFetch = vi.fn();
const tauriInvoke = vi.fn();
let tauri = false;

vi.mock("../backend-core", () => ({
  isTauri: () => tauri,
  devFetch: (...args: unknown[]) => devFetch(...args),
  tauriInvoke: (...args: unknown[]) => tauriInvoke(...args),
  DEV_SERVER: "http://localhost:3001",
  IPC_TIMEOUT: { NETWORK: 30000, DEFAULT: 10000 },
  devTerminalOpen: vi.fn(),
}));

function okRes(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}
function errRes(status: number, json: unknown) {
  return { ok: false, status, json: async () => json };
}

const LISTING = {
  entries: [{ name: "src", path: "src", kind: "dir", ignored: false, size: 0 }],
  truncated: false,
};

describe("listRepoDir", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("invokes list_repo_dir with camelCase arguments under Tauri", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue(LISTING);
    const { listRepoDir } = await import("../backend");
    await expect(listRepoDir("/repo", "src", true)).resolves.toEqual(LISTING);
    expect(tauriInvoke).toHaveBeenCalledWith("list_repo_dir", {
      cwd: "/repo",
      dir: "src",
      includeIgnored: true,
    });
  });

  it("POSTs to /api/list-repo-dir under the dev-server", async () => {
    devFetch.mockResolvedValue(okRes(LISTING));
    const { listRepoDir } = await import("../backend");
    await expect(listRepoDir("/repo", "", false)).resolves.toEqual(LISTING);
    expect(devFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/list-repo-dir",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cwd: "/repo", dir: "", includeIgnored: false }),
      }),
    );
  });

  it("throws the dev-server's own message on refusal", async () => {
    devFetch.mockResolvedValue(errRes(400, { error: "Directory not found: gone" }));
    const { listRepoDir } = await import("../backend");
    await expect(listRepoDir("/repo", "gone", false)).rejects.toThrow("Directory not found: gone");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/backend-files-view.test.ts`
Expected: FAIL with `listRepoDir is not a function` (3 failures).

- [ ] **Step 3: Add the wrapper**

In `apps/desktop/src/utils/backend.ts`, after the closing `}` of `listRepoTree` (line 411), insert:

```ts

// ─── One working-tree directory (Files view, v3.11.2) ────────────────

/** One entry of `listRepoDir`. `path` is repo-relative with `/` separators. */
export interface RepoDirEntry {
  name: string;
  path: string;
  /** Symlinks are reported, never followed. */
  kind: "file" | "dir" | "symlink";
  /** Matched by an ignore rule and not tracked. Only returned when requested. */
  ignored: boolean;
  /** Byte length for files; 0 for directories and symlinks. */
  size: number;
}

export interface RepoDirListing {
  entries: RepoDirEntry[];
  /** More than 5,000 listable entries: only the first 5,000 are returned. */
  truncated: boolean;
}

/**
 * List one directory of the working tree (`dir` is repo-relative, "" for the
 * root). `.git` is never listed. Ignored entries are dropped unless
 * `includeIgnored`, in which case they come back with `ignored: true`.
 */
export async function listRepoDir(
  cwd: string,
  dir: string,
  includeIgnored: boolean,
): Promise<RepoDirListing> {
  if (isTauri()) {
    return tauriInvoke<RepoDirListing>("list_repo_dir", { cwd, dir, includeIgnored });
  }
  const res = await devFetch(`${DEV_SERVER}/api/list-repo-dir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, dir, includeIgnored }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `list_repo_dir failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 4: Run the wrapper test and the registry guard**

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/backend-files-view.test.ts src/utils/__tests__/commandRegistry.test.ts`
Expected: `backend-files-view.test.ts` PASS (3). `commandRegistry.test.ts` FAIL on "has an entry for every command the frontend invokes" with `list_repo_dir`.

- [ ] **Step 5: Add the dev-server helper and route**

In `apps/desktop/dev-server.mjs` line 13, add `lstatSync` to the `node:fs` import list (after `statSync,`).

After `function devExtractPercent(line) { … }` (ends at line 110), insert:

```js

/** Per-directory cap of `list_repo_dir` — mirrors MAX_REPO_DIR_ENTRIES in files.rs. */
const MAX_REPO_DIR_ENTRIES = 5000;

/** Code-point order, the same as Rust's `str::cmp` (UTF-8 byte order). */
function cmpCodePoints(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Mirror of the Tauri `list_repo_dir` command (Files view, v3.11.2): one level
 * of the working tree, `.git` skipped, symlinks reported and never followed,
 * non-UTF-8 names skipped, sorted directories first then case-insensitively,
 * capped after sorting. Rust classifies ignores in process with libgit2; this
 * process has no libgit2, so it makes one `git check-ignore -z --stdin` call,
 * which already leaves tracked paths out (verified 2026-10-01: `build/`
 * holding a tracked file and a force-added `*.log` are not reported). Slow on
 * a huge directory, but dev-only. Pinned by tests/parity/list-repo-dir.test.mjs.
 */
function devListRepoDir(cwd, rawDir, includeIgnored) {
  if (!cwd || !cwd.trim()) throw new Error("cwd must not be empty");
  const dir = String(rawDir ?? "").replace(/^\/+|\/+$/g, "");
  if (dir.split("/").includes(".git")) throw new Error(`Refusing to list inside .git: ${dir}`);
  const resolved = safeRepoPath(cwd, dir === "" ? "." : dir);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new Error(`Directory not found: ${dir}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a directory: ${dir}`);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const raw = [];
  let dirents;
  try {
    dirents = readdirSync(resolved, { withFileTypes: true, encoding: "buffer" });
  } catch (e) {
    throw new Error(`Failed to list ${dir || "."}: ${e.message}`);
  }
  for (const d of dirents) {
    let name;
    try {
      name = decoder.decode(d.name);
    } catch {
      continue; // not UTF-8: no path built from it could round-trip
    }
    if (name === ".git") continue;
    const kind = d.isSymbolicLink() ? "symlink" : d.isDirectory() ? "dir" : "file";
    let size = 0;
    if (kind === "file") {
      try { size = lstatSync(join(resolved, name)).size; } catch { size = 0; }
    }
    raw.push({ name, kind, size });
  }
  raw.sort((a, b) => {
    if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
    return cmpCodePoints(a.name.toLowerCase(), b.name.toLowerCase()) || cmpCodePoints(a.name, b.name);
  });

  const prefix = dir ? `${dir}/` : "";
  const rels = raw.map((e) => prefix + e.name);
  let ignoredSet = new Set();
  if (rels.length > 0) {
    const r = spawnSync(GIT, ["check-ignore", "-z", "--stdin"], {
      cwd,
      input: rels.join("\0") + "\0",
      maxBuffer: 64 * 1024 * 1024,
    });
    // 0 = some ignored, 1 = none ignored; anything else is a git failure,
    // reported but not fatal (the listing is still right about what exists).
    if (r.status === 0) {
      ignoredSet = new Set(r.stdout.toString("utf8").split("\0").filter(Boolean));
    } else if (r.status !== 1) {
      console.warn(`[dev] list-repo-dir: git check-ignore failed: ${r.stderr?.toString() ?? r.error}`);
    }
  }

  const entries = [];
  let truncated = false;
  for (let i = 0; i < raw.length; i++) {
    const ignored = ignoredSet.has(rels[i]);
    if (ignored && !includeIgnored) continue;
    if (entries.length === MAX_REPO_DIR_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name: raw[i].name, path: rels[i], kind: raw[i].kind, ignored, size: raw[i].size });
  }
  return { entries, truncated };
}
```

After the `/api/list-repo-tree` route (its closing `}` is line 2053), insert:

```js

    // POST /api/list-repo-dir  { cwd, dir, includeIgnored }
    //
    // Mirrors the Tauri `list_repo_dir` command (Files view, v3.11.2) through
    // devListRepoDir() above. Response: { entries, truncated }, camelCase like
    // the Rust struct's `rename_all = "camelCase"`.
    if (url.pathname === "/api/list-repo-dir" && req.method === "POST") {
      const { cwd, dir = "", includeIgnored = false } = await readBody(req);
      try {
        return jsonResponse(req, res, devListRepoDir(cwd, dir, includeIgnored === true));
      } catch (e) {
        return jsonResponse(req, res, { error: e.message }, 400);
      }
    }
```

- [ ] **Step 6: Add the registry entry**

In `apps/desktop/src/utils/commandRegistry.ts`, after `list_repo_tree: { route: "/api/list-repo-tree" },` (line 145), add:

```ts
  list_repo_dir: { route: "/api/list-repo-dir" },
```

- [ ] **Step 7: Run the registry guard**

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/commandRegistry.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 8: Write the failing parity test and its fixture**

In `apps/desktop/tests/parity/fixtures.mjs` line 20, add `symlinkSync` to the `node:fs` import. Append:

```js

// ─── Files view fixture (v3.11.2) ──────────────────────────────────────────

/**
 * Every `list_repo_dir` classification the Files view shows: tracked,
 * untracked, an ignored file and directory, an ignored directory holding a
 * tracked file, a tracked `*.log` under a `*.log` rule, mixed-case names,
 * spaces and non-ASCII (in the repo path itself too), and, outside Windows, a
 * symlink leaving the repo. Global excludes are neutralised so the
 * developer's own ~/.gitignore cannot change the answer on either side.
 */
export function fixtureListRepoDir() {
  const cwd = mkTempRepo("gw list dir é-");
  execFileSync("git", ["-C", cwd, "config", "core.excludesFile", join(cwd, ".git", "no-global-excludes")]);
  commitFile(cwd, "src/main.ts", "export {};\n", "add src", 0);
  commitFile(cwd, "Readme.md", "# hi\n", "add readme", 1);
  // Both committed before the rules that would ignore them.
  commitFile(cwd, "build/keep.txt", "keep\n", "add build/keep.txt", 2);
  commitFile(cwd, "forced.log", "forced\n", "add forced.log", 3);
  commitFile(cwd, "docs/guide one.md", "guide\n", "add guide", 4);
  commitFile(cwd, ".gitignore", "build/\nnode_modules/\n*.log\n", "add ignore rules", 5);
  // Untracked, not ignored.
  writeFileSync(join(cwd, "alpha.txt"), "a\n");
  writeFileSync(join(cwd, "Zeta.txt"), "z\n");
  writeFileSync(join(cwd, "café.txt"), "c\n");
  // Ignored.
  writeFileSync(join(cwd, "debug.log"), "d\n");
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x\n");
  writeFileSync(join(cwd, "build", "out.bin"), "o\n");
  if (process.platform !== "win32") symlinkSync(tmpdir(), join(cwd, "link-out"));
  return cwd;
}
```

Create `apps/desktop/tests/parity/list-repo-dir.test.mjs`:

```js
/**
 * Parity tests: `list_repo_dir` (Rust) vs `/api/list-repo-dir` (Node dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * Prerequisite: the Rust probe must be built at least once
 *   cargo build --example parity-probe
 * (see README.md in this folder).
 *
 * The two backends answer "is this ignored?" by different means. Rust asks
 * libgit2 in process (`is_path_ignored`, then an index lookup so a tracked
 * path under a rule is not ignored); the dev-server makes one
 * `git check-ignore -z --stdin` call. Two mechanisms for one answer is exactly
 * what drifts, so every classification the Files view shows is pinned here,
 * on a repo whose own path has a space and a non-ASCII character. Refusals are
 * pinned too: the tree shows their message on an error row.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { fixtureListRepoDir } from "./fixtures.mjs";

const HAS_SYMLINK = process.platform !== "win32";

/** POST /api/list-repo-dir, returning the same {ok, value, error} shape as runProbe. */
async function nodeListRepoDir(dev, body) {
  const res = await dev.fetch("/api/list-repo-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

function listing(dev, cwd, dir, includeIgnored) {
  const args = { cwd, dir, includeIgnored };
  return assertParity(dev, {
    command: "list-repo-dir",
    args,
    httpPath: "/api/list-repo-dir",
    method: "POST",
    body: args,
  });
}

async function bothRefuse(dev, cwd, dir) {
  const args = { cwd, dir, includeIgnored: false };
  const rust = runProbe("list-repo-dir", args);
  const node = await nodeListRepoDir(dev, args);
  expect(rust.ok, `rust accepted ${dir}`).toBe(false);
  expect(node.ok, `node accepted ${dir}`).toBe(false);
  return { rust: rust.error, node: node.error };
}

describe("parity: list-repo-dir", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("the root without ignored entries is identical, sorted directories first", async () => {
    const cwd = fixtureListRepoDir();
    const { rust } = await listing(dev, cwd, "", false);
    expect(rust.entries.map((e) => e.name)).toEqual([
      "build", "docs", "src",
      ".gitignore", "alpha.txt", "café.txt", "forced.log",
      ...(HAS_SYMLINK ? ["link-out"] : []),
      "Readme.md", "Zeta.txt",
    ]);
    expect(rust.truncated).toBe(false);
  });

  it("the root with ignored entries flags exactly the untracked ones", async () => {
    const cwd = fixtureListRepoDir();
    const { rust } = await listing(dev, cwd, "", true);
    const ignored = Object.fromEntries(rust.entries.map((e) => [e.name, e.ignored]));
    expect(ignored["node_modules"]).toBe(true);
    expect(ignored["debug.log"]).toBe(true);
    expect(ignored["build"]).toBe(false); // holds a tracked file
    expect(ignored["forced.log"]).toBe(false); // tracked under a *.log rule
    expect(ignored["alpha.txt"]).toBe(false);
    if (HAS_SYMLINK) expect(rust.entries.find((e) => e.name === "link-out")?.kind).toBe("symlink");
  });

  it("inside an ignored directory, the tracked file is not ignored and the rest is", async () => {
    const cwd = fixtureListRepoDir();
    const { rust } = await listing(dev, cwd, "build", true);
    expect(rust.entries.map((e) => [e.path, e.ignored])).toEqual([
      ["build/keep.txt", false],
      ["build/out.bin", true],
    ]);
  });

  it("a name with a space keeps it in its repo-relative path", async () => {
    const cwd = fixtureListRepoDir();
    const { rust } = await listing(dev, cwd, "docs", false);
    expect(rust.entries.map((e) => e.path)).toEqual(["docs/guide one.md"]);
  });

  it("a missing directory, a file and .git are refused with the same message", async () => {
    const cwd = fixtureListRepoDir();
    for (const [dir, message] of [
      ["gone", "Directory not found: gone"],
      ["Readme.md", "Not a directory: Readme.md"],
      [".git", "Refusing to list inside .git: .git"],
    ]) {
      const { rust, node } = await bothRefuse(dev, cwd, dir);
      expect(rust).toBe(message);
      expect(node).toBe(message);
    }
  });

  it("a path escaping the repo, directly or through a symlink, is refused by both", async () => {
    const cwd = fixtureListRepoDir();
    const dirs = ["../..", ...(HAS_SYMLINK ? ["link-out"] : [])];
    for (const dir of dirs) {
      const { rust, node } = await bothRefuse(dev, cwd, dir);
      expect(rust).toMatch(/^path escapes cwd/);
      expect(node).toMatch(/^path escapes cwd/);
    }
  });
});
```

- [ ] **Step 9: Run the parity test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo build --example parity-probe && cd .. && pnpm exec vitest run --config vitest.config.parity.ts tests/parity/list-repo-dir.test.mjs`
Expected: FAIL. The cases using `assertParity` throw `parity-probe failed for "list-repo-dir"`, because the probe prints `unknown command: list-repo-dir` and exits 2.

- [ ] **Step 10: Add the parity entry point and the probe arm**

In `apps/desktop/src-tauri/src/lib.rs`, after `read_file_parity` (line 258), insert:

```rust

/// Parity entry point for `list_repo_dir` (v3.11.2). Rust classifies ignored
/// entries in process with libgit2; the dev-server shells out to
/// `git check-ignore`. Two mechanisms answering one question is exactly what
/// parity coverage exists for.
pub fn list_repo_dir_parity(
    cwd: String,
    dir: String,
    include_ignored: bool,
) -> Result<types::RepoDirListing, String> {
    tauri::async_runtime::block_on(commands::files::list_repo_dir(cwd, dir, include_ignored))
}
```

In `apps/desktop/src-tauri/examples/parity_probe.rs`, add `list_repo_dir_parity` to the `use gitwand_desktop_lib::{ … }` list (lines 35-44). Add `list-repo-dir` to the `commands:` usage line (line 52). After the `"read-file"` arm (ends line 241), insert:

```rust
        "list-repo-dir" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            let dir = input
                .get("dir")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let include_ignored = input
                .get("includeIgnored")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            to_json(list_repo_dir_parity(cwd, dir, include_ignored))
        }
```

- [ ] **Step 11: Run the parity test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo build --example parity-probe && cd .. && pnpm exec vitest run --config vitest.config.parity.ts tests/parity/list-repo-dir.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 12: Format, lint, commit**

```bash
cd apps/desktop/src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ../../..
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/examples/parity_probe.rs apps/desktop/dev-server.mjs apps/desktop/src/utils/backend.ts apps/desktop/src/utils/commandRegistry.ts apps/desktop/src/utils/__tests__/backend-files-view.test.ts apps/desktop/tests/parity/fixtures.mjs apps/desktop/tests/parity/list-repo-dir.test.mjs
git commit -m "feat(desktop): listRepoDir wrapper, dev-server route and Rust/Node parity for list_repo_dir"
```

---

### Task 3: `reveal_in_file_manager`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/ops.rs:4739` (after `open_in_editor`), plus a test module
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`generate_handler!`, after `commands::ops::open_url,` at line 764)
- Modify: `apps/desktop/src/utils/backend.ts` (after `openInEditor`, line 1510)
- Modify: `apps/desktop/src/utils/commandRegistry.ts` (after `read_gitwandrc`, line 150)
- Modify: `apps/desktop/dev-server.mjs` (after the `/api/list-repo-dir` route from Task 2)
- Test: `apps/desktop/src/utils/__tests__/backend-files-view.test.ts`, and `ops.rs` `mod reveal_tests`

**Interfaces:**
- Consumes: `safe_repo_path`, `hidden_cmd(bin) -> Command` (`git/cmd.rs:286`), `sanitize_appimage_search_paths(&mut Command)` (`git/cmd.rs:238`), `try_open_linux(cmd, label)` (`ops.rs:4658`, Linux-only and private to `ops.rs`, which is why the command lives there and not in `files.rs`).
- Produces:
  ```rust
  fn reveal_target(cwd: &str, path: &str) -> Result<std::path::PathBuf, String>; // "Path not found: <path>" when missing
  #[tauri::command] pub(crate) async fn reveal_in_file_manager(cwd: String, path: String) -> Result<(), String>;
  ```
  ```ts
  export async function revealInFileManager(cwd: string, path: string): Promise<void>
  ```
  Dev route: `POST /api/reveal-in-file-manager { cwd, path }` → `{ ok: true }`, or `400 { error }`.

**Deviation from spec §4, kept deliberately:** the spec asks for a dev route *and* a registry entry "giving the reason". `commandRegistry.test.ts` ("declares exactly one of route or desktopOnly") forbids both on one entry. The entry therefore names the route, and the reason it cannot be exercised for real lives in a code comment above it. The route still validates the path exactly as Rust does, so a bad path fails under `dev:web` too.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src-tauri/src/commands/ops.rs`:

```rust
#[cfg(test)]
mod reveal_tests {
    use super::reveal_target;

    fn temp_repo(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gitwand-reveal-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("a.rs"), "").unwrap();
        dir
    }

    #[test]
    fn reveal_target_resolves_an_existing_path_inside_the_repo() {
        let repo = temp_repo("ok");
        let cwd = repo.to_string_lossy().to_string();
        let target = reveal_target(&cwd, "src/a.rs").unwrap();
        assert!(target.ends_with("src/a.rs"));
        assert!(target.is_absolute());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn reveal_target_refuses_paths_outside_the_repo() {
        let repo = temp_repo("escape");
        let cwd = repo.to_string_lossy().to_string();
        let err = reveal_target(&cwd, "../").unwrap_err();
        assert!(err.contains("path escapes cwd"), "{err}");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), repo.join("link-out")).unwrap();
            let err = reveal_target(&cwd, "link-out").unwrap_err();
            assert!(err.contains("path escapes cwd"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn reveal_target_reports_a_missing_path() {
        let repo = temp_repo("missing");
        let cwd = repo.to_string_lossy().to_string();
        assert_eq!(
            reveal_target(&cwd, "src/gone.rs").unwrap_err(),
            "Path not found: src/gone.rs"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }
}
```

Append to `apps/desktop/src/utils/__tests__/backend-files-view.test.ts`:

```ts
describe("revealInFileManager", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("invokes reveal_in_file_manager under Tauri", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue(undefined);
    const { revealInFileManager } = await import("../backend");
    await revealInFileManager("/repo", "src/a.ts");
    expect(tauriInvoke).toHaveBeenCalledWith("reveal_in_file_manager", { cwd: "/repo", path: "src/a.ts" });
  });

  it("POSTs to the dev-server and surfaces its refusal", async () => {
    devFetch.mockResolvedValue(errRes(400, { error: "Path not found: x" }));
    const { revealInFileManager } = await import("../backend");
    await expect(revealInFileManager("/repo", "x")).rejects.toThrow("Path not found: x");
    expect(devFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/reveal-in-file-manager",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ cwd: "/repo", path: "x" }) }),
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test reveal_target`
Expected: compile error `unresolved import super::reveal_target`.

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/backend-files-view.test.ts`
Expected: FAIL with `revealInFileManager is not a function` (2 failures; the 3 earlier tests still pass).

- [ ] **Step 3: Implement the Rust command**

In `apps/desktop/src-tauri/src/commands/ops.rs`, after `open_in_editor` (closing `}` at line 4739), insert:

```rust

// ─── Reveal in the OS file manager (Files view, v3.11.2) ─────

/// What `reveal_in_file_manager` opens, after `safe_repo_path`: a path that
/// exists inside the repo. A symlink leading out of the repo canonicalizes
/// outside it and is refused like any other escape.
fn reveal_target(cwd: &str, path: &str) -> Result<std::path::PathBuf, String> {
    let full = safe_repo_path(cwd, path)?;
    if !full.exists() {
        return Err(format!("Path not found: {}", path));
    }
    Ok(full)
}

/// Show a working-tree path in the OS file manager. macOS and Windows select
/// the item; Linux has no portable "select", so it opens the parent folder
/// through the same opener chain as `open_url` (AppImage-safe env, exit
/// status checked).
#[tauri::command]
pub(crate) async fn reveal_in_file_manager(cwd: String, path: String) -> Result<(), String> {
    let target = reveal_target(&cwd, &path)?;

    #[cfg(target_os = "macos")]
    {
        hidden_cmd("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to reveal {}: {}", path, e))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // `canonicalize` yields a verbatim `\\?\C:\…` path, which Explorer
        // does not understand.
        let raw = target.to_string_lossy().to_string();
        let plain = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{}", rest)
        } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            raw
        };
        // Explorer parses its own command line: `/select,` must be followed by
        // the quoted path inside the same argument, which `arg()` would wrap
        // in quotes as a whole. A Windows path cannot contain `"`.
        hidden_cmd("explorer")
            .raw_arg(format!("/select,\"{}\"", plain))
            .spawn()
            .map_err(|e| format!("Failed to reveal {}: {}", path, e))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let dir = target.parent().unwrap_or(&target).to_path_buf();
        let openers: [(&str, &[&str]); 3] =
            [("xdg-open", &[]), ("gio", &["open"]), ("kde-open5", &[])];
        let mut errors: Vec<String> = Vec::new();
        for (bin, prefix) in openers {
            let mut cmd = hidden_cmd(bin);
            cmd.args(prefix).arg(&dir);
            sanitize_appimage_search_paths(&mut cmd);
            match try_open_linux(cmd, bin) {
                Ok(()) => return Ok(()),
                Err(e) => errors.push(e),
            }
        }
        Err(format!("Failed to reveal {}: {}", path, errors.join("; ")))
    }
}
```

In `apps/desktop/src-tauri/src/lib.rs`, after `commands::ops::open_url,` in `generate_handler!`, add:

```rust
            commands::ops::reveal_in_file_manager,
```

- [ ] **Step 4: Implement the wrapper, the route and the registry entry**

In `apps/desktop/src/utils/backend.ts`, after `openInEditor` (closing `}` at line 1510), insert:

```ts

/**
 * Show a working-tree path in the OS file manager (Files view, v3.11.2):
 * selected in Finder / Explorer, its folder opened on Linux. Throws with the
 * backend's message when the path is missing or outside the repo.
 */
export async function revealInFileManager(cwd: string, path: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("reveal_in_file_manager", { cwd, path });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/reveal-in-file-manager`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `reveal_in_file_manager failed: ${res.status}`);
  }
}
```

In `apps/desktop/dev-server.mjs`, right after the `/api/list-repo-dir` route, insert:

```js

    // POST /api/reveal-in-file-manager  { cwd, path }
    //
    // Stands in for the Tauri `reveal_in_file_manager` (v3.11.2), which opens
    // the OS file manager: only the packaged app on the user's desktop session
    // can do that. The route validates the path exactly as the Rust command
    // does (safe_repo_path, then existence), so a bad path fails the same way
    // under `pnpm dev:web`, and then it only logs.
    if (url.pathname === "/api/reveal-in-file-manager" && req.method === "POST") {
      const { cwd, path } = await readBody(req);
      let full;
      try { full = safeRepoPath(cwd, path); }
      catch (e) { return jsonResponse(req, res, { error: e.message }, 400); }
      if (!existsSync(full)) return jsonResponse(req, res, { error: `Path not found: ${path}` }, 400);
      console.info(`[dev] revealInFileManager: ${full}`);
      return jsonResponse(req, res, { ok: true });
    }
```

In `apps/desktop/src/utils/commandRegistry.ts`, after `read_gitwandrc: { route: "/api/read-gitwandrc" },` (line 150), add:

```ts
  // The route validates the path like the Rust command and then only logs:
  // opening Finder / Explorer needs the packaged app on a desktop session, so
  // manual QA of the reveal itself happens in the Tauri app (spec §9).
  reveal_in_file_manager: { route: "/api/reveal-in-file-manager" },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test reveal_target`
Expected: PASS (3 tests).

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/backend-files-view.test.ts src/utils/__tests__/commandRegistry.test.ts`
Expected: PASS (5 + 7).

- [ ] **Step 6: Format, lint, commit**

```bash
cd apps/desktop/src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ../../..
git add apps/desktop/src-tauri/src/commands/ops.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/utils/backend.ts apps/desktop/src/utils/commandRegistry.ts apps/desktop/dev-server.mjs apps/desktop/src/utils/__tests__/backend-files-view.test.ts
git commit -m "feat(desktop): reveal_in_file_manager selects a working-tree path in Finder or Explorer"
```

---

### Task 4: `fileTreeKeymap.ts`, the pure keyboard resolver

**Files:**
- Create: `apps/desktop/src/composables/fileTreeKeymap.ts`
- Test: `apps/desktop/src/composables/__tests__/fileTreeKeymap.test.ts`

**Interfaces:**
- Consumes: `isEditableTarget(el: EventTarget | null): boolean` (`apps/desktop/src/utils/editableTarget.ts:14`). It uses `instanceof HTMLElement`, so the test runs under jsdom, like `usePrReviewKeymap.test.ts`.
- Produces:
  ```ts
  export const TYPE_AHEAD_RESET_MS = 700;
  export interface KeymapRow { kind: "folder" | "file" | "loading" | "error" | "truncated"; path: string; name: string; depth: number; expanded?: boolean }
  export interface TypeAheadState { buffer: string; at: number }
  export interface FileTreeKeyContext { rows: readonly KeymapRow[]; cursor: number; typeAhead: TypeAheadState; now: number }
  export type FileTreeAction =
    | { type: "move" | "expand" | "collapse" | "open" | "toggle" | "retry" | "context-menu"; index: number }
    | { type: "type-ahead"; index: number; typeAhead: TypeAheadState };
  export function resolveFileTreeShortcut(e: KeyboardEvent, ctx: FileTreeKeyContext): FileTreeAction | null
  ```
  `KeymapRow` is structurally satisfied by Task 5's `LazyTreeRow`, so this task does not depend on Task 5.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/fileTreeKeymap.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  resolveFileTreeShortcut,
  TYPE_AHEAD_RESET_MS,
  type KeymapRow,
  type TypeAheadState,
} from "../fileTreeKeymap";

const ROWS: KeymapRow[] = [
  { kind: "folder", path: "docs", name: "docs", depth: 0, expanded: true }, // 0
  { kind: "file", path: "docs/guide.md", name: "guide.md", depth: 1 }, // 1
  { kind: "folder", path: "docs/img", name: "img", depth: 1, expanded: false }, // 2
  { kind: "folder", path: "src", name: "src", depth: 0, expanded: true }, // 3
  { kind: "error", path: "src", name: "", depth: 1 }, // 4
  { kind: "file", path: "README.md", name: "README.md", depth: 0 }, // 5
  { kind: "file", path: "Readme-old.md", name: "Readme-old.md", depth: 0 }, // 6
  { kind: "file", path: "setup.cfg", name: "setup.cfg", depth: 0 }, // 7
];

const IDLE: TypeAheadState = { buffer: "", at: 0 };
const NOW = 100_000;

function kd(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...init });
}
function at(cursor: number, typeAhead: TypeAheadState = IDLE, now = NOW) {
  return { rows: ROWS, cursor, typeAhead, now };
}

describe("resolveFileTreeShortcut — movement", () => {
  it("↓ / ↑ move by one and clamp at the ends", () => {
    expect(resolveFileTreeShortcut(kd("ArrowDown"), at(0))).toEqual({ type: "move", index: 1 });
    expect(resolveFileTreeShortcut(kd("ArrowDown"), at(7))).toEqual({ type: "move", index: 7 });
    expect(resolveFileTreeShortcut(kd("ArrowUp"), at(3))).toEqual({ type: "move", index: 2 });
    expect(resolveFileTreeShortcut(kd("ArrowUp"), at(0))).toEqual({ type: "move", index: 0 });
  });

  it("↓ / ↑ with no cursor land on the first row", () => {
    expect(resolveFileTreeShortcut(kd("ArrowDown"), at(-1))).toEqual({ type: "move", index: 0 });
    expect(resolveFileTreeShortcut(kd("ArrowUp"), at(-1))).toEqual({ type: "move", index: 0 });
  });

  it("Home / End jump to the first and last row", () => {
    expect(resolveFileTreeShortcut(kd("Home"), at(5))).toEqual({ type: "move", index: 0 });
    expect(resolveFileTreeShortcut(kd("End"), at(0))).toEqual({ type: "move", index: 7 });
  });
});

describe("resolveFileTreeShortcut — → and ←", () => {
  it("→ expands a collapsed folder", () => {
    expect(resolveFileTreeShortcut(kd("ArrowRight"), at(2))).toEqual({ type: "expand", index: 2 });
  });
  it("→ on an expanded folder goes to its first child, placeholder included", () => {
    expect(resolveFileTreeShortcut(kd("ArrowRight"), at(0))).toEqual({ type: "move", index: 1 });
    expect(resolveFileTreeShortcut(kd("ArrowRight"), at(3))).toEqual({ type: "move", index: 4 });
  });
  it("→ on a file does nothing", () => {
    expect(resolveFileTreeShortcut(kd("ArrowRight"), at(1))).toBeNull();
  });
  it("← collapses an expanded folder", () => {
    expect(resolveFileTreeShortcut(kd("ArrowLeft"), at(0))).toEqual({ type: "collapse", index: 0 });
  });
  it("← elsewhere goes to the parent row", () => {
    expect(resolveFileTreeShortcut(kd("ArrowLeft"), at(1))).toEqual({ type: "move", index: 0 });
    expect(resolveFileTreeShortcut(kd("ArrowLeft"), at(2))).toEqual({ type: "move", index: 0 });
    expect(resolveFileTreeShortcut(kd("ArrowLeft"), at(4))).toEqual({ type: "move", index: 3 });
  });
  it("← on a root-level row has nowhere to go", () => {
    expect(resolveFileTreeShortcut(kd("ArrowLeft"), at(5))).toBeNull();
  });
});

describe("resolveFileTreeShortcut — Enter and the context menu", () => {
  it("Enter opens a file, toggles a folder and retries an error row", () => {
    expect(resolveFileTreeShortcut(kd("Enter"), at(1))).toEqual({ type: "open", index: 1 });
    expect(resolveFileTreeShortcut(kd("Enter"), at(2))).toEqual({ type: "toggle", index: 2 });
    expect(resolveFileTreeShortcut(kd("Enter"), at(4))).toEqual({ type: "retry", index: 4 });
    expect(resolveFileTreeShortcut(kd("Enter"), at(-1))).toBeNull();
  });
  it("⇧F10 and the context-menu key open the menu on the current row", () => {
    expect(resolveFileTreeShortcut(kd("F10", { shiftKey: true }), at(5))).toEqual({ type: "context-menu", index: 5 });
    expect(resolveFileTreeShortcut(kd("ContextMenu"), at(1))).toEqual({ type: "context-menu", index: 1 });
    expect(resolveFileTreeShortcut(kd("ContextMenu"), at(-1))).toBeNull();
    expect(resolveFileTreeShortcut(kd("F10"), at(5))).toBeNull();
  });
});

describe("resolveFileTreeShortcut — type-ahead", () => {
  it("jumps to the next visible row whose name starts with the key, case-insensitively", () => {
    expect(resolveFileTreeShortcut(kd("s"), at(0))).toEqual({
      type: "type-ahead",
      index: 3,
      typeAhead: { buffer: "s", at: NOW },
    });
    expect(resolveFileTreeShortcut(kd("R"), at(0))).toMatchObject({ index: 5 });
  });

  it("extends the prefix within 700 ms, searching from the current row", () => {
    const typing = { buffer: "s", at: NOW - (TYPE_AHEAD_RESET_MS - 1) };
    expect(resolveFileTreeShortcut(kd("e"), at(3, typing))).toEqual({
      type: "type-ahead",
      index: 7,
      typeAhead: { buffer: "se", at: NOW },
    });
    const readme = { buffer: "readme", at: NOW - 10 };
    expect(resolveFileTreeShortcut(kd("-"), at(5, readme))).toMatchObject({ index: 6 });
  });

  it("starts a fresh prefix after 700 ms, from the row after the cursor", () => {
    const stale = { buffer: "s", at: NOW - TYPE_AHEAD_RESET_MS - 1 };
    expect(resolveFileTreeShortcut(kd("s"), at(3, stale))).toEqual({
      type: "type-ahead",
      index: 7,
      typeAhead: { buffer: "s", at: NOW },
    });
  });

  it("wraps around and skips placeholder rows", () => {
    expect(resolveFileTreeShortcut(kd("d"), at(7))).toMatchObject({ index: 0 });
  });

  it("keeps the cursor but records the buffer when nothing matches", () => {
    expect(resolveFileTreeShortcut(kd("x"), at(2))).toEqual({
      type: "type-ahead",
      index: 2,
      typeAhead: { buffer: "x", at: NOW },
    });
  });

  it("ignores Space", () => {
    expect(resolveFileTreeShortcut(kd(" "), at(0))).toBeNull();
  });
});

describe("resolveFileTreeShortcut — guards", () => {
  it("ignores modified keys", () => {
    expect(resolveFileTreeShortcut(kd("ArrowDown", { ctrlKey: true }), at(0))).toBeNull();
    expect(resolveFileTreeShortcut(kd("a", { metaKey: true }), at(0))).toBeNull();
    expect(resolveFileTreeShortcut(kd("a", { altKey: true }), at(0))).toBeNull();
  });

  it("returns null on an empty tree", () => {
    expect(resolveFileTreeShortcut(kd("ArrowDown"), { rows: [], cursor: -1, typeAhead: IDLE, now: NOW })).toBeNull();
  });

  it("stays inert while the user types in an editable element", () => {
    for (const el of [
      document.createElement("input"),
      document.createElement("textarea"),
      Object.assign(document.createElement("div"), { contentEditable: "true" }),
    ]) {
      document.body.appendChild(el);
      let got: unknown = "unset";
      el.addEventListener("keydown", (e) => {
        got = resolveFileTreeShortcut(e, at(0));
      });
      el.dispatchEvent(kd("ArrowDown"));
      expect(got).toBeNull();
      el.remove();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/composables/__tests__/fileTreeKeymap.test.ts`
Expected: FAIL with `Failed to resolve import "../fileTreeKeymap"`.

- [ ] **Step 3: Implement the resolver**

Create `apps/desktop/src/composables/fileTreeKeymap.ts`:

```ts
/**
 * fileTreeKeymap.ts — keyboard model of the Files view tree (v3.11.2).
 *
 * A pure resolver in the style of `usePrReviewKeymap.ts`: a `KeyboardEvent`
 * plus the tree's rows and cursor in, a discriminated action out, no side
 * effects and no Vue state. `FileTreePane.vue` owns the listener and applies
 * the action. The ←/→ model is the one `FolderDiffTree.vue` (dead code) had:
 * → expands, then descends; ← collapses, then climbs to the parent.
 *
 * Type-ahead state travels in and out with the action, so the resolver stays
 * pure. It matches the start of row names, case-insensitively, and resets after
 * 700 ms of silence.
 */
import { isEditableTarget } from "../utils/editableTarget";

export const TYPE_AHEAD_RESET_MS = 700;

/** The subset of a tree row the keymap reads. `LazyTreeRow` satisfies it. */
export interface KeymapRow {
  kind: "folder" | "file" | "loading" | "error" | "truncated";
  path: string;
  name: string;
  depth: number;
  expanded?: boolean;
}

export interface TypeAheadState {
  buffer: string;
  /** `Date.now()` of the last type-ahead key. */
  at: number;
}

export interface FileTreeKeyContext {
  rows: readonly KeymapRow[];
  /** Index into `rows`, or -1 when nothing has the cursor yet. */
  cursor: number;
  typeAhead: TypeAheadState;
  now: number;
}

export type FileTreeAction =
  | { type: "move" | "expand" | "collapse" | "open" | "toggle" | "retry" | "context-menu"; index: number }
  | { type: "type-ahead"; index: number; typeAhead: TypeAheadState };

function isNamed(row: KeymapRow): boolean {
  return row.kind === "file" || row.kind === "folder";
}

function findByPrefix(rows: readonly KeymapRow[], prefix: string, start: number): number {
  const n = rows.length;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const row = rows[i]!;
    if (isNamed(row) && row.name.toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

export function resolveFileTreeShortcut(
  e: KeyboardEvent,
  ctx: FileTreeKeyContext,
): FileTreeAction | null {
  if (isEditableTarget(e.target)) return null;
  const { rows } = ctx;
  if (rows.length === 0) return null;
  const last = rows.length - 1;
  const cur = ctx.cursor < 0 ? -1 : Math.min(ctx.cursor, last);
  const row = cur >= 0 ? rows[cur] : undefined;

  if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
    return cur >= 0 ? { type: "context-menu", index: cur } : null;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null;

  switch (e.key) {
    case "ArrowDown":
      return { type: "move", index: cur < 0 ? 0 : Math.min(cur + 1, last) };
    case "ArrowUp":
      return { type: "move", index: cur <= 0 ? 0 : cur - 1 };
    case "Home":
      return { type: "move", index: 0 };
    case "End":
      return { type: "move", index: last };
    case "ArrowRight": {
      if (!row || row.kind !== "folder") return null;
      if (!row.expanded) return { type: "expand", index: cur };
      const next = rows[cur + 1];
      return next && next.depth > row.depth ? { type: "move", index: cur + 1 } : null;
    }
    case "ArrowLeft": {
      if (!row) return null;
      if (row.kind === "folder" && row.expanded) return { type: "collapse", index: cur };
      for (let i = cur - 1; i >= 0; i--) {
        if (rows[i]!.depth < row.depth) return { type: "move", index: i };
      }
      return null;
    }
    case "Enter": {
      if (!row) return null;
      if (row.kind === "file") return { type: "open", index: cur };
      if (row.kind === "folder") return { type: "toggle", index: cur };
      if (row.kind === "error") return { type: "retry", index: cur };
      return null;
    }
  }

  if (e.key.length === 1 && e.key !== " ") {
    const fresh = ctx.typeAhead.buffer === "" || ctx.now - ctx.typeAhead.at > TYPE_AHEAD_RESET_MS;
    const buffer = (fresh ? "" : ctx.typeAhead.buffer) + e.key.toLowerCase();
    // A new prefix looks past the current row; an extended one may stay on it.
    const start = fresh ? cur + 1 : Math.max(cur, 0);
    const found = findByPrefix(rows, buffer, start);
    return { type: "type-ahead", index: found < 0 ? cur : found, typeAhead: { buffer, at: ctx.now } };
  }
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/composables/__tests__/fileTreeKeymap.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/fileTreeKeymap.ts apps/desktop/src/composables/__tests__/fileTreeKeymap.test.ts
git commit -m "feat(desktop): pure keyboard resolver for the Files view tree"
```

---

### Task 5: `useLazyRepoTree`, the tree model

**Files:**
- Create: `apps/desktop/src/composables/useLazyRepoTree.ts`
- Test: `apps/desktop/src/composables/__tests__/useLazyRepoTree.test.ts`

**Interfaces:**
- Consumes: the `RepoDirEntry` and `RepoDirListing` types from Task 2, `RepoChangeEvent` (`backend.ts:3431`), `RepoChangeKind` (`useRepoWatcher.ts:12`), and `RepoFileEntry { path; status: "added" | "modified" | "deleted" | "renamed"; section: "staged" | "unstaged" | "untracked" | "conflicted" }` (`useGitRepo.ts:92`). The live list is `allFiles` (`useGitRepo.ts:321`), aliased `repoFiles` in `App.vue:246`. A file both staged and modified appears in it twice.
- Produces:
  ```ts
  export const DIR_ENTRY_CAP = 5000;
  export const WATCH_DEBOUNCE_MS = 300;
  export const FILES_VIEW_STORAGE_PREFIX = "gitwand-files-view:";
  export type ListDirFn = (dir: string, includeIgnored: boolean) => Promise<RepoDirListing>;
  export interface TreeWatcher { on: (kinds: RepoChangeKind[], handler: (ev: RepoChangeEvent) => void) => () => void }
  export interface FileStatusInfo { status: RepoFileEntry["status"]; staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean; deletedOnDisk: boolean }
  export interface FolderBadge { changed: number; conflicted: boolean }
  export interface FolderRow { kind: "folder"; path; name; depth; expanded: boolean; ignored: boolean; deleted: boolean; badge: FolderBadge | null }
  export interface FileRow { kind: "file"; path; name; depth; ignored: boolean; symlink: boolean; deleted: boolean; size: number; status: FileStatusInfo | null }
  export interface PlaceholderRow { kind: "loading" | "truncated"; path /* the directory */; name: ""; depth }
  export interface ErrorRow { kind: "error"; path /* the directory */; name: ""; depth; message: string }
  export type LazyTreeRow = FolderRow | FileRow | PlaceholderRow | ErrorRow;
  export function parentOf(path: string): string;
  export function buildStatusMap(files: readonly RepoFileEntry[]): Map<string, FileStatusInfo>;
  export function useLazyRepoTree(opts: UseLazyRepoTreeOptions): {
    rows: ComputedRef<LazyTreeRow[]>; selected: Ref<string | null>; showIgnored: Ref<boolean>;
    statusByPath: ComputedRef<Map<string, FileStatusInfo>>;
    isExpanded(dir: string): boolean; expand(dir: string): Promise<void>; collapse(dir: string): void;
    toggle(dir: string): Promise<void>; retry(dir: string): Promise<void>; reveal(path: string): Promise<void>;
    folderBadge(dir: string): FolderBadge | null; changedUnder(dir: string): string[]; dispose(): void;
  };
  export type LazyRepoTree = ReturnType<typeof useLazyRepoTree>;
  ```

**Why the lister is injected.** AGENTS.md forbids mocking the git layer. The composable never talks to git: it receives `listDir` (FilesView passes `(dir, inc) => listRepoDir(repoPath, dir, inc)`), and its tests pass an in-memory map. That map stands in for the IPC wrapper, not for git. What a real directory lists as, ignore classification included, is pinned by Task 1 on real repos and by Task 2's parity test. This file tests only the tree logic layered on top.

**Deviations from spec §5, decided here:**
- `rows` is a new `LazyTreeRow` union, not `TreeRow`. The `TreeRow` type (`useFileTree.ts:20-31`) has `kind: "folder" | "file"` only, so it cannot carry the loading, error and truncated placeholders §5 requires.
- `showIgnored` is owned and returned by the composable rather than passed in, because §5 also makes the composable persist it.
- A tracked folder deleted on disk becomes a "ghost" folder row (`deleted: true`). Its children come only from `repoFiles` and it is never listed. Without this, `rm -rf src/foo` would make every deleted file under it invisible.
- A watcher event marks the event path's parent, and the path itself, for reload if they are loaded. A reload that fails on a non-root folder schedules its parent's reload, so a deleted expanded folder disappears instead of staying as an error row (Review Focus #2).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/useLazyRepoTree.test.ts`:

```ts
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
  FILES_VIEW_STORAGE_PREFIX,
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
    expect(JSON.parse(localStorage.getItem(`${FILES_VIEW_STORAGE_PREFIX}/repo`)!)).toEqual({
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/composables/__tests__/useLazyRepoTree.test.ts`
Expected: FAIL with `Failed to resolve import "../useLazyRepoTree"`.

- [ ] **Step 3: Implement the composable**

Create `apps/desktop/src/composables/useLazyRepoTree.ts`:

```ts
/**
 * useLazyRepoTree — the working-tree model behind the Files view (v3.11.2).
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
export const FILES_VIEW_STORAGE_PREFIX = "gitwand-files-view:";

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
  /** Defaults to `FILES_VIEW_STORAGE_PREFIX`; `null` turns persistence off. */
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
  const prefix = opts.storageKeyPrefix === undefined ? FILES_VIEW_STORAGE_PREFIX : opts.storageKeyPrefix;

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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/composables/__tests__/useLazyRepoTree.test.ts`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useLazyRepoTree.ts apps/desktop/src/composables/__tests__/useLazyRepoTree.test.ts
git commit -m "feat(desktop): useLazyRepoTree, a lazily listed working-tree model with live refresh"
```

---

### Task 6: `FileTreePane.vue`, the tree component

**Files:**
- Create: `apps/desktop/src/utils/revealLabel.ts`
- Create: `apps/desktop/src/utils/__tests__/revealLabel.test.ts`
- Create: `apps/desktop/src/components/FileTreePane.vue`
- Create: `apps/desktop/src/components/__tests__/FileTreePane.test.ts`
- Modify: `apps/desktop/src/locales/en.ts:2657`, `fr.ts:2626`, `es.ts:2616`, `pt-BR.ts:2616`, `zh-CN.ts:2625` (a new `filesView` group right after each locale's `files: { … },` group)

**Interfaces:**
- Consumes: `useVirtualRows({ count, getScrollElement, estimateSize, overscan }) → { virtualizer, virtualItems, totalSize, measure }` (`useVirtualRows.ts:27`; `virtualizer.value.scrollToIndex(i, { align })`, as `PrInlineDiff.vue:440` uses). Also `resolveFileTreeShortcut` and `TypeAheadState` (Task 4), and `LazyTreeRow`, `FileRow` and `DIR_ENTRY_CAP` (Task 5).
- Produces:
  - `revealLabelKey(platform?: string): "filesView.ctxRevealMac" | "filesView.ctxRevealWindows" | "filesView.ctxRevealLinux"`.
  - `<FileTreePane :rows :selected-path :show-ignored :label>`, which emits `select(path, kind)`, `toggle(path)`, `expand(path)`, `collapse(path)`, `retry(dir)`, `update:showIgnored(value)`, `scope-here(path)`, `copy-path(path)`, `reveal(path)` and `open-in-editor(path)`.
  - The locale group `filesView.{treeLabel, showIgnored, loading, loadError, retry, truncated, folderChanges, ctxScopeHere, ctxCopyPath, ctxRevealMac, ctxRevealWindows, ctxRevealLinux, ctxOpenInEditor, statusAdded, statusModified, statusDeleted, statusRenamed, statusUntracked, statusConflicted, statusIgnored}`.

- [ ] **Step 1: Add the locale keys (all five files)**

In `apps/desktop/src/locales/en.ts`, right after the closing `},` of the `files: {` group (line 2657), insert:

```ts
  // ─── v3.11.2 Files view ─────────────────────────────────
  filesView: {
    treeLabel: "Files in {0}",
    showIgnored: "Show ignored",
    loading: "Loading…",
    loadError: "Couldn't list this folder: {0}",
    retry: "Retry",
    truncated: "Only the first {0} entries are shown",
    folderChanges: "{0} changed below",
    ctxScopeHere: "Scope here",
    ctxCopyPath: "Copy path",
    ctxRevealMac: "Reveal in Finder",
    ctxRevealWindows: "Show in Explorer",
    ctxRevealLinux: "Open containing folder",
    ctxOpenInEditor: "Open in editor",
    statusAdded: "Added",
    statusModified: "Modified",
    statusDeleted: "Deleted",
    statusRenamed: "Renamed",
    statusUntracked: "Untracked",
    statusConflicted: "Conflicted",
    statusIgnored: "Ignored",
  },
```

In `fr.ts`, after the `files:` group (line 2626):

```ts
  // ─── v3.11.2 Files view ─────────────────────────────────
  filesView: {
    treeLabel: "Fichiers de {0}",
    showIgnored: "Afficher les ignorés",
    loading: "Chargement…",
    loadError: "Impossible de lister ce dossier\u00a0: {0}",
    retry: "Réessayer",
    truncated: "Seules les {0} premières entrées sont affichées",
    folderChanges: "{0} modifié(s) en dessous",
    ctxScopeHere: "Limiter le périmètre ici",
    ctxCopyPath: "Copier le chemin",
    ctxRevealMac: "Afficher dans le Finder",
    ctxRevealWindows: "Afficher dans l'Explorateur",
    ctxRevealLinux: "Ouvrir le dossier parent",
    ctxOpenInEditor: "Ouvrir dans l'éditeur",
    statusAdded: "Ajouté",
    statusModified: "Modifié",
    statusDeleted: "Supprimé",
    statusRenamed: "Renommé",
    statusUntracked: "Non suivi",
    statusConflicted: "En conflit",
    statusIgnored: "Ignoré",
  },
```

In `es.ts`, after the `files:` group (line 2616):

```ts
  // ─── v3.11.2 Files view ─────────────────────────────────
  filesView: {
    treeLabel: "Archivos de {0}",
    showIgnored: "Mostrar ignorados",
    loading: "Cargando…",
    loadError: "No se pudo listar esta carpeta: {0}",
    retry: "Reintentar",
    truncated: "Solo se muestran las primeras {0} entradas",
    folderChanges: "{0} cambiados debajo",
    ctxScopeHere: "Acotar aquí",
    ctxCopyPath: "Copiar ruta",
    ctxRevealMac: "Mostrar en Finder",
    ctxRevealWindows: "Mostrar en el Explorador",
    ctxRevealLinux: "Abrir la carpeta contenedora",
    ctxOpenInEditor: "Abrir en el editor",
    statusAdded: "Añadido",
    statusModified: "Modificado",
    statusDeleted: "Eliminado",
    statusRenamed: "Renombrado",
    statusUntracked: "Sin seguimiento",
    statusConflicted: "En conflicto",
    statusIgnored: "Ignorado",
  },
```

In `pt-BR.ts`, after the `files:` group (line 2616):

```ts
  // ─── v3.11.2 Files view ─────────────────────────────────
  filesView: {
    treeLabel: "Arquivos em {0}",
    showIgnored: "Mostrar ignorados",
    loading: "Carregando…",
    loadError: "Não foi possível listar esta pasta: {0}",
    retry: "Tentar novamente",
    truncated: "Apenas as primeiras {0} entradas são exibidas",
    folderChanges: "{0} alterados abaixo",
    ctxScopeHere: "Definir escopo aqui",
    ctxCopyPath: "Copiar caminho",
    ctxRevealMac: "Mostrar no Finder",
    ctxRevealWindows: "Mostrar no Explorer",
    ctxRevealLinux: "Abrir a pasta que contém",
    ctxOpenInEditor: "Abrir no editor",
    statusAdded: "Adicionado",
    statusModified: "Modificado",
    statusDeleted: "Excluído",
    statusRenamed: "Renomeado",
    statusUntracked: "Não rastreado",
    statusConflicted: "Em conflito",
    statusIgnored: "Ignorado",
  },
```

In `zh-CN.ts`, after the `files:` group (line 2625):

```ts
  // ─── v3.11.2 Files view ─────────────────────────────────
  filesView: {
    treeLabel: "{0} 中的文件",
    showIgnored: "显示已忽略",
    loading: "加载中…",
    loadError: "无法列出此文件夹：{0}",
    retry: "重试",
    truncated: "仅显示前 {0} 项",
    folderChanges: "下方有 {0} 处更改",
    ctxScopeHere: "限定到此处",
    ctxCopyPath: "复制路径",
    ctxRevealMac: "在访达中显示",
    ctxRevealWindows: "在资源管理器中显示",
    ctxRevealLinux: "打开所在文件夹",
    ctxOpenInEditor: "在编辑器中打开",
    statusAdded: "已添加",
    statusModified: "已修改",
    statusDeleted: "已删除",
    statusRenamed: "已重命名",
    statusUntracked: "未跟踪",
    statusConflicted: "有冲突",
    statusIgnored: "已忽略",
  },
```

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop/src/utils/__tests__/revealLabel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { revealLabelKey } from "../revealLabel";

describe("revealLabelKey", () => {
  it("names the platform's own file manager", () => {
    expect(revealLabelKey("MacIntel")).toBe("filesView.ctxRevealMac");
    expect(revealLabelKey("Win32")).toBe("filesView.ctxRevealWindows");
    expect(revealLabelKey("Linux x86_64")).toBe("filesView.ctxRevealLinux");
    expect(revealLabelKey("")).toBe("filesView.ctxRevealLinux");
  });
});
```

Create `apps/desktop/src/components/__tests__/FileTreePane.test.ts`:

```ts
// @vitest-environment jsdom
/**
 * FileTreePane — ARIA, keyboard dispatch and context menus. Rows are given as
 * props (the model is useLazyRepoTree's, tested on its own). jsdom has no
 * layout, so `@tanstack/vue-virtual` is replaced by a virtualizer that renders
 * every row; that is a UI-library stand-in, not a git one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import en from "../../locales/en";
import type { LazyTreeRow } from "../../composables/useLazyRepoTree";

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
        getVirtualItems: () =>
          Array.from({ length: inst.options.count }, (_, i) => ({ index: i, key: i, start: i * 24, size: 24 })),
        getTotalSize: () => inst.options.count * 24,
        measureElement: () => {},
        scrollToIndex: () => {},
      };
      const r = shallowRef(inst);
      return r;
    },
  };
});

import FileTreePane from "../FileTreePane.vue";

const MODIFIED = { status: "modified" as const, staged: false, unstaged: true, untracked: false, conflicted: false, deletedOnDisk: false };

const ROWS: LazyTreeRow[] = [
  { kind: "folder", path: "src", name: "src", depth: 0, expanded: true, ignored: false, deleted: false, badge: { changed: 1, conflicted: false } },
  { kind: "folder", path: "src/lib", name: "lib", depth: 1, expanded: true, ignored: false, deleted: false, badge: null },
  { kind: "error", path: "src/lib", name: "", depth: 2, message: "denied" },
  { kind: "file", path: "src/a.ts", name: "a.ts", depth: 1, ignored: false, symlink: false, deleted: false, size: 3, status: MODIFIED },
  { kind: "folder", path: "docs", name: "docs", depth: 0, expanded: false, ignored: false, deleted: false, badge: null },
  { kind: "file", path: "README.md", name: "README.md", depth: 0, ignored: true, symlink: false, deleted: false, size: 9, status: null },
];

const REVEAL_LABELS = [en.filesView.ctxRevealMac, en.filesView.ctxRevealWindows, en.filesView.ctxRevealLinux];

let app: App | null = null;
let container: HTMLElement;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

async function mount(props: { selectedPath?: string | null; showIgnored?: boolean } = {}) {
  const events: Array<[string, ...unknown[]]> = [];
  const on = (name: string) => (...args: unknown[]) => {
    events.push([name, ...args]);
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(FileTreePane, {
          rows: ROWS,
          selectedPath: props.selectedPath ?? null,
          showIgnored: props.showIgnored ?? false,
          label: "repo",
          onSelect: on("select"),
          onToggle: on("toggle"),
          onExpand: on("expand"),
          onCollapse: on("collapse"),
          onRetry: on("retry"),
          "onUpdate:showIgnored": on("update:showIgnored"),
          onScopeHere: on("scope-here"),
          onCopyPath: on("copy-path"),
          onReveal: on("reveal"),
          onOpenInEditor: on("open-in-editor"),
        }),
    }),
  );
  app.mount(container);
  await nextTick();
  await nextTick();
  return events;
}

const tree = () => container.querySelector<HTMLElement>("[role=tree]")!;
const items = () => [...container.querySelectorAll<HTMLElement>("[role=treeitem]")];
const menuLabels = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].map((b) => b.textContent?.trim());
function key(k: string, init: KeyboardEventInit = {}) {
  tree().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
}

describe("FileTreePane — ARIA", () => {
  it("is a single-tab-stop tree whose active descendant is the selected row", async () => {
    await mount({ selectedPath: "src/a.ts" });
    expect(tree().getAttribute("tabindex")).toBe("0");
    expect(tree().getAttribute("aria-label")).toBe(en.filesView.treeLabel.replace("{0}", "repo"));
    expect(tree().getAttribute("aria-activedescendant")).toBe(items()[3]!.id);
    expect(items()[3]!.getAttribute("aria-selected")).toBe("true");
    expect(items()[0]!.getAttribute("aria-selected")).toBe("false");
  });

  it("gives folders aria-expanded and every row its level", async () => {
    await mount();
    expect(items()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(items()[4]!.getAttribute("aria-expanded")).toBe("false");
    expect(items()[3]!.hasAttribute("aria-expanded")).toBe(false);
    expect(items().map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2", "3", "2", "1", "1"]);
  });

  it("greys out an ignored row", async () => {
    await mount();
    expect(items()[5]!.classList.contains("ftp__row--ignored")).toBe(true);
  });
});

describe("FileTreePane — keyboard", () => {
  it("↓ selects the next row and ← climbs to the parent", async () => {
    const events = await mount({ selectedPath: "src/a.ts" });
    key("ArrowDown");
    expect(events.at(-1)).toEqual(["select", "docs", "folder"]);
    key("ArrowUp");
    key("ArrowLeft");
    expect(events.at(-1)).toEqual(["select", "src", "folder"]);
  });

  it("Enter toggles a folder", async () => {
    const events = await mount({ selectedPath: "docs" });
    key("Enter");
    expect(events.at(-1)).toEqual(["toggle", "docs"]);
  });

  it("clicking an error row retries its folder", async () => {
    const events = await mount();
    items()[2]!.click();
    expect(events.at(-1)).toEqual(["retry", "src/lib"]);
  });
});

describe("FileTreePane — context menu", () => {
  it("offers Scope here, Copy path and Reveal on a folder", async () => {
    const events = await mount();
    items()[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await nextTick();
    const labels = menuLabels();
    expect(labels.slice(0, 2)).toEqual([en.filesView.ctxScopeHere, en.filesView.ctxCopyPath]);
    expect(REVEAL_LABELS).toContain(labels[2]);
    document.querySelector<HTMLElement>("[role=menuitem]")!.click();
    expect(events.at(-1)).toEqual(["scope-here", "src"]);
    await nextTick();
    expect(document.querySelector("[role=menu]")).toBeNull();
  });

  it("offers Open in editor, Copy path and Reveal on a file, also from ⇧F10", async () => {
    const events = await mount({ selectedPath: "src/a.ts" });
    key("F10", { shiftKey: true });
    await nextTick();
    const labels = menuLabels();
    expect(labels.slice(0, 2)).toEqual([en.filesView.ctxOpenInEditor, en.filesView.ctxCopyPath]);
    expect(REVEAL_LABELS).toContain(labels[2]);
    document.querySelectorAll<HTMLElement>("[role=menuitem]")[1]!.click();
    expect(events.at(-1)).toEqual(["copy-path", "src/a.ts"]);
  });
});

describe("FileTreePane — Show ignored", () => {
  it("emits the new value", async () => {
    const events = await mount();
    const box = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(events.at(-1)).toEqual(["update:showIgnored", true]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/revealLabel.test.ts src/components/__tests__/FileTreePane.test.ts`
Expected: FAIL with `Failed to resolve import "../revealLabel"` and `Failed to resolve import "../FileTreePane.vue"`.

- [ ] **Step 4: Implement `revealLabel.ts`**

Create `apps/desktop/src/utils/revealLabel.ts`:

```ts
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
```

- [ ] **Step 5: Implement `FileTreePane.vue`**

Create `apps/desktop/src/components/FileTreePane.vue`:

```vue
<script setup lang="ts">
/**
 * FileTreePane — the Files view's tree (v3.11.2).
 *
 * Virtualized rows (`useVirtualRows`), one tab stop with
 * `aria-activedescendant`, the keyboard model of `fileTreeKeymap.ts`, and a
 * component-local context menu (the `ctxMenu` pattern of CommitGraph.vue).
 * It owns no data: rows come from `useLazyRepoTree` through FilesView, and
 * every action is emitted. The cursor is local because a placeholder row
 * (error, truncated) can hold it without being a selection.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "../composables/useI18n";
import { useVirtualRows } from "../composables/useVirtualRows";
import { resolveFileTreeShortcut, type FileTreeAction, type TypeAheadState } from "../composables/fileTreeKeymap";
import { DIR_ENTRY_CAP, type FileRow, type LazyTreeRow } from "../composables/useLazyRepoTree";
import { revealLabelKey } from "../utils/revealLabel";

const props = defineProps<{
  rows: LazyTreeRow[];
  selectedPath: string | null;
  showIgnored: boolean;
  /** Repo name, or the scope folder: names the tree for assistive tech. */
  label: string;
}>();

const emit = defineEmits<{
  select: [path: string, kind: "file" | "folder"];
  toggle: [path: string];
  expand: [path: string];
  collapse: [path: string];
  retry: [dir: string];
  "update:showIgnored": [value: boolean];
  "scope-here": [path: string];
  "copy-path": [path: string];
  reveal: [path: string];
  "open-in-editor": [path: string];
}>();

const { t } = useI18n();

const ROW_HEIGHT = 24;
const scrollEl = ref<HTMLElement | null>(null);
const { virtualizer, virtualItems, totalSize, measure } = useVirtualRows({
  count: computed(() => props.rows.length),
  getScrollElement: () => scrollEl.value,
  estimateSize: () => ROW_HEIGHT,
  overscan: 12,
});
const view = computed(() =>
  virtualItems.value
    .map((vr) => ({ vr, row: props.rows[vr.index] }))
    .filter((x): x is { vr: (typeof virtualItems.value)[number]; row: LazyTreeRow } => x.row !== undefined),
);

const uid = `ftp-${Math.random().toString(36).slice(2, 8)}`;
function rowId(i: number): string {
  return `${uid}-row-${i}`;
}

const cursor = ref(-1);
let typeAhead: TypeAheadState = { buffer: "", at: 0 };

function isNamed(r: LazyTreeRow | undefined): r is Extract<LazyTreeRow, { kind: "file" | "folder" }> {
  return r !== undefined && (r.kind === "file" || r.kind === "folder");
}

// Follow the selection when rows are rebuilt (a reload, a re-root).
watch(
  () => [props.selectedPath, props.rows] as const,
  ([sel, rows]) => {
    if (sel !== null) {
      const i = rows.findIndex((r) => r.path === sel && isNamed(r));
      if (i >= 0) {
        cursor.value = i;
        return;
      }
    }
    if (cursor.value >= rows.length) cursor.value = rows.length - 1;
  },
  { immediate: true },
);

const activeId = computed(() =>
  cursor.value >= 0 && cursor.value < props.rows.length ? rowId(cursor.value) : undefined,
);

function moveTo(i: number): void {
  if (i < 0 || i >= props.rows.length) return;
  cursor.value = i;
  virtualizer.value?.scrollToIndex(i, { align: "auto" });
  const r = props.rows[i];
  if (isNamed(r)) emit("select", r.path, r.kind);
}

function apply(a: FileTreeAction): void {
  const r = props.rows[a.index];
  switch (a.type) {
    case "move":
      moveTo(a.index);
      break;
    case "type-ahead":
      typeAhead = a.typeAhead;
      moveTo(a.index);
      break;
    case "expand":
      if (r) emit("expand", r.path);
      break;
    case "collapse":
      if (r) emit("collapse", r.path);
      break;
    case "toggle":
      if (r) emit("toggle", r.path);
      break;
    case "open":
      if (r?.kind === "file") emit("select", r.path, "file");
      break;
    case "retry":
      if (r) emit("retry", r.path);
      break;
    case "context-menu":
      void openMenuForIndex(a.index);
      break;
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (menu.value) return; // the menu owns the keyboard while open
  const action = resolveFileTreeShortcut(e, {
    rows: props.rows,
    cursor: cursor.value,
    typeAhead,
    now: Date.now(),
  });
  if (!action) return;
  e.preventDefault();
  apply(action);
}

function onRowClick(i: number): void {
  const r = props.rows[i];
  if (r?.kind === "error") {
    cursor.value = i;
    emit("retry", r.path);
    return;
  }
  moveTo(i);
}

function onChevronClick(e: MouseEvent, i: number): void {
  e.stopPropagation();
  const r = props.rows[i];
  cursor.value = i;
  if (r?.kind === "folder") emit("toggle", r.path);
}

function onRowDblClick(i: number): void {
  const r = props.rows[i];
  if (r?.kind === "folder") emit("toggle", r.path);
  else if (r?.kind === "file" && !r.deleted) emit("open-in-editor", r.path);
}

// ── Status presentation ────────────────────────────────────
type StatusKey = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
const STATUS_LETTER: Record<StatusKey, string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U", conflicted: "C",
};
const STATUS_LABEL = {
  added: "filesView.statusAdded",
  modified: "filesView.statusModified",
  deleted: "filesView.statusDeleted",
  renamed: "filesView.statusRenamed",
  untracked: "filesView.statusUntracked",
  conflicted: "filesView.statusConflicted",
} as const;

function statusKey(row: FileRow): StatusKey | null {
  const s = row.status;
  if (!s) return null;
  if (s.conflicted) return "conflicted";
  if (s.untracked && !s.staged && !s.unstaged) return "untracked";
  return s.status;
}
function statusTitle(row: FileRow): string {
  const k = statusKey(row);
  if (k) return t(STATUS_LABEL[k]);
  return row.ignored ? t("filesView.statusIgnored") : "";
}

function rowClass(row: LazyTreeRow, index: number) {
  const named = isNamed(row) ? row : null;
  return {
    "ftp__row--active": index === cursor.value,
    "ftp__row--folder": row.kind === "folder",
    "ftp__row--ignored": named?.ignored ?? false,
    "ftp__row--deleted": named?.deleted ?? false,
  };
}
function rowStyle(start: number, depth: number) {
  return { transform: `translateY(${start}px)`, paddingLeft: `${depth * 14 + 6}px` };
}

// ── Context menu ───────────────────────────────────────────
type MenuId = "scope" | "copy" | "reveal" | "editor";
const menu = ref<{ x: number; y: number; index: number } | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuRow = computed(() => (menu.value ? (props.rows[menu.value.index] ?? null) : null));

const menuItems = computed<Array<{ id: MenuId; label: string }>>(() => {
  const r = menuRow.value;
  if (!isNamed(r)) return [];
  const out: Array<{ id: MenuId; label: string }> = [];
  if (r.kind === "folder") {
    if (!r.deleted) out.push({ id: "scope", label: t("filesView.ctxScopeHere") });
  } else if (!r.deleted) {
    out.push({ id: "editor", label: t("filesView.ctxOpenInEditor") });
  }
  out.push({ id: "copy", label: t("filesView.ctxCopyPath") });
  if (!r.deleted) out.push({ id: "reveal", label: t(revealLabelKey()) });
  return out;
});

async function openMenu(index: number, x: number, y: number): Promise<void> {
  if (!isNamed(props.rows[index])) return;
  cursor.value = index;
  menu.value = { x, y, index };
  await nextTick();
  const el = menuEl.value;
  if (el && menu.value) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    menu.value = {
      ...menu.value,
      x: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
    };
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }
  // After this event cycle, or the opening right-click closes it at once.
  setTimeout(() => window.addEventListener("pointerdown", onOutside, true), 0);
}

function onRowContextMenu(e: MouseEvent, i: number): void {
  e.preventDefault();
  void openMenu(i, e.clientX, e.clientY);
}

async function openMenuForIndex(i: number): Promise<void> {
  const rect = document.getElementById(rowId(i))?.getBoundingClientRect();
  await openMenu(i, (rect?.left ?? 0) + 24, rect?.bottom ?? 0);
}

function closeMenu(refocus = true): void {
  menu.value = null;
  window.removeEventListener("pointerdown", onOutside, true);
  if (refocus) scrollEl.value?.focus();
}

function onOutside(e: PointerEvent): void {
  if (!(e.target as HTMLElement | null)?.closest?.(".ftp-menu")) closeMenu(false);
}

function onMenuKeydown(e: KeyboardEvent): void {
  const buttons = [...(menuEl.value?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  const i = buttons.indexOf(document.activeElement as HTMLElement);
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    buttons[(i + 1) % buttons.length]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
  }
}

function runMenu(id: MenuId): void {
  const r = menuRow.value;
  closeMenu();
  if (!isNamed(r)) return;
  if (id === "scope") emit("scope-here", r.path);
  else if (id === "copy") emit("copy-path", r.path);
  else if (id === "reveal") emit("reveal", r.path);
  else emit("open-in-editor", r.path);
}

onBeforeUnmount(() => window.removeEventListener("pointerdown", onOutside, true));
</script>

<template>
  <div class="ftp">
    <div class="ftp__toolbar">
      <label class="ftp__ignored">
        <input
          type="checkbox"
          :checked="showIgnored"
          @change="emit('update:showIgnored', ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ t('filesView.showIgnored') }}</span>
      </label>
    </div>

    <div
      ref="scrollEl"
      class="ftp__scroll"
      role="tree"
      tabindex="0"
      :aria-label="t('filesView.treeLabel', label)"
      :aria-activedescendant="activeId"
      @keydown="onKeydown"
    >
      <div class="ftp__sizer" :style="{ height: `${totalSize}px` }">
        <div
          v-for="{ vr, row } in view"
          :id="rowId(vr.index)"
          :key="`${row.kind}:${row.path}`"
          :ref="(el) => measure(el as Element)"
          :data-index="vr.index"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-selected="vr.index === cursor"
          :aria-expanded="row.kind === 'folder' ? row.expanded : undefined"
          :aria-busy="row.kind === 'loading' ? true : undefined"
          class="ftp__row"
          :class="rowClass(row, vr.index)"
          :style="rowStyle(vr.start, row.depth)"
          @click="onRowClick(vr.index)"
          @dblclick="onRowDblClick(vr.index)"
          @contextmenu="onRowContextMenu($event, vr.index)"
        >
          <template v-if="row.kind === 'folder'">
            <span
              class="ftp__chevron"
              :class="{ 'ftp__chevron--open': row.expanded }"
              aria-hidden="true"
              @click="onChevronClick($event, vr.index)"
            >▸</span>
            <span class="ftp__name">{{ row.name }}</span>
            <span
              v-if="row.badge"
              class="ftp__badge"
              :class="{ 'ftp__badge--conflicted': row.badge.conflicted }"
              :title="t('filesView.folderChanges', row.badge.changed)"
            >{{ row.badge.changed }}</span>
          </template>
          <template v-else-if="row.kind === 'file'">
            <span
              class="ftp__status"
              :class="statusKey(row) ? `ftp__status--${statusKey(row)}` : ''"
              :title="statusTitle(row) || undefined"
              aria-hidden="true"
            >{{ statusKey(row) ? STATUS_LETTER[statusKey(row)!] : '' }}</span>
            <span class="ftp__name">{{ row.name }}</span>
            <span v-if="statusTitle(row)" class="ftp__sr">{{ statusTitle(row) }}</span>
          </template>
          <span v-else-if="row.kind === 'loading'" class="ftp__placeholder">{{ t('filesView.loading') }}</span>
          <span v-else-if="row.kind === 'error'" class="ftp__placeholder ftp__placeholder--error" :title="row.message">
            {{ t('filesView.loadError', row.message) }} · {{ t('filesView.retry') }}
          </span>
          <span v-else class="ftp__placeholder">{{ t('filesView.truncated', DIR_ENTRY_CAP.toLocaleString()) }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="menu && menuItems.length"
      ref="menuEl"
      class="ftp-menu"
      role="menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @keydown="onMenuKeydown"
    >
      <button
        v-for="item in menuItems"
        :key="item.id"
        type="button"
        role="menuitem"
        class="ftp-menu__item"
        @click="runMenu(item.id)"
      >{{ item.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.ftp { display: flex; flex-direction: column; min-height: 0; min-width: 0; border-right: 1px solid var(--color-border); }
.ftp__toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--color-border); font-size: 12px; color: var(--color-text-muted); }
.ftp__ignored { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.ftp__scroll { flex: 1; min-height: 0; overflow: auto; outline: none; }
.ftp__scroll:focus-visible { box-shadow: inset 0 0 0 2px var(--color-accent); }
.ftp__sizer { position: relative; width: 100%; }
.ftp__row { position: absolute; top: 0; left: 0; width: 100%; height: 24px; display: flex; align-items: center; gap: 6px; padding-right: 8px; font-size: 12px; cursor: default; white-space: nowrap; box-sizing: border-box; }
.ftp__row:hover { background: var(--color-bg-hover, rgba(127, 127, 127, 0.08)); }
.ftp__row--active { background: var(--color-bg-selected, rgba(127, 127, 127, 0.16)); }
.ftp__row--ignored { opacity: 0.5; }
.ftp__row--deleted .ftp__name { text-decoration: line-through; }
.ftp__chevron { display: inline-block; width: 12px; transition: transform 0.1s; cursor: pointer; }
.ftp__chevron--open { transform: rotate(90deg); }
.ftp__name { overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); }
.ftp__badge { margin-left: auto; min-width: 16px; padding: 0 4px; border-radius: var(--radius-sm); font-size: 10px; text-align: center; background: var(--color-status-modified, var(--color-accent)); color: var(--color-bg); }
.ftp__badge--conflicted { background: var(--color-danger); }
.ftp__status { width: 12px; font-size: 10px; font-weight: 600; text-align: center; }
.ftp__status--added, .ftp__status--untracked, .ftp__status--renamed { color: var(--color-status-added); }
.ftp__status--modified { color: var(--color-status-modified, var(--color-accent)); }
.ftp__status--deleted, .ftp__status--conflicted { color: var(--color-danger); }
.ftp__placeholder { color: var(--color-text-muted); font-style: italic; }
.ftp__placeholder--error { color: var(--color-danger); cursor: pointer; }
.ftp__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ftp-menu { position: fixed; z-index: 1000; min-width: 180px; padding: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-elevated, var(--color-bg)); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25); display: flex; flex-direction: column; }
.ftp-menu__item { text-align: left; padding: 6px 10px; border: 0; border-radius: var(--radius-sm); background: transparent; color: inherit; font-size: 12px; cursor: pointer; }
.ftp-menu__item:hover, .ftp-menu__item:focus-visible { background: var(--color-bg-hover, rgba(127, 127, 127, 0.12)); outline: none; }
</style>
```

- [ ] **Step 6: Run the tests and the type-check**

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/revealLabel.test.ts src/components/__tests__/FileTreePane.test.ts`
Expected: PASS (1 + 9).

Run: `pnpm --filter @gitwand/core build && cd apps/desktop && pnpm exec vue-tsc --noEmit`
Expected: exit 0. All five locale objects satisfy `Locale` because every locale got the same `filesView` keys.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/utils/revealLabel.ts apps/desktop/src/utils/__tests__/revealLabel.test.ts apps/desktop/src/components/FileTreePane.vue apps/desktop/src/components/__tests__/FileTreePane.test.ts apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): FileTreePane, a virtualized keyboard-operable tree with a context menu"
```

---

### Task 7: `getGitDiff` forwards the optional fields on the Tauri path

**Files:**
- Modify: `apps/desktop/src/utils/backend.ts:553-591` (`getGitDiff`, Tauri branch)
- Modify: `CHANGELOG.md:9-11` (`## [Unreleased]` → `### Fixed`)
- Test: `apps/desktop/src/utils/__tests__/backend-files-view.test.ts`

**Interfaces:**
- Consumes: the Rust `GitDiff` serialization (`src-tauri/src/types.rs:98-121`). Its optional fields are already camelCase on the wire: `status`, `oldPath`, `truncatedFromBytes`, `isDirectory`, `newFiles` and `nestedRepo`.
- Produces: `getGitDiff(cwd, path, staged): Promise<GitDiff>`, which now carries those fields in both backends. `GitDiff` itself (`backend.ts:517-548`) is unchanged.

**Why this is in scope:** the preview's "diff over 5 MB" row (spec §7) reads `truncatedFromBytes`, and the Tauri branch of `getGitDiff` rebuilds the object from `path` and `hunks` only. The same drop is why `DiffViewer`'s untracked-directory and nested-repo panel (issue #183, `DiffViewer.vue:947-965`) never renders in the packaged app while it does under `dev:web`.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/utils/__tests__/backend-files-view.test.ts`:

```ts
describe("getGitDiff — Tauri path", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = true;
  });

  it("keeps the truncation marker the Rust command sends", async () => {
    tauriInvoke.mockResolvedValue({ path: "big.sql", hunks: [], truncatedFromBytes: 7_340_032 });
    const { getGitDiff } = await import("../backend");
    const diff = await getGitDiff("/repo", "big.sql", false);
    expect(diff.truncatedFromBytes).toBe(7_340_032);
  });

  it("keeps the directory, nested-repo, status and rename fields", async () => {
    tauriInvoke.mockResolvedValue({
      path: "vendor/",
      hunks: [],
      status: "renamed",
      oldPath: "old/",
      isDirectory: true,
      newFiles: ["vendor/a.txt"],
      nestedRepo: true,
    });
    const { getGitDiff } = await import("../backend");
    const diff = await getGitDiff("/repo", "vendor/", false);
    expect(diff).toMatchObject({
      status: "renamed",
      oldPath: "old/",
      isDirectory: true,
      newFiles: ["vendor/a.txt"],
      nestedRepo: true,
    });
  });

  it("still maps hunks from snake_case", async () => {
    tauriInvoke.mockResolvedValue({
      path: "a.ts",
      hunks: [{ header: "@@", old_start: 1, old_count: 1, new_start: 1, new_count: 1, lines: [{ type: "add", content: "x", new_line_no: 1 }] }],
    });
    const { getGitDiff } = await import("../backend");
    const diff = await getGitDiff("/repo", "a.ts", false);
    expect(diff.hunks[0]).toEqual({
      header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
      lines: [{ type: "add", content: "x", oldLineNo: undefined, newLineNo: 1 }],
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/backend-files-view.test.ts`
Expected: FAIL. The first two new tests fail (`expected undefined to be 7340032`, and a `toMatchObject` mismatch); the hunk-mapping test passes.

- [ ] **Step 3: Forward the fields**

In `apps/desktop/src/utils/backend.ts`, inside `getGitDiff`'s Tauri branch, extend the `tauriInvoke` type parameter so that, after `path: string;`, it reads:

```ts
      path: string;
      status?: GitDiff["status"];
      oldPath?: string;
      truncatedFromBytes?: number;
      isDirectory?: boolean;
      newFiles?: string[];
      nestedRepo?: boolean;
```

Then replace the `return { path: raw.path, hunks: … };` object with:

```ts
    return {
      path: raw.path,
      // Already camelCase on the wire (explicit serde renames in types.rs).
      // Dropping them hid the 5 MB truncation banner and the untracked-
      // directory / nested-repo panel (issue #183) in the packaged app only.
      status: raw.status,
      oldPath: raw.oldPath,
      truncatedFromBytes: raw.truncatedFromBytes,
      isDirectory: raw.isDirectory,
      newFiles: raw.newFiles,
      nestedRepo: raw.nestedRepo,
      hunks: raw.hunks.map((h) => ({
        header: h.header,
        oldStart: h.old_start,
        oldCount: h.old_count,
        newStart: h.new_start,
        newCount: h.new_count,
        lines: h.lines.map((l) => ({
          type: l.type as "context" | "add" | "delete",
          content: l.content,
          oldLineNo: l.old_line_no,
          newLineNo: l.new_line_no,
        })),
      })),
    };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/utils/__tests__/backend-files-view.test.ts src/components/__tests__/DiffViewer-nested-repo.test.ts`
Expected: PASS (8 in `backend-files-view.test.ts`; `DiffViewer-nested-repo.test.ts` unchanged and green).

- [ ] **Step 5: Record the fix in the changelog**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, after the existing AppImage bullet (keep it), add:

```markdown
- **Three diff panels never appeared in the packaged app.** On the desktop path, `getGitDiff` rebuilt the diff from its path and hunks only, and dropped every other field the Rust command sends. So the "diff truncated at 5 MB" banner, the untracked-directory panel and the nested-repository panel (issue #183) never rendered, while they did under `pnpm dev:web`. The wrapper now passes those fields through.
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/utils/backend.ts apps/desktop/src/utils/__tests__/backend-files-view.test.ts CHANGELOG.md
git commit -m "fix(desktop): getGitDiff keeps truncation, directory and nested-repo fields under Tauri"
```

---

### Task 8: `useFilePreview`, what the preview shows

**Files:**
- Create: `apps/desktop/src/composables/useFilePreview.ts`
- Test: `apps/desktop/src/composables/__tests__/useFilePreview.test.ts`

**Interfaces:**
- Consumes:
  - from Task 5: `FileStatusInfo`, `TreeWatcher` and `WATCH_DEBOUNCE_MS`;
  - `FileAtRevision { bytesBase64; byteLength; mime; absent }` (`backend.ts:221`);
  - `GitDiff`, which carries `truncatedFromBytes` after Task 7 (`backend.ts:517`).
- Produces:
  ```ts
  export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
  export type PreviewTarget =
    | { kind: "folder"; path: string }
    | { kind: "file"; path: string; size: number; symlink: boolean; status: FileStatusInfo | null };
  export type DiffSide = "worktree" | "index";
  export type PreviewPlan =
    | { kind: "folder" } | { kind: "conflicted" } | { kind: "symlink" }
    | { kind: "too-large"; size: number } | { kind: "content" }
    | { kind: "diff"; staged: boolean; canSwitch: boolean };
  export type PreviewBody =
    | { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }
    | { kind: "folder" } | { kind: "conflicted" } | { kind: "symlink" } | { kind: "gone" }
    | { kind: "placeholder"; reason: "too-large" | "binary" | "non-utf8" | "no-text-diff"; size: number }
    | { kind: "text"; content: string } | { kind: "diff"; diff: GitDiff };
  export interface PreviewLoaders {
    readFile: (cwd: string, path: string) => Promise<FileAtRevision>;
    getDiff: (cwd: string, path: string, staged: boolean) => Promise<GitDiff>;
  }
  export function planPreview(target: PreviewTarget, side: DiffSide): PreviewPlan;
  export function decodeText(bytesBase64: string): { ok: true; text: string } | { ok: false; reason: "binary" | "non-utf8" };
  export function formatBytes(n: number): string;
  export function useFilePreview(opts: { cwd: Readonly<Ref<string>>; target: Readonly<Ref<PreviewTarget | null>>; loaders: PreviewLoaders; watcher?: TreeWatcher | null; debounceMs?: number }):
    { side: Ref<DiffSide>; plan: ComputedRef<PreviewPlan | null>; body: ShallowRef<PreviewBody>; retry: () => Promise<void>; dispose: () => void };
  ```

**Additions to the spec §7 table, decided here:**
- **An unchanged symlink is a placeholder.** It is never read, because its target may be outside the repo (Review Focus #4).
- **An unchanged or untracked file larger than 5 MB** (from `RepoDirEntry.size`) is refused before any read. Otherwise selecting a 2 GB file would base64 the whole thing through IPC.
- **A diff with no hunks** (binary, or a mode-only change) shows the "no textual changes" placeholder.
- **An unchanged file that vanished** (`absent: true`) shows "Deleted from disk" (spec §8).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/useFilePreview.test.ts`:

```ts
/**
 * useFilePreview — the spec §7 decision table, text decoding, the selection
 * race guard and the watcher reload. Loaders are injected stand-ins for the
 * `readFileAtRevision` / `getGitDiff` IPC wrappers, whose own outputs are
 * covered by the git-diff and read-file parity suites.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { effectScope, nextTick, ref, type EffectScope, type Ref } from "vue";
import {
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
function run(target: Ref<PreviewTarget | null>, l: PreviewLoaders, watcher: TreeWatcher | null = null) {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => useFilePreview({ cwd: ref("/repo"), target, loaders: l, watcher }))!;
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/composables/__tests__/useFilePreview.test.ts`
Expected: FAIL with `Failed to resolve import "../useFilePreview"`.

- [ ] **Step 3: Implement the composable**

Create `apps/desktop/src/composables/useFilePreview.ts`:

```ts
/**
 * useFilePreview — what the Files view's preview pane shows (v3.11.2).
 *
 * `planPreview` is the spec §7 table as a pure function: a selection and a
 * Working tree | Index side in, a plan out. `useFilePreview` runs the plan
 * through injected loaders and guards against the race that matters while
 * arrowing through the tree: every load carries a request id, and a response
 * for an earlier selection is dropped. It reloads through the watcher when the
 * previewed file changes on disk, and an error is always shown as an error,
 * never as an empty body.
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

  const plan = computed<PreviewPlan | null>(() =>
    opts.target.value ? planPreview(opts.target.value, side.value) : null,
  );
  /** Primitive, so the load watcher never needs to be deep. */
  const loadKey = computed(() => {
    const t = opts.target.value;
    const p = plan.value;
    return t && p ? `${opts.cwd.value}\u0000${t.path}\u0000${JSON.stringify(p)}` : "";
  });

  async function load(): Promise<void> {
    const id = ++requestId;
    const t = opts.target.value;
    const p = plan.value;
    if (!t || !p) {
      body.value = { kind: "idle" };
      return;
    }
    if (p.kind === "folder" || p.kind === "conflicted" || p.kind === "symlink") {
      body.value = { kind: p.kind };
      return;
    }
    if (p.kind === "too-large") {
      body.value = { kind: "placeholder", reason: "too-large", size: p.size };
      return;
    }
    body.value = { kind: "loading" };
    try {
      if (p.kind === "content") {
        const file = await opts.loaders.readFile(opts.cwd.value, t.path);
        if (id !== requestId) return;
        if (file.absent) {
          body.value = { kind: "gone" };
          return;
        }
        if (file.byteLength > PREVIEW_MAX_BYTES) {
          body.value = { kind: "placeholder", reason: "too-large", size: file.byteLength };
          return;
        }
        const decoded = decodeText(file.bytesBase64);
        body.value = decoded.ok
          ? { kind: "text", content: decoded.text }
          : { kind: "placeholder", reason: decoded.reason, size: file.byteLength };
        return;
      }
      const diff = await opts.loaders.getDiff(opts.cwd.value, t.path, p.staged);
      if (id !== requestId) return;
      if (diff.truncatedFromBytes) {
        body.value = { kind: "placeholder", reason: "too-large", size: diff.truncatedFromBytes };
      } else if (diff.hunks.length === 0) {
        body.value = { kind: "placeholder", reason: "no-text-diff", size: t.kind === "file" ? t.size : 0 };
      } else {
        body.value = { kind: "diff", diff };
      }
    } catch (err) {
      if (id !== requestId) return;
      body.value = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Declared before the load watcher so a new selection loads once, on the working tree.
  watch(
    () => opts.target.value?.path ?? null,
    () => {
      side.value = "worktree";
    },
  );
  watch(loadKey, () => void load(), { immediate: true });

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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/composables/__tests__/useFilePreview.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useFilePreview.ts apps/desktop/src/composables/__tests__/useFilePreview.test.ts
git commit -m "feat(desktop): useFilePreview picks the preview body by status, race-guarded"
```

---

### Task 9: `FilePreviewPane.vue`

**Files:**
- Create: `apps/desktop/src/components/FilePreviewPane.vue`
- Create: `apps/desktop/src/components/__tests__/FilePreviewPane.test.ts`
- Modify: the `filesView` group of each locale: `en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts` (a nested `preview` group as its last member)

**Interfaces:**
- Consumes:
  - from Task 8: `useFilePreview`, `formatBytes` and `PreviewTarget`;
  - from Task 5: `TreeWatcher`;
  - from Task 6: `revealLabelKey`;
  - `readFileAtRevision(cwd, rev, path)` (`backend.ts:245`) and `getGitDiff(cwd, path, staged)` (`backend.ts:553`);
  - `CodeEditor` props `{ modelValue, filePath, readonly, minLines, maxLines, ariaLabel }` (`CodeEditor.vue:30-41`);
  - `DiffViewer` props `{ diff, filePath, diffMode }` (`DiffViewer.vue:24-54`; it stays non-`editable` and non-`selectable` by default).
- Produces:
  - `<FilePreviewPane :cwd :target :changed-below :watcher>`, which emits `select-path(path)`, `open-in-editor(path)`, `reveal(path)` and `open-merge-editor(path)`;
  - the locale keys `filesView.preview.{noSelection, pathLabel, error, sideLabel, sideWorktree, sideIndex, conflicted, openMergeEditor, tooLarge, binary, nonUtf8, noTextDiff, gone, symlink, folderChanged, folderClean, folderMore}`.

- [ ] **Step 1: Add the locale keys (all five files)**

In each locale, insert as the last member of the `filesView: { … }` group, right after `statusIgnored: …,`:

`en.ts`:
```ts
    preview: {
      noSelection: "Select a file or folder to preview it",
      pathLabel: "Path",
      error: "Couldn't load the preview: {0}",
      sideLabel: "Compare",
      sideWorktree: "Working tree",
      sideIndex: "Index",
      conflicted: "This file has merge conflicts.",
      openMergeEditor: "Open in merge editor",
      tooLarge: "Too large to preview ({0})",
      binary: "Not a text file ({0})",
      nonUtf8: "Not UTF-8 text ({0})",
      noTextDiff: "No textual changes to show ({0})",
      gone: "Deleted from disk",
      symlink: "Symbolic link — GitWand does not follow it",
      folderChanged: "{0} changed files below this folder",
      folderClean: "No changes below this folder",
      folderMore: "and {0} more",
    },
```
`fr.ts`:
```ts
    preview: {
      noSelection: "Sélectionnez un fichier ou un dossier pour l'afficher",
      pathLabel: "Chemin",
      error: "Impossible de charger l'aperçu\u00a0: {0}",
      sideLabel: "Comparer",
      sideWorktree: "Copie de travail",
      sideIndex: "Index",
      conflicted: "Ce fichier contient des conflits de fusion.",
      openMergeEditor: "Ouvrir dans l'éditeur de fusion",
      tooLarge: "Trop volumineux pour l'aperçu ({0})",
      binary: "Pas un fichier texte ({0})",
      nonUtf8: "Texte non UTF-8 ({0})",
      noTextDiff: "Aucune modification textuelle à afficher ({0})",
      gone: "Supprimé du disque",
      symlink: "Lien symbolique — GitWand ne le suit pas",
      folderChanged: "{0} fichier(s) modifié(s) dans ce dossier",
      folderClean: "Aucune modification dans ce dossier",
      folderMore: "et {0} de plus",
    },
```
`es.ts`:
```ts
    preview: {
      noSelection: "Selecciona un archivo o una carpeta para previsualizarlo",
      pathLabel: "Ruta",
      error: "No se pudo cargar la vista previa: {0}",
      sideLabel: "Comparar",
      sideWorktree: "Árbol de trabajo",
      sideIndex: "Índice",
      conflicted: "Este archivo tiene conflictos de fusión.",
      openMergeEditor: "Abrir en el editor de fusión",
      tooLarge: "Demasiado grande para previsualizar ({0})",
      binary: "No es un archivo de texto ({0})",
      nonUtf8: "Texto que no es UTF-8 ({0})",
      noTextDiff: "No hay cambios de texto que mostrar ({0})",
      gone: "Eliminado del disco",
      symlink: "Enlace simbólico — GitWand no lo sigue",
      folderChanged: "{0} archivos cambiados en esta carpeta",
      folderClean: "No hay cambios en esta carpeta",
      folderMore: "y {0} más",
    },
```
`pt-BR.ts`:
```ts
    preview: {
      noSelection: "Selecione um arquivo ou uma pasta para visualizar",
      pathLabel: "Caminho",
      error: "Não foi possível carregar a visualização: {0}",
      sideLabel: "Comparar",
      sideWorktree: "Árvore de trabalho",
      sideIndex: "Índice",
      conflicted: "Este arquivo tem conflitos de merge.",
      openMergeEditor: "Abrir no editor de merge",
      tooLarge: "Grande demais para visualizar ({0})",
      binary: "Não é um arquivo de texto ({0})",
      nonUtf8: "Texto que não é UTF-8 ({0})",
      noTextDiff: "Nenhuma alteração de texto para mostrar ({0})",
      gone: "Excluído do disco",
      symlink: "Link simbólico — o GitWand não o segue",
      folderChanged: "{0} arquivos alterados nesta pasta",
      folderClean: "Nenhuma alteração nesta pasta",
      folderMore: "e mais {0}",
    },
```
`zh-CN.ts`:
```ts
    preview: {
      noSelection: "选择一个文件或文件夹进行预览",
      pathLabel: "路径",
      error: "无法加载预览：{0}",
      sideLabel: "比较",
      sideWorktree: "工作区",
      sideIndex: "暂存区",
      conflicted: "此文件存在合并冲突。",
      openMergeEditor: "在合并编辑器中打开",
      tooLarge: "文件过大，无法预览（{0}）",
      binary: "不是文本文件（{0}）",
      nonUtf8: "不是 UTF-8 文本（{0}）",
      noTextDiff: "没有可显示的文本更改（{0}）",
      gone: "已从磁盘删除",
      symlink: "符号链接 — GitWand 不会跟随",
      folderChanged: "此文件夹下有 {0} 个已更改文件",
      folderClean: "此文件夹下没有更改",
      folderMore: "以及另外 {0} 个",
    },
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/components/__tests__/FilePreviewPane.test.ts`:

```ts
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
    expect(events.at(-1)).toEqual(["open-merge-editor", "c.ts"]);
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
    expect(events.at(-1)).toEqual(["select-path", "src/lib/b.ts"]);
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
    expect(events.at(-1)).toEqual(["select-path", "src/lib"]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/components/__tests__/FilePreviewPane.test.ts`
Expected: FAIL with `Failed to resolve import "../FilePreviewPane.vue"`.

- [ ] **Step 4: Implement the component**

Create `apps/desktop/src/components/FilePreviewPane.vue`:

```vue
<script setup lang="ts">
/**
 * FilePreviewPane — the Files view's read-only preview (v3.11.2).
 *
 * Presentation only: what to show is `useFilePreview`'s decision (spec §7).
 * Unchanged files render in a read-only CodeEditor; changed files in the
 * inline DiffViewer, never editable or selectable from here.
 */
import { computed, toRef } from "vue";
import CodeEditor from "./CodeEditor.vue";
import DiffViewer from "./DiffViewer.vue";
import { useI18n } from "../composables/useI18n";
import { formatBytes, useFilePreview, type PreviewTarget } from "../composables/useFilePreview";
import type { TreeWatcher } from "../composables/useLazyRepoTree";
import { getGitDiff, readFileAtRevision } from "../utils/backend";
import { revealLabelKey } from "../utils/revealLabel";

/** A folder summary lists at most this many paths, then "and N more". */
const FOLDER_LIST_LIMIT = 500;

const props = defineProps<{
  cwd: string;
  target: PreviewTarget | null;
  /** Folder selections only: the changed paths below it, sorted. */
  changedBelow: string[];
  watcher: TreeWatcher | null;
}>();

const emit = defineEmits<{
  "select-path": [path: string];
  "open-in-editor": [path: string];
  reveal: [path: string];
  "open-merge-editor": [path: string];
}>();

const { t } = useI18n();

const preview = useFilePreview({
  cwd: toRef(props, "cwd"),
  target: toRef(props, "target"),
  loaders: {
    readFile: (cwd, path) => readFileAtRevision(cwd, "", path),
    getDiff: getGitDiff,
  },
  watcher: props.watcher,
});
const body = preview.body;
const plan = preview.plan;
const side = preview.side;

const segments = computed(() => {
  const parts = (props.target?.path ?? "").split("/").filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
});
const canSwitch = computed(() => plan.value?.kind === "diff" && plan.value.canSwitch);
const fileStatus = computed(() => (props.target?.kind === "file" ? props.target.status : null));
const isGone = computed(() => body.value.kind === "gone" || (fileStatus.value?.deletedOnDisk ?? false));

const STATUS_LABEL = {
  added: "filesView.statusAdded",
  modified: "filesView.statusModified",
  deleted: "filesView.statusDeleted",
  renamed: "filesView.statusRenamed",
  untracked: "filesView.statusUntracked",
  conflicted: "filesView.statusConflicted",
} as const;
const statusLabel = computed(() => {
  const s = fileStatus.value;
  if (!s) return "";
  const key = s.conflicted ? "conflicted" : s.untracked && !s.staged && !s.unstaged ? "untracked" : s.status;
  return t(STATUS_LABEL[key]);
});

const placeholderText = computed(() => {
  const b = body.value;
  if (b.kind !== "placeholder") return "";
  const size = formatBytes(b.size);
  if (b.reason === "too-large") return t("filesView.preview.tooLarge", size);
  if (b.reason === "binary") return t("filesView.preview.binary", size);
  if (b.reason === "non-utf8") return t("filesView.preview.nonUtf8", size);
  return t("filesView.preview.noTextDiff", size);
});

const folderList = computed(() => props.changedBelow.slice(0, FOLDER_LIST_LIMIT));
const folderRest = computed(() => Math.max(0, props.changedBelow.length - FOLDER_LIST_LIMIT));
const revealLabel = computed(() => t(revealLabelKey()));
</script>

<template>
  <section class="fpp">
    <header v-if="target" class="fpp__header">
      <nav class="fpp__crumbs" :aria-label="t('filesView.preview.pathLabel')">
        <template v-for="(seg, i) in segments" :key="seg.path">
          <span v-if="i > 0" class="fpp__sep" aria-hidden="true">/</span>
          <button
            v-if="i < segments.length - 1 || target.kind === 'folder'"
            type="button"
            class="fpp__crumb"
            @click="emit('select-path', seg.path)"
          >{{ seg.name }}</button>
          <span v-else class="fpp__crumb fpp__crumb--leaf">{{ seg.name }}</span>
        </template>
      </nav>
      <span v-if="statusLabel" class="fpp__status">{{ statusLabel }}</span>
      <div v-if="canSwitch" class="fpp__side" role="radiogroup" :aria-label="t('filesView.preview.sideLabel')">
        <button
          type="button"
          role="radio"
          class="fpp__side-btn"
          :aria-checked="side === 'worktree'"
          @click="side = 'worktree'"
        >{{ t('filesView.preview.sideWorktree') }}</button>
        <button
          type="button"
          role="radio"
          class="fpp__side-btn"
          :aria-checked="side === 'index'"
          @click="side = 'index'"
        >{{ t('filesView.preview.sideIndex') }}</button>
      </div>
      <div class="fpp__actions">
        <button
          v-if="target.kind === 'file' && !isGone"
          type="button"
          class="fpp__btn"
          @click="emit('open-in-editor', target.path)"
        >{{ t('filesView.ctxOpenInEditor') }}</button>
        <button
          v-if="!isGone"
          type="button"
          class="fpp__btn"
          @click="emit('reveal', target.path)"
        >{{ revealLabel }}</button>
      </div>
    </header>

    <div class="fpp__body">
      <p v-if="!target" class="fpp__empty">{{ t('filesView.preview.noSelection') }}</p>
      <p v-else-if="body.kind === 'loading'" class="fpp__empty" aria-busy="true">{{ t('filesView.loading') }}</p>
      <div v-else-if="body.kind === 'error'" class="fpp__notice fpp__notice--error" role="alert">
        <span>{{ t('filesView.preview.error', body.message) }}</span>
        <button type="button" class="fpp__btn" @click="preview.retry()">{{ t('filesView.retry') }}</button>
      </div>
      <div v-else-if="body.kind === 'conflicted'" class="fpp__notice">
        <span>{{ t('filesView.preview.conflicted') }}</span>
        <button type="button" class="fpp__btn fpp__btn--primary" @click="emit('open-merge-editor', target.path)">
          {{ t('filesView.preview.openMergeEditor') }}
        </button>
      </div>
      <div v-else-if="body.kind === 'placeholder'" class="fpp__notice">
        <span>{{ placeholderText }}</span>
        <button
          v-if="target.kind === 'file'"
          type="button"
          class="fpp__btn"
          @click="emit('open-in-editor', target.path)"
        >{{ t('filesView.ctxOpenInEditor') }}</button>
      </div>
      <p v-else-if="body.kind === 'gone'" class="fpp__notice">{{ t('filesView.preview.gone') }}</p>
      <p v-else-if="body.kind === 'symlink'" class="fpp__notice">{{ t('filesView.preview.symlink') }}</p>
      <div v-else-if="body.kind === 'folder'" class="fpp__folder">
        <p>
          {{ changedBelow.length
            ? t('filesView.preview.folderChanged', changedBelow.length)
            : t('filesView.preview.folderClean') }}
        </p>
        <ul class="fpp__list">
          <li v-for="p in folderList" :key="p">
            <button type="button" class="fpp__link" @click="emit('select-path', p)">{{ p }}</button>
          </li>
        </ul>
        <p v-if="folderRest > 0" class="fpp__more">{{ t('filesView.preview.folderMore', folderRest) }}</p>
      </div>
      <div v-else-if="body.kind === 'text'" class="fpp__code">
        <CodeEditor :model-value="body.content" :file-path="target.path" readonly :aria-label="target.path" />
      </div>
      <DiffViewer v-else-if="body.kind === 'diff'" :diff="body.diff" :file-path="target.path" diff-mode="inline" />
    </div>
  </section>
</template>

<style scoped>
.fpp { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.fpp__header { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--color-border); font-size: 12px; flex-wrap: wrap; }
.fpp__crumbs { display: flex; align-items: center; gap: 2px; min-width: 0; font-family: var(--font-mono); }
.fpp__crumb { border: 0; background: transparent; color: var(--color-text-muted); padding: 2px 4px; border-radius: var(--radius-sm); cursor: pointer; font: inherit; }
.fpp__crumb:hover { color: var(--color-text); background: var(--color-bg-hover, rgba(127, 127, 127, 0.1)); }
.fpp__crumb--leaf { color: var(--color-text); cursor: default; }
.fpp__sep { color: var(--color-text-muted); }
.fpp__status { padding: 1px 6px; border-radius: var(--radius-sm); background: var(--color-bg-hover, rgba(127, 127, 127, 0.12)); }
.fpp__side { display: inline-flex; border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; }
.fpp__side-btn { border: 0; background: transparent; color: inherit; padding: 2px 8px; font: inherit; cursor: pointer; }
.fpp__side-btn[aria-checked="true"] { background: var(--color-accent); color: var(--color-bg); }
.fpp__actions { margin-left: auto; display: flex; gap: 6px; }
.fpp__btn { border: 1px solid var(--color-border); background: transparent; color: inherit; padding: 3px 8px; border-radius: var(--radius-sm); font: inherit; cursor: pointer; }
.fpp__btn--primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-bg); }
.fpp__body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.fpp__empty, .fpp__notice { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--color-text-muted); font-size: 13px; }
.fpp__notice--error { color: var(--color-danger); }
.fpp__folder { padding: 12px 16px; font-size: 13px; }
.fpp__list { list-style: none; margin: 8px 0; padding: 0; }
.fpp__link { border: 0; background: transparent; color: var(--color-accent); padding: 2px 0; font-family: var(--font-mono); font-size: 12px; cursor: pointer; text-align: left; }
.fpp__more { color: var(--color-text-muted); }
.fpp__code { flex: 1; min-height: 0; display: flex; }
.fpp__code :deep(.code-editor) { flex: 1; min-height: 0; }
.fpp__code :deep(.cm-editor) { height: 100%; max-height: none; border: 0; border-radius: 0; }
</style>
```

- [ ] **Step 5: Run the tests and the type-check**

Run: `cd apps/desktop && pnpm exec vitest run src/components/__tests__/FilePreviewPane.test.ts`
Expected: PASS (13 tests).

Run: `pnpm --filter @gitwand/core build && cd apps/desktop && pnpm exec vue-tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/FilePreviewPane.vue apps/desktop/src/components/__tests__/FilePreviewPane.test.ts apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): FilePreviewPane, a read-only content or inline-diff preview"
```

---

### Task 10: `FilesView.vue` and App integration (view mode, dock, settings, palette, menu)

**Files:**
- Create: `apps/desktop/src/components/FilesView.vue`
- Create: `apps/desktop/src/components/__tests__/FilesView.test.ts`
- Create: `apps/desktop/src/composables/__tests__/useSettings-filesView.test.ts`
- Create: `apps/desktop/src/__tests__/filesView-wiring.test.ts`
- Modify: `apps/desktop/src/composables/useGitRepo.ts:64-71` (`ViewMode`)
- Modify: `apps/desktop/src/composables/useSettings.ts:30-56` (dock helpers), `:235` (`AppSettings`), `:499` (defaults)
- Modify: `apps/desktop/src/components/SettingsPanel.vue:186` (`Settings`), `:298` (defaults), `:414-422` (`dockEntryLabel`), `:1645` (checkbox after "Show Files")
- Modify: `apps/desktop/src/components/AppDock.vue:16`, `:59-66`, `:75-80`, `:206-223`, plus the template at `:376` and `:384-389`
- Modify: `apps/desktop/src/composables/useAppMenu.ts:58` (`AppMenuActions`), `:313` (View menu)
- Modify: `apps/desktop/src/App.vue:66`, `:102`, `:627`, `:2068`, `:2106`, `:4088-4094`, `:4535-4537`
- Modify: the five locales (`header.paletteViewFiles` after `paletteViewGraph`; `menu.openFilesView` after the menu group's `openLaunchpad`; `settings.dock.itemFilesView` and `showFilesView` after `showFiles`; `filesView.dockLabel`, `breadcrumbLabel`, `scopeGone` and `revealFailed` at the end of `filesView`)

**Interfaces:**
- Consumes:
  - `useLazyRepoTree` (Task 5), `FileTreePane` (Task 6), `FilePreviewPane` (Task 9);
  - `listRepoDir` (Task 2) and `revealInFileManager` (Task 3);
  - `pathExists(cwd, rel)` (`backend.ts:2924`) and `clipboardWriteText(text)` (`backend.ts:3844`);
  - `useWorkspaceScope() → { activeScope, setScope, clearScope }` (`useWorkspaceScope.ts:139`) and `useLogs().pushLog(level, message)` (`useLogs.ts:60`);
  - in App.vue: `repoWatcher` (`App.vue:3890`, a `RepoWatcherApi` that structurally satisfies `TreeWatcher`), `handleOpenInEditor(path)` (`App.vue:1738`), and `handleOpenResidual(path)` (`App.vue:969`, which already switches to Changes and selects a file for the merge editor).
- Produces:
  ```ts
  export type DockEntryId = "launchpad" | "dashboard" | "prs" | "graph" | "changes" | "files-view";
  export function dockEntryViewMode(id: DockEntryId): ViewMode; // "files-view" → "files", otherwise the id itself
  // AppSettings & Settings: dockHideFilesView: boolean (default false)
  // ViewMode gains "files"; AppMenuActions gains openFilesView(): void
  ```
  - `<FilesView :repo-path :repo-files :watcher>`, which emits `open-in-editor(path)` and `open-merge-editor(path)`.

**Why `"files-view"` maps to `"files"`:** `AppDock` emits a `DockEntryId` as the `ViewMode` (`AppDock.vue:376`), and `App.vue:627` casts one into `viewMode`. That works only because every existing id is also a view mode. `"files"` cannot be the dock id, because `AppDock`'s `MenuTarget` already uses `"files"` for the File Explorer *tile* (`AppDock.vue:146`). So the dock id is `"files-view"`, as spec §7 says, and `dockEntryViewMode` translates it everywhere an id becomes a view.

- [ ] **Step 1: Add the locale keys (all five files)**

`en.ts`, after `paletteViewGraph: "View: Git Tree",` (line 121):
```ts
    paletteViewFiles: "View: Browse files",
```
`en.ts`, after the menu group's `openLaunchpad: "Open Today",` (line 2438):
```ts
    openFilesView: "Browse Files",
```
`en.ts`, after `showFiles: "Show Files",` (line 1470):
```ts
      itemFilesView: "Browse",
      showFilesView: "Show Browse",
```
`en.ts`, as the last members of `filesView` (after the `preview: { … },` block):
```ts
    dockLabel: "Browse",
    breadcrumbLabel: "Location",
    scopeGone: "'{0}' no longer exists — showing the whole repo.",
    revealFailed: "Couldn't reveal {0}: {1}",
```

`fr.ts`, same four anchors (lines 115, 2408, 1454, end of `filesView`):
```ts
    paletteViewFiles: "Vue\u00a0: Parcourir les fichiers",
```
```ts
    openFilesView: "Parcourir les fichiers",
```
```ts
      itemFilesView: "Parcourir",
      showFilesView: "Afficher Parcourir",
```
```ts
    dockLabel: "Parcourir",
    breadcrumbLabel: "Emplacement",
    scopeGone: "« {0} » n'existe plus — affichage du dépôt entier.",
    revealFailed: "Impossible d'afficher {0}\u00a0: {1}",
```

`es.ts` (lines 121, 2399, 1445, end of `filesView`):
```ts
    paletteViewFiles: "Vista: Explorar archivos",
```
```ts
    openFilesView: "Explorar archivos",
```
```ts
      itemFilesView: "Explorar",
      showFilesView: "Mostrar Explorar",
```
```ts
    dockLabel: "Explorar",
    breadcrumbLabel: "Ubicación",
    scopeGone: "«{0}» ya no existe — mostrando todo el repositorio.",
    revealFailed: "No se pudo mostrar {0}: {1}",
```

`pt-BR.ts` (lines 122, 2399, 1445, end of `filesView`):
```ts
    paletteViewFiles: "Visão: Navegar pelos arquivos",
```
```ts
    openFilesView: "Navegar pelos arquivos",
```
```ts
      itemFilesView: "Navegar",
      showFilesView: "Mostrar Navegar",
```
```ts
    dockLabel: "Navegar",
    breadcrumbLabel: "Local",
    scopeGone: "\"{0}\" não existe mais — exibindo o repositório inteiro.",
    revealFailed: "Não foi possível mostrar {0}: {1}",
```

`zh-CN.ts` (lines 126, 2408, 1150, end of `filesView`):
```ts
    paletteViewFiles: "视图：浏览文件",
```
```ts
    openFilesView: "浏览文件",
```
```ts
      itemFilesView: "浏览",
      showFilesView: "显示浏览",
```
```ts
    dockLabel: "浏览",
    breadcrumbLabel: "位置",
    scopeGone: "“{0}”不再存在 — 正在显示整个仓库。",
    revealFailed: "无法显示 {0}：{1}",
```

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop/src/composables/__tests__/useSettings-filesView.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_DOCK_ORDER,
  dockEntryViewMode,
  isDockEntryHidden,
  loadSettings,
  normalizeDockOrder,
} from "../useSettings";
import en from "../../locales/en";
import fr from "../../locales/fr";
import es from "../../locales/es";
import ptBR from "../../locales/pt-BR";
import zhCN from "../../locales/zh-CN";

describe("v3.11.2 — Files view dock entry", () => {
  beforeEach(() => localStorage.clear());

  it("is in the default order, last, and appended to an older stored order", () => {
    expect(DEFAULT_DOCK_ORDER.at(-1)).toBe("files-view");
    expect(normalizeDockOrder(["changes", "graph", "prs", "dashboard", "launchpad"])).toEqual([
      "changes", "graph", "prs", "dashboard", "launchpad", "files-view",
    ]);
  });

  it("is visible by default and hideable", () => {
    const s = loadSettings();
    expect(s.dockHideFilesView).toBe(false);
    expect(isDockEntryHidden("files-view", s)).toBe(false);
    expect(isDockEntryHidden("files-view", { ...s, dockHideFilesView: true })).toBe(true);
  });

  it("opens the 'files' view mode; every other entry is its own view mode", () => {
    expect(dockEntryViewMode("files-view")).toBe("files");
    for (const id of ["launchpad", "dashboard", "prs", "graph", "changes"] as const) {
      expect(dockEntryViewMode(id)).toBe(id);
    }
  });

  it("has every new key in all five locales", () => {
    for (const loc of [en, fr, es, ptBR, zhCN]) {
      expect(loc.header.paletteViewFiles).toBeTruthy();
      expect(loc.menu.openFilesView).toBeTruthy();
      expect(loc.settings.dock.itemFilesView).toBeTruthy();
      expect(loc.settings.dock.showFilesView).toBeTruthy();
      expect(Object.keys(loc.filesView).sort()).toEqual(Object.keys(en.filesView).sort());
      expect(Object.keys(loc.filesView.preview).sort()).toEqual(Object.keys(en.filesView.preview).sort());
    }
  });
});
```

Create `apps/desktop/src/__tests__/filesView-wiring.test.ts`:

```ts
/**
 * App.vue call sites of the Files view (v3.11.2). Each is optional to the
 * type-checker (a prop, a palette id, a menu action), so forgetting one
 * type-checks and silently removes an entry point, which is how MergeEditor's
 * `cwd` went missing in v3.11.1 (see mergeEditor-cwd-wiring.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appVue = readFileSync(resolve(__dirname, "../App.vue"), "utf-8");

describe("App.vue — Files view wiring", () => {
  it("lazy-loads FilesView", () => {
    expect(appVue).toMatch(/const FilesView = defineAsyncComponent\(\(\) => import\("\.\/components\/FilesView\.vue"\)\)/);
  });

  it("renders it for viewMode 'files' with the repo files and the live watcher", () => {
    const branch = appVue.match(/v-else-if="viewMode === 'files'"[\s\S]*?<FilesView\b[\s\S]*?\/>/)?.[0];
    expect(branch, "no FilesView branch for viewMode 'files'").toBeTruthy();
    expect(branch).toMatch(/:repo-files="repoFiles"/);
    expect(branch).toMatch(/:watcher="repoWatcher"/);
    expect(branch).toMatch(/@open-in-editor="handleOpenInEditor"/);
    expect(branch).toMatch(/@open-merge-editor="handleOpenResidual"/);
  });

  it("offers it in the palette and the native menu", () => {
    expect(appVue).toMatch(/id: "view-files"/);
    expect(appVue).toMatch(/case "view-files": viewMode\.value = "files"; break;/);
    expect(appVue).toMatch(/openFilesView: \(\) =>/);
  });

  it("maps the startup dock entry through dockEntryViewMode", () => {
    expect(appVue).toMatch(/viewMode\.value = dockEntryViewMode\(first\)/);
  });
});
```

Create `apps/desktop/src/components/__tests__/FilesView.test.ts`:

```ts
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
  getGitDiff: vi.fn(async () => ({ path: "x", hunks: [] })),
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
  return { default: defineComponent({ setup: () => () => h("div", { class: "stub-diff" }) }) };
});
vi.mock("../CodeEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ props: { modelValue: String }, setup: (p) => () => h("pre", { class: "stub-code" }, p.modelValue) }) };
});

import FilesView from "../FilesView.vue";
import { listRepoDir, pathExists, readFileAtRevision, revealInFileManager } from "../../utils/backend";
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

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(
    defineComponent({
      setup: () => () => h(FilesView, { repoPath: "/repo", repoFiles: [], watcher: null }),
    }),
  );
  app.mount(container);
  await settle();
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
    const reveal = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].at(-1)!;
    reveal.click();
    await settle();
    expect(revealInFileManager).toHaveBeenCalledWith("/repo", "README.md");
    expect(useLogs().entries.value.at(-1)).toMatchObject({
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
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/desktop && pnpm exec vitest run src/composables/__tests__/useSettings-filesView.test.ts src/__tests__/filesView-wiring.test.ts src/components/__tests__/FilesView.test.ts`
Expected: FAIL. The settings test fails on `dockEntryViewMode is not a function` and on `DEFAULT_DOCK_ORDER.at(-1)` being `"changes"`. The wiring test fails on every assertion. The view test fails with `Failed to resolve import "../FilesView.vue"`.

- [ ] **Step 4: Settings and view-mode types**

In `apps/desktop/src/composables/useGitRepo.ts`, add `| "files"` to `ViewMode` after `| "issue"` (line 71):

```ts
  | "issue"
  | "files";
```

In `apps/desktop/src/composables/useSettings.ts`, replace lines 30-56 (from the `DockEntryId` comment through the end of `isDockEntryHidden`) with:

```ts
/** Dock entry ids — used for dock ordering (v3). All but "files-view" are view modes too. */
export type DockEntryId = "launchpad" | "dashboard" | "prs" | "graph" | "changes" | "files-view";
/** Canonical default dock order, left → right. */
export const DEFAULT_DOCK_ORDER: DockEntryId[] = ["launchpad", "dashboard", "prs", "graph", "changes", "files-view"];

/**
 * The view a dock entry opens. Every entry is its own view mode except the
 * v3.11.2 Files view: its dock id cannot be "files", which AppDock's menu
 * already uses for the File Explorer tile.
 */
export function dockEntryViewMode(id: DockEntryId): ViewMode {
  return id === "files-view" ? "files" : id;
}

/**
 * Normalise a stored dock order so every entry is present exactly once:
 * keep the known/persisted order, then append any missing entries in default
 * order. Shared by AppDock (render order) and SettingsPanel (reorder list).
 */
export function normalizeDockOrder(stored: DockEntryId[] | undefined): DockEntryId[] {
  const order = stored?.length ? stored : DEFAULT_DOCK_ORDER;
  const known = order.filter((id) => DEFAULT_DOCK_ORDER.includes(id));
  const missing = DEFAULT_DOCK_ORDER.filter((id) => !known.includes(id));
  return [...known, ...missing];
}

/** Per-entry "hidden from dock" flag. Git Tree & Changes are never hideable. */
export function isDockEntryHidden(
  id: DockEntryId,
  flags: Pick<AppSettings, "dockHideLaunchpad" | "dockHideDashboard" | "dockHidePrs" | "dockHideFilesView">,
): boolean {
  if (id === "launchpad") return flags.dockHideLaunchpad;
  if (id === "dashboard") return flags.dockHideDashboard;
  if (id === "prs") return flags.dockHidePrs;
  if (id === "files-view") return flags.dockHideFilesView;
  return false;
}
```

At the top of `useSettings.ts`, with the other imports, add:

```ts
import type { ViewMode } from "./useGitRepo";
```

This import is type-only and erased at build time, so the runtime has no cycle, even though `useGitRepo` imports `useSettings`.

In `AppSettings`, after `dockHideFiles: boolean;` (line 235), add:

```ts
  /** v3.11.2 — hide the Files view ("Browse") entry from the dock. */
  dockHideFilesView: boolean;
```

In `defaultAppSettings`, after `dockHideFiles: false,` (line 499), add:

```ts
  dockHideFilesView: false,
```

In `apps/desktop/src/components/SettingsPanel.vue`:
- In the `Settings` interface, after `dockHideFiles: boolean;` (line 186), add `dockHideFilesView: boolean;`.
- In the defaults, after `dockHideFiles: false,` (line 298), add `dockHideFilesView: false,`.
- In `dockEntryLabel` (lines 414-422), add `case "files-view": return t("settings.dock.itemFilesView");` before the closing `}` of the switch.
- After the "Show Files" checkbox row (its closing `</div>` at line 1645), insert:

```vue

          <!-- Show Files view (v3.11.2) -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dock-files-view">
              <input id="setting-dock-files-view" type="checkbox" class="sp-checkbox"
                :checked="!settings.dockHideFilesView"
                @change="updateSetting('dockHideFilesView', !($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dock.showFilesView') }}</span>
            </label>
          </div>
```

- [ ] **Step 5: The dock**

In `apps/desktop/src/components/AppDock.vue`:

Line 16 becomes:
```ts
import { useSettings, normalizeDockOrder, isDockEntryHidden, dockEntryViewMode, type DockEntryId } from "../composables/useSettings";
```

In `entryLabel` (lines 59-66), add before the switch's closing `}`:
```ts
    case "files-view": return t("filesView.dockLabel");
```

Replace `isActive` (lines 75-80) with:
```ts
function isActive(id: DockEntryId): boolean {
  // History is a sub-view reached from the Git Tree (clicking a commit), so
  // it keeps the Git Tree entry highlighted.
  if (id === "graph") return props.viewMode === "graph" || props.viewMode === "history";
  return props.viewMode === dockEntryViewMode(id);
}
```

Replace `isRemovable`, `canBeStartup`, `removeFromDock` and `setAsStartup` (lines 205-223) with:
```ts
/** Today / Dashboard / PRs / Browse can be removed; Git Tree & Changes cannot. */
function isRemovable(id: DockEntryId): boolean {
  return id === "launchpad" || id === "dashboard" || id === "prs" || id === "files-view";
}

function isStartup(id: DockEntryId): boolean {
  return settings.value.startupView === id;
}

/** Changes has no diff-less landing and Browse needs a repo, so neither is a startup view. */
function canBeStartup(id: DockEntryId): boolean {
  return id !== "changes" && id !== "files-view";
}

// ── Per-target actions ──
function removeFromDock(id: DockEntryId) {
  if (id === "launchpad") patch({ dockHideLaunchpad: true });
  else if (id === "dashboard") patch({ dockHideDashboard: true });
  else if (id === "prs") patch({ dockHidePrs: true });
  else if (id === "files-view") patch({ dockHideFilesView: true });
  closeMenu();
}

function setAsStartup(id: DockEntryId) {
  if (id === "changes" || id === "files-view") return; // not valid startup views
  patch({ startupView: id });
  closeMenu();
}
```

In the template, change the dock button's click (line 376) to:
```vue
          @click="emit('changeView', dockEntryViewMode(id))"
```

Then, before the Changes fallback `<svg v-else …>` (line 389), insert the Browse icon:
```vue
          <!-- Browse (Files view, v3.11.2) -->
          <svg v-else-if="id === 'files-view'" class="dock-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h6l2 2h10v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M8 13h8" /><path d="M8 16h5" />
          </svg>
```

- [ ] **Step 6: The native menu**

In `apps/desktop/src/composables/useAppMenu.ts`, after `openLaunchpad: () => void;` in `AppMenuActions` (line 58), add:
```ts
  openFilesView: () => void;
```

In the View submenu, after the `view-open-launchpad` item (closing `}),` at line 312), insert:
```ts
        await MenuItem.new({
          id: "view-open-files",
          text: t("menu.openFilesView"),
          enabled: hasRepo,
          action: () => actions.openFilesView(),
        }),
```

- [ ] **Step 7: `FilesView.vue`**

Create `apps/desktop/src/components/FilesView.vue`:

```vue
<script setup lang="ts">
/**
 * FilesView — the Finder-like Files view (v3.11.2): a scope breadcrumb, then
 * the tree and the read-only preview side by side.
 *
 * It owns the wiring, not the logic. The tree model is `useLazyRepoTree`, the
 * preview `useFilePreview` (inside FilePreviewPane), the keyboard
 * `fileTreeKeymap`. What lives here is what needs the app: the workspace
 * scope, the clipboard, the OS file manager, and the hand-offs App.vue makes
 * (external editor, merge editor).
 */
import { computed, ref, shallowRef, toRef, watch } from "vue";
import FileTreePane from "./FileTreePane.vue";
import FilePreviewPane from "./FilePreviewPane.vue";
import { useLazyRepoTree, type LazyTreeRow, type TreeWatcher } from "../composables/useLazyRepoTree";
import type { PreviewTarget } from "../composables/useFilePreview";
import type { RepoFileEntry } from "../composables/useGitRepo";
import { useWorkspaceScope } from "../composables/useWorkspaceScope";
import { useI18n } from "../composables/useI18n";
import { useLogs } from "../composables/useLogs";
import { clipboardWriteText, listRepoDir, pathExists, revealInFileManager } from "../utils/backend";

const props = defineProps<{
  repoPath: string;
  repoFiles: RepoFileEntry[];
  watcher: TreeWatcher | null;
}>();

const emit = defineEmits<{
  "open-in-editor": [path: string];
  "open-merge-editor": [path: string];
}>();

const { t } = useI18n();
const { pushLog } = useLogs();
const { activeScope, setScope, clearScope } = useWorkspaceScope();

const root = computed(() => activeScope.value ?? "");
const scopeNotice = ref<string | null>(null);

const tree = useLazyRepoTree({
  repoPath: toRef(props, "repoPath"),
  root,
  repoFiles: toRef(props, "repoFiles"),
  listDir: (dir, includeIgnored) => listRepoDir(props.repoPath, dir, includeIgnored),
  watcher: props.watcher,
  onRootError: () => void checkScopeStillExists(),
});

/**
 * A scope root that fails to list is either gone or merely unreadable. Only
 * a folder that no longer exists clears the scope (spec §8); an unreadable
 * one keeps it and shows the error row with Retry.
 */
async function checkScopeStillExists(): Promise<void> {
  const scope = root.value;
  if (!scope) return;
  let exists = false;
  try {
    exists = await pathExists(props.repoPath, scope);
  } catch {
    exists = false;
  }
  if (exists || root.value !== scope) return;
  scopeNotice.value = t("filesView.scopeGone", scope);
  await clearScope();
}

const repoName = computed(() => props.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? props.repoPath);
const crumbs = computed(() => {
  const segs = root.value ? root.value.split("/") : [];
  return segs.map((name, i) => ({ name, path: segs.slice(0, i + 1).join("/") }));
});

// The selected row, kept while it is hidden (collapsed parent) or briefly
// missing (a reload in flight), so the preview does not flicker to empty.
const lastSelected = shallowRef<LazyTreeRow | null>(null);
watch(
  [() => tree.selected.value, () => tree.rows.value],
  ([path, rows]) => {
    if (!path) {
      lastSelected.value = null;
      return;
    }
    const row = rows.find((r) => r.path === path && (r.kind === "file" || r.kind === "folder"));
    if (row) lastSelected.value = row;
    else if (lastSelected.value?.path !== path) lastSelected.value = null;
  },
  { immediate: true },
);

const previewTarget = computed<PreviewTarget | null>(() => {
  const row = lastSelected.value;
  if (!row) return null;
  if (row.kind === "folder") return { kind: "folder", path: row.path };
  if (row.kind !== "file") return null;
  return {
    kind: "file",
    path: row.path,
    size: row.size,
    symlink: row.symlink,
    status: tree.statusByPath.value.get(row.path) ?? null,
  };
});

const changedBelow = computed(() =>
  previewTarget.value?.kind === "folder" ? tree.changedUnder(previewTarget.value.path) : [],
);

function onSelect(path: string): void {
  tree.selected.value = path;
}
async function onScopeHere(path: string): Promise<void> {
  scopeNotice.value = null;
  await setScope(path);
}
async function onWholeRepo(): Promise<void> {
  scopeNotice.value = null;
  await clearScope();
}
async function onCopyPath(path: string): Promise<void> {
  await clipboardWriteText(path);
}
async function onReveal(path: string): Promise<void> {
  try {
    await revealInFileManager(props.repoPath, path);
  } catch (err) {
    pushLog("error", t("filesView.revealFailed", path, err instanceof Error ? err.message : String(err)));
  }
}
function onSelectPath(path: string): void {
  void tree.reveal(path);
}
</script>

<template>
  <section class="fv">
    <nav class="fv__crumbs" :aria-label="t('filesView.breadcrumbLabel')">
      <button
        type="button"
        class="fv__crumb"
        :class="{ 'fv__crumb--current': !root }"
        :disabled="!root"
        @click="onWholeRepo"
      >{{ t('scope.wholeRepo') }}</button>
      <template v-for="(c, i) in crumbs" :key="c.path">
        <span class="fv__sep" aria-hidden="true">/</span>
        <button
          v-if="i < crumbs.length - 1"
          type="button"
          class="fv__crumb"
          @click="onScopeHere(c.path)"
        >{{ c.name }}</button>
        <span v-else class="fv__crumb fv__crumb--current" aria-current="location">{{ c.name }}</span>
      </template>
    </nav>
    <p v-if="scopeNotice" class="fv__notice" role="status">{{ scopeNotice }}</p>

    <div class="fv__split">
      <FileTreePane
        class="fv__tree"
        :rows="tree.rows.value"
        :selected-path="tree.selected.value"
        :show-ignored="tree.showIgnored.value"
        :label="root || repoName"
        @select="onSelect"
        @toggle="(p: string) => void tree.toggle(p)"
        @expand="(p: string) => void tree.expand(p)"
        @collapse="(p: string) => tree.collapse(p)"
        @retry="(d: string) => void tree.retry(d)"
        @update:show-ignored="(v: boolean) => { tree.showIgnored.value = v; }"
        @scope-here="onScopeHere"
        @copy-path="onCopyPath"
        @reveal="onReveal"
        @open-in-editor="(p: string) => emit('open-in-editor', p)"
      />
      <FilePreviewPane
        class="fv__preview"
        :cwd="repoPath"
        :target="previewTarget"
        :changed-below="changedBelow"
        :watcher="watcher"
        @select-path="onSelectPath"
        @open-in-editor="(p: string) => emit('open-in-editor', p)"
        @reveal="onReveal"
        @open-merge-editor="(p: string) => emit('open-merge-editor', p)"
      />
    </div>
  </section>
</template>

<style scoped>
.fv { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; }
.fv__crumbs { display: flex; align-items: center; gap: 2px; padding: 6px 12px; border-bottom: 1px solid var(--color-border); font-size: 12px; }
.fv__crumb { border: 0; background: transparent; color: var(--color-text-muted); padding: 2px 6px; border-radius: var(--radius-sm); font: inherit; cursor: pointer; }
.fv__crumb:hover:not(:disabled) { color: var(--color-text); background: var(--color-bg-hover, rgba(127, 127, 127, 0.1)); }
.fv__crumb--current { color: var(--color-text); cursor: default; }
.fv__sep { color: var(--color-text-muted); }
.fv__notice { margin: 0; padding: 6px 12px; font-size: 12px; color: var(--color-text-muted); border-bottom: 1px solid var(--color-border); }
.fv__split { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(220px, 32%) 1fr; }
.fv__tree, .fv__preview { min-height: 0; }
</style>
```

- [ ] **Step 8: App.vue**

In `apps/desktop/src/App.vue`:

After line 66 (`const FileExplorerPanel = defineAsyncComponent(…)`):
```ts
const FilesView = defineAsyncComponent(() => import("./components/FilesView.vue"));
```

Line 102 becomes:
```ts
import { useSettings, normalizeDockOrder, isDockEntryHidden, dockEntryViewMode } from "./composables/useSettings";
```

Line 627 becomes:
```ts
  if (first) viewMode.value = dockEntryViewMode(first);
```

In the palette list, after `{ id: "view-graph", label: t("header.paletteViewGraph") },` (line 2068):
```ts
    { id: "view-files", label: t("header.paletteViewFiles") },
```

In `onPaletteAction`, after `case "view-graph": viewMode.value = "graph"; break;` (line 2106):
```ts
    case "view-files": viewMode.value = "files"; break;
```

In the `useAppMenu({ … })` actions, after the `openLaunchpad: () => { … },` block (ends at line 4094):
```ts
    openFilesView: () => {
      if (hasRepo.value) onViewModeChange("files");
    },
```

In the template, between the Git Tree view's closing `</div>` (line 4535) and `<!-- Issue detail view: in-app issue review (v2.22) -->` (line 4537):
```vue

            <!-- ── Files view (v3.11.2): Finder-like tree │ read-only preview ── -->
            <div v-else-if="viewMode === 'files'" class="view view--files">
              <FilesView class="view__content"
                :repo-path="repoFolderPath ?? ''"
                :repo-files="repoFiles"
                :watcher="repoWatcher"
                @open-in-editor="handleOpenInEditor"
                @open-merge-editor="handleOpenResidual" />
            </div>
```

- [ ] **Step 9: Run the new tests, the full desktop suite and the type-check**

Run: `cd apps/desktop && pnpm exec vitest run src/composables/__tests__/useSettings-filesView.test.ts src/__tests__/filesView-wiring.test.ts src/components/__tests__/FilesView.test.ts`
Expected: PASS (4 + 4 + 6).

Run: `cd apps/desktop && pnpm test`
Expected: the whole suite passes. `commandRegistry.test.ts`, `FileExplorerPanel.test.ts` and `useRepoFileTree.test.ts` are unchanged and green.

Run: `pnpm --filter @gitwand/core build && cd apps/desktop && pnpm exec vue-tsc --noEmit`
Expected: exit 0. This proves both `entryLabel` switches, `setAsStartup`'s narrowing and the locale shapes compile.

- [ ] **Step 10: Manual QA under `dev:web`**

Run `cd apps/desktop && pnpm dev:web`, open a repo (seed it through `localStorage` as the "QA web" memory note describes), then check:
- the dock shows "Browse", and clicking it opens the view;
- ↑ ↓ ← → Enter Home End, type-ahead, and ⇧F10 all work;
- "Show ignored" greys out `node_modules`;
- "Scope here" re-roots the tree and shows the breadcrumb, and "Whole repo" clears it;
- the preview shows content for a clean file, a diff for a modified one, and the Working tree | Index switch for a file that is both staged and modified;
- a conflicted file offers "Open in merge editor";
- in Settings → Dock, "Show Browse" hides and shows the entry.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/components/FilesView.vue apps/desktop/src/components/__tests__/FilesView.test.ts apps/desktop/src/composables/__tests__/useSettings-filesView.test.ts apps/desktop/src/__tests__/filesView-wiring.test.ts apps/desktop/src/composables/useGitRepo.ts apps/desktop/src/composables/useSettings.ts apps/desktop/src/components/SettingsPanel.vue apps/desktop/src/components/AppDock.vue apps/desktop/src/composables/useAppMenu.ts apps/desktop/src/App.vue apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): Files view, a Finder-like working-tree browser reachable from the dock, palette and menu"
```

---

### Task 11: Docs: CHANGELOG, ROADMAP follow-ups, website guide

**Files:**
- Modify: `CHANGELOG.md:9` (`## [Unreleased]`: add `### Added` above the existing `### Fixed`)
- Modify: `ROADMAP.md:118-149` (`### Later (unscheduled)`: append bullets)
- Modify: `website/guide/desktop.md:95` (new section after "Folder Tree in Commit Diff (v1.6)")

**Interfaces:**
- Consumes: Tasks 1-10 as shipped.
- Produces: user-facing docs. `website/changelog.md` and the move of the ROADMAP v3.11.2 item to **Shipped** happen at tag time, together with `./scripts/bump-version.sh 3.11.2` (AGENTS.md § Changelog / Roadmap). They are not done here.

- [ ] **Step 1: CHANGELOG**

In `CHANGELOG.md`, directly under `## [Unreleased]` and above the existing `### Fixed` (keep both Fixed bullets), insert:

```markdown
### Added
- **A Finder-like Files view.** A new dock entry, "Browse", also reachable from the command palette ("View: Browse files") and the macOS View menu, opens the working tree full-screen: a folder tree on the left and a read-only preview on the right. Badges are landmarks, not the point. Every changed file has one, and so does every folder above it, including folders that were never opened.
  - **Lazy, one folder at a time.** A new `list_repo_dir` command lists a single directory when it is first expanded, capped at 5,000 entries. Ignored entries are classified in process with libgit2: a path is ignored when an ignore rule matches it and the index does not track it, so a force-added file is not shown as ignored. Measured on a `microsoft/vscode` checkout, a 6,000-file directory lists in 66 ms, where `git check-ignore` takes 1.6 s. Ignored files are hidden by default, and "Show ignored" shows them greyed out.
  - **Keyboard-first.** Arrow keys expand, collapse, descend and climb. Enter opens a file or toggles a folder, Home and End jump to the ends, typing a name jumps to it, and ⇧F10 opens the context menu. The tree is virtualized and exposes `role="tree"` with a single tab stop.
  - **Preview, not editor.** An unchanged file opens in a read-only code viewer. A changed one shows the inline diff, with a Working tree | Index switch when it is both staged and modified. A conflicted file offers "Open in merge editor", and a binary or larger-than-5 MB file shows a placeholder instead of being read. Open in editor and Reveal in Finder / Explorer hand the file to the system.
  - **Live, and scope-aware.** The tree refreshes from the Live Repo watcher and re-lists only the folders that changed. Right-click "Scope here" narrows the whole app to a folder, the tree re-roots on it, and if that folder is deleted, the view falls back to the whole repo with a notice. Expanded folders, the selection and "Show ignored" are remembered per repository.
  - The existing Files panel (File Explorer, with tabs and editing) is unchanged.
```

- [ ] **Step 2: ROADMAP follow-ups (spec §10)**

In `ROADMAP.md`, at the end of `### Later (unscheduled)` (after the last bullet, before the `---`), append:

```markdown
- **Files view follow-ups** (out of scope for v3.11.2, spec §10). The view is deliberately read-only. Not done: editing in the view, stage/unstage from the view, file operations (rename, delete, create), and tree-wide name search beyond type-ahead over the visible rows. Each needs its own design: editing would have to coexist with the File Explorer panel's tabs, and search with a 5,000-per-folder listing cap.
- **Move the File Explorer panel onto `useLazyRepoTree`.** This lifts its 20,000-entry `list_repo_tree` cap and gives it live refresh and keyboard navigation. It was planned as an optional last task of v3.11.2. If that task ships, this bullet is removed in the same commit.
```

- [ ] **Step 3: Website guide**

In `website/guide/desktop.md`, after the "Folder Tree in Commit Diff (v1.6)" section (ends at line 95, before `## File History & Blame`), insert:

```markdown
## Files View (v3.11.2)

The **Browse** entry in the dock opens the working tree the way the Finder shows a folder. The tree is on the left and a read-only preview is on the right. You can also open it from the command palette (**View: Browse files**) or, on macOS, from **View → Browse Files**.

- **Status at a glance.** Changed files carry a letter (M, A, D, R, U, C), and every folder above a change carries a count, even a folder you have not opened. Deleted files stay in place, struck through.
- **Ignored files on demand.** They are hidden by default. **Show ignored** shows them greyed out, and they are still loaded one folder at a time.
- **Keyboard.** Use ↑ ↓ to move. → expands a folder and then steps into it, and ← collapses it and then climbs to the parent. Enter opens a file or toggles a folder, Home and End jump to the ends, and you can type the start of a name to jump to it. ⇧F10 opens the context menu.
- **Preview.** Unchanged files open read-only. Changed files show the inline diff, with a **Working tree | Index** switch when a file is both staged and modified. A conflicted file offers **Open in merge editor**. Binary files and files over 5 MB show a placeholder with **Open in editor**.
- **Context menu.** On a folder: **Scope here**, which narrows the app to that folder and re-roots the tree, with a breadcrumb and **Whole repo** to go back, **Copy path** and **Reveal in Finder**. On a file: **Open in editor**, **Copy path** and **Reveal**.
- **Live.** The tree and the preview follow changes on disk through the Live Repo watcher.

The view is for exploring. Editing stays in the **Files** panel and staging stays in **Changes**.
```

- [ ] **Step 4: Check the website builds**

Run: `pnpm --filter website build`
Expected: exit 0 (VitePress builds; no dead links).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md ROADMAP.md website/guide/desktop.md
git commit -m "docs: v3.11.2 Files view in the changelog, roadmap follow-ups and desktop guide"
```

---

### Task 12 (OPTIONAL, droppable): move `FileExplorerPanel` onto `useLazyRepoTree`

Drop this task if the release has no room. Task 11's ROADMAP bullet already records it as a follow-up. If you do it, it lifts the panel's 20,000-entry cap and gives it live refresh. `list_repo_tree` and its wrapper stay (spec §4: "`list_repo_tree` is not changed").

**Files:**
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue:1-33` (script), `:446-448` (truncated badge), `:466-505` (tree rows)
- Modify: `apps/desktop/src/App.vue` (the `<FileExplorerPanel …>` tag at ~line 4568)
- Modify: `apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts:38-60` (backend mock), plus one test
- Delete: `apps/desktop/src/composables/useRepoFileTree.ts`, `apps/desktop/src/composables/__tests__/useRepoFileTree.test.ts`
- Modify: `ROADMAP.md` (remove the bullet added in Task 11), `CHANGELOG.md` (`### Changed`)

**Interfaces:**
- Consumes: `useLazyRepoTree({ …, storageKeyPrefix })` (Task 5) and `listRepoDir` (Task 2).
- Produces: the panel gains an optional `watcher?: TreeWatcher | null` prop. Its persistence key is `gitwand-explorer-tree:<repoPath>`, so the panel never shares expansion state with the view.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts`, add to the `vi.mock("../../utils/backend", …)` factory, next to `listRepoTree`:

```ts
  listRepoDir: vi.fn(async (_cwd: string, dir: string) => ({
    entries:
      dir === ""
        ? [
            { name: "lib", path: "lib", kind: "dir", ignored: false, size: 0 },
            { name: "a.ts", path: "a.ts", kind: "file", ignored: false, size: 13 },
            { name: "b.ts", path: "b.ts", kind: "file", ignored: false, size: 13 },
          ]
        : [{ name: "c.ts", path: "lib/c.ts", kind: "file", ignored: false, size: 1 }],
    truncated: false,
  })),
```

Add `import { listRepoDir } from "../../utils/backend";` with the other imports. Then append:

```ts
describe("FileExplorerPanel — lazy tree (v3.11.2)", () => {
  it("lists the root through listRepoDir and a folder only when it is opened", async () => {
    mountPanel();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "", false);
    const folder = [...container.querySelectorAll<HTMLElement>("[role=treeitem]")].find((r) => r.textContent?.includes("lib"))!;
    folder.click();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "lib", false);
    expect(container.textContent).toContain("c.ts");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/components/__tests__/FileExplorerPanel.test.ts`
Expected: FAIL. The new test fails with `expected "spy" to be called with arguments: [ '/repo', '', false ]`, because the panel still calls `listRepoTree`. The five existing tests pass.

- [ ] **Step 3: Migrate the panel**

In `apps/desktop/src/components/FileExplorerPanel.vue`:
- Replace `import { useRepoFileTree } from "../composables/useRepoFileTree";` (line 4) with:

```ts
import { useLazyRepoTree, type TreeWatcher } from "../composables/useLazyRepoTree";
```

- Change `import { getGitBlame } from "../utils/backend";` (line 9) to `import { getGitBlame, listRepoDir } from "../utils/backend";`.
- Replace the props (lines 15-18) with:

```ts
const props = defineProps<{
  repoPath: string;
  changedFiles: RepoFileEntry[];
  /** v3.11.2 — live refresh; optional so existing mounts keep working. */
  watcher?: TreeWatcher | null;
}>();
```

- Replace lines 30-33 (from `const repoPathRef` through `watch(repoPathRef, () => tree.refresh(), { immediate: true });`) with:

```ts
const repoPathRef = toRef(props, "repoPath");
const changedFilesRef = toRef(props, "changedFiles");
// Lazy, live tree (v3.11.2): replaces the one-shot 20,000-entry list_repo_tree
// load. Its own storage prefix keeps the panel's expansion separate from the
// Files view's.
const tree = useLazyRepoTree({
  repoPath: repoPathRef,
  root: ref(""),
  repoFiles: changedFilesRef,
  listDir: (dir, includeIgnored) => listRepoDir(props.repoPath, dir, includeIgnored),
  watcher: props.watcher ?? null,
  storageKeyPrefix: "gitwand-explorer-tree:",
});
```

- Delete the truncated badge `<button v-if="tree.truncated.value" class="fe__truncated" …>…</button>` (lines 446-448). Truncation is now a per-folder placeholder row.
- Replace the rows `<div v-for="row in tree.rows.value" …> … </div>` block (lines 469-504) with:

```vue
        <div
          v-for="row in tree.rows.value"
          :key="`${row.kind}-${row.path}`"
          class="file-item"
          :class="{ 'tree-folder': row.kind === 'folder' }"
          :style="{ paddingLeft: `${row.depth * 14 + (row.kind === 'folder' ? 5 : 18)}px` }"
          role="treeitem"
          tabindex="0"
          @click="row.kind === 'folder' ? tree.toggle(row.path) : row.kind === 'file' ? onFileClick(row.path) : row.kind === 'error' ? tree.retry(row.path) : undefined"
          @dblclick="row.kind === 'file' && onFileDblClick(row.path)"
        >
          <template v-if="row.kind === 'folder'">
            <svg
              class="tree-chevron"
              :class="{ 'tree-chevron--collapsed': !row.expanded }"
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 5h6l2 2h10v12H3z" />
            </svg>
            <span class="file-name mono tree-folder-name">{{ row.name }}</span>
            <span v-if="row.badge" class="tree-folder-count">{{ row.badge.changed }}</span>
          </template>
          <template v-else-if="row.kind === 'file'">
            <span
              v-if="row.status"
              class="file-status-dot"
              :class="`file-status-dot--${row.status.status}`"
              :title="row.status.status"
            />
            <span class="file-name mono">{{ row.name }}</span>
          </template>
          <span v-else-if="row.kind === 'loading'" class="file-name">{{ t('filesView.loading') }}</span>
          <span v-else-if="row.kind === 'error'" class="file-name" :title="row.message">{{ t('filesView.loadError', row.message) }}</span>
          <span v-else class="file-name">{{ t('filesView.truncated', '5,000') }}</span>
        </div>
```

- `ref` must be imported: line 2 already imports `ref` from `vue`, so nothing changes there.

In `apps/desktop/src/App.vue`, add `:watcher="repoWatcher"` to the `<FileExplorerPanel …>` tag, after `:changed-files="repoFiles"`.

Delete the superseded files:

```bash
git rm apps/desktop/src/composables/useRepoFileTree.ts apps/desktop/src/composables/__tests__/useRepoFileTree.test.ts
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `cd apps/desktop && pnpm exec vitest run src/components/__tests__/FileExplorerPanel.test.ts src/utils/__tests__/commandRegistry.test.ts`
Expected: PASS (6 + 7). The registry still lists `list_repo_tree`, because `backend.ts` still invokes it; the wrapper stays per spec §4.

Run: `cd apps/desktop && pnpm test && pnpm --filter @gitwand/core build && pnpm exec vue-tsc --noEmit`
Expected: the whole suite passes; vue-tsc exits 0.

- [ ] **Step 5: Docs for this task**

In `ROADMAP.md`, delete the bullet `- **Move the File Explorer panel onto useLazyRepoTree.** …` that Task 11 added.

In `CHANGELOG.md`, under `## [Unreleased]`, between `### Added` and `### Fixed`, add:

```markdown
### Changed
- **The Files panel lists folders lazily and refreshes live.** The File Explorer panel used to load the whole repository once, capped at 20,000 entries, and never refreshed. It now uses the Files view's tree model: each folder is listed when it is opened, folders show a count of changes below them, and the Live Repo watcher keeps the tree current.
```

Also update the last line of Task 11's CHANGELOG `Added` entry from "The existing Files panel (File Explorer, with tabs and editing) is unchanged." to "The existing Files panel keeps its tabs and editing (see Changed)."

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/FileExplorerPanel.vue apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts apps/desktop/src/App.vue ROADMAP.md CHANGELOG.md
git commit -m "feat(desktop): the File Explorer panel lists folders lazily and refreshes live"
```

---

## Self-review (done while writing; re-run before execution)

**Spec coverage.**

| Spec | Covered by |
|---|---|
| §4 `list_repo_dir` | Task 1. libgit2 classification, `.git` skipped, symlinks not followed, 5,000 cap, sorting, `safe_repo_path`. |
| §4 wiring and parity | Task 2 |
| §4 `reveal_in_file_manager` | Task 3 |
| §5 | Task 5. Cache, expansion, rows with placeholders, deleted merge, badges from one memoized pass, root reset, watcher with 300 ms debounce and a full reload on `truncated`, persistence. |
| §6 | Task 4 (keys) and Task 6 (ARIA and the listener with its `isEditableTarget` guard). |
| §7 integration | Task 10. `ViewMode`, `DockEntryId`, `DEFAULT_DOCK_ORDER`, `normalizeDockOrder`, the hidden flag in both settings files, palette `view-files`, `useAppMenu`, `defineAsyncComponent`. The Files tile is kept. |
| §7 tree pane | Task 6. Virtualized, Show ignored, both context menus. |
| §7 preview | Task 8 (table) and Task 9 (header and body). |
| §8 | Task 5 (error row, scope root), Task 10 (scope-gone fallback), Task 8 (inline error, request id, watcher reload, "Deleted from disk"). |
| §9 | Every bullet maps to a named test. Manual QA: Task 10 Step 10, and Task 3's comment for Reveal and the native menu in the Tauri app. |
| §10 | Task 11 (ROADMAP) and Task 12 (optional panel migration). |

**Placeholder scan.** Every code step has a code block. No step says "similar to Task N" or "add error handling". Every expected failure names its error.

**Type consistency.** These names are used identically across tasks:
- `RepoDirEntry` and `RepoDirListing` (Rust in Task 1, TS in Task 2, consumed in Tasks 5, 10 and 12);
- `ListDirFn`, `TreeWatcher`, `FileStatusInfo`, `LazyTreeRow` and `FileRow` (Task 5 → 6, 8, 9, 10, 12);
- `DIR_ENTRY_CAP` (Task 5 → 6) and `WATCH_DEBOUNCE_MS` (Task 5 → 8);
- `PreviewTarget` (Task 8 → 9, 10) and `revealLabelKey` (Task 6 → 9);
- `dockEntryViewMode` (Task 10 → AppDock and App).

`KeymapRow` (Task 4) is structurally satisfied by `LazyTreeRow`: placeholders carry `name: ""`, and only folders carry `expanded`.

**Review focus.** Each of the five lines names a test that exists in its owning task: Tasks 1, 2, 3, 5, 8 and 10.
