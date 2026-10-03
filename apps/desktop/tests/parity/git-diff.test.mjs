/**
 * Parity tests: `git_diff` (Rust) vs `/api/git-diff` (Node dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * Prerequisite: the Rust probe must be built at least once
 *   cargo build --example parity-probe
 * (see README.md in this folder).
 *
 * Two things are guarded here, both of which have already drifted once:
 *
 *  - The v3.10.0 libgit2 fast path must be indistinguishable from the CLI
 *    output the dev-server produces.
 *  - The *directory* branch lived only in the dev-server for several
 *    releases, so clicking an untracked folder worked under `dev:web` and
 *    showed an empty panel in the packaged app (issue #183). It also has to
 *    keep short-circuiting ahead of the libgit2 path, which cannot diff a
 *    directory.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { commitFile, fixtureDiff, fixtureUntrackedDirs, mkTempRepo } from "./fixtures.mjs";

describe("parity: git-diff", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("unstaged edit produces identical hunks", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "a.txt", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=a.txt&staged=false`,
    });
  });

  it("staged edit produces identical hunks", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "b.txt", staged: true },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=b.txt&staged=true`,
    });
  });

  it("clean file produces no hunks on either side", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "b.txt", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=b.txt&staged=false`,
    });
  });

  describe("on a directory", () => {
    it("a plain untracked folder lists the files inside it", async () => {
      const cwd = fixtureUntrackedDirs();
      const { rust, node } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "newdir/", staged: false },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("newdir/")}`,
      });

      for (const side of [rust, node]) {
        expect(side.isDirectory).toBe(true);
        expect(side.hunks).toEqual([]);
        expect([...side.newFiles].sort()).toEqual(["newdir/e.txt", "newdir/sub/f.txt"]);
        expect(side.nestedRepo).toBeUndefined();
      }
    });

    it("a nested git repo is reported as such, with no file list", async () => {
      const cwd = fixtureUntrackedDirs();
      const { rust, node } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "inner/", staged: false },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("inner/")}`,
      });

      for (const side of [rust, node]) {
        expect(side.isDirectory).toBe(true);
        expect(side.nestedRepo).toBe(true);
        // Its files belong to the other repo. Offering them here would produce
        // a row that reopens this same panel.
        expect(side.newFiles ?? []).toEqual([]);
      }
    });

    it("a modified file still produces a real diff", async () => {
      const cwd = fixtureUntrackedDirs();
      const { rust, node } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "README.md", staged: false },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("README.md")}`,
      });

      for (const side of [rust, node]) {
        expect(side.isDirectory).toBeUndefined();
        expect(side.nestedRepo).toBeUndefined();
        expect(side.hunks.length).toBeGreaterThan(0);
      }
    });

    // Regression for a second drift this file caught: the dev-server ran its
    // `--no-index` fallback on any path with an empty `git diff`, so a tracked
    // file with nothing to show came back as an all-green whole-file addition.
    // The Rust side has always guarded that with `ls-files --error-unmatch`.
    it("a tracked file with no change reports no hunks on either side", async () => {
      const cwd = fixtureUntrackedDirs();
      const { rust, node } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "tracked.txt", staged: false },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("tracked.txt")}`,
      });

      expect(rust.hunks).toEqual([]);
      expect(node.hunks).toEqual([]);
    });
  });

  // The untracked fallback runs `git diff --no-index -- /dev/null <path>`,
  // which reads any file it is handed. Neither backend validated `path`, so
  // `../secret` rendered a file outside the repository.
  describe("path boundary", () => {
    const SECRET = "outside-secret-content";

    it("a `../` or absolute path outside the repo is refused by both, with the same message", async () => {
      const cwd = mkTempRepo("gw-parity-diff-escape-");
      commitFile(cwd, "a.txt", "a\n", "init", 0);
      const outside = join(cwd, "..", `${basename(cwd)}-outside.txt`);
      writeFileSync(outside, `${SECRET}\n`);
      try {
        for (const path of [`../${basename(outside)}`, outside]) {
          const rust = runProbe("git-diff", { cwd, path, staged: false });
          const res = await dev.fetch(
            `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&staged=false`,
          );
          const node = await res.json();

          expect(rust.ok, `rust must not diff ${path}`).toBe(false);
          expect(res.status, `node must refuse ${path}`).toBe(400);
          expect(rust.error).toMatch(/^path escapes cwd/);
          expect(node.error).toBe(rust.error);
          expect(JSON.stringify(node)).not.toContain(SECRET);
        }
      } finally {
        rmSync(outside, { force: true });
      }
    });

    it("a deleted file whose directory is gone still diffs identically", async () => {
      const cwd = mkTempRepo("gw-parity-diff-deleted-");
      commitFile(cwd, "old/deep/gone.txt", "bye\n", "init", 0);
      rmSync(join(cwd, "old"), { recursive: true });
      const { rust, node } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "old/deep/gone.txt", staged: false },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("old/deep/gone.txt")}&staged=false`,
      });
      for (const side of [rust, node]) {
        expect(side.hunks).toHaveLength(1);
        expect(side.hunks[0].lines.every((l) => l.type === "delete")).toBe(true);
      }
    });
  });
});
