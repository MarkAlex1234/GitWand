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

const last = <T,>(a: T[]): T | undefined => a[a.length - 1];
const tree = () => container.querySelector<HTMLElement>("[role=tree]")!;
const items = () => [...container.querySelectorAll<HTMLElement>("[role=treeitem]")];
const menuLabels = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].map((b) => b.textContent?.trim());
function key(k: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  tree().dispatchEvent(e);
  return e;
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
    expect(last(events)).toEqual(["select", "docs", "folder"]);
    key("ArrowUp");
    key("ArrowLeft");
    expect(last(events)).toEqual(["select", "src", "folder"]);
  });

  it("Enter toggles a folder", async () => {
    const events = await mount({ selectedPath: "docs" });
    key("Enter");
    expect(last(events)).toEqual(["toggle", "docs"]);
  });

  it("clicking an error row retries its folder", async () => {
    const events = await mount();
    items()[2]!.click();
    expect(last(events)).toEqual(["retry", "src/lib"]);
  });

  it("leaves the cursor alone when type-ahead finds nothing and there is no cursor", async () => {
    const events = await mount();
    const e = key("z");
    expect(e.defaultPrevented).toBe(true);
    expect(events).toEqual([]);
    expect(tree().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("does not swallow keys the tree has no use for", async () => {
    await mount({ selectedPath: "docs" });
    expect(key("k", { metaKey: true }).defaultPrevented).toBe(false);
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
    expect(last(events)).toEqual(["scope-here", "src"]);
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
    expect(last(events)).toEqual(["copy-path", "src/a.ts"]);
  });
});

describe("FileTreePane — context menu lifecycle", () => {
  async function openOnFolder() {
    const events = await mount();
    items()[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await nextTick();
    await new Promise((r) => setTimeout(r, 5)); // let the outside-click listener register
    expect(document.querySelector("[role=menu]")).not.toBeNull();
    return events;
  }
  const menuOpen = () => document.querySelector("[role=menu]") !== null;
  const closed = async () => {
    await nextTick();
    return !menuOpen();
  };

  it("closes on Escape", async () => {
    await openOnFolder();
    document.querySelector("[role=menuitem]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await closed()).toBe(true);
  });

  it("closes on an outside pointerdown", async () => {
    await openOnFolder();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(await closed()).toBe(true);
  });

  it("closes on Tab and gives the keyboard back to the tree", async () => {
    await openOnFolder();
    document.querySelector("[role=menuitem]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(await closed()).toBe(true);
    key("ArrowDown");
    expect(tree().getAttribute("aria-activedescendant")).not.toBeNull();
  });

  it("closes when the tree scrolls", async () => {
    await openOnFolder();
    tree().dispatchEvent(new Event("scroll"));
    expect(await closed()).toBe(true);
  });

  it("registers no pointerdown listener after unmounting right after opening", async () => {
    const calls: Array<"add" | "remove"> = [];
    const add = vi.spyOn(window, "addEventListener").mockImplementation(((t: string) => {
      if (t === "pointerdown") calls.push("add");
    }) as typeof window.addEventListener);
    const rem = vi.spyOn(window, "removeEventListener").mockImplementation(((t: string) => {
      if (t === "pointerdown") calls.push("remove");
    }) as typeof window.removeEventListener);
    try {
      await mount({ selectedPath: "src/a.ts" });
      key("F10", { shiftKey: true });
      await nextTick();
      app!.unmount();
      app = null;
      const atUnmount = calls.length;
      await new Promise((r) => setTimeout(r, 5)); // run the pending timers
      // Order-aware: nothing may be added once the component is gone, and the net count is 0.
      expect(calls.slice(atUnmount)).not.toContain("add");
      expect(calls.filter((c) => c === "add").length - calls.filter((c) => c === "remove").length).toBeLessThanOrEqual(0);
    } finally {
      add.mockRestore();
      rem.mockRestore();
    }
  });
});

describe("FileTreePane — Show ignored", () => {
  it("emits the new value", async () => {
    const events = await mount();
    const box = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(last(events)).toEqual(["update:showIgnored", true]);
  });
});
