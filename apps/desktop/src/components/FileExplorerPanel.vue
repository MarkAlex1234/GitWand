<script setup lang="ts">
import { computed, reactive, ref, toRef, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import FileTreePane from "./FileTreePane.vue";
import DiffViewer from "./DiffViewer.vue";
import { useFileExplorer, resolveFileExplorerShortcut, type FileTab } from "../composables/useFileExplorer";
import { useLazyRepoTree, type TreeWatcher } from "../composables/useLazyRepoTree";
import { useTreeScopeRoot } from "../composables/useTreeScopeRoot";
import { formatBytes, useFilePreview, type PreviewBody, type PreviewTarget } from "../composables/useFilePreview";
import { canShowDiff, initialTabView, isDiffable, visibleTabView, type TabView } from "../composables/explorerTabView";
import type { DiffMode } from "../utils/diffMode";
import { useSettings } from "../composables/useSettings";
import { useI18n } from "../composables/useI18n";
import { useLogs } from "../composables/useLogs";
import { useDraggableResizable } from "../composables/useDraggableResizable";
import type { RepoFileEntry } from "../composables/useGitRepo";
import { clipboardWriteText, getGitBlame, getGitDiff, listRepoDir, readFileAtRevision, revealInFileManager } from "../utils/backend";
import { buildBlameModel, type BlameGutterEntry } from "../composables/useBlameGutter";
import { useCodeMirror } from "../composables/useCodeMirror";
import { peekCodeMirror } from "../utils/codemirrorLibs";
import type { EditorState as EditorStateType, Extension } from "@codemirror/state";

const props = defineProps<{
  repoPath: string;
  changedFiles: RepoFileEntry[];
  /** v3.11.2 — live refresh; optional so existing mounts keep working. */
  watcher?: TreeWatcher | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "request-close-tab", tabId: number): void;
  /** v3.11.2 — context menu "Open in editor": App opens the configured external editor. */
  (e: "open-in-editor", path: string): void;
  /** v3.11.2 — the conflicted banner: App opens the merge editor in the Changes view. */
  (e: "open-merge-editor", path: string): void;
  /** v3.11.2 — DiffViewer's history button: App opens the file history in the Changes view. */
  (e: "open-file-history", path: string): void;
}>();

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
const treePane = ref<InstanceType<typeof FileTreePane> | null>(null);

/** "Whole repo" removes its own button, so focus would fall to the body. */
async function onWholeRepo(): Promise<void> {
  await scope.wholeRepo();
  await nextTick();
  treePane.value?.focus();
}
const tree = useLazyRepoTree({
  repoPath: repoPathRef,
  root: scope.root,
  repoFiles: changedFilesRef,
  listDir: (dir, includeIgnored) => listRepoDir(props.repoPath, dir, includeIgnored),
  watcher: props.watcher ?? null,
  onRootError: () => void scope.onRootError(),
});
const repoName = computed(() => props.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? props.repoPath);

const tabs = computed(() => explorer.tabsFor(props.repoPath));
const activeId = computed(() => explorer.activeTabId(props.repoPath));
const activeTab = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);

const mode = computed(() => settings.value.filesMode);
const fullscreen = computed(() => mode.value === "fullscreen");
const bottom = computed(() => mode.value === "bottom");

// The inline header button toggles fullscreen on/off, restoring the layout
// that was active before fullscreen (floating or bottom) on the way out —
// mirrors TerminalPanel.vue's toggleFullscreen exactly.
function toggleFullscreen() {
  if (fullscreen.value) {
    settings.value.filesMode = settings.value.filesPrevMode;
  } else {
    settings.value.filesPrevMode = mode.value as "floating" | "bottom";
    settings.value.filesMode = "fullscreen";
  }
  saveSettings(settings.value);
}

