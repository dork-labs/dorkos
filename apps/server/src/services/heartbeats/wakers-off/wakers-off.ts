/**
 * Every waker that cannot wake now, for the team page (DOR-3641, PM scope of
 * Nov 2): each schedule switched off, waiting for approval or paused, each
 * heartbeat set to `wake: off`, each paused agent, and heartbeats as a whole
 * when they are off. Each says since when and who can turn it back on, so a
 * waker that is off never goes unnoticed. `GET /api/heartbeats/wakers-off`.
 *
 * - **Since when** is read, never guessed: a schedule's `off_since` (kept by a
 *   trigger on every switch), a pause's own time, and for a heartbeat the time
 *   its `HEARTBEAT.md` was last saved, which is when it said `off` at the
 *   latest. Heartbeats switched off as a whole carry no time; the setting keeps
 *   none.
 * - **Who** is the person the waker's agent reports up to (the owner for a
 *   global schedule), or for a paused agent the person who paused it.
 *
 * @module services/heartbeats/wakers-off/wakers-off
 */
import { and, eq, not } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import type { AgentPause } from '@dorkos/shared/mesh-schemas';
import { resolveHeartbeatSettings, type HeartbeatWake } from '@dorkos/shared/heartbeat-schemas';
import type { WakerOff, WakersOff } from '@dorkos/shared/waker-schemas';
import type { WakersOffRouterDeps } from '../../../routes/wakers-off.js';
import type { BeatAgent } from '../beat-runner.js';
import { frontmatterInForce } from '../beat-plan.js';
import { readHeartbeatFile } from '../heartbeat-file.js';
import type { HeartbeatStore } from '../heartbeat-store.js';

/** A schedule row as the list reads it. */
export interface OffScheduleRow {
  id: string;
  name: string;
  displayName: string | null;
  agentId: string | null;
  enabled: boolean;
  status: 'active' | 'paused' | 'pending_approval';
  offSince: string | null;
  /** A project's own copy of a shared schedule (DOR-3376). */
  projectOnly: boolean;
}

/** What {@link listWakersOff} reads. */
export interface WakersOffInput {
  /** Every schedule that cannot run now. */
  schedules: OffScheduleRow[];
  /** Every agent on this server. */
  agents: BeatAgent[];
  /** `heartbeats.enabled`. */
  heartbeatsEnabled: boolean;
  /** How an agent's heartbeat wakes, and when its file last changed (ISO), if known. */
  heartbeatOf(agent: BeatAgent): Promise<{ wake: HeartbeatWake; savedAt: string | null }>;
  /** Every paused agent. */
  pauses: AgentPause[];
  /** The person an agent reports up to; `null` asks for the owner. */
  personOf(agentId: string | null): string;
  /** A person's name, or null when DorkOS knows them only by id. */
  nameOf(accountId: string): string | null;
}

/**
 * Read every schedule that cannot run now: switched off, or not `active`.
 *
 * @param db - The server database.
 */
export function readOffSchedules(db: Db): OffScheduleRow[] {
  return (
    db
      .select({
        id: pulseSchedules.id,
        name: pulseSchedules.name,
        displayName: pulseSchedules.displayName,
        agentId: pulseSchedules.agentId,
        enabled: pulseSchedules.enabled,
        status: pulseSchedules.status,
        offSince: pulseSchedules.offSince,
        projectOnly: pulseSchedules.projectOnly,
      })
      .from(pulseSchedules)
      .where(not(and(eq(pulseSchedules.enabled, true), eq(pulseSchedules.status, 'active'))!))
      .all()
      // A project's copy starts off on purpose until that project's person turns
      // it on (DOR-3376); listing every one would bury the wakers that stopped.
      .filter((row) => !(row.projectOnly && !row.enabled && row.status === 'active'))
  );
}

/** Why a schedule row cannot run, in the list's terms. */
function scheduleState(row: OffScheduleRow): WakerOff['state'] {
  if (row.status === 'pending_approval') return 'waiting';
  if (row.status === 'paused') return 'paused';
  return 'off';
}

/**
 * List every waker that cannot wake now, longest off first; those with no
 * known time last.
 *
 * @param input - What the list reads.
 */
