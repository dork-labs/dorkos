/**
 * The production {@link RoomSeatMover}: the mover's ports filled from the
 * running server, and the one instance the room dispatcher and `rooms.reseat`
 * share.
 *
 * Built by the rooms startup step once the Claude Code transcript reader
 * exists, because an expired seat is found by asking it.
 *
 * @module services/rooms/reseat/create-seat-mover
 */
import { sessionPath } from '@dorkos/shared/session-link';
import type { ActivityService } from '../../activity/activity-service.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { coreRanking } from '../../core/usage/account-ranking.js';
import { projectOfFolder } from '../../core/usage/account-eligibility.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { resolveTurnRuntimeType } from '../../runtimes/shared/resolve-agent-runtime-type.js';
import { accountUsageForSession } from '../../session/fleet/session-account.js';
import {
  claudeTranscriptPath,
  gatherCarryOverSummary,
  runGitForSummary,
} from '../../session/fleet/carry-over-summary.js';
import type { RoomStore } from '../room-store.js';
import {
  probeRoomBindingTranscript,
  type RoomBindingTranscriptDeps,
} from '../session-bindings/room-binding-transcripts.js';
import { RESEAT_RUNTIME, RoomSeatMover, type ReseatActivity } from './seat-mover.js';
import {
  hasTestAccountWorld,
  testWorldRan,
  testWorldRanking,
  testWorldSeatAccount,
} from './test-account-world.js';

let current: RoomSeatMover | null = null;

/** The server's seat mover, or `null` before the rooms step built it (and in tests). */
export function getRoomSeatMover(): RoomSeatMover | null {
  return current;
}

/**
 * Install the server's seat mover, or `null` to take it away.
 *
 * @param mover - The mover.
 */
export function setRoomSeatMover(mover: RoomSeatMover | null): void {
  current = mover;
}

/** What a move's Activity entry says it was for. */
const TRIGGER_WORDS: Record<ReseatActivity['trigger'], string> = {
  limit: 'its account ran out of usage',
  'nearly-out': 'its account was almost out of usage',
  stranded: 'its earlier session had expired',
  person: 'a person moved it',
};

/**
 * Record one move in the Activity feed (Security Must 6): who or what moved
 * it, from which account to which, the message it answers, and both sessions.
 * Never throws.
 *
 * @param activity - The Activity feed writer, when the server has one.
 * @param entry - The move.
 */
export function recordReseatActivity(
  activity: ActivityService | undefined,
  entry: ReseatActivity
): void {
  if (!activity) return;
  const to = entry.toAccountLabel ? ` to ${entry.toAccountLabel}` : '';
  const from = entry.fromAccountLabel ? ` from ${entry.fromAccountLabel}` : '';
  void activity
    .emit({
      actorType: entry.trigger === 'person' ? 'user' : 'system',
      actorLabel: entry.trigger === 'person' ? (entry.by ?? 'You') : 'DorkOS',
      category: 'agent',
      eventType: 'room.seat_moved',
      resourceType: 'room',
      resourceId: entry.roomId,
      summary:
        entry.trigger === 'stranded'
          ? `Started a fresh session for an agent in a room because ${TRIGGER_WORDS.stranded}`
          : `Moved an agent's room seat${from}${to} because ${TRIGGER_WORDS[entry.trigger]}`,
      linkPath: sessionPath({ session: entry.toSessionId }),
      metadata: { ...entry },
    })
    .catch(() => undefined);
}

/** The test runtime's type: its sessions stand in for Claude Code's under a test world. */
const TEST_RUNTIME = 'test-mode';

/**
 * A runtime as the mover sees it: under the forced-limit seam's test world
 * (test runtime only), a test-runtime session stands in for a Claude Code one,
 * since the world's accounts are Claude Code accounts. Unchanged otherwise.
 *
 * @param type - The session's resolved runtime.
 */
