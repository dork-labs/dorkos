/** Check host targets before acquiring any Codex process, including a warm one. */
import { protectedPathRoots } from '../../shared/policy/protected-path-roots.js';
import { codexProtectedConfig } from '../policy/protected-profile.js';
import { reconcileMountTargets } from '../policy/reconcile-mount-targets.js';
import { refuseMissingWritableTargets } from '../policy/writable-missing-targets.js';
import { prepareProjectFolders } from '../policy/prepare-project-folders.js';
import type { CodexTurnRequest } from './codex-transport.js';

/** Fake-host tests have no native mounts; production always checks them. */
export async function prepareCodexFilePolicy(request: CodexTurnRequest, mountTargets?: false) {
  const policy = request.tools.filePolicy ?? {
    roots: protectedPathRoots(request.cwd),
    writable: [],
  };
  if (process.platform === 'linux' && mountTargets !== false) {
    await reconcileMountTargets(policy.roots.data);
    if (['bypassPermissions', 'acceptEdits'].includes(request.settings.permissionMode ?? '')) {
      prepareProjectFolders(policy);
      codexProtectedConfig(request.cwd, policy, request.settings, (targets) =>
        refuseMissingWritableTargets(request.settings, targets, policy)
      );
    }
  }
  return policy;
}