// ── Floating position/size, persisted — via the shared useDraggableResizable
// composable (also used by TerminalPanel.vue). Defaults: docked to the left
// edge, directly under the header (app-body already excludes the header, so
// top:0 lands there for free), full height of the container measured on
// mount (0 is a "not yet set" sentinel — see the onMounted block below).
const feRef = ref<HTMLElement | null>(null);

const {
  height, left, width, top,
  isDragging, isResizingX, isResizingL, isResizingBottom, resizingCorner,
  onDragStart, onMoveStart, onResizeXStart, onResizeLeftStart, onResizeBottomStart, onResizeCornerStart,
} = useDraggableResizable({
  panelRef: feRef,
  keyPrefix: "gitwand-explorer",
  initialHeight: Number(localStorage.getItem("gitwand-explorer-height")) || 0,
  initialLeft: Number(localStorage.getItem("gitwand-explorer-left")) || 0,
  initialWidth: Number(localStorage.getItem("gitwand-explorer-width")) || 0,
  initialTop: Number(localStorage.getItem("gitwand-explorer-top")) || 0,
  canMove: () => !bottom.value,
});

onMounted(() => {
  const parent = feRef.value?.parentElement;
  if (!width.value) {
    width.value = Math.round((parent?.offsetWidth ?? window.innerWidth) * 0.5);
  }
  if (!height.value) {
    height.value = parent?.offsetHeight ?? window.innerHeight;
  }
});

const panelStyle = computed(() => {
  if (fullscreen.value || bottom.value) return {};
  return {
    left: `${left.value}px`,
    top: `${top.value}px`,
    width: `${width.value}px`,
    height: `${height.value}px`,
  };
});

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

// The tree's highlight follows the active tab, however it became active.
watch(
  () => activeTab.value?.path,
  (path) => {
    if (path) tree.selected.value = path;
  },
);

function onTabClick(tabId: number) {
  explorer.setActive(props.repoPath, tabId);
}

function onTabClose(tabId: number) {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (tab && explorer.isDirty(tab)) {
    emit("request-close-tab", tabId);
  } else {
    explorer.closeTab(props.repoPath, tabId);
  }
}

// ── CodeMirror 6 (shared wiring, one EditorView with per-tab cached state) ──
//
// v3.11: the loader, the view and the editable/theme compartments moved into
// `useCodeMirror`. What stays here is everything that knows about *tabs*: the
// per-tab `EditorState` cache, the blame models, and the "did the active tab
// change while we awaited?" re-checks in `mountTab`. The composable
// deliberately does not own mounting end to end, so this cache can survive.
const editorHost = ref<HTMLElement | null>(null);
const docStates = new Map<number, EditorStateType>();
const editLocked = ref(true);
const editable = computed(() => !editLocked.value);

const cm = useCodeMirror({ host: editorHost, editable });

/**
 * The doc-change listener for ONE tab, baked into that tab's `EditorState`.
 *
 * The tab id is captured here rather than read from `activeTab` at fire time,
 * and that distinction is the whole point. `mountTab` awaits `waitForTabLoaded`
 * and the grammar load while the PREVIOUS tab's view is still mounted and
 * editable. A keystroke (or `onUndo`) in that window fires with `activeTab`
 * already pointing at the new tab, so a listener that read it would write the
 * old tab's text into the new tab's cache and into `explorer.updateContent` —
 * and the new tab would then display, and on save write, the previous file's
 * contents. Capturing per state is what the pre-v3.11 code did; the v3.11
 * refactor briefly lost it.
 */
function updateListenerFor(tabId: number): Extension {
  const libs = peekCodeMirror()!;
  return libs.EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    docStates.set(tabId, update.state);
    explorer.updateContent(props.repoPath, tabId, update.state.doc.toString());
    // Editing shifts line numbers, so the committed blame no longer aligns:
    // drop this tab's cached model and turn blame off. Deferred to a
    // microtask to avoid dispatching a reconfigure from inside an update.
    if (blameEnabled.value) {
      blameModels.delete(tabId);
      queueMicrotask(() => {
        if (!blameEnabled.value) return;
        blameEnabled.value = false;
        applyBlame(tabId);
      });
    }
  });
}

