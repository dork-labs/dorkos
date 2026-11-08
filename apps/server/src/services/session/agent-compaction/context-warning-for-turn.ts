/** Resolve the rare context warning without growing the turn orchestrator. */
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { takeContextWarning, restoreContextWarning } from './context-warning.js';
import { isCompactionBlocked } from './compaction-permission.js';

/** Take the warning and name the summary tool only when it can work. */
export async function takeContextWarningForTurn(
  bag: AdditionalContext,
  key: string,
  capabilities: RuntimeCapabilities,
  home?: string
): Promise<number | null> {
  const percent = takeContextWarning(key);
  try {
    if (percent !== null && !capabilities.nativeContext.includes('context_warning')) {
      const canCompact =
        capabilities.commandIntents.compact.supported && !(await isCompactionBlocked(home));
      bag.push({ kind: 'context_warning', scope: 'per-turn', data: { percent, canCompact } });
    }
    return percent;
  } catch (err) {
    if (percent !== null) restoreContextWarning(key, percent);
    throw err;
  }
}
