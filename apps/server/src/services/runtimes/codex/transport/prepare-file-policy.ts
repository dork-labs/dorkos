/** Check host targets before acquiring any Codex process, including a warm one. */
import { protectedPathRoots } from '../../shared/policy/protected-path-roots.js';
import { codexProtectedConfig } from '../policy/protected-profile.js';
import { reconcileMountTargets } from '../policy/reconcile-mount-targets.js';
import { refuseMissingFullTargets } from '../policy/full-missing-targets.js';
import type { CodexTurnRequest } from './codex-transport.js';

/** Fake-host tests have no native mounts; production always checks them. */
export async function prepareCodexFilePolicy(request: CodexTurnRequest, mountTargets?: false) {
  const policy = request.tools.filePolicy ?? {
    roots: protectedPathRoots(request.cwd),
    writable: [],
  };
  if (process.platform === 'linux' && mountTargets !== false) {
    await reconcileMountTargets(policy.roots.data);
    if (request.settings.permissionMode === 'bypassPermissions')
      codexProtectedConfig(request.cwd, policy, request.settings, (targets) =>
        refuseMissingFullTargets(request.settings, targets)
      );
  }
  return policy;
}