function asWorldRuntime(type: string): string {
  return hasTestAccountWorld() && type.startsWith(TEST_RUNTIME) ? RESEAT_RUNTIME : type;
}

/**
 * Build the production mover.
 *
 * @param opts.store - The room store, whose bindings are the seats.
 * @param opts.transcripts - The transcript probe the boot sweep uses; absent
 *   when Claude Code is not in this process, and then no seat reads as expired.
 * @param opts.activity - Reads the Activity feed writer when a move is recorded.
 */
export function createRoomSeatMover(opts: {
  store: Pick<RoomStore, 'rebindRoomSession'>;
  transcripts: RoomBindingTranscriptDeps | undefined;
  activity: () => ActivityService | undefined;
}): RoomSeatMover {
  return new RoomSeatMover({
    rebind: (roomId, authorId, sessionId) =>
      opts.store.rebindRoomSession(roomId, authorId, sessionId),
    runtimeOf: async (seat) =>
      asWorldRuntime(
        await resolveTurnRuntimeType({ sessionId: seat.sessionId, agentPath: seat.agentPath })
      ),
    newSeatRuntime: async (agentPath) =>
      asWorldRuntime(await resolveTurnRuntimeType({ sessionId: null, agentPath })),
    settingsOf: (sessionId) => runtimeRegistry.getSessionSettings(sessionId),
    saveSettings: (sessionId, settings) => runtimeRegistry.saveSessionSettings(sessionId, settings),
    declaredModes: (runtime) => {
      const type = runtimeRegistry.has(runtime)
        ? runtime
        : hasTestAccountWorld() && runtimeRegistry.has(TEST_RUNTIME)
          ? TEST_RUNTIME
          : null;
      return type === null
        ? undefined
        : runtimeRegistry.get(type).getCapabilities().permissionModes;
    },
    accountOf: async (runtime, sessionId, cwd) => {
      // The forced-limit seam (DOR-3143), set only under the test runtime.
      if (hasTestAccountWorld()) {
        return testWorldSeatAccount(sessionId) ?? { id: null, label: null, usage: null };
      }
      const usage = runtimeRegistry.has(runtime)
        ? await accountUsageForSession(
            getAccountUsageStore(),
            runtimeRegistry.get(runtime),
            sessionId,
            cwd
          )
        : null;
      return { id: usage?.accountId ?? null, label: usage?.label ?? null, usage };
    },
    ranking: async (runtime, cwd) =>
      testWorldRanking() ?? coreRanking(runtime, await projectOfFolder(cwd)),
    transcriptState: async (seat) => {
      if (hasTestAccountWorld()) {
        return seat.sessionId !== null && testWorldRan(seat.sessionId) ? 'present' : 'unknown';
      }
      if (!opts.transcripts || seat.sessionId === null) return 'unknown';
      const { verdict } = await probeRoomBindingTranscript(
        { roomId: seat.roomId, authorId: seat.authorId, sessionId: seat.sessionId },
        opts.transcripts
      );
      return verdict === 'present' || verdict === 'missing' ? verdict : 'unknown';
    },
    summaryOf: (input) =>
      gatherCarryOverSummary(
        {
          sessionId: input.sessionId,
          accountLabel: input.accountLabel,
          window: input.window,
          resetsAt: input.resetsAt,
          cwd: input.cwd,
          transcriptPath: claudeTranscriptPath(input.accountPath, input.cwd, input.sessionId),
          stoppedBecause: input.stoppedBecause,
        },
        {
          runGit: runGitForSummary,
          readHistory: async () => {
            const runtime = await runtimeRegistry.resolveForSession(input.sessionId);
            const internalId = runtime.getInternalSessionId(input.sessionId) ?? input.sessionId;
            return runtime.getMessageHistory(input.cwd, internalId);
          },
        }
      ),
    recordActivity: (entry) => recordReseatActivity(opts.activity(), entry),
  });
}
