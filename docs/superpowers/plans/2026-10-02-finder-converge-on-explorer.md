# v3.11.2 Converge on the File Explorer Panel: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the File Explorer panel (`FileExplorerPanel.vue`) the only file browser. It gets the Browse view's additions: the virtualized, keyboard-operable `FileTreePane` tree with "Show ignored" and the context menu, rooting at the workspace scope, and a per-tab **Diff | File** toggle that opens a changed file on its inline diff. Then the full-screen Browse view (`FilesView`, `FilePreviewPane`, `ViewMode` `"files"`, dock entry `"files-view"`, palette, menu, `dockHideFilesView`) is removed.

**Architecture:** The panel renders `FileTreePane` over its existing `useLazyRepoTree`, and a new `useTreeScopeRoot` composable roots the tree at the scope. That composable is lifted from `FilesView.vue` and gains a repo-switch guard, because the panel lives in a `KeepAlive` and is never remounted. For the Diff side, the panel feeds the active tab, when it is diffable, into `useFilePreview` and renders `DiffViewer`. Which side a tab shows comes from the pure rules in `explorerTabView.ts`. When a tab leaves the Diff side, `useFileExplorer.reloadTab` re-reads a clean buffer from disk, so the editor never comes back with content that is older than the diff the user just saw.

**Tech Stack:** TypeScript, Vue 3 `<script setup>`, CodeMirror 6 (through `useCodeMirror`), `@tanstack/vue-virtual` (through `useVirtualRows`), Vitest 4 (node by default, jsdom per file). No Rust, no new Tauri command, and no dev-server change.

**Spec:** docs/superpowers/specs/2026-10-02-finder-converge-on-explorer-design.md (the addendum, which is the source of truth), amending docs/superpowers/specs/2026-10-01-finder-folder-navigation-design.md

## Global Constraints

- Every filesystem path from the frontend goes through `safe_repo_path()` (`apps/desktop/src-tauri/src/git/cmd.rs:73`) in Rust and through `safeRepoPath()` (`apps/desktop/dev-server.mjs:42`) in the dev-server. Never inline your own path validation. (No backend change is planned. This applies if one becomes necessary.)
- Pass git and process arguments as discrete arrays (`.arg()` / `.args([...])`, `execFileSync`/`spawnSync` arrays). Never build a command string by interpolation.
- Every new `#[tauri::command]` gets, in the same task, a typed wrapper in `apps/desktop/src/utils/backend.ts`, an entry in `apps/desktop/src/utils/commandRegistry.ts` and a route in `apps/desktop/dev-server.mjs`. Never call `invoke()` from a component or composable, and always pass the command name to `tauriInvoke` as a string literal. (This plan adds none. It only consumes existing wrappers: `listRepoDir`, `revealInFileManager`, `clipboardWriteText`, `pathExists`, `getGitDiff`, `readFileAtRevision`, `readFile`.)
- `list_repo_dir` caps each directory at **5,000 entries**, then sets `truncated: true`.
- Watcher-driven reloads use a **300 ms** trailing debounce.
- Type-ahead resets after **700 ms**.
- Tree state persists in `localStorage` under the key **`gitwand-explorer-tree:<repoPath>`**. Every access is wrapped in `try/catch`, and the panel works without storage. The `gitwand-files-view:` prefix is retired (Task 7).
- Every user-visible string needs a key in all **5 locales**: `en`, `fr`, `es`, `pt-BR`, `zh-CN` (`apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`). Prefer the `i18n-sync` skill. Every task below also gives the exact strings. The locales are typed against `en` (`const fr: Locale = …`), so `vue-tsc` fails on a key missing from, or left over in, any one of them.
- A settings field is added to, or removed from, **both** `apps/desktop/src/composables/useSettings.ts` (`AppSettings` + `defaultAppSettings`) **and** `apps/desktop/src/components/SettingsPanel.vue` (`Settings` + defaults), in the same commit.
- `FileExplorerPanel` stays loaded with `defineAsyncComponent(() => import(...))` in `App.vue` (`App.vue:66`), inside its `KeepAlive`.
- No `{ deep: true }` watcher anywhere. Watch primitives, computed strings or array identities.
- Tests needing git use **real temporary git repos**. Never mock the git layer. The only stand-ins allowed are the IPC wrapper (`utils/backend`, as 60+ existing component tests already do), injected loader functions for pure logic, `@tanstack/vue-virtual` (jsdom has no layout) and a `DiffViewer` stub (its own rendering is tested elsewhere). Listing correctness itself is pinned by the Rust tests on real repos and by the parity test, which this plan does not touch.
- Run `cargo fmt` (then `cargo clippy --all-targets -- -D warnings`) from `apps/desktop/src-tauri` before committing any Rust. (No Rust is planned.)
- New components and composables use `<script setup lang="ts">` / the Composition API only.
- Never hand-edit a version field (`package.json`, `Cargo.toml`, `tauri.conf.json`). Use `pnpm` only.
- Do not touch the user's uncommitted WIP: `benchmark/corpus.json`, `benchmark/results/v3.11.1-corpus3-baseline.json` and `.github/workflows/benchmark-gate.yml`. Always `git add` named files, never `git add -A` or `git add .`.
- The desktop type-check needs `packages/core/dist`. Run `pnpm --filter @gitwand/core build` before `vue-tsc`.
- **Test command:** `cd apps/desktop && node_modules/.bin/vitest run <files>`. `pnpm exec vitest` hangs in the sandbox. **Type-check command:** `cd apps/desktop && node_modules/.bin/vue-tsc --noEmit`.
- The locale namespace stays `filesView.*`, even though the Browse view goes away. `FileTreePane`, `revealLabel.ts` and the panel all share it, and renaming it would rewrite about 40 keys in 5 files for no user-visible change.

## Review Focus

These are the five failure modes most likely to bite a user that the tasks' main-path tests would not catch on their own. Each one is pinned by a named test in the task that owns it.

1. **The tab's editor buffer and the file on disk disagree around the Diff side.** The diff always reads the disk, but `useFileExplorer` reads a tab's buffer once, when the tab opens. Say the file changes on disk while the tab is on Diff, and the user then switches to File. A stale clean buffer would come back, and saving it would silently overwrite the external change. With a dirty buffer, the Diff side would show a diff that does not contain the user's edits.
   - Task 5, "the Diff side is disabled while the buffer has unsaved edits".
   - Task 6, "switching to File re-reads a clean tab from disk".
   - Task 4, `reloadTab` "never touches a dirty tab" and "drops a read that lands after the user typed".
2. **Switching Diff/File, or switching tabs, while a diff load is in flight.** A late response must not paint over the editor, or paint file A's diff into tab B.
   - Task 5, "a diff that resolves after switching to File is dropped".
   - Task 5, "a diff for an earlier tab is dropped".
3. **A tab whose file changes status while it is open.** Three cases:
   - Its file becomes unchanged (diff → nothing). For example, it is committed or discarded from the Changes view.
   - Its file becomes changed while the tab is on File. For example, the user saves it. The tab must not flip to the diff under the cursor.
   - Its file is deleted on disk.

   Pins:
   - Task 5, "a File tab stays on File when its file becomes changed".
   - Task 6, "falls back to the editor when its file becomes unchanged, and stays there when it changes again".
   - Task 6, "says Deleted from disk and keeps the buffer".
4. **The panel inside `KeepAlive` across repo switches** (`App.vue:4585-4594`, not keyed by repo, unlike the Browse view was). A diff or a scope check started for repo A must not land in repo B.
   - Task 5, "survives a repo switch inside KeepAlive: the new repo's tree and tabs, never the old repo's late diff".
   - Task 2, "never clears the scope of a repo switched to while the check was in flight".
5. **An existing user whose saved settings mention Browse.** A stored `dockOrder` may contain `"files-view"`, and a stored `dockHideFilesView` may be present. Loading those settings must not render a phantom dock button, must not crash the reorder list, and must not start the app on a view that no longer exists.
   - Task 7, "drops a stored 'files-view' dock id".
   - Task 7, "an existing user's saved Browse settings load, and startup lands on a real view".

---

## File Structure

| File | Status | Single responsibility |
|---|---|---|
| `apps/desktop/src/components/FileTreePane.vue` | modify | new `activate(path, pinned)` emit: a click or Enter opens a preview tab, a double click pins it; a click on a folder row toggles it |
| `apps/desktop/src/components/__tests__/FileTreePane.test.ts` | modify | activation tests; `mount()` takes `rows` |
| `apps/desktop/src/composables/useTreeScopeRoot.ts` | create | tree root under the workspace scope, the scope-gone fallback (`pathExists`), Scope here / Whole repo, guarded against repo switches |
| `apps/desktop/src/composables/__tests__/useTreeScopeRoot.test.ts` | create | fallback, keep-when-exists, repo-switch race, notice lifecycle |
| `apps/desktop/src/components/FileExplorerPanel.vue` | modify | tree → `FileTreePane`, context-menu actions, scope chip and notice (Task 3); Diff \| File toggle, Working tree \| Index, conflicted banner, diff body (Task 5); reload on leaving Diff, status fallback, "Deleted from disk" (Task 6) |
| `apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts` | modify | mocks and `mountPanel` reworked; tree, context menu, scope, diff, race and lifecycle tests |
| `apps/desktop/src/composables/explorerTabView.ts` | create | pure rules: `isDiffable`, `initialTabView`, `resolveTabView`, `canShowDiff` |
| `apps/desktop/src/composables/__tests__/explorerTabView.test.ts` | create | the rules |
| `apps/desktop/src/composables/useFileExplorer.ts` | modify | `reloadTab(repoPath, cwd, tabId)` |
| `apps/desktop/src/composables/__tests__/useFileExplorer.test.ts` | modify | `reloadTab` tests |
| `apps/desktop/src/App.vue` | modify | panel emits wired (Tasks 3, 5); `hideFilesOnHandoff`; Browse removed (Task 7) |
| `apps/desktop/src/__tests__/fileExplorerPanel-wiring.test.ts` | create | source-level pin of the panel's App.vue call site |
| `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` | modify | `filesView.viewLabel/viewDiff/viewFile/diffNeedsSave`, `noTextDiff` without a size (Task 5); Browse-only keys removed (Task 7) |
| `apps/desktop/src/components/FilesView.vue`, `FilePreviewPane.vue` + their tests | delete | Browse view (Task 7) |
| `apps/desktop/src/__tests__/filesView-wiring.test.ts`, `src/composables/__tests__/useSettings-filesView.test.ts` | delete | Browse pins (Task 7) |
| `apps/desktop/src/composables/useGitRepo.ts`, `useSettings.ts`, `useAppMenu.ts`, `components/SettingsPanel.vue`, `components/AppDock.vue` | modify | Browse removed (Task 7) |
| `apps/desktop/src/composables/useLazyRepoTree.ts` + its test | modify | default storage prefix becomes `gitwand-explorer-tree:` (Task 7) |
| `apps/desktop/src/composables/useFilePreview.ts` | modify (comment only) | doc names the panel as its consumer (Task 7) |
| `apps/desktop/src/composables/__tests__/useSettings-browseRemoved.test.ts` | create | dock order, stored settings, locale cleanup, every `filesView` key referenced (Task 7) |
| `CHANGELOG.md`, `ROADMAP.md`, `website/guide/desktop.md` | modify | docs rewritten around the panel (Task 8) |

**Order, and why it differs from the suggested one.** The suggested four steps become nine tasks, for three reasons.
- **Task 1 (FileTreePane) and Task 2 (scope composable) are split out of "Panel tree".** `FileTreePane` cannot express "open a preview tab" today: a click and every arrow key both emit `select` (`FileTreePane.vue:88-95`), Enter emits `select` too (`:116-118`), and a double click emits `open-in-editor`, the external editor (`:158-162`). So it needs a new emit, with its own reviewer gate. The scope logic is lifted from `FilesView.vue:37-68,114-121` into a composable before that file is deleted. It also gains a guard that `FilesView` never needed, because `FilesView` was keyed by repo (`App.vue:4547`) and the panel is not.
- **The Diff | File work is split into its building blocks (Task 4), the feature (Task 5) and the lifecycle (Task 6).** Review Focus #1 and #3 depend on rules that are easier to pin as pure functions and as a `useFileExplorer` method than through a mounted panel.
- **A final verification task (Task 9)** runs the whole suite, the type-check and the manual QA once Browse is gone.

---

### Task 1: FileTreePane activates a file on click or Enter and pins it on double click

**Files:**
- Modify: `apps/desktop/src/components/FileTreePane.vue:2-11` (doc comment), `:27-38` (emits), `:116-118` (`apply` case `"open"`), `:141-162` (`onRowClick`, `onRowDblClick`)
- Test: `apps/desktop/src/components/__tests__/FileTreePane.test.ts:59-91` (`mount` gains `rows` and `onActivate`), append a `describe` after `:264`

**Interfaces:**
- Consumes: `LazyTreeRow` (`useLazyRepoTree.ts:81`), `resolveFileTreeShortcut` (`fileTreeKeymap.ts`, unchanged).
- Produces: a new emit on `FileTreePane`:
  ```ts
  activate: [path: string, pinned: boolean];
  ```
  It is emitted on a click on a non-deleted file (`pinned = false`), on Enter on a non-deleted file (`false`) and on a double click on a non-deleted file (`true`). A click on a folder row now also emits `toggle`. A double click never emits `open-in-editor` any more, which stays reachable from the context menu. `select` keeps its meaning: the cursor moved.

