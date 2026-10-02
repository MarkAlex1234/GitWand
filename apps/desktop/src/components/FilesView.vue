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