// ── Blame gutter (opt-in, per tab) ──
// A Compartment owned by THIS component, not the composable: `useCodeMirror`
// has no business knowing what blame is, and `useBlameGutter.ts` is
// deliberately CodeMirror-free. It holds either an empty extension (blame off)
// or a gutter built from the active tab's model. Blame reflects the *committed*
// file, so editing a tab clears it (see the update listener above).
let blameCompartment: InstanceType<typeof import("@codemirror/state").Compartment> | null = null;
const blameEnabled = ref(false);
const blameModels = new Map<number, Map<number, BlameGutterEntry>>();

/** Ensure the libs are loaded and this component's blame compartment exists. */
async function ensureCodeMirrorLibs() {
  const libs = await cm.ensure();
  blameCompartment ??= new libs.Compartment();
  return libs;
}

// Build a CodeMirror gutter extension from a `finalLine → entry` blame model.
// One marker per source line; continuation lines of a same-commit run render
// blank (entry.showLabel === false) so the author shows once per block.
function blameGutterExtension(model: Map<number, BlameGutterEntry>): Extension {
  const libs = peekCodeMirror()!;
  const GM = libs.GutterMarker;
  class BlameMarker extends GM {
    constructor(public entry: BlameGutterEntry) {
      super();
    }
    eq(other: BlameMarker) {
      return other.entry.hashFull === this.entry.hashFull && other.entry.showLabel === this.entry.showLabel;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = "cm-blame-marker";
      span.textContent = this.entry.showLabel ? this.entry.label : "";
      span.title = this.entry.title;
      return span;
    }
  }
  return libs.gutter({
    class: "cm-blame-gutter",
    // Rendered in CodeMirror's separate `.cm-gutters-after` container, to the
    // right of .cm-content, instead of alongside the line-number gutter on
    // the left — appearing/resizing the blame column then never shifts the
    // code's horizontal position (see review discussion on PR #108).
    side: "after",
    lineMarker(view, blockLine) {
      const ln = view.state.doc.lineAt(blockLine.from).number;
      const entry = model.get(ln);
      return entry ? new BlameMarker(entry) : null;
    },
    lineMarkerChange: () => false,
  });
}

// Fetch + cache the blame model for a tab. Returns false on failure or if the
// user switched tabs while the (async) blame was in flight.
async function ensureBlameForTab(tab: FileTab): Promise<boolean> {
  if (blameModels.has(tab.id)) return true;
  try {
    const lines = await getGitBlame(props.repoPath, tab.path);
    if (activeTab.value?.id !== tab.id) return false;
    blameModels.set(tab.id, buildBlameModel(lines));
    return true;
  } catch {
    return false;
  }
}

// Reconfigure the shared blame compartment on the live view for `tabId`:
// the tab's gutter when blame is on and a model is cached, empty otherwise.
function applyBlame(tabId: number) {
  if (!cm.view.value || !blameCompartment) return;
  const model = blameEnabled.value ? blameModels.get(tabId) : undefined;
  cm.reconfigure(blameCompartment, model ? blameGutterExtension(model) : []);
  docStates.set(tabId, cm.view.value.state);
}

async function toggleBlame() {
  if (!activeTab.value || activeTab.value.binary) return;
  blameEnabled.value = !blameEnabled.value;
  if (blameEnabled.value) {
    const ok = await ensureBlameForTab(activeTab.value);
    if (!ok) {
      blameEnabled.value = false;
      return;
    }
  }
  if (activeTab.value) applyBlame(activeTab.value.id);
}

function waitForTabLoaded(tab: FileTab): Promise<void> {
  if (!tab.loading) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(
      () => tab.loading,
      (loading) => {
        if (!loading) {
          stop();
          resolve();
        }
      },
    );
  });
}

