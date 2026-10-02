<script setup lang="ts">
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
  /** Open the file: a click or Enter (preview tab), a double click (`pinned`). */
  activate: [path: string, pinned: boolean];
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

function isNamed(r: LazyTreeRow | null | undefined): r is Extract<LazyTreeRow, { kind: "file" | "folder" }> {
  return r != null && (r.kind === "file" || r.kind === "folder");
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
  // -1 (type-ahead with no match and no cursor) means "stay where you are".
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
      if (r?.kind === "file" && !r.deleted) emit("activate", r.path, false);
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
  if (r?.kind === "folder") emit("toggle", r.path);
  else if (r?.kind === "file" && !r.deleted) emit("activate", r.path, false);
}

function onChevronClick(e: MouseEvent, i: number): void {
  e.stopPropagation();
  const r = props.rows[i];
  cursor.value = i;
  if (r?.kind === "folder") emit("toggle", r.path);
}

/**
 * A double click pins the file's tab. A folder needs nothing here: the two
 * clicks that come before a dblclick have already toggled it twice.
 */
function onRowDblClick(i: number): void {
  const r = props.rows[i];
  if (r?.kind === "file" && !r.deleted) emit("activate", r.path, true);
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
  clearOutsideTimer();
  outsideTimer = setTimeout(() => {
    outsideTimer = null;
    if (menu.value) window.addEventListener("pointerdown", onOutside, true);
  }, 0);
}

function onRowContextMenu(e: MouseEvent, i: number): void {
  e.preventDefault();
  void openMenu(i, e.clientX, e.clientY);
}

async function openMenuForIndex(i: number): Promise<void> {
  const rect = document.getElementById(rowId(i))?.getBoundingClientRect();
  await openMenu(i, (rect?.left ?? 0) + 24, rect?.bottom ?? 0);
}

let outsideTimer: ReturnType<typeof setTimeout> | null = null;
function clearOutsideTimer(): void {
  if (outsideTimer !== null) clearTimeout(outsideTimer);
  outsideTimer = null;
}

function closeMenu(refocus = true): void {
  clearOutsideTimer();
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
  if (e.key === "Tab") {
    e.preventDefault();
    closeMenu();
  } else if (e.key === "Escape") {
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

// The menu is `position: fixed`: it must not outlive a scroll.
function onTreeScroll(): void {
  if (menu.value) closeMenu(false);
}

onBeforeUnmount(() => {
  clearOutsideTimer();
  window.removeEventListener("pointerdown", onOutside, true);
});
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
      @scroll="onTreeScroll"
      @wheel.passive="onTreeScroll"
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