- [ ] **Step 1: Write the failing tests**

In `FileTreePane.test.ts`, change the `mount` signature and props (lines 59-91):

```ts
async function mount(props: { selectedPath?: string | null; showIgnored?: boolean; rows?: LazyTreeRow[] } = {}) {
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
          rows: props.rows ?? ROWS,
          selectedPath: props.selectedPath ?? null,
          showIgnored: props.showIgnored ?? false,
          label: "repo",
          onSelect: on("select"),
          onActivate: on("activate"),
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
```

Append at the end of the file:

```ts
describe("FileTreePane — activation (File Explorer panel)", () => {
  const DELETED: LazyTreeRow = {
    kind: "file", path: "gone.ts", name: "gone.ts", depth: 0,
    ignored: false, symlink: false, deleted: true, size: 0, status: null,
  };

  it("a click on a file moves the cursor and opens it as a preview", async () => {
    const events = await mount();
    items()[3]!.click();
    expect(events).toEqual([["select", "src/a.ts", "file"], ["activate", "src/a.ts", false]]);
  });

  it("a double click pins the file and never hands it to the external editor", async () => {
    const events = await mount();
    items()[3]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(last(events)).toEqual(["activate", "src/a.ts", true]);
    expect(events.some(([name]) => name === "open-in-editor")).toBe(false);
  });

  it("Enter opens the file under the cursor as a preview", async () => {
    const events = await mount({ selectedPath: "src/a.ts" });
    key("Enter");
    expect(last(events)).toEqual(["activate", "src/a.ts", false]);
  });

  it("the arrow keys only move the cursor", async () => {
    const events = await mount();
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowDown");
    expect(events.some(([name]) => name === "activate")).toBe(false);
  });

  it("a click on a folder row toggles it", async () => {
    const events = await mount();
    items()[4]!.click();
    expect(events).toEqual([["select", "docs", "folder"], ["toggle", "docs"]]);
  });

  it("never activates a deleted file", async () => {
    const events = await mount({ rows: [DELETED], selectedPath: "gone.ts" });
    items()[0]!.click();
    items()[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    key("Enter");
    expect(events.some(([name]) => name === "activate")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/components/__tests__/FileTreePane.test.ts`
Expected: 5 failures in "activation". There is no `activate` event, so the first test's `toEqual` gets `[["select","src/a.ts","file"]]`. The double-click test finds `open-in-editor`, and the folder-click test lacks `["toggle","docs"]`. "the arrow keys only move the cursor" passes already: it pins that the change does not over-reach. The existing tests still pass.

- [ ] **Step 3: Implement**

In `FileTreePane.vue`, replace the doc comment (lines 2-11):

```ts
/**
 * FileTreePane — the File Explorer panel's tree (v3.11.2).
 *
 * Virtualized rows (`useVirtualRows`), one tab stop with
 * `aria-activedescendant`, the keyboard model of `fileTreeKeymap.ts`, and a
 * component-local context menu (the `ctxMenu` pattern of CommitGraph.vue).
 * It owns no data: rows come from `useLazyRepoTree` through the panel, and
 * every action is emitted. `select` means the cursor moved; `activate` means
 * open the file: a click or Enter opens the preview tab, a double click pins
 * it. The cursor is local because a placeholder row (error, truncated) can
 * hold it without being a selection.
 */
```

In the emits (lines 27-38), after `select: [path: string, kind: "file" | "folder"];`, add:

```ts
  /** Open the file: a click or Enter (preview tab), a double click (`pinned`). */
  activate: [path: string, pinned: boolean];
```

Replace the `"open"` case (lines 116-118):

```ts
    case "open":
      if (r?.kind === "file" && !r.deleted) emit("activate", r.path, false);
      break;
```

Replace `onRowClick` and `onRowDblClick` (lines 141-162, keeping `onChevronClick` between them unchanged):

```ts
function onRowClick(i: number): void {
  const r = props.rows[i];
  if (r?.kind === "error") {
    cursor.value = i;
    emit("retry", r.path);
    return;
  }
  moveTo(i);
  if (r?.kind === "folder") emit("toggle", r.path);
  else if (r?.kind === "file" && !r.deleted) emit("activate", r.path, false);
}
```

```ts
/**
 * A double click pins the file's tab. A folder needs nothing here: the two
 * clicks that come before a dblclick have already toggled it twice.
 */
function onRowDblClick(i: number): void {
  const r = props.rows[i];
  if (r?.kind === "file" && !r.deleted) emit("activate", r.path, true);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/components/__tests__/FileTreePane.test.ts src/components/__tests__/FilesView.test.ts`
Expected: all pass. `FilesView` does not listen to `activate`. Its folder rows now toggle on click, which is harmless until Task 7 deletes it.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/FileTreePane.vue apps/desktop/src/components/__tests__/FileTreePane.test.ts
git commit -m "feat(desktop): FileTreePane opens a file on click or Enter and pins it on double click"
```

---

### Task 2: `useTreeScopeRoot`, the scope-rooted tree root with a repo-switch guard

**Files:**
- Create: `apps/desktop/src/composables/useTreeScopeRoot.ts`
- Test: `apps/desktop/src/composables/__tests__/useTreeScopeRoot.test.ts`

**Interfaces:**
- Consumes: `useWorkspaceScope()` → `{ activeScope: Ref<string | null>, setScope(path): Promise<void>, clearScope(): Promise<void> }` (`useWorkspaceScope.ts`, module singleton). Also `pathExists(cwd: string, rel: string): Promise<boolean>` (`backend.ts:3005`).
- Produces:
  ```ts
  export function useTreeScopeRoot(repoPath: Readonly<Ref<string>>): {
    /** "" for the whole repo, else the scope folder: `useLazyRepoTree`'s `root`. */
    root: ComputedRef<string>;
    /** The scope folder that disappeared, for the notice; null when there is nothing to say. */
    goneScope: Ref<string | null>;
    /** `useLazyRepoTree`'s `onRootError`: clears the scope only if its folder no longer exists. */
    onRootError: () => Promise<void>;
    scopeHere: (path: string) => Promise<void>;
    wholeRepo: () => Promise<void>;
  };
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/useTreeScopeRoot.test.ts`:

```ts
// @vitest-environment jsdom
/**
 * useTreeScopeRoot — the File Explorer panel's tree root under a workspace
 * scope. `utils/backend` is the IPC wrapper stand-in (pathExists and the
 * workspace file), not a git one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { effectScope, nextTick, ref, type EffectScope } from "vue";

vi.mock("../../utils/backend", () => ({
  pathExists: vi.fn(async () => false),
  workspaceRead: vi.fn(async () => {
    throw new Error("no workspace file");
  }),
  workspaceWrite: vi.fn(async () => {}),
}));

import { pathExists } from "../../utils/backend";
import { useTreeScopeRoot } from "../useTreeScopeRoot";
import { useWorkspaceScope } from "../useWorkspaceScope";

let scope: EffectScope | null = null;
function setup(repo = "/repo") {
  const repoPath = ref(repo);
  scope = effectScope();
  const s = scope.run(() => useTreeScopeRoot(repoPath))!;
  return { repoPath, s };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(pathExists).mockReset().mockResolvedValue(false);
  useWorkspaceScope().activeScope.value = null;
});
afterEach(() => {
  scope?.stop();
  scope = null;
  useWorkspaceScope().activeScope.value = null;
});

describe("useTreeScopeRoot", () => {
  it("roots the tree at the active scope, and at the repo without one", () => {
    const { s } = setup();
    expect(s.root.value).toBe("");
    useWorkspaceScope().activeScope.value = "packages/core";
    expect(s.root.value).toBe("packages/core");
  });

  it("clears a scope whose folder is gone and names it", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    const { s } = setup();
    await s.onRootError();
    expect(pathExists).toHaveBeenCalledWith("/repo", "gone");
    expect(useWorkspaceScope().activeScope.value).toBeNull();
    expect(s.goneScope.value).toBe("gone");
  });

  it("keeps a scope whose folder exists but failed to list", async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    useWorkspaceScope().activeScope.value = "locked";
    const { s } = setup();
    await s.onRootError();
    expect(useWorkspaceScope().activeScope.value).toBe("locked");
    expect(s.goneScope.value).toBeNull();
  });

  it("treats a failed existence check as gone", async () => {
    vi.mocked(pathExists).mockRejectedValue(new Error("ipc down"));
    useWorkspaceScope().activeScope.value = "gone";
    const { s } = setup();
    await s.onRootError();
    expect(useWorkspaceScope().activeScope.value).toBeNull();
  });

  it("never clears the scope of a repo switched to while the check was in flight", async () => {
    const check = deferred<boolean>();
    vi.mocked(pathExists).mockReturnValueOnce(check.promise);
    useWorkspaceScope().activeScope.value = "gone";
    const { s, repoPath } = setup();
    const pending = s.onRootError();
    repoPath.value = "/other";
    await nextTick();
    check.resolve(false);
    await pending;
    expect(useWorkspaceScope().activeScope.value).toBe("gone");
    expect(s.goneScope.value).toBeNull();
  });

  it("Scope here and Whole repo set and clear the scope, and drop the notice", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    const { s } = setup();
    await s.onRootError();
    expect(s.goneScope.value).toBe("gone");
    await s.scopeHere("src");
    expect(useWorkspaceScope().activeScope.value).toBe("src");
    expect(s.goneScope.value).toBeNull();
    await s.wholeRepo();
    expect(useWorkspaceScope().activeScope.value).toBeNull();
  });

  it("drops the notice on a repo switch", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    const { s, repoPath } = setup();
    await s.onRootError();
    repoPath.value = "/other";
    await nextTick();
    expect(s.goneScope.value).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/composables/__tests__/useTreeScopeRoot.test.ts`
Expected: FAIL. The suite cannot resolve `../useTreeScopeRoot` ("Failed to load url" / "Cannot find module").

- [ ] **Step 3: Implement**

Create `apps/desktop/src/composables/useTreeScopeRoot.ts`:

```ts
/**
 * useTreeScopeRoot — the File Explorer panel's tree root under the workspace
 * scope (v3.11.2).
 *
 * Lifted from the Browse view (FilesView.vue, removed in the same release).
 * With a scope active the tree is rooted at the scope folder. A root that
 * fails to list is either gone or merely unreadable: only a folder that no
 * longer exists clears the scope (spec §8), and an unreadable one keeps it,
 * so the tree shows its error row with Retry.
 *
 * One addition the keyed Browse view never needed: the panel lives in a
 * KeepAlive and is not remounted on a repo switch, so an existence check that
 * resolves after the switch must not clear the next repo's scope.
 */
import { computed, ref, watch, type Ref } from "vue";
import { useWorkspaceScope } from "./useWorkspaceScope";
import { pathExists } from "../utils/backend";

export function useTreeScopeRoot(repoPath: Readonly<Ref<string>>) {
  const { activeScope, setScope, clearScope } = useWorkspaceScope();
  const root = computed(() => activeScope.value ?? "");
  const goneScope = ref<string | null>(null);

  watch(repoPath, () => {
    goneScope.value = null;
  });

  async function onRootError(): Promise<void> {
    const scope = root.value;
    const repo = repoPath.value;
    if (!scope || !repo) return;
    let exists = false;
    try {
      exists = await pathExists(repo, scope);
    } catch {
      exists = false;
    }
    if (exists || root.value !== scope || repoPath.value !== repo) return;
    goneScope.value = scope;
    await clearScope();
  }

  async function scopeHere(path: string): Promise<void> {
    goneScope.value = null;
    await setScope(path);
  }

  async function wholeRepo(): Promise<void> {
    goneScope.value = null;
    await clearScope();
  }

  return { root, goneScope, onRootError, scopeHere, wholeRepo };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/composables/__tests__/useTreeScopeRoot.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useTreeScopeRoot.ts apps/desktop/src/composables/__tests__/useTreeScopeRoot.test.ts
git commit -m "feat(desktop): useTreeScopeRoot roots a tree at the workspace scope, safe across repo switches"
```

---

### Task 3: The panel's tree becomes FileTreePane, with the context menu and the scope

**Files:**
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue:1-13` (imports), `:22-25` (emits), `:27-43` (setup of i18n, logs, scope, tree), `:107-113` (`onFileClick` / `onFileDblClick` → `onActivate`, `onCopyPath`, `onReveal`), `:475-517` (the hand-written tree → `FileTreePane`), CSS `:734-739` (`.fe__tree`) and `:825-845` (row styles that only the old tree used)
- Modify: `apps/desktop/src/App.vue:4586-4593` (`<FileExplorerPanel>`: add `@open-in-editor`)
- Test: `apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts:31-106` (mocks, imports, hooks, `mountPanel`), replace the `"lazy tree (v3.11.2)"` describe at `:229-257`
- Create: `apps/desktop/src/__tests__/fileExplorerPanel-wiring.test.ts`

**Interfaces:**
- Consumes: `FileTreePane` props `{ rows, selectedPath, showIgnored, label }` and emits `select`, `activate` (Task 1), `toggle`, `expand`, `collapse`, `retry`, `update:showIgnored`, `scope-here`, `copy-path`, `reveal`, `open-in-editor`. Also `useTreeScopeRoot` (Task 2), `useLazyRepoTree(...).{rows, selected, showIgnored, toggle, expand, collapse, retry}`, `explorer.openTab(repoPath, cwd, path, pin)` (`useFileExplorer.ts:66`), `clipboardWriteText(text)` (`backend.ts:3925`), `revealInFileManager(cwd, path)` (`backend.ts:1577`), `useLogs().pushLog(level, message)`, and App's `handleOpenInEditor(path: string)` (`App.vue:1740`).
- Produces: a new emit on `FileExplorerPanel`, `(e: "open-in-editor", path: string): void`. The existing locale keys used are `filesView.copyPathFailed`, `filesView.revealFailed`, `filesView.scopeGone`, `scope.active`, `scope.wholeRepo` and `scope.picker`. No new string.

- [ ] **Step 1: Write the failing tests**

In `FileExplorerPanel.test.ts`, replace lines 31-106 (from the `import { describe…` line through the end of `mountPanel`) with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, KeepAlive, nextTick, reactive, type App } from "vue";
import en from "../../locales/en";
import type { RepoDirEntry } from "../../utils/backend";
import type { RepoFileEntry } from "../../composables/useGitRepo";

