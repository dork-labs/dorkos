/** Claude-owned birth-only staging; ordinary updateSession keeps its original path. */
import { isDeepStrictEqual } from 'node:util';
import type { PermissionMode, SessionSettings } from '@dorkos/shared/types';
import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import {
  PreparedSettingsWriteError,
  stageSettingsPublication,
} from '../../../../core/runtime-seam/prepared-settings-write.js';
import { setChosenMode } from '../../turn-permission.js';
import type { AgentSession } from '../../agent-types.js';
import type { SessionStore } from '../session-store.js';

function settingsOf(session: AgentSession) {
  return {
    permissionMode: session.permissionMode,
    turnLevelMode: session.turnLevelMode,
    model: session.model,
    effort: session.effort,
    fastMode: session.fastMode,
    sdkSessionId: session.sdkSessionId,
    accountRoot: session.accountRoot,
    hasStarted: session.hasStarted,
    turnStartedAwake: session.turnStartedAwake,
    turnPermissionCeiling: structuredClone(session.turnPermissionCeiling),
    backgroundPermissionCeiling: structuredClone(session.backgroundPermissionCeiling),
  };
}

/** Read hydration without creating or modifying an owner, then stage its exact publication. */
export async function prepareClaudeSettingsUpdate(
  store: SessionStore,
  id: string,
  opts: SessionSettings,
  port: SessionSettingsPort | undefined,
  defaultMode: PermissionMode
) {
  if (
    !port ||
    [opts.permissionMode, opts.model, opts.effort, opts.fastMode].every(
      (value) => value === undefined
    )
  )
    throw new PreparedSettingsWriteError();
  const original = store.findSession(id);
  // Fresh birth never addresses another map owner or an already-renamed native identity.
  if (store.sessionKeyOf(id) !== id || (original && original.sdkSessionId !== id))
    throw new PreparedSettingsWriteError();
  const originalSettings = original ? settingsOf(original) : undefined;
  const originalQuery = original?.activeQuery;
  const originalTurn = original?.connectorTurn;
  const originalEvents = original?.eventQueue;
  const persisted = original ? null : await port.getSessionSettings(id);
  let published: AgentSession | undefined;
  let publishedSettings: ReturnType<typeof settingsOf> | undefined;
  let publishedQuery: AgentSession['activeQuery'];
  let publishedTurn: AgentSession['connectorTurn'];
  let publishedEvents: AgentSession['eventQueue'] | undefined;
  let previousMode: AgentSession['permissionMode'] | undefined;
  stageSettingsPublication(id, {
    isCurrent: () => {
      const current = store.findSession(id);
      return (
        store.sessionKeyOf(id) === id &&
        (!current || current.sdkSessionId === id) &&
        current === original &&
        (!current ||
          (current.activeQuery === originalQuery &&
            current.connectorTurn === originalTurn &&
            current.eventQueue === originalEvents &&
            isDeepStrictEqual(settingsOf(current), originalSettings)))
      );
    },
    publish: () => {
      if (!original) {
        store.ensureSession(id, {
          permissionMode: opts.permissionMode ?? persisted?.permissionMode ?? defaultMode,
          model: opts.model ?? persisted?.model,
          effort: opts.effort ?? persisted?.effort,
          fastMode: opts.fastMode ?? persisted?.fastMode,
          hasStarted: false,
        });
      }
      const session = store.findSession(id);
      if (!session) throw new Error('Committed Claude settings owner was not published.');
      if (!original) session.needsTranscriptCheck = true;
      previousMode = session.permissionMode;
      if (opts.permissionMode) setChosenMode(session, opts.permissionMode);
      if (opts.model) session.model = opts.model;
      if (opts.effort) session.effort = opts.effort;
      if (opts.fastMode !== undefined) session.fastMode = opts.fastMode;
      published = session;
      publishedSettings = settingsOf(session);
      publishedQuery = session.activeQuery;
      publishedTurn = session.connectorTurn;
      publishedEvents = session.eventQueue;
      return undefined;
    },
  });
  return {
    session(): AgentSession {
      if (!published) throw new Error('Claude settings publication did not commit.');
      return published;
    },
    previousMode(): AgentSession['permissionMode'] {
      if (previousMode === undefined)
        throw new Error('Claude settings publication did not commit.');
      return previousMode;
    },
    isCurrent(): boolean {
      const current = store.findSession(id);
      return (
        store.sessionKeyOf(id) === id &&
        current === published &&
        current !== undefined &&
        current.sdkSessionId === id &&
        current.activeQuery === publishedQuery &&
        current.connectorTurn === publishedTurn &&
        current.eventQueue === publishedEvents &&
        isDeepStrictEqual(settingsOf(current), publishedSettings)
      );
    },
  };
}
