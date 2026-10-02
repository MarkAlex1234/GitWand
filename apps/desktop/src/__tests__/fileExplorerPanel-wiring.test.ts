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
  it("hands conflicted files to the merge editor and history to the Changes view", () => {
    expect(panel).toMatch(/@open-merge-editor="\(p: string\) => \{ hideFilesOnHandoff\(\); handleOpenResidual\(p\); \}"/);
    expect(panel).toMatch(
      /@open-file-history="\(p: string\) => \{ hideFilesOnHandoff\(\); openFileHistory\(p\); viewMode = 'changes'; \}"/,
    );
    expect(appVue).toMatch(
      /function hideFilesOnHandoff\(\): void \{\n\s*if \(showFiles\.value && settings\.value\.filesHideOnNav\) showFiles\.value = false;/,
    );
  });

  it("is reachable from the command palette and the View menu, through the dock's own toggle", () => {
    // Browse's entries are gone; the panel's only other way in was the dock tile.
    expect(appVue).toMatch(/@toggle-files="toggleFiles\(\)"/);
    expect(appVue).toMatch(/\{ id: "toggle-file-explorer", label: t\("header\.paletteToggleFileExplorer"\) \}/);
    expect(appVue).toMatch(/case "toggle-file-explorer": toggleFiles\(\); break;/);
    expect(appVue).toMatch(/toggleFileExplorer: \(\) => toggleFiles\(\)/);
    const menu = readFileSync(resolve(__dirname, "../composables/useAppMenu.ts"), "utf-8");
    expect(menu).toMatch(/text: t\("menu\.toggleFileExplorer"\),\n\s*enabled: hasRepo,\n\s*action: \(\) => actions\.toggleFileExplorer\(\)/);
  });
});
