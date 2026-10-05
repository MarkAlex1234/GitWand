/**
 * Parity tests: `list_repo_dir` (Rust) vs `/api/list-repo-dir` (Node dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * Prerequisite: the Rust probe must be built at least once
 *   cargo build --example parity-probe
 * (see README.md in this folder).
 *
 * The two backends answer "is this ignored?" by different means. Rust asks
 * libgit2 in process (`is_path_ignored`, then an index lookup so a tracked
 * path under a rule is not ignored); the dev-server makes one
 * `git check-ignore -z --stdin` call. Two mechanisms for one answer is exactly
 * what drifts, so every classification the Files view shows is pinned here,
 * on a repo whose own path has a space and a non-ASCII character. Refusals are
 * pinned too: the tree shows their message on an error row.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { fixtureListRepoDir } from "./fixtures.mjs";

const HAS_SYMLINK = process.platform !== "win32";

/** POST /api/list-repo-dir, returning the same {ok, value, error} shape as runProbe. */
async function nodeListRepoDir(dev, body) {
  const res = await dev.fetch("/api/list-repo-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

function listing(dev, cwd, dir, includeIgnored) {
  const args = { cwd, dir, includeIgnored };
  return assertParity(dev, {
    command: "list-repo-dir",
    args,
    httpPath: "/api/list-repo-dir",
    method: "POST",
    body: args,
  });
}

async function bothRefuse(dev, cwd, dir) {
  const args = { cwd, dir, includeIgnored: false };
  const rust = runProbe("list-repo-dir", args);
  const node = await nodeListRepoDir(dev, args);
  expect(rust.ok, `rust accepted ${dir}`).toBe(false);
  expect(node.ok, `node accepted ${dir}`).toBe(false);
  return { rust: rust.error, node: node.error };
}

describe("parity: list-repo-dir", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("the root without ignored entries is identical, sorted directories first", async () => {
    const cwd = fixtureListRepoDir();
    const { rust } = await listing(dev, cwd, "", false);
    expect(rust.entries.map((e) => e.name)).toEqual([
      "build", "docs", "src",
      ".gitignore", "alpha.txt", "café.txt", "forced.log",
      ...(HAS_SYMLINK ? ["link-out"] : []),
      "Readme.md", "Zeta.txt",
    ]);
    expect(rust.truncated).toBe(false);
  });

  it("the root with ignored entries flags exactly the untracked ones", async () => {
    const cwd = fixtureListRepoDir();
    const { rust } = await listing(dev, cwd, "", true);
    const ignored = Object.fromEntries(rust.entries.map((e) => [e.name, e.ignored]));
    expect(ignored["node_modules"]).toBe(true);
    expect(ignored["debug.log"]).toBe(true);
    expect(ignored["build"]).toBe(false); // holds a tracked file
    expect(ignored["forced.log"]).toBe(false); // tracked under a *.log rule
    expect(ignored["alpha.txt"]).toBe(false);
    if (HAS_SYMLINK) expect(rust.entries.find((e) => e.name === "link-out")?.kind).toBe("symlink");
  });

  it("inside an ignored directory, the tracked file is not ignored and the rest is", async () => {
    const cwd = fixtureListRepoDir();
    const { rust } = await listing(dev, cwd, "build", true);
    expect(rust.entries.map((e) => [e.path, e.ignored])).toEqual([
      ["build/keep.txt", false],
      ["build/out.bin", true],
    ]);
  });

  it("a name with a space keeps it in its repo-relative path", async () => {
    const cwd = fixtureListRepoDir();
    const { rust } = await listing(dev, cwd, "docs", false);
    expect(rust.entries.map((e) => e.path)).toEqual(["docs/guide one.md"]);
  });

  it("a missing directory, a file and .git are refused with the same message", async () => {
    const cwd = fixtureListRepoDir();
    for (const [dir, message] of [
      ["gone", "Directory not found: gone"],
      ["Readme.md", "Not a directory: Readme.md"],
      [".git", "Refusing to list inside .git: .git"],
    ]) {
      const { rust, node } = await bothRefuse(dev, cwd, dir);
      expect(rust).toBe(message);
      expect(node).toBe(message);
    }
  });

  it("a path escaping the repo, directly or through a symlink, is refused by both", async () => {
    const cwd = fixtureListRepoDir();
    const dirs = ["../..", ...(HAS_SYMLINK ? ["link-out"] : [])];
    for (const dir of dirs) {
      const { rust, node } = await bothRefuse(dev, cwd, dir);
      expect(rust).toMatch(/^path escapes cwd/);
      expect(node).toMatch(/^path escapes cwd/);
    }
  });
});
