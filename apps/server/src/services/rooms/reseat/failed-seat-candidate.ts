/** Strict live producer + durable failed room-turn evidence, never preference fallback. */
import { resolve } from 'node:path';
import { projectOfFolder } from '../../core/usage/account-eligibility.js';
import { resolveLaunchAccountRoot } from '../../runtimes/claude-code/claude-config-dir.js';
import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { getSessionEventStore, peekProjector } from '../../session/session-state-projector.js';
import { latestClaudeRoomServerFailure } from '../../session/history/latest-room-failure.js';
import { claudeTranscriptPath } from '../../session/fleet/carry-over-summary.js';
import { isTurnInFlight } from '../../session/message-dispatcher/turn-probes.js';
import { agentPause } from '../../mesh/pause/agent-pause.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { mayAutoPickClaudeRoot } from '../../runtimes/claude-code/accounts/account-login-metadata.js';
import type { RecoveryAuthority } from './required-launch-store.js';
import type { Seat } from './seat-mover.js';

/** A positive historical witness, with current guard revalidation owned by its runtime. */
export interface FailedSeatCandidate {
  startSeq: number;
  endSeq: number;
  sourceDispatchId: string;
  authority: RecoveryAuthority;
  currentAllowed(): boolean;
}
interface ClaudeFailureReader {
  readFailedSeatAuthority(
    sessionId: string
  ): (RecoveryAuthority & { dispatchId: string; entryId: string }) | null;
}

/** Resolve only a proven Claude candidate with an intact transcript and current guards. */
export async function failedSeatCandidate(seat: Seat): Promise<FailedSeatCandidate | null> {
  if (!seat.sessionId) return null;
  const sessionId = seat.sessionId;
  if ((await runtimeRegistry.getSessionAgentPath(sessionId)) !== seat.agentPath) return null;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  if (runtime.type !== 'claude-code' || !('readFailedSeatAuthority' in runtime)) return null;
  const reader = runtime as typeof runtime & ClaudeFailureReader;
  const authority = reader.readFailedSeatAuthority(sessionId);
  const events = getSessionEventStore();
  const witness = latestClaudeRoomServerFailure(
    events?.readLatestTurnStrict(sessionId) ?? null,
    seat.roomId
  );
  if (
    !authority ||
    !authority.accountId ||
    !witness ||
    witness.dispatchId !== authority.dispatchId ||
    witness.entryId !== authority.entryId
  )
    return null;
  const launchCwd = runtime.getSessionCwd?.(sessionId) ?? seat.agentPath;
  let project: Awaited<ReturnType<typeof projectOfFolder>>;
  try {
    project = await projectOfFolder(launchCwd);
  } catch {
    return null;
  }
  const transcript = claudeTranscriptPath(authority.root, launchCwd, sessionId);
  if (!transcript) return null;
  let signature: { mtimeMs: number; size: number };
  try {
    const before = await stat(transcript);
    const text = await readFile(transcript, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim());
    if (
      lines.length === 0 ||
      lines.some((line) => {
        try {
          const record: unknown = JSON.parse(line);
          return !record || typeof record !== 'object';
        } catch {
          return true;
        }
      })
    )
      return null;
    const after = await stat(transcript);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) return null;
    signature = { mtimeMs: after.mtimeMs, size: after.size };
  } catch {
    return null;
  }
  const currentAllowed = () => {
    try {
      const now = reader.readFailedSeatAuthority(sessionId);
      const pause = agentPause();
      const projector = peekProjector(sessionId);
      const usage = getAccountUsageStore()?.peekByRoot('claude-code', authority.root);
      const disk = statSync(transcript);
      // Display attribution can fall back to `default`; that is not recovery authority.
      // An explicit current account must still name the exact previously observed root.
      const account = resolveLaunchAccountRoot({ hintId: authority.accountId!, project });
      return (
        (runtime.getSessionCwd?.(sessionId) ?? seat.agentPath) === launchCwd &&
        account.ok &&
        resolve(account.root) === authority.root &&
        now?.dispatchId === authority.dispatchId &&
        now.root === authority.root &&
        now.billing === authority.billing &&
        now.inference === authority.inference &&
        now.accountId === authority.accountId &&
        pause !== undefined &&
        !pause.isPaused(seat.agentPath) &&
        projector !== undefined &&
        !projector.hasPendingInteractions() &&
        !isTurnInFlight(sessionId, runtime) &&
        !runtime.holdsBackgroundWork?.(sessionId) &&
        !runtime.isHelperWorking?.(sessionId) &&
        usage !== undefined &&
        usage.state === 'ok' &&
        mayAutoPickClaudeRoot(authority.root) &&
        disk.mtimeMs === signature.mtimeMs &&
        disk.size === signature.size
      );
    } catch {
      return false;
    }
  };
  return currentAllowed()
    ? {
        startSeq: witness.startSeq,
        endSeq: witness.endSeq,
        sourceDispatchId: witness.dispatchId,
        authority,
        currentAllowed,
      }
    : null;
}