async function mountTab(tab: FileTab) {
  if (tab.binary) {
    // Binary files get a placeholder (see FileTab.binary) — tear down any
    // mounted editor so a previously-open text tab's view doesn't linger.
    cm.destroy();
    return;
  }

  await ensureCodeMirrorLibs();
  if (activeTab.value?.id !== tab.id) return; // a newer tab switch happened while libs were loading

  if (tab.loading) {
    await waitForTabLoaded(tab);
    if (activeTab.value?.id !== tab.id) return; // a newer tab switch happened while we waited for content
    if (tab.binary) {
      // The read resolved to a binary file while we were waiting — re-check
      // and bail the same way the top-of-function binary guard does.
      cm.destroy();
      return;
    }
  }

  await nextTick();
  if (!editorHost.value) return;
  if (activeTab.value?.id !== tab.id) return; // re-check after nextTick too

  let state = docStates.get(tab.id);
  if (!state) {
    state = await cm.buildState(tab.content, tab.path, [
      blameCompartment!.of([]),
      updateListenerFor(tab.id),
    ]);
    if (activeTab.value?.id !== tab.id) return; // a newer tab switch happened while the grammar was loading — don't touch the shared view/docStates with a stale tab's state
    docStates.set(tab.id, state);
  }

  // `mount` re-asserts the lock and the theme, so a cached state built before
  // the last toggle still comes back consistent with the rest of the panel.
  cm.mount(state);
  docStates.set(tab.id, cm.view.value!.state);

  // Re-assert blame for this tab: if blame is on, load its model (once) and
  // show the gutter; otherwise applyBlame clears any gutter carried over from
  // a previously-shown state.
  if (blameEnabled.value && !tab.binary) {
    await ensureBlameForTab(tab);
    if (activeTab.value?.id !== tab.id) return;
  }
  applyBlame(tab.id);
}

function toggleLock() {
  // `editable` is a computed over `editLocked` and `useCodeMirror` watches it,
  // so the live view reconfigures itself. We only re-cache the resulting state
  // so this tab's cached copy does not carry the stale lock.
  editLocked.value = !editLocked.value;
  const tab = activeTab.value;
  if (tab && cm.view.value) docStates.set(tab.id, cm.view.value.state);
}

function onUndo() {
  const libs = peekCodeMirror();
  if (editLocked.value || editorPending.value || !cm.view.value || !libs) return;
  libs.undo(cm.view.value); // dispatches internally; the existing updateListener
  // (see updateListenerFor) picks up the resulting docChanged transaction
  // and syncs it into useFileExplorer's tab.content, same as any keystroke.
}

function onToolbarSave() {
  if (!activeTab.value || activeTab.value.binary || editorPending.value) return;
  explorer.saveTab(props.repoPath, props.repoPath, activeTab.value.id);
}

// ── Diff | File (v3.11.2) ──
// A tab on a changed file opens on its inline diff; the toolbar toggle
// switches to the editor and back. What a tab shows is
// `resolveTabView(stored side, status)`. The side is stored the first time the
// panel shows the tab, so a file that becomes changed while open does not
// flip its tab. The diff reads the disk, which is why a dirty buffer cannot
// switch to it (canShowDiff).
// Keyed by repo + tab id: the panel stays mounted across a repo switch, and a
// tab's side must survive leaving and coming back to its repo.
const viewKey = (id: number) => `${props.repoPath}::${id}`;
const tabViews = reactive(new Map<string, TabView>());
// Right after a repo switch `changedFiles` still holds the previous repo's
// status until the new one loads: deciding a tab's first side then would
// record "file" for a file changed only in the new repo. Until the status
// arrives, no side is recorded and the tab resolves from the live status.
const statusPending = ref(false);
watch(repoPathRef, () => {
  statusPending.value = true;
});
watch(changedFilesRef, () => {
  statusPending.value = false;
});
const activeStatus = computed(() =>
  activeTab.value ? (tree.statusByPath.value.get(activeTab.value.path) ?? null) : null,
);
const activeDiffable = computed(() => isDiffable(activeStatus.value));
const showDiff = computed(
  () =>
    activeTab.value !== null &&
    visibleTabView(tabViews.get(viewKey(activeTab.value.id)), activeStatus.value, explorer.isDirty(activeTab.value)) === "diff",
);
const diffBlocked = computed(
  () => activeTab.value !== null && !canShowDiff(activeStatus.value, explorer.isDirty(activeTab.value)),
);

