<script setup lang="ts">
/**
 * FilePreviewPane — the Files view's read-only preview (v3.11.2).
 *
 * Presentation only: what to show is `useFilePreview`'s decision (spec §7).
 * Unchanged files render in a read-only CodeEditor; changed files in the
 * inline DiffViewer, never editable or selectable from here.
 */
import { computed, ref, toRef } from "vue";
import CodeEditor from "./CodeEditor.vue";
import DiffViewer from "./DiffViewer.vue";
import { useI18n } from "../composables/useI18n";
import { formatBytes, useFilePreview, type PreviewTarget } from "../composables/useFilePreview";
import type { TreeWatcher } from "../composables/useLazyRepoTree";
import { getGitDiff, readFileAtRevision } from "../utils/backend";
import { revealLabelKey } from "../utils/revealLabel";
import type { DiffMode } from "../utils/diffMode";

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
  "open-file-history": [path: string];
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
/** DiffViewer's own header toggle; the preview starts inline, like the Changes view. */
const diffMode = ref<DiffMode>("inline");

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
      <DiffViewer
        v-else-if="body.kind === 'diff'"
        v-model:diff-mode="diffMode"
        :diff="body.diff"
        :file-path="target.path"
        @open-in-editor="(p: string) => emit('open-in-editor', p)"
        @open-file-history="(p: string) => emit('open-file-history', p)"
      />
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
