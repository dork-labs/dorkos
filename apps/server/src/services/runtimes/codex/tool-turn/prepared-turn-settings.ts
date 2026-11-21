/** Prepared Codex settings and the active choice before its per-turn ceiling. */
import type {
  MessageOpts,
  SessionSettingsPort,
  RuntimeCapabilities,
} from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/types';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import type { CodexSessionRegistry } from '../session-registry.js';
import { chosenModeWithinOwnBounds } from '../../../core/turn-power/full-autonomy.js';

/** Resolve once for the actual turn, never by rereading next-turn registry settings. */
export async function prepareCodexTurnSettings(
  registry: CodexSessionRegistry,
  settingsPort: SessionSettingsPort | undefined,
  modes: RuntimeCapabilities['permissionModes'],
  sessionId: string,
  opts?: MessageOpts
): Promise<{ settings: SessionSettings; chosenMode: string | undefined }> {
  if (!registry.has(sessionId)) {
    const persisted = await settingsPort?.getSessionSettings(sessionId);
    registry.register(sessionId, {
      permissionMode: opts?.permissionMode ?? persisted?.permissionMode ?? 'default',
      ...(persisted?.model !== undefined ? { model: persisted.model } : {}),
      ...(persisted?.effort !== undefined ? { effort: persisted.effort } : {}),
      ...(persisted?.fastMode !== undefined ? { fastMode: persisted.fastMode } : {}),
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
  }
  const tracked = registry.get(sessionId)!;
  const model = opts?.model ?? tracked.model;
  const effort = opts?.effort ?? tracked.effort;
  const fastMode = opts?.fastMode ?? tracked.fastMode;
  // A chat that follows its agent up starts from the agent's level this turn
  // (DOR-3175); the tracked mode is left as it was.
  const chosen = opts?.levelPermissionMode ?? opts?.permissionMode ?? tracked.permissionMode;
  return {
    chosenMode: chosenModeWithinOwnBounds(modes, chosen, opts?.permissionCeiling),
    settings: {
      // Apply an explicit per-turn ceiling without rewriting the session's chosen mode.
      permissionMode:
        opts?.permissionCeiling !== undefined
          ? clampModeToCeiling(modes, chosen, opts.permissionCeiling)
          : chosen,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    },
  };
}
