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
