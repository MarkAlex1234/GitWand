// @vitest-environment jsdom
/**
 * useTreeScopeRoot — the File Explorer panel's tree root under a workspace
 * scope. `utils/backend` is the IPC wrapper stand-in (pathExists and the
 * workspace file), not a git one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { effectScope, nextTick, ref, type EffectScope } from "vue";

vi.mock("../../utils/backend", () => ({
  pathExists: vi.fn(async () => false),
  workspaceRead: vi.fn(async () => {
    throw new Error("no workspace file");
  }),
  workspaceWrite: vi.fn(async () => {}),
}));

import { pathExists } from "../../utils/backend";
import { useTreeScopeRoot } from "../useTreeScopeRoot";
import { useWorkspaceScope } from "../useWorkspaceScope";

let scope: EffectScope | null = null;
function setup(repo = "/repo") {
  const repoPath = ref(repo);
  scope = effectScope();
  const s = scope.run(() => useTreeScopeRoot(repoPath))!;
  return { repoPath, s };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(pathExists).mockReset().mockResolvedValue(false);
  useWorkspaceScope().activeScope.value = null;
});
afterEach(() => {
  scope?.stop();
  scope = null;
  useWorkspaceScope().activeScope.value = null;
});

describe("useTreeScopeRoot", () => {
  it("roots the tree at the active scope, and at the repo without one", () => {
    const { s } = setup();
    expect(s.root.value).toBe("");
    useWorkspaceScope().activeScope.value = "packages/core";
    expect(s.root.value).toBe("packages/core");
  });

  it("clears a scope whose folder is gone and names it", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    const { s } = setup();
    await s.onRootError();
    expect(pathExists).toHaveBeenCalledWith("/repo", "gone");
    expect(useWorkspaceScope().activeScope.value).toBeNull();
    expect(s.goneScope.value).toBe("gone");
  });

  it("keeps a scope whose folder exists but failed to list", async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    useWorkspaceScope().activeScope.value = "locked";
    const { s } = setup();
    await s.onRootError();
    expect(useWorkspaceScope().activeScope.value).toBe("locked");
    expect(s.goneScope.value).toBeNull();
  });

  it("treats a failed existence check as gone", async () => {
    vi.mocked(pathExists).mockRejectedValue(new Error("ipc down"));
    useWorkspaceScope().activeScope.value = "gone";
    const { s } = setup();
    await s.onRootError();
    expect(useWorkspaceScope().activeScope.value).toBeNull();
  });

  it("never clears the scope of a repo switched to while the check was in flight", async () => {
    const check = deferred<boolean>();
    vi.mocked(pathExists).mockReturnValueOnce(check.promise);
    useWorkspaceScope().activeScope.value = "gone";
    const { s, repoPath } = setup();
    const pending = s.onRootError();
    repoPath.value = "/other";
    await nextTick();
    check.resolve(false);
    await pending;
    expect(useWorkspaceScope().activeScope.value).toBe("gone");
    expect(s.goneScope.value).toBeNull();
  });

  it("Scope here and Whole repo set and clear the scope, and drop the notice", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    const { s } = setup();
    await s.onRootError();
    expect(s.goneScope.value).toBe("gone");
    await s.scopeHere("src");
    expect(useWorkspaceScope().activeScope.value).toBe("src");
    expect(s.goneScope.value).toBeNull();
    await s.wholeRepo();
    expect(useWorkspaceScope().activeScope.value).toBeNull();
  });

  it("drops the notice on a repo switch", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    const { s, repoPath } = setup();
    await s.onRootError();
    repoPath.value = "/other";
    await nextTick();
    expect(s.goneScope.value).toBeNull();
  });
});
