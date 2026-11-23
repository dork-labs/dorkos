/** Codex settings publication for ordinary sessions and exact acknowledged drafts. */
import { isDeepStrictEqual } from 'node:util';
import type { SessionSettingsPort, SessionUpdateResult } from '@dorkos/shared/agent-runtime';
import { tightensDeclaredMode } from '@dorkos/shared/permission-semantics';
import type { SessionSettings } from '@dorkos/shared/types';
import { savePreparedSettings } from '../../../core/runtime-seam/prepared-settings-write.js';
import { CODEX_CAPABILITIES } from '../runtime-constants.js';
import type { CodexSessionRegistry } from '../session-registry.js';

/** Persist the explicit choices before publishing them to the current local registry. */
export async function updateCodexSessionSettings(
  registry: CodexSessionRegistry,
  id: string,
  opts: SessionSettings,
  port: SessionSettingsPort | undefined,
  owner: { isTurnOpen: () => boolean; ownsDraft?: () => boolean }
): Promise<SessionUpdateResult> {
  const prior = registry.get(id);
  const ownsDraft = owner.ownsDraft;
  if (!ownsDraft) await port?.saveSessionSettings(id, opts);
  const patch = {
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
  };
  if (ownsDraft)
    return savePreparedSettings(id, opts, port, {
      isCurrent: () => ownsDraft() && isDeepStrictEqual(registry.get(id), prior),
      publish: () => {
        registry.register(id, patch);
        return undefined;
      },
    });

  registry.register(id, patch);
  const modes = CODEX_CAPABILITIES.permissionModes;
  const pending =
    opts.permissionMode !== undefined &&
    owner.isTurnOpen() &&
    tightensDeclaredMode(
      modes.values ?? [],
      prior?.permissionMode ?? modes.default ?? 'default',
      opts.permissionMode
    );
  return { updated: true, ...(pending ? { permissionModePendingUntilNextTurn: true } : {}) };
}
