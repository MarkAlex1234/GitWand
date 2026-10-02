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
});
