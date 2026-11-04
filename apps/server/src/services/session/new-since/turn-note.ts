/** Keep identity resolution and claim restoration outside the turn orchestrator. */
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import {
  homeOf,
  readHomeManifest,
  resolveAgentHome,
  turnAgentOf,
} from '../../core/agent-identity/index.js';
import { seenVersions } from './seen-versions.js';

/** Take an ordinary agent turn's note and return its settlement callback. */
export async function takeNewSinceForTurn(
  bag: AdditionalContext,
  cwd: string | undefined,
  turn: {
    forAgent?: string;
    roomTurn?: { agentPath?: string };
    clientId: string;
    unattended?: boolean;
  }
): Promise<(delivered?: boolean) => void> {
  const store = seenVersions();
  if (!store || turn.clientId === 'todos' || turn.unattended) return () => {};
  const home = homeOf(resolveAgentHome(cwd, turnAgentOf(turn)));
  const manifest = home ? await readHomeManifest(home) : null;
  const claim = manifest ? store.takeNewSince(manifest.id) : null;
  if (!claim) return () => {};
  bag.push({ kind: 'new_since_last_run', scope: 'per-turn', data: claim.data });
  return (delivered = false) => {
    if (delivered) store.delivered(claim);
    else store.restoreNewSince(claim);
  };
}
