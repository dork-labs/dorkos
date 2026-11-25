/** One actual permission/Auto launch decision, shared with its live facts handover. */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession } from '../agent-types.js';
import type { ClaudeToolLaunchSettings } from './live-tool-turn.js';
import { narrowToClaudeCodeMode } from '../runtime-constants.js';
import { turnPermissionMode } from '../turn-permission.js';
import { logger } from '../../../../lib/logger.js';
import {
  AUTO_DOWNGRADE_STATUS,
  UNKNOWN_MODE_STATUS,
  resolveEffectivePermissionMode,
} from '../messaging/permission-mode-guard.js';

/** Apply the decision actually sent to the SDK and retain its exact input evidence. */
export function prepareClaudeLaunchPermission(
  session: AgentSession,
  sdkOptions: Options,
  context: {
    sessionId: string;
    modelSupportsAutoMode: boolean | undefined;
    launchModel: string | undefined;
    statusEvents: StreamEvent[];
  }
): ClaudeToolLaunchSettings & { sdkPermissionMode: NonNullable<Options['permissionMode']> } {
  const { sessionId, modelSupportsAutoMode, launchModel, statusEvents } = context;
  // Reconcile the permission mode against the active model: `'auto'` only works on
  // models KNOWN to support it, so coerce it to `'default'` here (the runtime is the
  // authoritative chokepoint) rather than letting the SDK 400. This is a per-query
  // coercion only — we deliberately do NOT mutate `session.permissionMode`, so the
  // operator's Auto choice isn't silently destroyed: the displayed mode stays honest,
  // the status note fires each send the model can't be trusted with Auto, and Auto
  // resumes automatically once it can be. The note's wording follows the REASON —
  // an unconfirmed model must not be described as one that lacks Auto.
  //
  // The session's own id is checked into the SDK's vocabulary FIRST, because a
  // mode id is whatever its runtime declared (DOR-885): the session may be
  // sitting in one this runtime has since retired, or in one only another
  // runtime ever offered, and a name the SDK has never heard of fails the entire
  // turn with a 400. `'default'` — ask about everything — is the only safe
  // reading of a mode nothing here can weigh.
  //
  // And it is announced, for the same reason the auto downgrade below is: this
  // coercion is per query and never rewrites `session.permissionMode`, so the
  // panel keeps showing the saved mode while the agent asks about everything.
  // Silence there is the whole complaint — a person watching it ask would have
  // no way to learn why. The note is user-facing and says what changes for them;
  // the log line beside it carries the id, which is the half a person cannot use
  // and an operator reading logs needs.
  //
  // The turn's ceiling is applied FIRST, for the same reason and in the same
  // per-query way: a turn another agent's post or a stranger's message started
  // runs no looser than its sender, and the session's own choice is never
  // rewritten (spec `trusted-by-default-flip` §4). On a warm process the mode
  // this resolves is what the fingerprint compares, so the live process is moved
  // down for this turn and back up for the next one.
  const turnMode = turnPermissionMode(session);
  const declaredMode = narrowToClaudeCodeMode(turnMode, 'default');
  if (declaredMode !== turnMode) {
    logger.warn('[sendMessage] saved permission mode is not one this runtime offers', {
      session: sessionId,
      stored: turnMode,
      running: declaredMode,
    });
    statusEvents.push({ type: 'system_status', data: { message: UNKNOWN_MODE_STATUS } });
  }
  const { permissionMode: effectivePermissionMode, autoDowngrade } = resolveEffectivePermissionMode(
    {
      permissionMode: declaredMode,
      modelSupportsAutoMode,
    }
  );
  if (autoDowngrade) {
    statusEvents.push({
      type: 'system_status',
      data: { message: AUTO_DOWNGRADE_STATUS[autoDowngrade] },
    });
  }
  // Which model Auto is confirmed for, recorded for what reads the mode this
  // turn REALLY runs at (the `session_start` ceiling): the coercion above leaves
  // `session.permissionMode` at `'auto'` on purpose, so the stored choice alone
  // would overstate the turn. Confirmed only on a definite `true`, so a model
  // nothing could vouch for counts as no Auto at all.
  session.autoModeConfirmedFor = modelSupportsAutoMode === true ? (launchModel ?? '') : undefined;
  // Every value that reaches here is one the SDK accepts: `narrowToClaudeCodeMode`
  // checked the id and the guard above resolved Auto, so no allowlist is needed.
  sdkOptions.permissionMode = effectivePermissionMode;
  return {
    permissionMode: session.permissionMode,
    turnLevelMode: session.turnLevelMode,
    sdkPermissionMode: effectivePermissionMode,
    model: launchModel,
    autoModeConfirmedFor: session.autoModeConfirmedFor,
  };
}