const files: Record<string, string> = {
  "a.ts": "const a = 1;\n",
  "b.ts": "const b = 2;\n",
};

const FS: Record<string, RepoDirEntry[]> = {
  "": [
    { name: "lib", path: "lib", kind: "dir", ignored: false, size: 0 },
    { name: "a.ts", path: "a.ts", kind: "file", ignored: false, size: 13 },
    { name: "b.ts", path: "b.ts", kind: "file", ignored: false, size: 13 },
  ],
  lib: [{ name: "c.ts", path: "lib/c.ts", kind: "file", ignored: false, size: 1 }],
};

const HUNK = { header: "@@ -1 +1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] };

vi.mock("../../utils/backend", () => ({
  readFile: vi.fn(async (_cwd: string, path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  }),
  writeFile: vi.fn(async () => {}),
  listRepoDir: vi.fn(async (_cwd: string, dir: string) => {
    const entries = FS[dir];
    if (!entries) throw new Error(`Directory not found: ${dir}`);
    return { entries, truncated: false };
  }),
  getGitBlame: vi.fn(async () => [
    {
      line: 1,
      hash: "abc1234",
      hashFull: "abc1234def",
      author: "Ada",
      date: "2026-01-01",
      summary: "first",
    },
  ]),
  openInEditor: vi.fn(async () => {}),
  revealInFileManager: vi.fn(async () => {}),
  clipboardWriteText: vi.fn(async () => {}),
  pathExists: vi.fn(async () => false),
  workspaceRead: vi.fn(async () => {
    throw new Error("no workspace file");
  }),
  workspaceWrite: vi.fn(async () => {}),
  getGitDiff: vi.fn(async (_cwd: string, path: string, staged: boolean) => ({
    path: staged ? `${path}@index` : path,
    hunks: [HUNK],
  })),
  readFileAtRevision: vi.fn(async () => ({ bytesBase64: "", byteLength: 0, mime: "text/plain", absent: false })),
}));
// jsdom has no layout: a virtualizer that renders every row (a UI-library stand-in).
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

import FileExplorerPanel from "../FileExplorerPanel.vue";
import { useFileExplorer } from "../../composables/useFileExplorer";
import { useWorkspaceScope } from "../../composables/useWorkspaceScope";
import { useLogs } from "../../composables/useLogs";
import { loadCodeMirror } from "../../utils/codemirrorLibs";
import { useTheme } from "../../composables/useTheme";
import { clipboardWriteText, listRepoDir, pathExists, readFile, revealInFileManager } from "../../utils/backend";

const REPO = "/repo";
const OTHER = "/other";
const REVEAL_LABELS = [en.filesView.ctxRevealMac, en.filesView.ctxRevealWindows, en.filesView.ctxRevealLinux];

let app: App | null = null;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  // Back to each vi.fn's own implementation, "once" queues included.
  vi.resetAllMocks();
  useFileExplorer().disposeRepo(REPO);
  useFileExplorer().disposeRepo(OTHER);
  useWorkspaceScope().activeScope.value = null;
  useLogs().clearLogs();
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  useWorkspaceScope().activeScope.value = null;
  files["a.ts"] = "const a = 1;\n";
});

/**
 * Mount the panel behind a reactive state, so a test can change the repo, the
 * changed files or the panel's visibility the way App.vue does. `keepAlive`
 * wraps it in a KeepAlive like App.vue:4585.
 */
function mountPanel(changedFiles: RepoFileEntry[] = [], opts: { keepAlive?: boolean } = {}) {
  const state = reactive({ repoPath: REPO, changedFiles, shown: true });
  const events: Array<[string, ...unknown[]]> = [];
  const on = (name: string) => (...args: unknown[]) => {
    events.push([name, ...args]);
  };
  const panel = () =>
    state.shown
      ? h(FileExplorerPanel, {
          repoPath: state.repoPath,
          changedFiles: state.changedFiles,
          onOpenInEditor: on("open-in-editor"),
          onOpenMergeEditor: on("open-merge-editor"),
          onOpenFileHistory: on("open-file-history"),
        })
      : null;
  const Wrapper = defineComponent({
    setup: () => () => (opts.keepAlive ? h(KeepAlive, null, { default: panel }) : panel()),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
  return { state, events };
}

const rows = () => [...container.querySelectorAll<HTMLElement>("[role=treeitem]")];
const row = (name: string) => rows().find((r) => r.querySelector(".ftp__name")?.textContent === name)!;
const tree = () => container.querySelector<HTMLElement>("[role=tree]")!;
const key = (k: string) => tree().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const menuItems = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
const menuItem = (label: string) => menuItems().find((b) => b.textContent?.trim() === label)!;
const lastLog = () => {
  const logs = useLogs().entries.value;
  return logs[logs.length - 1];
};
```

Keep `settle`, `openTab`, `editorDoc`, `liveView`, `typeIntoEditor` and the `"editor wiring"` describe unchanged (lines 107-227 today). Replace the `describe("FileExplorerPanel — lazy tree (v3.11.2)", …)` block (lines 229-257) with:

```ts
describe("FileExplorerPanel — tree (v3.11.2)", () => {
  it("lists the root through listRepoDir and a folder only when it is opened", async () => {
    mountPanel();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "", false);
    expect(listRepoDir).not.toHaveBeenCalledWith(REPO, "lib", false);
    row("lib").click();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "lib", false);
    expect(row("c.ts")).toBeTruthy();
  });

  it("shows a deleted file struck through and never opens it", async () => {
    mountPanel([{ path: "lib/gone.ts", status: "deleted", section: "unstaged" }]);
    await settle();
    row("lib").click();
    await settle();
    const gone = row("gone.ts");
    expect(gone.classList.contains("ftp__row--deleted")).toBe(true);
    vi.mocked(readFile).mockClear();
    gone.click();
    gone.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();
    expect(readFile).not.toHaveBeenCalled();
    expect(useFileExplorer().tabsFor(REPO)).toHaveLength(0);
  });

  it("a click opens the preview tab and a double click pins it", async () => {
    mountPanel();
    await settle();
    row("a.ts").click();
    await settle();
    expect(useFileExplorer().tabsFor(REPO).map((t) => [t.path, t.pinned])).toEqual([["a.ts", false]]);
    row("a.ts").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();
    expect(useFileExplorer().tabsFor(REPO).map((t) => [t.path, t.pinned])).toEqual([["a.ts", true]]);
  });

  it("Enter opens the file under the cursor; the arrow keys alone open nothing", async () => {
    mountPanel();
    await settle();
    key("ArrowDown"); // lib
    key("ArrowDown"); // a.ts
    await settle();
    expect(useFileExplorer().tabsFor(REPO)).toHaveLength(0);
    key("Enter");
    await settle();
    expect(useFileExplorer().tabsFor(REPO).map((t) => [t.path, t.pinned])).toEqual([["a.ts", false]]);
  });

  it("Show ignored re-lists the tree with ignored entries", async () => {
    mountPanel();
    await settle();
    const box = container.querySelector<HTMLInputElement>(".ftp__ignored input")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "", true);
  });
});

describe("FileExplorerPanel — context menu (v3.11.2)", () => {
  async function openMenuOn(name: string) {
    mountPanel();
    await settle();
    row(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
  }

  it("Open in editor hands the file to App's external editor", async () => {
    const { events } = mountPanel();
    await settle();
    row("a.ts").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    menuItem(en.filesView.ctxOpenInEditor).click();
    expect(events[events.length - 1]).toEqual(["open-in-editor", "a.ts"]);
  });

  it("Copy path writes the repo-relative path", async () => {
    await openMenuOn("a.ts");
    menuItem(en.filesView.ctxCopyPath).click();
    await settle();
    expect(clipboardWriteText).toHaveBeenCalledWith("a.ts");
  });

  it("logs a failed Copy path instead of rejecting unhandled", async () => {
    vi.mocked(clipboardWriteText).mockRejectedValueOnce(new Error("denied"));
    await openMenuOn("a.ts");
    menuItem(en.filesView.ctxCopyPath).click();
    await settle();
    expect(lastLog()).toMatchObject({
      level: "error",
      message: en.filesView.copyPathFailed.replace("{0}", "a.ts").replace("{1}", "denied"),
    });
  });

  it("Reveal hands the path to the file manager, and logs a failure", async () => {
    vi.mocked(revealInFileManager).mockRejectedValueOnce(new Error("Path not found: a.ts"));
    await openMenuOn("a.ts");
    menuItems().find((b) => REVEAL_LABELS.includes(b.textContent?.trim() ?? ""))!.click();
    await settle();
    expect(revealInFileManager).toHaveBeenCalledWith(REPO, "a.ts");
    expect(lastLog()).toMatchObject({
      level: "error",
      message: en.filesView.revealFailed.replace("{0}", "a.ts").replace("{1}", "Path not found: a.ts"),
    });
  });
});

describe("FileExplorerPanel — scope (v3.11.2)", () => {
  it("'Scope here' sets the workspace scope and re-roots the tree on it", async () => {
    mountPanel();
    await settle();
    row("lib").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    menuItem(en.filesView.ctxScopeHere).click();
    await settle();
    expect(useWorkspaceScope().activeScope.value).toBe("lib");
    expect(listRepoDir).toHaveBeenLastCalledWith(REPO, "lib", false);
    expect(row("c.ts")).toBeTruthy();
    expect(container.querySelector(".fe__scope")?.textContent).toContain(en.scope.active.replace("{0}", "lib"));
  });

  it("roots the tree at the active scope, and 'Whole repo' clears it", async () => {
    useWorkspaceScope().activeScope.value = "lib";
    mountPanel();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "lib", false);
    expect(row("a.ts")).toBeUndefined();
    [...container.querySelectorAll<HTMLButtonElement>(".fe__scope button")]
      .find((b) => b.textContent?.trim() === en.scope.wholeRepo)!
      .click();
    await settle();
    expect(useWorkspaceScope().activeScope.value).toBeNull();
    expect(listRepoDir).toHaveBeenLastCalledWith(REPO, "", false);
    expect(container.querySelector(".fe__scope")).toBeNull();
  });

  it("falls back to the whole repo, with a notice, when the scope folder is gone", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    mountPanel();
    await settle();
    expect(pathExists).toHaveBeenCalledWith(REPO, "gone");
    expect(useWorkspaceScope().activeScope.value).toBeNull();
    expect(container.textContent).toContain(en.filesView.scopeGone.replace("{0}", "gone"));
    expect(listRepoDir).toHaveBeenLastCalledWith(REPO, "", false);
  });

  it("keeps the scope when its folder exists but cannot be listed", async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    useWorkspaceScope().activeScope.value = "gone";
    mountPanel();
    await settle();
    expect(useWorkspaceScope().activeScope.value).toBe("gone");
    expect(rows()[0]?.textContent).toContain("Directory not found: gone");
  });
});
```

Create `apps/desktop/src/__tests__/fileExplorerPanel-wiring.test.ts`:

```ts
/**
 * App.vue call site of the File Explorer panel (v3.11.2). Each handler is
 * optional to the type-checker, so forgetting one type-checks and silently
 * removes a hand-off, which is how MergeEditor's `cwd` went missing in
 * v3.11.1 (see mergeEditor-cwd-wiring.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appVue = readFileSync(resolve(__dirname, "../App.vue"), "utf-8");
const panel = appVue.match(/<FileExplorerPanel\b[\s\S]*?\/>/)?.[0] ?? "";

describe("App.vue — File Explorer panel wiring", () => {
  it("is lazy-loaded and kept alive", () => {
    expect(appVue).toMatch(
      /const FileExplorerPanel = defineAsyncComponent\(\(\) => import\("\.\/components\/FileExplorerPanel\.vue"\)\)/,
    );
    expect(appVue).toMatch(/<KeepAlive>\s*<FileExplorerPanel\b/);
  });

  it("gets the repo files and the live watcher", () => {
    expect(panel).toMatch(/:changed-files="repoFiles"/);
    expect(panel).toMatch(/:watcher="repoWatcher"/);
  });

  it("hands files to the external editor and asks before closing a dirty tab", () => {
    expect(panel).toMatch(/@open-in-editor="handleOpenInEditor"/);
    expect(panel).toMatch(/@request-close-tab="onRequestCloseFileTab"/);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/components/__tests__/FileExplorerPanel.test.ts src/__tests__/fileExplorerPanel-wiring.test.ts`
Expected: the new tree, context-menu and scope tests fail, because the old tree has no `.ftp__name`, so `row(...)` returns `undefined` and `.click()` throws a `TypeError`. The wiring test fails on `@open-in-editor="handleOpenInEditor"`. The five "editor wiring" tests still pass.

- [ ] **Step 3: Implement the panel's script**

In `FileExplorerPanel.vue`, replace lines 1-13 (the imports) with:

```ts
<script setup lang="ts">
import { computed, ref, toRef, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import FileTreePane from "./FileTreePane.vue";
import { useFileExplorer, resolveFileExplorerShortcut, type FileTab } from "../composables/useFileExplorer";
import { useLazyRepoTree, type TreeWatcher } from "../composables/useLazyRepoTree";
import { useTreeScopeRoot } from "../composables/useTreeScopeRoot";
import { useSettings } from "../composables/useSettings";
import { useI18n } from "../composables/useI18n";
import { useLogs } from "../composables/useLogs";
import { useDraggableResizable } from "../composables/useDraggableResizable";
import type { RepoFileEntry } from "../composables/useGitRepo";
import { clipboardWriteText, getGitBlame, listRepoDir, revealInFileManager } from "../utils/backend";
import { buildBlameModel, type BlameGutterEntry } from "../composables/useBlameGutter";
import { useCodeMirror } from "../composables/useCodeMirror";
import { peekCodeMirror } from "../utils/codemirrorLibs";
import type { EditorState as EditorStateType, Extension } from "@codemirror/state";
```

Replace the emits (lines 22-25) with:

```ts
const emit = defineEmits<{
  (e: "close"): void;
  (e: "request-close-tab", tabId: number): void;
  /** v3.11.2 — context menu "Open in editor": App opens the configured external editor. */
  (e: "open-in-editor", path: string): void;
}>();
```

Replace lines 27-43 (from `const { t } = useI18n();` through the end of the `useLazyRepoTree` call) with:

```ts
const { t } = useI18n();
const { pushLog } = useLogs();
const { settings, saveSettings } = useSettings();
const explorer = useFileExplorer();

