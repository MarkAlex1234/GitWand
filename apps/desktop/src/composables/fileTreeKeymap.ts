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
