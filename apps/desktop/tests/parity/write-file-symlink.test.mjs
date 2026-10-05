/**
 * `/api/write-file` (dev-server) must not write through a symlink that does
 * not resolve: writing through a dangling one creates its target, wherever it
 * points, including outside the repository. The Rust `write_file` has the
 * same guard (`files.rs`, `write_file_tests`); the parity probe does not
 * expose `write_file`, so this side is checked against the dev-server only.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { mkTempRepo } from "./fixtures.mjs";

describe("dev-server: write-file and symlinks", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);
  afterAll(async () => {
    await dev?.stop();
  });

  const write = (cwd, path) =>
    dev.fetch("/api/write-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, path, content: "new" }),
    });

  it("refuses a dangling symlink and creates nothing outside the repo", async () => {
    const cwd = mkTempRepo("gw-write-dangling-");
    const out = `${cwd}-out`;
    mkdirSync(out);
    try {
      symlinkSync(join(out, "newfile"), join(cwd, "danglingleaf"));
      const res = await write(cwd, "danglingleaf");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "refusing to write through a symlink that does not resolve: danglingleaf",
      );
      expect(existsSync(join(out, "newfile"))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses paths below a dangling symlink or after `..` through a link", async () => {
    const cwd = mkTempRepo("gw-write-below-");
    const out = `${cwd}-out`;
    mkdirSync(join(out, "sub"), { recursive: true });
    try {
      symlinkSync(join(out, "nope"), join(cwd, "dangling"));
      symlinkSync(join(out, "sub"), join(cwd, "linkdir"));
      for (const path of ["dangling/x", "linkdir/../x", "linkdir/x"]) {
        const res = await write(cwd, path);
        expect(res.status, path).toBe(400);
      }
      expect(existsSync(join(out, "nope"))).toBe(false);
      expect(existsSync(join(out, "x"))).toBe(false);
      expect(existsSync(join(out, "sub", "x"))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("still writes a plain file and through a symlink to a file in the repo", async () => {
    const cwd = mkTempRepo("gw-write-ok-");
    writeFileSync(join(cwd, "t.txt"), "old");
    symlinkSync(join(cwd, "t.txt"), join(cwd, "l.txt"));
    expect((await write(cwd, "l.txt")).status).toBe(200);
    expect(readFileSync(join(cwd, "t.txt"), "utf-8")).toBe("new");
    expect((await write(cwd, "fresh.txt")).status).toBe(200);
    expect(readFileSync(join(cwd, "fresh.txt"), "utf-8")).toBe("new");
  });
});
