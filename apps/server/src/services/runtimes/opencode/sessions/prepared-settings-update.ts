/** OpenCode-owned settings hydration and birth-only post-commit publication. */
import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import {
  PreparedSettingsWriteError,
  stageSettingsPublication,
} from '../../../core/runtime-seam/prepared-settings-write.js';
import { openCodeSettingsPatch } from './session-settings.js';
import type { OpenCodeSessionPatch, OpenCodeSessionRegistry } from './session-registry.js';

/** Stage only the exact local record and known native-identity absence, with no sidecar lookup. */
export async function prepareOpenCodeSettingsUpdate(
  registry: OpenCodeSessionRegistry,
  sessionId: string,
  explicit: OpenCodeSessionPatch,
  port: SessionSettingsPort | undefined,
  ownsUnboundIdentity: () => boolean
): Promise<void> {
  if (
    !port ||
    [explicit.permissionMode, explicit.model, explicit.fastMode].every(
      (value) => value === undefined
    )
  )
    throw new PreparedSettingsWriteError();
  const owner = registry.prepareSettingsOwner(sessionId);
  if (!owner.isCurrent() || !ownsUnboundIdentity()) throw new PreparedSettingsWriteError();
  const persisted = owner.tracked ? null : await port.getSessionSettings(sessionId);
  const patch = openCodeSettingsPatch(owner.tracked, persisted, explicit);
  stageSettingsPublication(sessionId, {
    isCurrent: () => owner.isCurrent() && ownsUnboundIdentity(),
    publish: () => {
      registry.register(sessionId, patch);
      return undefined;
    },
  });
}
