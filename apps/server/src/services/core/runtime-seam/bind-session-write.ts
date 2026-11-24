/** Synchronous runtime binding with current durable birth and required-identity checks. */
import { and, eq, isNull, sessionDraftSources, sessionMetadata, type Db } from '@dorkos/db';
import {
  assertPersonDraftSource,
  readDraftSource,
  type PersonDraftWitness,
} from './person-draft-settings.js';
import { RequiredSessionIdentityError } from '../../../lib/replay/required-session-identity-error.js';
import { RequiredRoomLaunchStore } from '../../rooms/reseat/required-launch-store.js';
import type { TurnOrigin } from '../../session/origin/turn-origin.js';
import {
  withSessionBirthWrite,
  SessionBirthWriteError,
  type SessionBirthWriteContext,
} from './session-birth-write.js';
import {
  keepRecordedAgent,
  fillNullsWith,
  launchColumns,
  type SettingsUpdate,
} from './session-metadata-columns.js';

/** Compare only the origin and owner facts the actual source describes. */
function assertBindingSource(
  origin: TurnOrigin,
  agentPath: string | undefined,
  birth: SessionBirthWriteContext | undefined
): void {
  if (!birth) return;
  if (birth.kind === 'required-recovery') {
    if (origin.kind !== 'room' || agentPath !== birth.agentPath)
      throw new SessionBirthWriteError('source');
  } else if (birth.kind === 'person-location' || birth.kind === 'person-agent') {
    if (
      (origin.kind !== 'interactive' && origin.kind !== 'session-relay') ||
      (birth.kind === 'person-agent' && agentPath !== birth.recordedRegisteredPath)
    )
      throw new SessionBirthWriteError('source');
  } else if (birth.kind === 'room-seat') {
    const expectedOrigin = birth.delivery === 'owner-http' ? 'interactive' : 'room';
    if (origin.kind !== expectedOrigin || agentPath !== birth.agentPath)
      throw new SessionBirthWriteError('source');
  } else if (
    origin.kind !== 'chat-message' ||
    (birth.targetAgent && agentPath !== birth.targetAgent.path)
  ) {
    throw new SessionBirthWriteError('source');
  }
}

/** Seeds are prepared by the registry before SQL; the transaction retains the original INSERT/CLAIM. */
export function bindSessionWrite(
  db: Db,
  sessionId: string,
  runtime: string,
  origin: TurnOrigin,
  agentPath: string | undefined,
  seed: Partial<typeof sessionMetadata.$inferInsert>,
  claimMode: SettingsUpdate,
  expectedRequiredId: string | undefined,
  birth: SessionBirthWriteContext | undefined,
  draft?: PersonDraftWitness
): boolean {
  assertBindingSource(origin, agentPath, birth);
  return withSessionBirthWrite(db, sessionId, birth, (tx, insertBirth) => {
    const storedDraft = readDraftSource(tx, sessionId);
    if (draft) {
      if (
        birth ||
        origin.kind !== 'interactive' ||
        !storedDraft ||
        (draft.sourceKind === 'person-agent' && agentPath !== draft.sourcePath)
      )
        throw new SessionBirthWriteError('source');
      assertPersonDraftSource(tx, sessionId, draft);
      const pending = tx
        .select({ agentPath: sessionMetadata.agentPath })
        .from(sessionMetadata)
        .where(
          and(
            eq(sessionMetadata.sessionId, sessionId),
            isNull(sessionMetadata.runtime),
            eq(sessionMetadata.modelLaunchState, 'pending-v1')
          )
        )
        .get();
      if (
        !pending ||
        (draft.sourceKind === 'person-agent' &&
          pending.agentPath !== null &&
          pending.agentPath !== draft.sourcePath)
      )
        throw new SessionBirthWriteError('metadata');
    } else if (storedDraft) {
      throw new SessionBirthWriteError('context');
    }
    const currentRequired = new RequiredRoomLaunchStore(tx).forSession(sessionId);
    if (
      currentRequired?.id !== expectedRequiredId ||
      (currentRequired && currentRequired.destinationSessionId !== sessionId)
    )
      throw new RequiredSessionIdentityError('Recovery identity changed before binding.');
    if (currentRequired && currentRequired.runtime !== runtime)
      throw new Error('Recovery runtime cannot change.');
    const result = tx
      .insert(sessionMetadata)
      .values({
        sessionId,
        runtime,
        agentPath: agentPath ?? null,
        // What started it, server-held and never overwritten: the fact that
        // decides whether a limited session may carry its work to another
        // account (spec `claude-account-fleet` D9).
        ...launchColumns(origin),
        createdAt: new Date().toISOString(),
        ...seed,
        ...insertBirth,
      })
      .onConflictDoUpdate({
        target: sessionMetadata.sessionId,
        set: {
          runtime,
          // The binding write is what establishes identity, so the agent it
          // names is the session's — but only when it names one, so a caller
          // with no agent never erases a path some other write knew. And only
          // into an empty column: a recorded agent never changes once recorded,
          // not even by the claim (DOR-3706, R3).
          ...keepRecordedAgent(agentPath),
          ...fillNullsWith(seed),
          // The claim names what started the session only when nothing has yet.
          ...launchColumns(origin, 'claim'),
          // **The UPDATE branch is a CLAIM, and not every origin may seed one.**
          // This row already exists: something created it before the session
          // started, which for a person is their own pre-launch settings change
          // and for a room is evidence the conversation is not new. So an
          // insert-only origin hands nothing down here, and the stored mode is
          // left to stand or fall on its own (`configured-stop-on-insert` in
          // {@link permissionSeedForOrigin}, DOR-2105 review). The INSERT branch
          // above is unaffected: a row this call mints is new by definition.
          ...claimMode,
        },
        // The whole guard: claim a row nobody has bound, never re-bind one.
        setWhere: isNull(sessionMetadata.runtime),
      })
      .run();
    // better-sqlite3 RunResult: `changes` is the number of rows actually written
    // — 1 for a fresh insert, 1 for a claim, and 0 when `setWhere` refused an
    // already-bound row. That is exactly "this call bound the session".
    if (draft) {
      if (result.changes !== 1) throw new SessionBirthWriteError('metadata');
      assertPersonDraftSource(tx, sessionId, draft);
      const retired = tx
        .delete(sessionDraftSources)
        .where(eq(sessionDraftSources.sessionId, sessionId))
        .run();
      if (retired.changes !== 1) throw new SessionBirthWriteError('write');
    }
    return result.changes > 0;
  });
}