const repoPathRef = toRef(props, "repoPath");
const changedFilesRef = toRef(props, "changedFiles");
// Lazy, live tree (v3.11.2), rooted at the workspace scope when one is
// active. The panel lives in a KeepAlive and is not remounted on a repo
// switch: the tree and the scope check both follow `repoPath` instead.
const scope = useTreeScopeRoot(repoPathRef);
const tree = useLazyRepoTree({
  repoPath: repoPathRef,
  root: scope.root,
  repoFiles: changedFilesRef,
  listDir: (dir, includeIgnored) => listRepoDir(props.repoPath, dir, includeIgnored),
  watcher: props.watcher ?? null,
  onRootError: () => void scope.onRootError(),
  storageKeyPrefix: "gitwand-explorer-tree:",
});
const repoName = computed(() => props.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? props.repoPath);
```

Replace `onFileClick` and `onFileDblClick` (lines 107-113) with:

```ts
/** A click or Enter opens the preview tab; a double click pins it (FileTreePane's `activate`). */
async function onActivate(path: string, pinned: boolean) {
  tree.selected.value = path;
  await explorer.openTab(props.repoPath, props.repoPath, path, pinned);
}

async function onCopyPath(path: string): Promise<void> {
  try {
    await clipboardWriteText(path);
  } catch (err) {
    pushLog("error", t("filesView.copyPathFailed", path, err instanceof Error ? err.message : String(err)));
  }
}

async function onReveal(path: string): Promise<void> {
  try {
    await revealInFileManager(props.repoPath, path);
  } catch (err) {
    pushLog("error", t("filesView.revealFailed", path, err instanceof Error ? err.message : String(err)));
  }
}
```

- [ ] **Step 4: Implement the panel's template and styles**

Replace the `<div class="fe__tree" role="tree">…</div>` block (lines 475-517) with:

```html
      <div class="fe__tree-col">
        <div v-if="scope.root.value" class="fe__scope" role="group" :aria-label="t('scope.picker')">
          <span class="fe__scope-path mono" :title="scope.root.value">{{ t('scope.active', scope.root.value) }}</span>
          <button type="button" class="fe__action-btn" @click="scope.wholeRepo()">{{ t('scope.wholeRepo') }}</button>
        </div>
        <p v-if="scope.goneScope.value" class="fe__scope-notice" role="status">
          {{ t('filesView.scopeGone', scope.goneScope.value) }}
        </p>
        <FileTreePane
          class="fe__tree"
          :rows="tree.rows.value"
          :selected-path="tree.selected.value"
          :show-ignored="tree.showIgnored.value"
          :label="scope.root.value || repoName"
          @select="(p: string) => { tree.selected.value = p; }"
          @activate="onActivate"
          @toggle="(p: string) => void tree.toggle(p)"
          @expand="(p: string) => void tree.expand(p)"
          @collapse="(p: string) => tree.collapse(p)"
          @retry="(d: string) => void tree.retry(d)"
          @update:show-ignored="(v: boolean) => { tree.showIgnored.value = v; }"
          @scope-here="(p: string) => void scope.scopeHere(p)"
          @copy-path="onCopyPath"
          @reveal="onReveal"
          @open-in-editor="(p: string) => emit('open-in-editor', p)"
        />
      </div>
