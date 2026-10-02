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
    expect(DEFAULT_DOCK_ORDER[DEFAULT_DOCK_ORDER.length - 1]).toBe("files-view");
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
