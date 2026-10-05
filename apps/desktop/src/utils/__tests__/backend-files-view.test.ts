/**
 * v3.11.2 Files view — IPC wrappers. Locks the argument names each backend
 * receives (Tauri converts `includeIgnored` to the Rust `include_ignored`)
 * and that a dev-server refusal surfaces the server's own message, which the
 * tree shows on its error row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const devFetch = vi.fn();
const tauriInvoke = vi.fn();
let tauri = false;

vi.mock("../backend-core", () => ({
  isTauri: () => tauri,
  devFetch: (...args: unknown[]) => devFetch(...args),
  tauriInvoke: (...args: unknown[]) => tauriInvoke(...args),
  DEV_SERVER: "http://localhost:3001",
  IPC_TIMEOUT: { NETWORK: 30000, DEFAULT: 10000 },
  devTerminalOpen: vi.fn(),
}));

function okRes(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}
function errRes(status: number, json: unknown) {
  return { ok: false, status, json: async () => json };
}

const LISTING = {
  entries: [{ name: "src", path: "src", kind: "dir", ignored: false, size: 0 }],
  truncated: false,
};

describe("listRepoDir", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("invokes list_repo_dir with camelCase arguments under Tauri", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue(LISTING);
    const { listRepoDir } = await import("../backend");
    await expect(listRepoDir("/repo", "src", true)).resolves.toEqual(LISTING);
    expect(tauriInvoke).toHaveBeenCalledWith("list_repo_dir", {
      cwd: "/repo",
      dir: "src",
      includeIgnored: true,
    });
  });

  it("POSTs to /api/list-repo-dir under the dev-server", async () => {
    devFetch.mockResolvedValue(okRes(LISTING));
    const { listRepoDir } = await import("../backend");
    await expect(listRepoDir("/repo", "", false)).resolves.toEqual(LISTING);
    expect(devFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/list-repo-dir",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cwd: "/repo", dir: "", includeIgnored: false }),
      }),
    );
  });

  it("throws the dev-server's own message on refusal", async () => {
    devFetch.mockResolvedValue(errRes(400, { error: "Directory not found: gone" }));
    const { listRepoDir } = await import("../backend");
    await expect(listRepoDir("/repo", "gone", false)).rejects.toThrow("Directory not found: gone");
  });
});

describe("revealInFileManager", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("invokes reveal_in_file_manager under Tauri", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue(undefined);
    const { revealInFileManager } = await import("../backend");
    await revealInFileManager("/repo", "src/a.ts");
    expect(tauriInvoke).toHaveBeenCalledWith("reveal_in_file_manager", { cwd: "/repo", path: "src/a.ts" });
  });

  it("POSTs to the dev-server and surfaces its refusal", async () => {
    devFetch.mockResolvedValue(errRes(400, { error: "Path not found: x" }));
    const { revealInFileManager } = await import("../backend");
    await expect(revealInFileManager("/repo", "x")).rejects.toThrow("Path not found: x");
    expect(devFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/reveal-in-file-manager",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ cwd: "/repo", path: "x" }) }),
    );
  });
});

describe("getGitDiff — Tauri path", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = true;
  });

  it("keeps the truncation marker the Rust command sends", async () => {
    tauriInvoke.mockResolvedValue({ path: "big.sql", hunks: [], truncatedFromBytes: 7_340_032 });
    const { getGitDiff } = await import("../backend");
    const diff = await getGitDiff("/repo", "big.sql", false);
    expect(diff.truncatedFromBytes).toBe(7_340_032);
  });

  it("keeps the directory, nested-repo, status and rename fields", async () => {
    tauriInvoke.mockResolvedValue({
      path: "vendor/",
      hunks: [],
      status: "renamed",
      oldPath: "old/",
      isDirectory: true,
      newFiles: ["vendor/a.txt"],
      nestedRepo: true,
    });
    const { getGitDiff } = await import("../backend");
    const diff = await getGitDiff("/repo", "vendor/", false);
    expect(diff).toMatchObject({
      status: "renamed",
      oldPath: "old/",
      isDirectory: true,
      newFiles: ["vendor/a.txt"],
      nestedRepo: true,
    });
  });

  it("still maps hunks from snake_case", async () => {
    tauriInvoke.mockResolvedValue({
      path: "a.ts",
      hunks: [{ header: "@@", old_start: 1, old_count: 1, new_start: 1, new_count: 1, lines: [{ type: "add", content: "x", new_line_no: 1 }] }],
    });
    const { getGitDiff } = await import("../backend");
    const diff = await getGitDiff("/repo", "a.ts", false);
    expect(diff.hunks[0]).toEqual({
      header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
      lines: [{ type: "add", content: "x", oldLineNo: undefined, newLineNo: 1 }],
    });
  });
});
