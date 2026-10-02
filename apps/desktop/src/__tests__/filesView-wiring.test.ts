/**
 * App.vue call sites of the Files view (v3.11.2). Each is optional to the
 * type-checker (a prop, a palette id, a menu action), so forgetting one
 * type-checks and silently removes an entry point, which is how MergeEditor's
 * `cwd` went missing in v3.11.1 (see mergeEditor-cwd-wiring.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appVue = readFileSync(resolve(__dirname, "../App.vue"), "utf-8");

describe("App.vue — Files view wiring", () => {
  it("lazy-loads FilesView", () => {
    expect(appVue).toMatch(/const FilesView = defineAsyncComponent\(\(\) => import\("\.\/components\/FilesView\.vue"\)\)/);
  });

  it("renders it for viewMode 'files' with the repo files and the live watcher", () => {
    const branch = appVue.match(/v-else-if="viewMode === 'files'"[\s\S]*?<FilesView\b[\s\S]*?\/>/)?.[0];
    expect(branch, "no FilesView branch for viewMode 'files'").toBeTruthy();
    expect(branch).toMatch(/:repo-files="repoFiles"/);
    expect(branch).toMatch(/:watcher="repoWatcher"/);
    // The tree model and the preview read repo/watcher once at setup, so a repo
    // switch must remount FilesView.
    expect(branch).toMatch(/:key="repoFolderPath/);
    expect(branch).toMatch(/@open-in-editor="handleOpenInEditor"/);
    expect(branch).toMatch(/@open-merge-editor="handleOpenResidual"/);
  });

  it("offers it in the palette and the native menu", () => {
    expect(appVue).toMatch(/id: "view-files"/);
    expect(appVue).toMatch(/case "view-files": viewMode\.value = "files"; break;/);
    expect(appVue).toMatch(/openFilesView: \(\) =>/);
  });

  it("maps the startup dock entry through dockEntryViewMode", () => {
    expect(appVue).toMatch(/viewMode\.value = dockEntryViewMode\(first\)/);
  });
});