const previewTarget = computed<PreviewTarget | null>(() => {
  const tab = activeTab.value;
  const status = activeStatus.value;
  if (!tab || !status || !showDiff.value) return null;
  // `size` lets planPreview refuse a huge untracked file before diffing it at
  // all. The tree row carries it; a file whose folder is not loaded has no
  // row, and keeps 0 — then git_diff's own 5 MB cap (plain and untracked
  // --no-index output alike) still bounds what crosses IPC.
  const row = tree.rows.value.find((r) => r.kind === "file" && r.path === tab.path);
  const size = row?.kind === "file" ? row.size : 0;
  return { kind: "file", path: tab.path, size, symlink: false, status };
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

// Record a tab's side the first time it is shown. When its file stops having
// a diff to show (committed, discarded, deleted on disk), store File, so the
// next change does not flip the tab back to the diff under the cursor.
watch(
  () => [activeTab.value?.id ?? null, props.repoPath, statusPending.value, isDiffable(activeStatus.value)] as const,
  ([id, , pending, diffable]) => {
    if (id === null || pending) return;
    const k = viewKey(id);
    const stored = tabViews.get(k);
    if (stored === undefined) tabViews.set(k, initialTabView(activeStatus.value));
    else if (stored === "diff" && !diffable) void setView("file");
  },
  { immediate: true },
);

// Latest side request per tab: a File request whose read is still pending is
// void once the user asked for either side again (Diff then File, say).
const viewRequests = new Map<string, number>();
let viewRequestSeq = 0;
// Per tab (viewKey), the number of leaving-Diff re-reads in flight. While one
// is pending for the active tab, its buffer may predate the disk file: the
// editor stays hidden and Lock/Edit, Undo, Blame, Save and ⌘S are off.
const reloadPending = reactive(new Map<string, number>());
const editorPending = computed(() => activeTab.value !== null && reloadPending.has(viewKey(activeTab.value.id)));

async function setView(view: TabView): Promise<void> {
  const tab = activeTab.value;
  if (!tab) return;
  const repo = props.repoPath;
  const k = viewKey(tab.id);
  const request = ++viewRequestSeq;
  viewRequests.set(k, request);
  if (view === "diff") {
    if (canShowDiff(activeStatus.value, explorer.isDirty(tab))) tabViews.set(k, "diff");
    return;
  }
  if (tabViews.get(k) !== "diff") {
    tabViews.set(k, "file");
    if (props.repoPath === repo && activeTab.value?.id === tab.id) await mountTab(tab);
    return;
  }
  // Leaving Diff. The diff showed the file on disk; the buffer dates from when
  // the tab opened. Keep the diff on screen while a clean buffer is re-read:
  // revealing the editor first would let an edit (or Undo) land on the old
  // text, make the reload decline as dirty, and a save would then overwrite
  // the newer disk file. The cached editor state and blame built from the old
  // text are dropped for THAT tab, whichever is active by the time the read
  // lands. The diff is not always there to cover the read: when the watcher
  // falls back because the file has no diff any more, the tab already resolves
  // to File. `reloadPending` hides the editor and disables its actions until
  // the read lands, whichever way we got here.
  reloadPending.set(k, (reloadPending.get(k) ?? 0) + 1);
  try {
    if (await explorer.reloadTab(repo, repo, tab.id)) {
      docStates.delete(tab.id);
      blameModels.delete(tab.id);
    }
    // Do not override a side the user chose, or a repo switched, in the meantime.
    if (props.repoPath !== repo || tabViews.get(k) !== "diff" || viewRequests.get(k) !== request) return;
    tabViews.set(k, "file");
    if (activeTab.value?.id === tab.id) await mountTab(tab);
  } finally {
    const left = (reloadPending.get(k) ?? 1) - 1;
    if (left > 0) reloadPending.set(k, left);
    else reloadPending.delete(k);
  }
}

function diffPlaceholder(body: Extract<PreviewBody, { kind: "placeholder" }>): string {
  return body.reason === "too-large"
    ? t("filesView.preview.tooLarge", formatBytes(body.size))
    : t("filesView.preview.noTextDiff");
}

watch(activeTab, (tab) => {
  if (tab) mountTab(tab);
});

watch(
  () => tabs.value.map((t) => t.id),
  (ids, oldIds) => {
    for (const id of oldIds ?? []) {
      if (!ids.includes(id)) {
        docStates.delete(id);
        blameModels.delete(id);
      }
    }
  },
);

// A side is dropped only when its tab is closed in its own repo: ids are
// compared within one repoPath, never across a repo switch.
watch(
  () => [props.repoPath, tabs.value.map((t) => t.id)] as const,
  ([repo, ids], [oldRepo, oldIds]) => {
    if (repo !== oldRepo) return;
    for (const id of oldIds) if (!ids.includes(id)) tabViews.delete(`${repo}::${id}`);
  },
);

onBeforeUnmount(() => {
  cm.destroy();
});

function onKeyDown(e: KeyboardEvent) {
  const shortcut = resolveFileExplorerShortcut(e, true);
  if (!shortcut || !activeTab.value) return;
  if (shortcut === "save") {
    e.preventDefault();
    if (!activeTab.value.binary && !editorPending.value) explorer.saveTab(props.repoPath, props.repoPath, activeTab.value.id);
  } else if (shortcut === "close") {
    e.preventDefault();
    onTabClose(activeTab.value.id);
  } else if (typeof shortcut === "object") {
    const target = tabs.value[shortcut.switch];
    if (target) onTabClick(target.id);
  }
}
</script>

<template>
  <div
    ref="feRef"
    class="fe"
    :class="{ 'fe--full': fullscreen, 'fe--bottom': bottom, 'fe--floating': !fullscreen && !bottom }"
    :style="panelStyle"
    tabindex="0"
    @keydown="onKeyDown"
  >
    <div v-if="!fullscreen" class="fe__drag" :class="{ 'fe__drag--active': isDragging }" @mousedown="onDragStart" />
    <div class="fe__header" @mousedown="onMoveStart">
      <span class="fe__title">{{ t("files.headerLabel") }}</span>
      <span class="fe__header-divider" aria-hidden="true" />
      <div class="fe__header-actions">
        <button
          class="fe__action-btn"
          :class="{ 'fe__action-btn--active': !editLocked }"
          :disabled="showDiff || editorPending"
          :title="editLocked ? t('files.toolbarEdit') : t('files.toolbarLock')"
          @click="toggleLock"
        >
          <svg v-if="editLocked" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2"/>
            <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
          </svg>
          <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2"/>
            <path d="M8 11V7a4 4 0 0 1 7.75-1.5"/>
          </svg>
          <span>{{ editLocked ? t("files.toolbarEdit") : t("files.toolbarLock") }}</span>
        </button>
        <button
          class="fe__action-btn"
          :disabled="!activeTab || activeTab.binary || !explorer.isDirty(activeTab) || editorPending"
          :title="t('files.toolbarSave')"
          @click="onToolbarSave"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
          <span>{{ t("files.toolbarSave") }}</span>
        </button>
        <span class="fe__header-divider" aria-hidden="true" />
        <button class="fe__action-btn" :disabled="editLocked || showDiff || editorPending" :title="t('files.toolbarUndo')" @click="onUndo">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 7v6h6"/>
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
          </svg>
          <span>{{ t("files.toolbarUndo") }}</span>
        </button>
        <button
          class="fe__action-btn"
          :class="{ 'fe__action-btn--active': blameEnabled }"
          :disabled="!activeTab || activeTab.binary || explorer.isDirty(activeTab) || showDiff || editorPending"
          :title="t('files.toolbarBlame')"
          @click="toggleBlame"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"/>
            <line x1="1.5" y1="12" x2="8" y2="12"/>
            <line x1="16" y1="12" x2="22.5" y2="12"/>
          </svg>
          <span>{{ t("files.toolbarBlame") }}</span>
        </button>
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
      </div>
      <div class="fe__header-spacer" />
      <button
        class="fe__full"
        :title="fullscreen ? t('files.exitFullscreen') : t('files.fullscreen')"
        :aria-label="fullscreen ? t('files.exitFullscreen') : t('files.fullscreen')"
        @click="toggleFullscreen"
      >
        <svg v-if="!fullscreen" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
          <line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
      </button>
      <button class="fe__close" :title="t('common.close')" @click="emit('close')">✕</button>
    </div>

    <div class="fe__body">
      <div class="fe__tree-col">
        <div v-if="scope.root.value" class="fe__scope" role="group" :aria-label="t('scope.picker')">
          <span class="fe__scope-path mono" :title="scope.root.value">{{ t('scope.active', scope.root.value) }}</span>
          <button type="button" class="fe__action-btn" @click="onWholeRepo">{{ t('scope.wholeRepo') }}</button>
        </div>
        <p v-if="scope.goneScope.value" class="fe__scope-notice" role="status">
          {{ t('filesView.scopeGone', scope.goneScope.value) }}
        </p>
        <FileTreePane
          ref="treePane"
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

      <div class="fe__editor-pane">
        <div v-if="tabs.length" class="fe__tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="fe__tab"
            :class="{ 'fe__tab--active': tab.id === activeId, 'fe__tab--preview': !tab.pinned }"
            @click="onTabClick(tab.id)"
          >
            <span class="fe__tab-name">{{ tab.path.split('/').pop() }}</span>
            <span v-if="explorer.isDirty(tab)" class="fe__tab-dot" />
            <span class="fe__tab-close" @click.stop="onTabClose(tab.id)">✕</span>
          </button>
        </div>
        <p v-if="activeTab && activeStatus?.deletedOnDisk" class="fe__notice" role="status">{{ t('filesView.preview.gone') }}</p>
        <div v-show="activeTab && !activeTab.binary && !showDiff && !editorPending" class="fe__content" ref="editorHost"></div>
        <p v-if="activeTab && !showDiff && editorPending" class="fe__empty" aria-busy="true">{{ t('filesView.loading') }}</p>
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
      </div>
    </div>

    <template v-if="!fullscreen && !bottom">
      <div class="fe__resize-x fe__resize-x--left" :class="{ 'fe__resize-x--active': isResizingL }" @mousedown="onResizeLeftStart" />
      <div class="fe__resize-x" :class="{ 'fe__resize-x--active': isResizingX }" @mousedown="onResizeXStart" />
      <div class="fe__resize-y fe__resize-y--bottom" :class="{ 'fe__resize-y--active': isResizingBottom }" @mousedown="onResizeBottomStart" />
      <div class="fe__corner fe__corner--tl" :class="{ 'fe__corner--active': resizingCorner === 'tl' }" @mousedown="onResizeCornerStart('tl', $event)" />
      <div class="fe__corner fe__corner--tr" :class="{ 'fe__corner--active': resizingCorner === 'tr' }" @mousedown="onResizeCornerStart('tr', $event)" />
      <div class="fe__corner fe__corner--bl" :class="{ 'fe__corner--active': resizingCorner === 'bl' }" @mousedown="onResizeCornerStart('bl', $event)" />
      <div class="fe__corner fe__corner--br" :class="{ 'fe__corner--active': resizingCorner === 'br' }" @mousedown="onResizeCornerStart('br', $event)" />
    </template>
  </div>
</template>

<style scoped>
.fe {
  position: absolute;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 40;
  overflow: hidden;
}

.fe--full {
  position: static;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0;
}

.fe--bottom {
  position: static;
  width: 100%;
  height: 360px;
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
}

.fe__drag {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 5px;
  cursor: ns-resize;
  z-index: 3;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}

.fe__resize-x {
  position: absolute;
  top: 0;
  right: -4px;
  width: 8px;
  height: 100%;
  cursor: ew-resize;
  z-index: 1;
}

.fe__resize-x--left {
  right: auto;
  left: -4px;
}

.fe__resize-y {
  position: absolute;
  left: 0;
  width: 100%;
  height: 8px;
  cursor: ns-resize;
  z-index: 1;
}

.fe__resize-y--bottom {
  bottom: -4px;
}

.fe__corner {
  position: absolute;
  width: 14px;
  height: 14px;
  z-index: 2;
}

.fe__corner--tl {
  top: -4px;
  left: -4px;
  cursor: nwse-resize;
}

.fe__corner--tr {
  top: -4px;
  right: -4px;
  cursor: nesw-resize;
}

.fe__corner--bl {
  bottom: -4px;
  left: -4px;
  cursor: nesw-resize;
}

.fe__corner--br {
  bottom: -4px;
  right: -4px;
  cursor: nwse-resize;
}

.fe__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  cursor: grab;
}

.fe__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
}

