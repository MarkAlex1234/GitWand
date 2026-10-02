/**
 * useTreeScopeRoot — the File Explorer panel's tree root under the workspace
 * scope (v3.11.2).
 *
 * Lifted from the Browse view (FilesView.vue, removed in the same release).
 * With a scope active the tree is rooted at the scope folder. A root that
 * fails to list is either gone or merely unreadable: only a folder that no
 * longer exists clears the scope (spec §8), and an unreadable one keeps it,
 * so the tree shows its error row with Retry.
 *
 * One addition the keyed Browse view never needed: the panel lives in a
 * KeepAlive and is not remounted on a repo switch, so an existence check that
 * resolves after the switch must not clear the next repo's scope.
 */
import { computed, ref, watch, type Ref } from "vue";
import { useWorkspaceScope } from "./useWorkspaceScope";
import { pathExists } from "../utils/backend";

export function useTreeScopeRoot(repoPath: Readonly<Ref<string>>) {
  const { activeScope, setScope, clearScope } = useWorkspaceScope();
  const root = computed(() => activeScope.value ?? "");
  const goneScope = ref<string | null>(null);

  watch(repoPath, () => {
    goneScope.value = null;
  });

  async function onRootError(): Promise<void> {
    const scope = root.value;
    const repo = repoPath.value;
    if (!scope || !repo) return;
    let exists = false;
    try {
      exists = await pathExists(repo, scope);
    } catch {
      exists = false;
    }
    if (exists || root.value !== scope || repoPath.value !== repo) return;
    goneScope.value = scope;
    await clearScope();
  }

  async function scopeHere(path: string): Promise<void> {
    goneScope.value = null;
    await setScope(path);
  }

  async function wholeRepo(): Promise<void> {
    goneScope.value = null;
    await clearScope();
  }

  return { root, goneScope, onRootError, scopeHere, wholeRepo };
}