export async function listWakersOff(input: WakersOffInput): Promise<WakersOff> {
  const person = (accountId: string) => ({ accountId, name: input.nameOf(accountId) });
  const wakers: WakerOff[] = input.schedules.map((row) => ({
    kind: 'schedule',
    id: row.id,
    name: row.displayName ?? row.name,
    agentId: row.agentId,
    state: scheduleState(row),
    offSince: row.offSince,
    waitingOn: person(input.personOf(row.agentId)),
  }));

  const paused = new Map(input.pauses.map((pause) => [pause.agentId, pause]));
  if (!input.heartbeatsEnabled) {
    wakers.push({
      kind: 'heartbeat',
      id: 'all',
      name: 'Every heartbeat',
      agentId: null,
      state: 'off',
      offSince: null,
      waitingOn: person(input.personOf(null)),
    });
  }
  for (const agent of input.agents) {
    const pause = paused.get(agent.id);
    if (pause) {
      wakers.push({
        kind: 'heartbeat',
        id: agent.id,
        name: agent.name,
        agentId: agent.id,
        state: 'paused',
        offSince: pause.pausedAt,
        // An agent paused by a person waits on that person; one an agent
        // paused waits on whoever its own agent reports to.
        waitingOn:
          pause.pausedBy.kind === 'person'
            ? { accountId: pause.pausedBy.accountId, name: pause.pausedBy.name }
            : person(input.personOf(agent.id)),
      });
      continue;
    }
    // While heartbeats are off as a whole, the one line above covers every agent.
    if (!input.heartbeatsEnabled) continue;
    const heartbeat = await input.heartbeatOf(agent);
    if (heartbeat.wake !== 'off') continue;
    wakers.push({
      kind: 'heartbeat',
      id: agent.id,
      name: agent.name,
      agentId: agent.id,
      state: 'off',
      offSince: heartbeat.savedAt,
      waitingOn: person(input.personOf(agent.id)),
    });
  }

  wakers.sort((a, b) => {
    if (a.offSince === b.offSince) return a.name.localeCompare(b.name);
    if (a.offSince === null) return 1;
    if (b.offSince === null) return -1;
    return a.offSince.localeCompare(b.offSince);
  });
  return { wakers };
}

/**
 * How an agent's heartbeat wakes, by the same settings the runner uses, and
 * when its file was last saved.
 *
 * @param read - What one read of `HEARTBEAT.md` found.
 * @param inForce - The frontmatter the runner holds in force for it.
 */
export function heartbeatWakeOf(
  read: { kind: 'absent' } | { kind: 'valid' | 'invalid'; mtimeMs: number },
  inForce: Parameters<typeof resolveHeartbeatSettings>[0]
): { wake: HeartbeatWake; savedAt: string | null } {
  return {
    wake: resolveHeartbeatSettings(inForce).wake,
    savedAt:
      read.kind !== 'absent' && read.mtimeMs > 0 ? new Date(read.mtimeMs).toISOString() : null,
  };
}

/** What {@link wakersOffReader} composes. */
export interface WakersOffReaderParts {
  /** The server database. */
  db: Db;
  /** Every agent on this server. */
  agents: { list(): BeatAgent[] };
  /** Whether heartbeats run here at all. */
  enabled(): boolean;
  /** The heartbeat state, for the last valid header held in force. */
  store: Pick<HeartbeatStore, 'getState'>;
  /** Every paused agent. */
  pauses(): AgentPause[];
  /** The person an agent reports up to; `null` asks for the owner. */
  personOf(agentId: string | null): string;
  /** A person's name, or null. */
  nameOf(accountId: string): string | null;
}

/**
 * The route's reader, over the live server.
 *
 * @param parts - What it reads.
 */
export function wakersOffReader(parts: WakersOffReaderParts): WakersOffRouterDeps {
  return {
    list: () =>
      listWakersOff({
        schedules: readOffSchedules(parts.db),
        agents: parts.agents.list(),
        heartbeatsEnabled: parts.enabled(),
        heartbeatOf: async (agent) => {
          const read = await readHeartbeatFile(agent.projectPath);
          return heartbeatWakeOf(
            read,
            frontmatterInForce(read, parts.store.getState(agent.id)?.lastValidFrontmatter)
          );
        },
        pauses: parts.pauses(),
        personOf: parts.personOf,
        nameOf: parts.nameOf,
      }),
  };
}
