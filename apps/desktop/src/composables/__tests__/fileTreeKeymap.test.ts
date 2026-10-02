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
        got = resolveFileTreeShortcut(e as KeyboardEvent, at(0));
      });
      el.dispatchEvent(kd("ArrowDown"));
      expect(got).toBeNull();
      el.remove();
    }
  });
});