.fe__header-divider {
  width: 1px;
  height: 16px;
  flex-shrink: 0;
  background: var(--color-border);
  margin: 0 var(--space-1);
}

.fe__header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.fe__header-spacer {
  flex: 1;
}

.fe__action-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  background: var(--color-bg-tertiary);
  white-space: nowrap;
}

.fe__action-btn:hover:not(:disabled) {
  color: var(--color-text);
}

.fe__action-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.fe__action-btn--active {
  color: var(--color-accent);
}

.fe__close {
  font-size: var(--font-size-xl);
  color: var(--color-text-muted);
}

.fe__full {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: var(--space-2);
  color: var(--color-text-muted);
}

.fe__full:hover,
.fe__close:hover {
  color: var(--color-text);
}

.fe__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

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

.fe__editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.fe__tabs {
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fe__tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.fe__tab--active {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.fe__tab--preview {
  font-style: italic;
}

.fe__tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
}

.fe__notice {
  margin: 0;
  padding: var(--space-2) var(--space-5);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
}

.fe__content {
  flex: 1;
  overflow: auto;
}

.fe__content :deep(.cm-editor) {
  height: 100%;
}

/* Blame gutter (opt-in) — rendered via CodeMirror's `side: "after"` gutter
   slot (.cm-gutters-after), to the right of .cm-content rather than beside
   the line-number gutter on the left, so showing/resizing it never shifts
   the code's horizontal position (PR #108 review). Shows `author · date`
   once per same-commit run; full details on hover (title).

   These were hard-coded to oneDark's own palette (#282c34 / #7d8799 /
   #21252b) because the editor used to be oneDark whatever the app theme was,
   so the `--color-*` tokens rendered a light gutter on a dark editor in light
   mode. v3.11 makes the editor follow the app theme, so the tokens are now the
   correct answer and the hard-coding is what would be wrong. */
.fe__content :deep(.cm-blame-gutter) {
  background-color: var(--color-bg-secondary);
  border-left: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 11px;
}
.fe__content :deep(.cm-blame-marker) {
  display: inline-block;
  overflow: hidden;
  max-width: 190px;
  padding: 0 var(--space-2);
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: default;
}

.fe__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

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
</style>