```

In `<style scoped>`, replace the `.fe__tree` rule (lines 734-739) with:

```css
.fe__tree-col {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.fe__tree {
  flex: 1;
  min-height: 0;
}

.fe__scope {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  border-right: 1px solid var(--color-border);
  font-size: var(--font-size-xs);
}

.fe__scope-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fe__scope-notice {
  margin: 0;
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  border-right: 1px solid var(--color-border);
}
```

Delete lines 825-845: the `.file-status-dot*` rules, the comment about the shared tree row classes, and the `.file-item--deleted` rules. `FileTreePane` owns its row styles (`FileTreePane.vue:412-439`).

- [ ] **Step 5: Wire App.vue**

In `App.vue`, add one line to the `<FileExplorerPanel>` tag (lines 4586-4593), after `@request-close-tab="onRequestCloseFileTab"`:

```html
          @open-in-editor="handleOpenInEditor"
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/components/__tests__/FileExplorerPanel.test.ts src/__tests__/fileExplorerPanel-wiring.test.ts src/components/__tests__/FileTreePane.test.ts`
Expected: all pass (5 editor wiring, 5 tree, 4 context menu, 4 scope, 3 wiring, plus FileTreePane).

Run: `pnpm --filter @gitwand/core build && cd apps/desktop && node_modules/.bin/vue-tsc --noEmit`
Expected: no error.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/FileExplorerPanel.vue apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts apps/desktop/src/App.vue apps/desktop/src/__tests__/fileExplorerPanel-wiring.test.ts
git commit -m "feat(desktop): File Explorer panel tree gains keyboard, context menu, Show ignored and scope rooting"
```

---

### Task 4: Tab-view rules and `useFileExplorer.reloadTab`

**Files:**
- Create: `apps/desktop/src/composables/explorerTabView.ts`
- Test: `apps/desktop/src/composables/__tests__/explorerTabView.test.ts`
- Modify: `apps/desktop/src/composables/useFileExplorer.ts:138` (insert after `saveTab`), `:160-170` (return object)
- Test: `apps/desktop/src/composables/__tests__/useFileExplorer.test.ts`, insert a `describe` at `:135` (before `describe("resolveFileExplorerShortcut"`)

**Interfaces:**
- Consumes: `FileStatusInfo` (`useLazyRepoTree.ts:36-45`), `readFile(cwd, path): Promise<string>` (`backend.ts:174`).
- Produces:
  ```ts
  // explorerTabView.ts
  export type TabView = "diff" | "file";
  export function isDiffable(status: FileStatusInfo | null): status is FileStatusInfo;
  export function initialTabView(status: FileStatusInfo | null): TabView;
  export function resolveTabView(stored: TabView | undefined, status: FileStatusInfo | null): TabView;
  export function canShowDiff(status: FileStatusInfo | null, dirty: boolean): boolean;
  // useFileExplorer()
  reloadTab(repoPath: string, cwd: string, tabId: number): Promise<boolean>; // true when the buffer changed
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/composables/__tests__/explorerTabView.test.ts`:

```ts
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
```

In `useFileExplorer.test.ts`, insert before line 136 (`describe("resolveFileExplorerShortcut", …)`):

```ts
describe("useFileExplorer.reloadTab (v3.11.2)", () => {
  const REPO = "/repo/reload";

  beforeEach(() => {
    vi.clearAllMocks();
    useFileExplorer().disposeRepo(REPO);
  });

  it("re-reads a clean tab from disk", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO, REPO, "a.ts", true);
    vi.mocked(readFile).mockResolvedValueOnce("changed on disk");
    expect(await explorer.reloadTab(REPO, REPO, tab.id)).toBe(true);
    expect(tab.content).toBe("changed on disk");
    expect(explorer.isDirty(tab)).toBe(false);
  });

  it("reports no change when the disk matches the buffer", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO, REPO, "a.ts", true);
    expect(await explorer.reloadTab(REPO, REPO, tab.id)).toBe(false);
    expect(tab.content).toBe("content of a.ts");
  });

  it("never touches a dirty tab", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO, REPO, "a.ts", true);
    explorer.updateContent(REPO, tab.id, "my edit");
    vi.mocked(readFile).mockClear();
    expect(await explorer.reloadTab(REPO, REPO, tab.id)).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
    expect(tab.content).toBe("my edit");
  });

  it("drops a read that lands after the user typed", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO, REPO, "a.ts", true);
    let land!: (v: string) => void;
    vi.mocked(readFile).mockImplementationOnce(() => new Promise<string>((r) => { land = r; }));
    const pending = explorer.reloadTab(REPO, REPO, tab.id);
    explorer.updateContent(REPO, tab.id, "typed meanwhile");
    land("disk");
    expect(await pending).toBe(false);
    expect(tab.content).toBe("typed meanwhile");
    expect(tab.originalContent).toBe("content of a.ts");
  });

  it("keeps the buffer when the read fails", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO, REPO, "a.ts", true);
    vi.mocked(readFile).mockRejectedValueOnce(new Error("gone"));
    expect(await explorer.reloadTab(REPO, REPO, tab.id)).toBe(false);
    expect(tab.content).toBe("content of a.ts");
    expect(tab.binary).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/composables/__tests__/explorerTabView.test.ts src/composables/__tests__/useFileExplorer.test.ts`
Expected: `explorerTabView.test.ts` fails to load (cannot find `../explorerTabView`). The `reloadTab` tests fail with `TypeError: explorer.reloadTab is not a function`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/composables/explorerTabView.ts`:

```ts
/**
 * explorerTabView — which side of the File Explorer panel's Diff | File
 * toggle a tab shows (v3.11.2). Pure rules: the panel only stores the side a
 * tab was opened on, or the one the user picked.
 *
 * A changed file opens on its diff. The choice is recorded the first time the
 * panel shows the tab, so a file that becomes changed while its tab is on
 * File (a save) does not flip to the diff under the cursor. A file with no
 * diff to show (unchanged, or deleted from disk) always shows File.
 */
import type { FileStatusInfo } from "./useLazyRepoTree";

export type TabView = "diff" | "file";

/** A diff exists to show: the file is changed (conflicted included) and still on disk. */
export function isDiffable(status: FileStatusInfo | null): status is FileStatusInfo {
  return status !== null && !status.deletedOnDisk;
}

/** The side a tab opens on, the first time the panel shows it. */
export function initialTabView(status: FileStatusInfo | null): TabView {
  return isDiffable(status) ? "diff" : "file";
}

/** The side a tab shows now: its stored choice, but only a diffable file shows a diff. */
export function resolveTabView(stored: TabView | undefined, status: FileStatusInfo | null): TabView {
  if (!isDiffable(status)) return "file";
  return stored ?? "diff";
}

/**
 * The diff always reads the file on disk, so it is refused while the buffer
 * has unsaved edits: it would not show them ("Save to see the diff").
 */
export function canShowDiff(status: FileStatusInfo | null, dirty: boolean): boolean {
  return isDiffable(status) && !dirty;
}
```

In `useFileExplorer.ts`, insert after `saveTab` (after line 137, before `function closeTab`):

```ts
  /**
   * v3.11.2 — re-read a clean tab from disk. The panel calls it when a tab
   * leaves its Diff side: the diff showed the file on disk, and the buffer
   * dates from when the tab opened, so the editor must not come back older
   * than the diff the user just read (and then overwrite it on save). A dirty
   * tab is never touched, a read that lands after the user typed is dropped,
   * and a failed read keeps the buffer. Returns true when the buffer changed.
   */
  async function reloadTab(repoPath: string, cwd: string, tabId: number): Promise<boolean> {
    const tab = tabsFor(repoPath).find((t) => t.id === tabId);
    if (!tab || tab.loading || tab.binary || isDirty(tab)) return false;
    const before = tab.originalContent;
    let content: string;
    try {
      content = await readFile(cwd, tab.path);
    } catch {
      return false;
    }
    if (!tabsFor(repoPath).some((t) => t.id === tabId)) return false;
    if (isDirty(tab) || tab.originalContent !== before || content === before) return false;
    tab.content = content;
    tab.originalContent = content;
    return true;
  }
```

In the returned object (lines 160-170), add `reloadTab,` after `saveTab,`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/composables/__tests__/explorerTabView.test.ts src/composables/__tests__/useFileExplorer.test.ts`
Expected: all pass (4 + the existing ones + 5).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/explorerTabView.ts apps/desktop/src/composables/__tests__/explorerTabView.test.ts apps/desktop/src/composables/useFileExplorer.ts apps/desktop/src/composables/__tests__/useFileExplorer.test.ts
git commit -m "feat(desktop): tab-view rules for Diff | File and useFileExplorer.reloadTab"
```

---

### Task 5: Diff | File toggle in the File Explorer panel

**Files:**
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue`. The changes are:
  - imports (the block written in Task 3);
  - emits (the block written in Task 3);
  - a new "Diff | File" script section after `onToolbarSave` (`:348-351` before Task 3; locate it by name);
  - the tab-ids watcher (`:357-367` before Task 3);
  - the header actions: the Undo and Blame buttons (`:433-453` before Task 3);
  - the editor-pane body (`:533-535` before Task 3);
  - new CSS rules.
- Modify: `apps/desktop/src/App.vue`, a new `hideFilesOnHandoff` after `toggleFiles` (`:2241-2247`), and the `<FileExplorerPanel>` tag (Task 3's version)
- Modify: `apps/desktop/src/locales/en.ts:2694,2705`, `fr.ts:2663,2674`, `es.ts:2653,2664`, `pt-BR.ts:2653,2664`, `zh-CN.ts:2662,2673` (`filesView.preview.noTextDiff`, and new keys after `filesView.copyPathFailed`)
- Test: `apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts` (a `DiffViewer` stub, helpers, a new `describe`)
- Test: `apps/desktop/src/__tests__/fileExplorerPanel-wiring.test.ts` (one more `it`)

**Interfaces:**
- Consumes:
  - `useFilePreview({ cwd, target, loaders, watcher })` → `{ side: Ref<DiffSide>, plan: ComputedRef<PreviewPlan | null>, body: ShallowRef<PreviewBody>, retry(): Promise<void> }` (`useFilePreview.ts:100-215`);
  - `formatBytes` and the types `PreviewTarget`, `PreviewBody` (`useFilePreview.ts`);
  - `getGitDiff(cwd, path, staged)` (`backend.ts:598`) and `readFileAtRevision(cwd, rev, path)` (`backend.ts:245`);
  - `DiffViewer` props `{ diff, filePath, diffMode }`, with emits `update:diffMode`, `open-in-editor` and `open-file-history` (`DiffViewer.vue:24-83`);
  - `explorerTabView` (Task 4);
  - App's `handleOpenResidual(path)` (`App.vue:970`) and `openFileHistory(path)` (`App.vue:1732`).
- Produces:
  - new panel emits `(e: "open-merge-editor", path: string): void` and `(e: "open-file-history", path: string): void`;
  - App's `function hideFilesOnHandoff(): void`;
  - locale keys `filesView.viewLabel`, `filesView.viewDiff`, `filesView.viewFile` and `filesView.diffNeedsSave`;
  - `filesView.preview.noTextDiff`, which loses its `{0}`.

- [ ] **Step 1: Write the failing tests**

In `FileExplorerPanel.test.ts`, add after the `@tanstack/vue-virtual` mock:

```ts
// DiffViewer's rendering is its own concern: a stub that shows which diff it got and re-emits.
vi.mock("../DiffViewer.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { diff: Object, filePath: String, diffMode: String },
      emits: ["open-file-history", "open-in-editor", "update:diffMode"],
      setup: (p, { emit }) => () =>
        h("div", { class: "stub-diff", "data-path": (p.diff as { path?: string } | undefined)?.path ?? "" }, [
          h("button", { class: "stub-history", onClick: () => emit("open-file-history", p.filePath) }),
          h("button", { class: "stub-editor", onClick: () => emit("open-in-editor", p.filePath) }),
        ]),
    }),
  };
});
```

Extend the backend import line to `import { clipboardWriteText, getGitDiff, listRepoDir, pathExists, readFile, revealInFileManager } from "../../utils/backend";`, and add these locale imports next to `en`:

```ts
import fr from "../../locales/fr";
import es from "../../locales/es";
import ptBR from "../../locales/pt-BR";
import zhCN from "../../locales/zh-CN";
```

Add these helpers after `lastLog`:

```ts
const MOD_A: RepoFileEntry = { path: "a.ts", status: "modified", section: "unstaged" };
const MOD_B: RepoFileEntry = { path: "b.ts", status: "modified", section: "unstaged" };
const radio = (label: string) =>
  [...container.querySelectorAll<HTMLElement>("[role=radio]")].find((b) => b.textContent?.trim() === label)!;
const diffPath = () => container.querySelector(".stub-diff")?.getAttribute("data-path") ?? null;
const editorShown = () => (container.querySelector(".fe__content") as HTMLElement).style.display !== "none";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
```

Append:

```ts
describe("FileExplorerPanel — Diff | File (v3.11.2)", () => {
  it("a changed file opens on its diff", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(getGitDiff).toHaveBeenCalledWith(REPO, "a.ts", false);
    expect(diffPath()).toBe("a.ts");
    expect(editorShown()).toBe(false);
    expect(radio(en.filesView.viewDiff).getAttribute("aria-checked")).toBe("true");
  });

  it("an unchanged file opens in the editor, with no toggle", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("b.ts").click();
    await settle();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("const b = 2;");
    expect(container.querySelector("[role=radio]")).toBeNull();
    expect(getGitDiff).not.toHaveBeenCalled();
  });

  it("Diff | File switches to the editor and back", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    radio(en.filesView.viewFile).click();
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("const a = 1;");
    radio(en.filesView.viewDiff).click();
    await settle();
    expect(diffPath()).toBe("a.ts");
    expect(getGitDiff).toHaveBeenCalledTimes(2);
  });

  it("the Diff side is disabled while the buffer has unsaved edits", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    radio(en.filesView.viewFile).click();
    await settle();
    await typeIntoEditor("EDITED ");
    const diffBtn = radio(en.filesView.viewDiff);
    expect(diffBtn.getAttribute("aria-disabled")).toBe("true");
    expect(diffBtn.getAttribute("title")).toBe(en.filesView.diffNeedsSave);
    diffBtn.click();
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("EDITED ");
  });

  it("offers Working tree | Index for a file both staged and modified", async () => {
    mountPanel([
      { path: "a.ts", status: "modified", section: "staged" },
      { path: "a.ts", status: "modified", section: "unstaged" },
    ]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(diffPath()).toBe("a.ts");
    radio(en.filesView.preview.sideIndex).click();
    await settle();
    expect(getGitDiff).toHaveBeenLastCalledWith(REPO, "a.ts", true);
    expect(diffPath()).toBe("a.ts@index");
  });

  it("a conflicted file shows the merge-editor banner, never a diff", async () => {
    const { events } = mountPanel([{ path: "a.ts", status: "modified", section: "conflicted" }]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(getGitDiff).not.toHaveBeenCalled();
    expect(container.textContent).toContain(en.filesView.preview.conflicted);
    [...container.querySelectorAll<HTMLButtonElement>(".fe__diff button")]
      .find((b) => b.textContent?.trim() === en.filesView.preview.openMergeEditor)!
      .click();
    expect(events[events.length - 1]).toEqual(["open-merge-editor", "a.ts"]);
  });

  it("a failed diff shows an inline error with Retry", async () => {
    vi.mocked(getGitDiff).mockRejectedValueOnce(new Error("boom"));
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(container.querySelector(".fe__diff")?.textContent).toContain(en.filesView.preview.error.replace("{0}", "boom"));
    [...container.querySelectorAll<HTMLButtonElement>(".fe__diff button")]
      .find((b) => b.textContent?.trim() === en.filesView.retry)!
      .click();
    await settle();
    expect(diffPath()).toBe("a.ts");
  });

  it("re-emits the diff's open-in-editor and file-history requests", async () => {
    const { events } = mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    container.querySelector<HTMLButtonElement>(".stub-editor")!.click();
    expect(events[events.length - 1]).toEqual(["open-in-editor", "a.ts"]);
    container.querySelector<HTMLButtonElement>(".stub-history")!.click();
    expect(events[events.length - 1]).toEqual(["open-file-history", "a.ts"]);
  });

  it("a File tab stays on File when its file becomes changed", async () => {
    const { state } = mountPanel([]);
    await settle();
    row("b.ts").click();
    await settle();
    state.changedFiles = [MOD_B];
    await settle();
    expect(radio(en.filesView.viewFile).getAttribute("aria-checked")).toBe("true");
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(getGitDiff).not.toHaveBeenCalled();
  });

  it("a diff that resolves after switching to File is dropped", async () => {
    const late = deferred<unknown>();
    vi.mocked(getGitDiff).mockImplementationOnce(() => late.promise as never);
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    radio(en.filesView.viewFile).click();
    await settle();
    late.resolve({ path: "late", hunks: [HUNK] });
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    radio(en.filesView.viewDiff).click();
    await settle();
    expect(diffPath()).toBe("a.ts");
  });

  it("a diff for an earlier tab is dropped", async () => {
    const late = deferred<unknown>();
    vi.mocked(getGitDiff).mockImplementationOnce(() => late.promise as never);
    mountPanel([MOD_A, MOD_B]);
    await settle();
    row("a.ts").click();
    await settle();
    row("b.ts").click();
    await settle();
    late.resolve({ path: "late-a", hunks: [HUNK] });
    await settle();
    expect(diffPath()).toBe("b.ts");
  });

  it("survives a repo switch inside KeepAlive: the new repo's tree and tabs, never the old repo's late diff", async () => {
    const late = deferred<unknown>();
    vi.mocked(getGitDiff).mockImplementationOnce(() => late.promise as never);
    const { state } = mountPanel([MOD_A], { keepAlive: true });
    await settle();
    await useFileExplorer().openTab(OTHER, OTHER, "a.ts", false);
    row("a.ts").click();
    await settle();
    state.shown = false; // KeepAlive deactivates the panel; it is not unmounted
    await settle();
    state.repoPath = OTHER;
    state.shown = true;
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(OTHER, "", false);
    expect(getGitDiff).toHaveBeenLastCalledWith(OTHER, "a.ts", false);
    late.resolve({ path: "late-from-repo", hunks: [HUNK] });
    await settle();
    expect(diffPath()).toBe("a.ts");
  });

  it("has the toggle's strings in all five locales", () => {
    for (const loc of [en, fr, es, ptBR, zhCN]) {
      expect(loc.filesView.viewLabel).toBeTruthy();
      expect(loc.filesView.viewDiff).toBeTruthy();
      expect(loc.filesView.viewFile).toBeTruthy();
      expect(loc.filesView.diffNeedsSave).toBeTruthy();
      expect(loc.filesView.preview.noTextDiff).not.toContain("{0}");
    }
  });
});
```

In `fileExplorerPanel-wiring.test.ts`, append inside the `describe`:

```ts
  it("hands conflicted files to the merge editor and history to the Changes view", () => {
    expect(panel).toMatch(/@open-merge-editor="\(p: string\) => \{ hideFilesOnHandoff\(\); handleOpenResidual\(p\); \}"/);
    expect(panel).toMatch(
      /@open-file-history="\(p: string\) => \{ hideFilesOnHandoff\(\); openFileHistory\(p\); viewMode = 'changes'; \}"/,
    );
    expect(appVue).toMatch(
      /function hideFilesOnHandoff\(\): void \{\n\s*if \(showFiles\.value && settings\.value\.filesHideOnNav\) showFiles\.value = false;/,
    );
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/components/__tests__/FileExplorerPanel.test.ts src/__tests__/fileExplorerPanel-wiring.test.ts`
Expected: the Diff | File tests fail. There is no `[role=radio]`, so `radio(...)` is `undefined` and throws a `TypeError`, and `getGitDiff` is never called. The locale test fails on `viewLabel` being `undefined`, and the wiring test on `@open-merge-editor`. "an unchanged file opens in the editor, with no toggle" passes already: it pins what must not change.

- [ ] **Step 3: Add the locale strings**

In each locale's `filesView` block, change `preview.noTextDiff`, and add four keys after `copyPathFailed`:

| Locale | `preview.noTextDiff` | `viewLabel` | `viewDiff` | `viewFile` | `diffNeedsSave` |
|---|---|---|---|---|---|
| `en.ts` (2694, 2705) | `"No textual changes to show"` | `"Show"` | `"Diff"` | `"File"` | `"Save to see the diff"` |
| `fr.ts` (2663, 2674) | `"Aucune modification textuelle à afficher"` | `"Afficher"` | `"Diff"` | `"Fichier"` | `"Enregistrez pour voir le diff"` |
| `es.ts` (2653, 2664) | `"No hay cambios de texto que mostrar"` | `"Mostrar"` | `"Diff"` | `"Archivo"` | `"Guarda para ver el diff"` |
| `pt-BR.ts` (2653, 2664) | `"Nenhuma alteração de texto para mostrar"` | `"Mostrar"` | `"Diff"` | `"Arquivo"` | `"Salve para ver o diff"` |
| `zh-CN.ts` (2662, 2673) | `"没有可显示的文本更改"` | `"显示"` | `"差异"` | `"文件"` | `"保存后即可查看差异"` |

For example, `en.ts` after `copyPathFailed: "Couldn't copy the path {0}: {1}",`:

```ts
    viewLabel: "Show",
    viewDiff: "Diff",
    viewFile: "File",
    diffNeedsSave: "Save to see the diff",
```

(`noTextDiff` loses its size: a tab does not know its file's size. `FilePreviewPane` still passes one until Task 7 deletes it, and the extra argument is harmless.)

- [ ] **Step 4: Implement the panel's script**

Change the `vue` import line to:

```ts
import { computed, reactive, ref, toRef, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
```

Add after `import FileTreePane from "./FileTreePane.vue";`:

```ts
import DiffViewer from "./DiffViewer.vue";
```

Add after the `useTreeScopeRoot` import:

```ts
import { formatBytes, useFilePreview, type PreviewBody, type PreviewTarget } from "../composables/useFilePreview";
import { canShowDiff, initialTabView, isDiffable, resolveTabView, type TabView } from "../composables/explorerTabView";
import type { DiffMode } from "../utils/diffMode";
```

Change the backend import to:

```ts
import { clipboardWriteText, getGitBlame, getGitDiff, listRepoDir, readFileAtRevision, revealInFileManager } from "../utils/backend";
```

Add to the emits, after `open-in-editor`:

```ts
  /** v3.11.2 — the conflicted banner: App opens the merge editor in the Changes view. */
  (e: "open-merge-editor", path: string): void;
  /** v3.11.2 — DiffViewer's history button: App opens the file history in the Changes view. */
  (e: "open-file-history", path: string): void;
```

Insert this section right after the `onToolbarSave` function:

```ts
// ── Diff | File (v3.11.2) ──
// A tab on a changed file opens on its inline diff; the toolbar toggle
// switches to the editor and back. What a tab shows is
// `resolveTabView(stored side, status)`. The side is stored the first time the
// panel shows the tab, so a file that becomes changed while open does not
// flip its tab. The diff reads the disk, which is why a dirty buffer cannot
// switch to it (canShowDiff).
const tabViews = reactive(new Map<number, TabView>());
const activeStatus = computed(() =>
  activeTab.value ? (tree.statusByPath.value.get(activeTab.value.path) ?? null) : null,
);
const activeDiffable = computed(() => isDiffable(activeStatus.value));
const showDiff = computed(
  () => activeTab.value !== null && resolveTabView(tabViews.get(activeTab.value.id), activeStatus.value) === "diff",
);
const diffBlocked = computed(
  () => activeTab.value !== null && !canShowDiff(activeStatus.value, explorer.isDirty(activeTab.value)),
);

const previewTarget = computed<PreviewTarget | null>(() => {
  const tab = activeTab.value;
  const status = activeStatus.value;
  if (!tab || !status || !showDiff.value) return null;
  // `size` only lets planPreview refuse a huge untracked file before diffing
  // it. A tab does not know its size, and the Rust diff truncates at 5 MB.
  return { kind: "file", path: tab.path, size: 0, symlink: false, status };
});
// Request-id race guard and stale-while-revalidate watcher reload come with
// useFilePreview: a response for an earlier tab, side or repo is dropped.
const preview = useFilePreview({
  cwd: repoPathRef,
  target: previewTarget,
  loaders: {
    readFile: (cwd, path) => readFileAtRevision(cwd, "", path),
    getDiff: getGitDiff,
  },
  watcher: props.watcher ?? null,
});
const diffBody = preview.body;
const diffSide = preview.side;
const canSwitchSide = computed(() => preview.plan.value?.kind === "diff" && preview.plan.value.canSwitch);
/** DiffViewer's own inline / side-by-side toggle; the panel starts inline. */
const diffMode = ref<DiffMode>("inline");

watch(
  () => activeTab.value?.id ?? null,
  (id) => {
    if (id !== null && !tabViews.has(id)) tabViews.set(id, initialTabView(activeStatus.value));
  },
  { immediate: true },
);

function setView(view: TabView): void {
  const tab = activeTab.value;
  if (!tab) return;
  if (view === "diff" && !canShowDiff(activeStatus.value, explorer.isDirty(tab))) return;
  tabViews.set(tab.id, view);
  if (view === "file") void mountTab(tab);
}

function diffPlaceholder(body: Extract<PreviewBody, { kind: "placeholder" }>): string {
  return body.reason === "too-large"
    ? t("filesView.preview.tooLarge", formatBytes(body.size))
    : t("filesView.preview.noTextDiff");
}
```

In the tab-ids watcher (`watch(() => tabs.value.map((t) => t.id), …)`), add `tabViews.delete(id);` next to `docStates.delete(id);` and `blameModels.delete(id);`.

- [ ] **Step 5: Implement the panel's template and styles**

On the Undo button, change `:disabled="editLocked"` to `:disabled="editLocked || showDiff"`. On the Blame button, change its `:disabled` to:

```html
          :disabled="!activeTab || activeTab.binary || explorer.isDirty(activeTab) || showDiff"
```

Right after the Blame button's closing `</button>`, inside `.fe__header-actions`, insert:

```html
        <template v-if="activeTab && activeDiffable">
          <span class="fe__header-divider" aria-hidden="true" />
          <div class="fe__seg" role="radiogroup" :aria-label="t('filesView.viewLabel')">
            <button
              type="button"
              role="radio"
              class="fe__seg-btn"
              :aria-checked="showDiff"
              :aria-disabled="diffBlocked ? 'true' : undefined"
              :title="diffBlocked ? t('filesView.diffNeedsSave') : undefined"
              @click="setView('diff')"
            >{{ t('filesView.viewDiff') }}</button>
            <button
              type="button"
              role="radio"
              class="fe__seg-btn"
              :aria-checked="!showDiff"
              @click="setView('file')"
            >{{ t('filesView.viewFile') }}</button>
          </div>
          <div v-if="showDiff && canSwitchSide" class="fe__seg" role="radiogroup" :aria-label="t('filesView.preview.sideLabel')">
            <button
              type="button"
              role="radio"
              class="fe__seg-btn"
              :aria-checked="diffSide === 'worktree'"
              @click="diffSide = 'worktree'"
            >{{ t('filesView.preview.sideWorktree') }}</button>
            <button
              type="button"
              role="radio"
              class="fe__seg-btn"
              :aria-checked="diffSide === 'index'"
              @click="diffSide = 'index'"
            >{{ t('filesView.preview.sideIndex') }}</button>
          </div>
        </template>
```

The Diff button uses `aria-disabled` rather than `disabled`, so the "Save to see the diff" tooltip still shows and the button stays focusable. `setView` refuses the click.

Replace the three body lines of `.fe__editor-pane` (the `fe__content` div, the binary placeholder and the empty hint) with:

```html
        <div v-show="activeTab && !activeTab.binary && !showDiff" class="fe__content" ref="editorHost"></div>
        <div v-if="activeTab && activeTab.binary && !showDiff" class="fe__empty">{{ t("files.binaryPlaceholder") }}</div>
        <div v-if="activeTab && showDiff" class="fe__diff">
          <p v-if="diffBody.kind === 'idle' || diffBody.kind === 'loading'" class="fe__empty" aria-busy="true">{{ t('filesView.loading') }}</p>
          <div v-else-if="diffBody.kind === 'error'" class="fe__empty fe__empty--stack fe__empty--error" role="alert">
            <span>{{ t('filesView.preview.error', diffBody.message) }}</span>
            <button type="button" class="fe__action-btn" @click="preview.retry()">{{ t('filesView.retry') }}</button>
          </div>
          <div v-else-if="diffBody.kind === 'conflicted'" class="fe__empty fe__empty--stack">
            <span>{{ t('filesView.preview.conflicted') }}</span>
            <button
              type="button"
              class="fe__action-btn fe__action-btn--active"
              @click="emit('open-merge-editor', activeTab.path)"
            >{{ t('filesView.preview.openMergeEditor') }}</button>
          </div>
          <p v-else-if="diffBody.kind === 'placeholder'" class="fe__empty">{{ diffPlaceholder(diffBody) }}</p>
          <DiffViewer
            v-else-if="diffBody.kind === 'diff'"
            v-model:diff-mode="diffMode"
            :diff="diffBody.diff"
            :file-path="activeTab.path"
            @open-in-editor="(p: string) => emit('open-in-editor', p)"
            @open-file-history="(p: string) => emit('open-file-history', p)"
          />
        </div>
        <div v-if="!activeTab" class="fe__empty">{{ t("files.emptyHint") }}</div>
```

Add to `<style scoped>`, after the `.fe__empty` rule:

```css
.fe__empty--stack {
  flex-direction: column;
  gap: var(--space-2);
}

.fe__empty--error {
  color: var(--color-danger);
}

.fe__diff {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.fe__seg {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.fe__seg-btn {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  background: transparent;
  white-space: nowrap;
}

.fe__seg-btn[aria-checked="true"] {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.fe__seg-btn[aria-disabled="true"] {
  opacity: 0.4;
  cursor: default;
}
```

- [ ] **Step 6: Wire App.vue**

After `toggleFiles()` (ends at `App.vue:2247`), add:

```ts
/**
 * v3.11.2 — the panel hands a file to the Changes view (merge editor, file
 * history). That is a navigation like a dock switch, so the same
 * `filesHideOnNav` rule dismisses the panel, which would otherwise cover it.
 */
function hideFilesOnHandoff(): void {
  if (showFiles.value && settings.value.filesHideOnNav) showFiles.value = false;
}
```

On the `<FileExplorerPanel>` tag, after `@open-in-editor="handleOpenInEditor"`, add:

```html
          @open-merge-editor="(p: string) => { hideFilesOnHandoff(); handleOpenResidual(p); }"
          @open-file-history="(p: string) => { hideFilesOnHandoff(); openFileHistory(p); viewMode = 'changes'; }"
```

(`onViewModeChange("changes")` is deliberately not used here. It selects the first changed file without awaiting it (`App.vue:1356-1365`), and that select would race the one `handleOpenResidual` awaits.)

- [ ] **Step 7: Run the tests and watch them pass**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/components/__tests__/FileExplorerPanel.test.ts src/__tests__/fileExplorerPanel-wiring.test.ts src/components/__tests__/FilePreviewPane.test.ts src/composables/__tests__/useFilePreview.test.ts`
Expected: all pass. `FilePreviewPane.test.ts` asserts only `tooLarge` (line 174), so the `noTextDiff` change does not touch it.

Run: `cd apps/desktop && node_modules/.bin/vue-tsc --noEmit`
Expected: no error.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/FileExplorerPanel.vue apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts apps/desktop/src/App.vue apps/desktop/src/__tests__/fileExplorerPanel-wiring.test.ts apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): File Explorer tabs open changed files on their diff, with a Diff | File toggle"
```

---

### Task 6: Diff | File lifecycle: a fresh buffer, status changes, "Deleted from disk"

**Files:**
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue`: `setView` and the `activeTab` id watcher from Task 5, the editor-pane body (a notice before `.fe__content`), and one CSS rule
- Test: `apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts` (a new `describe`)

**Interfaces:**
- Consumes: `explorer.reloadTab(repoPath, cwd, tabId): Promise<boolean>` (Task 4), `isDiffable`, the panel's `docStates`, `blameModels`, `mountTab` and `tabViews`.
- Produces: no new API. `setView(view: TabView): Promise<void>` becomes async.

- [ ] **Step 1: Write the failing tests**

Append to `FileExplorerPanel.test.ts`:

```ts
describe("FileExplorerPanel — Diff | File lifecycle (v3.11.2)", () => {
  it("switching to File re-reads a clean tab from disk", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    files["a.ts"] = "const a = 42;\n"; // changed on disk while the tab showed its diff
    radio(en.filesView.viewFile).click();
    await settle();
    expect(editorDoc()).toContain("const a = 42;");
    expect(editorDoc()).not.toContain("const a = 1;");
  });

  it("falls back to the editor when its file becomes unchanged, and stays there when it changes again", async () => {
    const { state } = mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(diffPath()).toBe("a.ts");
    state.changedFiles = []; // committed or discarded elsewhere
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(container.querySelector("[role=radio]")).toBeNull();
    state.changedFiles = [MOD_A];
    await settle();
    expect(radio(en.filesView.viewFile).getAttribute("aria-checked")).toBe("true");
    expect(diffPath()).toBeNull();
  });

  it("says Deleted from disk and keeps the buffer", async () => {
    const { state } = mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    state.changedFiles = [{ path: "a.ts", status: "deleted", section: "unstaged" }];
    await settle();
    expect(container.querySelector(".fe__notice")?.textContent).toContain(en.filesView.preview.gone);
    expect(diffPath()).toBeNull();
    expect(container.querySelector("[role=radio]")).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("const a = 1;");
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/components/__tests__/FileExplorerPanel.test.ts -t "lifecycle"`
Expected: three failures:
- "re-reads": `editorDoc()` still contains `const a = 1;`.
- "falls back": the last `aria-checked` is `"false"` and `diffPath()` is `"a.ts"`, because the stored `"diff"` comes back.
- "Deleted": `.fe__notice` is `null`.

- [ ] **Step 3: Implement**

Replace Task 5's `watch(() => activeTab.value?.id ?? null, …)` with:

```ts
// Record a tab's side the first time it is shown. When its file stops having
// a diff to show (committed, discarded, deleted on disk), store File, so the
// next change does not flip the tab back to the diff under the cursor.
watch(
  [() => activeTab.value?.id ?? null, () => isDiffable(activeStatus.value)],
  ([id, diffable]) => {
    if (id === null) return;
    const stored = tabViews.get(id);
    if (stored === undefined) tabViews.set(id, initialTabView(activeStatus.value));
    else if (stored === "diff" && !diffable) void setView("file");
  },
  { immediate: true },
);
```

Replace Task 5's `setView` with:

```ts
async function setView(view: TabView): Promise<void> {
  const tab = activeTab.value;
  if (!tab) return;
  if (view === "diff") {
    if (canShowDiff(activeStatus.value, explorer.isDirty(tab))) tabViews.set(tab.id, "diff");
    return;
  }
  const leavingDiff = tabViews.get(tab.id) === "diff";
  tabViews.set(tab.id, "file");
  // The diff showed the file on disk; the buffer dates from when the tab
  // opened. A clean buffer is re-read, and the cached editor state and blame
  // that were built from the old text are dropped.
  if (leavingDiff && (await explorer.reloadTab(props.repoPath, props.repoPath, tab.id))) {
    docStates.delete(tab.id);
    blameModels.delete(tab.id);
  }
  if (activeTab.value?.id === tab.id) await mountTab(tab);
}
```

The template keeps `@click="setView('diff')"` / `@click="setView('file')"`. The promise is not awaited there, which is fine for a click handler.

In the editor-pane body, insert before the `fe__content` div:

```html
        <p v-if="activeTab && activeStatus?.deletedOnDisk" class="fe__notice" role="status">{{ t('filesView.preview.gone') }}</p>
```

Add to `<style scoped>`:

```css
.fe__notice {
  margin: 0;
  padding: var(--space-2) var(--space-5);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/components/__tests__/FileExplorerPanel.test.ts`
Expected: all pass, including every Task 3 and Task 5 test.

Run: `cd apps/desktop && node_modules/.bin/vue-tsc --noEmit`
Expected: no error.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/FileExplorerPanel.vue apps/desktop/src/components/__tests__/FileExplorerPanel.test.ts
git commit -m "fix(desktop): a File Explorer tab leaving its diff re-reads the disk and follows its file's status"
```

---

### Task 7: Remove the Browse view

**Files:**
- Delete: `apps/desktop/src/components/FilesView.vue`, `apps/desktop/src/components/FilePreviewPane.vue`, `apps/desktop/src/components/__tests__/FilesView.test.ts`, `apps/desktop/src/components/__tests__/FilePreviewPane.test.ts`, `apps/desktop/src/__tests__/filesView-wiring.test.ts`, `apps/desktop/src/composables/__tests__/useSettings-filesView.test.ts`
- Modify: `apps/desktop/src/composables/useGitRepo.ts:71-72`
- Modify: `apps/desktop/src/composables/useSettings.ts:18`, `:31-43`, `:58-67`, `:247-248`, `:513`
- Modify: `apps/desktop/src/components/SettingsPanel.vue:187`, `:300`, `:423`, `:1651-1660`
- Modify: `apps/desktop/src/components/AppDock.vue:16`, `:66`, `:80`, `:206-208`, `:215-218`, `:225`, `:230`, `:377`, `:403-406`
- Modify: `apps/desktop/src/composables/useAppMenu.ts:59`, `:314-319`
- Modify: `apps/desktop/src/App.vue:67`, `:103`, `:628`, `:2070`, `:2109`, the `openFilesView` action (`:4098-4100` at the start of this plan, about `:4107-4109` once Task 5 has added `hideFilesOnHandoff`), and the Files-view branch (`:4543-4555` at the start, about `:4552-4564` after Task 5). Locate the last two by their quoted text.

Line numbers in this task are those at the start of Task 7. Edit each file from the bottom up so they stay valid.
- Modify: `apps/desktop/src/composables/useLazyRepoTree.ts:2` (doc), `:27`, `:93`, `:220`. Test: `apps/desktop/src/composables/__tests__/useLazyRepoTree.test.ts:12`, `:363`
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue`, dropping the now-default `storageKeyPrefix` line (from Task 3)
- Modify: `apps/desktop/src/composables/useFilePreview.ts:1-13` (doc comment only)
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` (the keys listed in Step 6)
- Create (test): `apps/desktop/src/composables/__tests__/useSettings-browseRemoved.test.ts`

**Interfaces:**
- Consumes: `normalizeDockOrder(stored)` (`useSettings.ts:50-55`), `isDockEntryHidden(id, flags)`, `loadSettings()` (`useSettings.ts:579-587`, settings key `"gitwand-settings"`, `useSettings.ts:566`).
- Produces:
  - `DockEntryId = "launchpad" | "dashboard" | "prs" | "graph" | "changes"`;
  - `ViewMode` without `"files"`;
  - `isDockEntryHidden(id, flags: Pick<AppSettings, "dockHideLaunchpad" | "dockHideDashboard" | "dockHidePrs">)`;
  - `export const EXPLORER_TREE_STORAGE_PREFIX = "gitwand-explorer-tree:"` (replaces `FILES_VIEW_STORAGE_PREFIX`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/useSettings-browseRemoved.test.ts`:

```ts
/**
 * v3.11.2 — the Browse view is gone: the File Explorer panel is the file
 * browser (spec addendum 2026-10-02). These pin what an existing user's saved
 * settings meet after the upgrade, and that the locales lost exactly the
 * Browse-only keys.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_DOCK_ORDER,
  defaultAppSettings,
  isDockEntryHidden,
  loadSettings,
  normalizeDockOrder,
  type DockEntryId,
} from "../useSettings";
import en from "../../locales/en";
import fr from "../../locales/fr";
import es from "../../locales/es";
import ptBR from "../../locales/pt-BR";
import zhCN from "../../locales/zh-CN";

const SRC = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");
/** useSettings.ts:566 (SETTINGS_KEY, not exported). */
const SETTINGS_KEY = "gitwand-settings";

describe("v3.11.2 — Browse removed, the File Explorer panel is the file browser", () => {
  beforeEach(() => localStorage.clear());

  it("drops a stored 'files-view' dock id", () => {
    expect(DEFAULT_DOCK_ORDER).not.toContain("files-view");
    const stored = ["files-view", "changes", "graph", "prs", "dashboard", "launchpad"] as unknown as DockEntryId[];
    expect(normalizeDockOrder(stored)).toEqual(["changes", "graph", "prs", "dashboard", "launchpad"]);
    expect(normalizeDockOrder(["files-view"] as unknown as DockEntryId[])).toEqual(DEFAULT_DOCK_ORDER);
  });

  it("an existing user's saved Browse settings load, and startup lands on a real view", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        dockOrder: ["files-view", "graph", "launchpad", "dashboard", "prs", "changes"],
        dockHideFilesView: false,
      }),
    );
    const s = loadSettings();
    // App.vue's "default" startup view: the first visible entry in dock order.
    const first = normalizeDockOrder(s.dockOrder).find((id) => !isDockEntryHidden(id, s));
    expect(first).toBe("graph");
  });

  it("has no dockHideFilesView left in either settings file", () => {
    expect("dockHideFilesView" in defaultAppSettings).toBe(false);
    expect(read("composables/useSettings.ts")).not.toContain("dockHideFilesView");
    expect(read("components/SettingsPanel.vue")).not.toContain("dockHideFilesView");
  });

  it("removes the Browse-only keys from all five locales, and keeps the rest aligned", () => {
    for (const loc of [en, fr, es, ptBR, zhCN]) {
      const l = loc as unknown as Record<string, Record<string, unknown>>;
      expect(l.header!.paletteViewFiles).toBeUndefined();
      expect(l.menu!.openFilesView).toBeUndefined();
      const dock = l.settings!.dock as Record<string, unknown>;
      expect(dock.itemFilesView).toBeUndefined();
      expect(dock.showFilesView).toBeUndefined();
      expect(l.filesView!.dockLabel).toBeUndefined();
      expect(l.filesView!.breadcrumbLabel).toBeUndefined();
      expect(Object.keys(loc.filesView).sort()).toEqual(Object.keys(en.filesView).sort());
      expect(Object.keys(loc.filesView.preview).sort()).toEqual(Object.keys(en.filesView.preview).sort());
    }
  });

  it("references every remaining filesView key from the source", () => {
    const sources = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((f) => /\.(vue|ts)$/.test(f) && !f.includes("locales") && !f.includes("__tests__"))
      .map((f) => readFileSync(join(SRC, f), "utf-8"))
      .join("\n");
    const keys = [
      ...Object.keys(en.filesView).filter((k) => k !== "preview").map((k) => `filesView.${k}`),
      ...Object.keys(en.filesView.preview).map((k) => `filesView.preview.${k}`),
    ];
    const unreferenced = keys.filter((k) => !sources.includes(`"${k}"`) && !sources.includes(`'${k}'`));
    expect(unreferenced).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/composables/__tests__/useSettings-browseRemoved.test.ts`
Expected: four failures.
- "drops a stored 'files-view' dock id": `DEFAULT_DOCK_ORDER` contains `"files-view"`.
- "…startup lands on a real view": `first` is `"files-view"`, not `"graph"`.
- "has no dockHideFilesView…": `"dockHideFilesView" in defaultAppSettings` is `true`.
- "removes the Browse-only keys…": `paletteViewFiles` is defined.

"references every remaining filesView key from the source" passes for now, because `FilePreviewPane.vue` still references the preview keys. It fails once Step 3 deletes that file, and passes again after Step 6. That is the check that Step 6 removed exactly the keys nothing uses.

- [ ] **Step 3: Delete the Browse files**

```bash
git rm apps/desktop/src/components/FilesView.vue apps/desktop/src/components/FilePreviewPane.vue apps/desktop/src/components/__tests__/FilesView.test.ts apps/desktop/src/components/__tests__/FilePreviewPane.test.ts apps/desktop/src/__tests__/filesView-wiring.test.ts apps/desktop/src/composables/__tests__/useSettings-filesView.test.ts
```

- [ ] **Step 4: Remove the view mode, the dock entry and the setting**

`useGitRepo.ts:71-72`: replace `  | "issue"\n  | "files";` with `  | "issue";`.

`useSettings.ts`:
- Delete line 18 (`import type { ViewMode } from "./useGitRepo";`).
- Replace lines 31-43 (the `DockEntryId` doc and type, `DEFAULT_DOCK_ORDER`, and the whole `dockEntryViewMode` doc and function) with:
  ```ts
  /** Dock entry ids (subset of ViewMode) — used for dock ordering (v3). */
  export type DockEntryId = "launchpad" | "dashboard" | "prs" | "graph" | "changes";
  /** Canonical default dock order, left → right. */
  export const DEFAULT_DOCK_ORDER: DockEntryId[] = ["launchpad", "dashboard", "prs", "graph", "changes"];
  ```
- In `isDockEntryHidden` (lines 58-67), change the `Pick` to `Pick<AppSettings, "dockHideLaunchpad" | "dockHideDashboard" | "dockHidePrs">` and delete the `if (id === "files-view") …` line.
- Delete lines 247-248 (the `dockHideFilesView` doc and field) and line 513 (`dockHideFilesView: false,`).

`SettingsPanel.vue`: delete line 187 (`dockHideFilesView: boolean;`), line 300 (`dockHideFilesView: false,`), line 423 (`case "files-view": …`) and lines 1651-1660 (the `<!-- Show Files view (v3.11.2) -->` checkbox row and the blank line after it).

`AppDock.vue`:
- Line 16: drop `dockEntryViewMode, ` from the import.
- Delete line 66 (`case "files-view": …`).
- Line 80: `return props.viewMode === id;`.
- Lines 206-208:
  ```ts
  /** Today / Dashboard / PRs can be removed; Git Tree & Changes cannot. */
  function isRemovable(id: DockEntryId): boolean {
    return id === "launchpad" || id === "dashboard" || id === "prs";
  ```
- Lines 215-217:
  ```ts
  /** Changes has no diff-less landing, so it is not offered as a startup view. */
  function canBeStartup(id: DockEntryId): boolean {
    return id !== "changes";
  ```
- Delete line 225 (`else if (id === "files-view") …`).
- Line 230: `if (id === "changes") return; // not a valid startup view`.
- Line 377: `@click="emit('changeView', id)"`.
- Delete lines 403-406 (the `<!-- Browse (Files view, v3.11.2) -->` comment and its `<svg>`).

`useAppMenu.ts`: delete line 59 (`openFilesView: () => void;`) and lines 314-319 (the `view-open-files` `MenuItem.new({…}),`).

`App.vue`:
- Delete line 67 (`const FilesView = defineAsyncComponent(…)`).
- Line 103: `import { useSettings, normalizeDockOrder, isDockEntryHidden } from "./composables/useSettings";`.
- Line 628: `if (first) viewMode.value = first as ViewMode;`.
- Delete line 2070 (`{ id: "view-files", label: t("header.paletteViewFiles") },`) and line 2109 (`case "view-files": viewMode.value = "files"; break;`).
- Delete the three lines `openFilesView: () => {` / `if (hasRepo.value) onViewModeChange("files");` / `},` in the `useAppMenu(…)` actions.
- Delete the block from `<!-- ── Files view (v3.11.2): Finder-like tree │ read-only preview ── -->` through the closing `</div>` of `<div v-else-if="viewMode === 'files'" class="view view--files">`, and the blank line after it.

- [ ] **Step 5: Retire the `gitwand-files-view:` prefix**

`useLazyRepoTree.ts`:
- Line 2: `useLazyRepoTree — the working-tree model behind the File Explorer panel (v3.11.2).`
- Line 27: `export const EXPLORER_TREE_STORAGE_PREFIX = "gitwand-explorer-tree:";`
- Line 93: `/** Defaults to \`EXPLORER_TREE_STORAGE_PREFIX\`; \`null\` turns persistence off. */`
- Line 220: `const prefix = opts.storageKeyPrefix === undefined ? EXPLORER_TREE_STORAGE_PREFIX : opts.storageKeyPrefix;`

`useLazyRepoTree.test.ts`: line 12 becomes `EXPLORER_TREE_STORAGE_PREFIX,`, and line 363 becomes `` expect(JSON.parse(localStorage.getItem(`${EXPLORER_TREE_STORAGE_PREFIX}/repo`)!)).toEqual({ ``.

`FileExplorerPanel.vue`: delete `  storageKeyPrefix: "gitwand-explorer-tree:",` from the `useLazyRepoTree` call. It is the default now, and the key users already have is unchanged.

`useFilePreview.ts`: in the doc comment (lines 1-13), replace `what the Files view's preview pane shows (v3.11.2).` with `what a File Explorer tab's Diff side shows (v3.11.2).` and `while arrowing through the tree` with `while switching tabs or sides`.

- [ ] **Step 6: Remove the Browse-only locale keys**

From each of `en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts` and `zh-CN.ts`, delete:
- `header.paletteViewFiles` (en:122, fr:116, es:122, pt-BR:123, zh-CN:127);
- `settings.dock.itemFilesView` and `settings.dock.showFilesView` (en:1472-1473, fr:1456-1457, es:1447-1448, pt-BR:1447-1448, zh-CN:1152-1153);
- `menu.openFilesView` (en:2442, fr:2412, es:2403, pt-BR:2403, zh-CN:2412);
- `filesView.dockLabel` and `filesView.breadcrumbLabel`;
- `filesView.preview.noSelection`, `pathLabel`, `binary`, `nonUtf8`, `symlink`, `folderChanged`, `folderClean` and `folderMore`.

What stays in `filesView.preview`: `error`, `sideLabel`, `sideWorktree`, `sideIndex`, `conflicted`, `openMergeEditor`, `tooLarge`, `noTextDiff` and `gone`.

- [ ] **Step 7: Run the tests and the type-check**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/composables/__tests__/useSettings-browseRemoved.test.ts src/composables/__tests__/useLazyRepoTree.test.ts src/components/__tests__/FileExplorerPanel.test.ts src/components/__tests__/FileTreePane.test.ts src/__tests__/fileExplorerPanel-wiring.test.ts`
Expected: all pass.

Run: `cd apps/desktop && node_modules/.bin/vue-tsc --noEmit`
Expected: no error. A leftover `"files"`, `"files-view"`, `dockEntryViewMode` or locale key fails here.

Run: `cd apps/desktop && grep -rnE "FilesView|FilePreviewPane|files-view|dockHideFilesView|openFilesView|view-files|dockEntryViewMode|FILES_VIEW_STORAGE_PREFIX|gitwand-files-view" src`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/composables/useGitRepo.ts apps/desktop/src/composables/useSettings.ts apps/desktop/src/components/SettingsPanel.vue apps/desktop/src/components/AppDock.vue apps/desktop/src/composables/useAppMenu.ts apps/desktop/src/App.vue apps/desktop/src/composables/useLazyRepoTree.ts apps/desktop/src/composables/__tests__/useLazyRepoTree.test.ts apps/desktop/src/components/FileExplorerPanel.vue apps/desktop/src/composables/useFilePreview.ts apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts apps/desktop/src/composables/__tests__/useSettings-browseRemoved.test.ts
git commit -m "refactor(desktop): remove the Browse view; the File Explorer panel is the file browser"
```

(The `git rm` of Step 3 is already staged.)

---

### Task 8: Docs around the panel

**Files:**
- Modify: `CHANGELOG.md:11-16` (the `### Added` entry), `:19` (the `### Changed` entry)
- Modify: `website/guide/desktop.md:97-108` (the `## Files View (v3.11.2)` section)
- Modify: `ROADMAP.md:23-29` (v3.11.2 section), `:121`, `:150-152`

**Interfaces:**
- Consumes: the behavior shipped by Tasks 1-7.
- Produces: docs only. `website/changelog.md` is updated at tag time (AGENTS.md § Changelog), not here.

- [ ] **Step 1: Rewrite the CHANGELOG `[Unreleased]` entries**

Replace lines 11-16 (the "A Finder-like Files view" bullet and its five sub-bullets) with:

```markdown
- **The File Explorer panel becomes a Finder-like file browser.** The panel behind the dock's Files tile keeps its tabs, editing and blame, and gains what a file browser needs. Badges are landmarks, not the point. Every changed file has one, and so does every folder above it, including folders that were never opened.
  - **Lazy, one folder at a time.** A new `list_repo_dir` command lists a single directory when it is first expanded, capped at 5,000 entries. Ignored entries are classified in process with libgit2: a path is ignored when an ignore rule matches it and the index does not track it, so a force-added file is not shown as ignored. Measured on a `microsoft/vscode` checkout, a 6,000-file directory lists in 66 ms, where `git check-ignore` takes 1.6 s. Ignored files are hidden by default, and "Show ignored" shows them greyed out.
  - **Keyboard-first.** Arrow keys expand, collapse, descend and climb. Enter opens a file in the preview tab or toggles a folder, and a double click still pins a tab. Home and End jump to the ends, typing a name jumps to it, and ⇧F10 opens the context menu. The tree is virtualized and exposes `role="tree"` with a single tab stop.
  - **Diff or file, per tab.** A tab on a changed file opens on its inline diff, with a Working tree | Index switch when the file is both staged and modified. A Diff | File toggle in the toolbar switches to the editor and back. The diff always shows the file on disk, so Diff waits while the tab has unsaved changes ("Save to see the diff"), and leaving the diff re-reads a clean tab from disk. An unchanged file opens in the editor, as before. A conflicted file offers "Open in merge editor", and a file deleted on disk says so.
  - **Context menu.** On a file: Open in editor, Copy path and Reveal in Finder / Explorer / the file manager. On a folder: Scope here, Copy path and Reveal.
  - **Live, and scope-aware.** The tree refreshes from the Live Repo watcher and re-lists only the folders that changed. "Scope here" narrows the whole app to a folder, the tree re-roots on it with a "Whole repo" button to go back, and if that folder is deleted, the panel falls back to the whole repo with a notice. Expanded folders, the selection and "Show ignored" are remembered per repository.
```

Replace line 19 (the "The Files panel lists folders lazily and refreshes live" bullet) with:

```markdown
- **The File Explorer panel lists folders lazily and refreshes live.** It used to load the whole repository once, capped at 20,000 entries, and never refreshed. Each folder is now listed when it is opened, folders show a count of changes below them, and the Live Repo watcher keeps the tree current.
```

Leave the `### Fixed` entries as they are. The `getGitDiff` fix still describes the Changes view's banners and panels.

- [ ] **Step 2: Rewrite the website guide section**

In `website/guide/desktop.md`, replace lines 97-108 (from `## Files View (v3.11.2)` through `The view is for exploring. …`) with:

```markdown
## File Explorer (v3.11.2)

The **Files** tile in the dock opens the File Explorer, with the working tree on the left and your open files on the right. It can float, dock at the bottom or go full-screen.

- **Status at a glance.** Changed files carry a letter (M, A, D, R, U, C), and every folder above a change carries a count, even a folder you have not opened. Deleted files stay in place, struck through.
- **Ignored files on demand.** They are hidden by default. **Show ignored** shows them greyed out, and they are still loaded one folder at a time.
- **Keyboard.** Use ↑ ↓ to move. → expands a folder and then steps into it, and ← collapses it and then climbs to the parent. Enter opens a file in the preview tab or toggles a folder, and a double click pins the tab. Home and End jump to the ends, and you can type the start of a name to jump to it. ⇧F10 opens the context menu.
- **Diff or file.** A changed file opens on its inline diff, with a **Working tree | Index** switch when it is both staged and modified. **Diff | File** in the toolbar switches to the editor, where you can edit, save and show blame. The diff always shows the file on disk, so **Diff** is available again once you save. Unchanged files open in the editor. A conflicted file offers **Open in merge editor**.
- **Context menu.** On a file: **Open in editor**, **Copy path** and **Reveal in Finder**. On a folder: **Scope here**, which narrows the app to that folder and re-roots the tree (**Whole repo** goes back), **Copy path** and **Reveal**.
- **Live.** The tree and an open diff follow changes on disk through the Live Repo watcher.

Staging stays in **Changes**.
```

- [ ] **Step 3: Adjust the ROADMAP**

In the `### v3.11.2 — Finder-like folder navigation` section (lines 23-29), add a paragraph after the existing one:

```markdown
Delivered in the File Explorer panel rather than as a separate view (decision of 2026-10-02, spec addendum `2026-10-02-finder-converge-on-explorer-design.md`): one file browser, which can also edit.
```

Line 121: change `the Browse tree and the File Explorer panel re-list a loaded folder only on a watcher event` to `the File Explorer panel re-lists a loaded folder only on a watcher event`.

Replace lines 150-152 (Files view follow-ups, keyboard navigation in the panel, watcher blind spot) with:

```markdown
- **File Explorer follow-ups** (out of scope for v3.11.2, spec §10 and its 2026-10-02 addendum). Not done: stage/unstage from the panel, file operations (rename, delete, create), and tree-wide name search beyond type-ahead over the visible rows. Each needs its own design, and search would have to work with a 5,000-per-folder listing cap.
- **Refresh a clean File Explorer tab on an external change.** A tab's buffer is read when the tab opens. Since v3.11.2 a clean tab re-reads the disk when it leaves its Diff side, but a tab that stays on File does not see an edit made outside GitWand until it is reopened. The watcher already reports the path, so a clean tab could reload in place, and a dirty one could offer to.
- **Live Repo watcher blind spot on ignored folders.** The watcher drops events under `node_modules`, `target`, `dist`, `.venv` and `__pycache__`, so an ignored folder expanded with "Show ignored" in the File Explorer does not refresh live. Collapsing and re-expanding it re-lists it.
```

- [ ] **Step 4: Check for leftovers**

Run: `grep -nE "Browse|Files view|Files View" CHANGELOG.md ROADMAP.md website/guide/desktop.md | grep -v "Browser"`
Expected: no line about the removed view. The `[3.x]` history above the `[Unreleased]` block does not mention it either.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md ROADMAP.md website/guide/desktop.md
git commit -m "docs: v3.11.2 lands in the File Explorer panel (changelog, guide, roadmap follow-ups)"
```

---

### Task 9: Full verification and manual QA

**Files:**
- None, unless a check fails. A fix then goes to the task that owns the file, as a new commit.

**Interfaces:**
- Consumes: everything above.
- Produces: a green suite, a clean type-check and a manual QA record for the PR description.

- [ ] **Step 1: Run the whole desktop suite**

Run: `cd apps/desktop && node_modules/.bin/vitest run`
Expected: every test file passes, and none of the six deleted test files appear.

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @gitwand/core build && cd apps/desktop && node_modules/.bin/vue-tsc --noEmit`
Expected: no error.

- [ ] **Step 3: Parity and command registry still hold**

Run: `cd apps/desktop && node_modules/.bin/vitest run src/utils/__tests__/commandRegistry.test.ts src/utils/__tests__/backend-files-view.test.ts`
Expected: pass. No command was added or removed: `list_repo_dir` and `reveal_in_file_manager` keep their wrappers, routes and parity test.

- [ ] **Step 4: Manual QA in `dev:web`**

Run: `cd apps/desktop && pnpm dev:web`. Inject a repository through localStorage instead of the folder picker. Then check each item:
- The dock has no "Browse" entry. The palette has no "View: Browse files". Settings → Dock has no "Show Browse" and its reorder list has five entries.
- Files tile → panel. In the tree: ↑ ↓ → ← Home End and type-ahead work. Enter opens a preview tab (italic), double click pins it, and ⇧F10 opens the menu.
- Context menu: Copy path pastes the repo-relative path. Scope here re-roots the tree and shows the "Scoped to …" chip, and Whole repo clears it. In `dev:web`, Reveal only logs (dev route).
- Changed file → diff. Diff | File → editor, then Edit, type: the Diff button is greyed out with the "Save to see the diff" tooltip. Save → Diff is available and shows the saved change.
- On a staged+modified file, Working tree | Index switches the diff.
- On a conflicted file, the banner's "Open in merge editor" goes to the Changes view, and the panel hides when "Hide on menu switch" is on.
- Show ignored shows `node_modules` greyed out.

- [ ] **Step 5: Manual QA in the debug app**

Run: `cd apps/desktop && pnpm dev` (Tauri). Then check each item:
- Reveal in Finder selects the file.
- Live Repo on: create a file in an expanded folder from a terminal, and it appears. Edit a file whose tab is on Diff, and the diff updates without blanking. Then switch to File: the editor shows the new content.
- `git checkout -- <file>` on a file whose tab is on Diff: the tab falls back to File, the toggle disappears, and the editor shows the restored content.
- `rm <file>` on an open tab: "Deleted from disk" appears and the buffer stays.
- Switch repos with the panel open, then hidden and shown again: the second repo's tree and tabs appear, with nothing from the first.
- A profile whose saved settings had "Browse" first in the dock order starts on the next visible view.

- [ ] **Step 6: Record**

Paste the results of Steps 4-5 into the PR description, one line per item, with anything that differed.
