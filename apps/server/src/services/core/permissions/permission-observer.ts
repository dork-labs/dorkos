/**
 * Notices a permission change nobody made through DorkOS.
 *
 * An agent's own settings live in its `.dork/agent.json`, and that file is the
 * source of truth (ADR-0043). So anything that can edit files on this computer,
 * an agent with file tools included, can change them without going through the
 * permission pages. DorkOS cannot stop that, and login does not either. What it
 * can do is notice: every time the permission layer reads an agent's settings,
 * this compares them with the last value DorkOS wrote or saw, and a difference
 * becomes one `permission.changed` event attributed to "Changed outside
 * DorkOS", with the before and after. The change is honoured, because the
 * person may have hand-edited the file on purpose; it is never silent.
 *
 * The last-seen values live in DorkOS's data directory, keyed by agent id, not
 * in the agent's own folder, so editing the manifest does not also move the
 * value it is compared against. That is a speed bump, not a wall: the data
 * directory is on the same computer, and an agent with a shell that sets out to
 * edit both files can hide a change from this record. Login does not change
 * that either.
 *
 * - **One event per change.** The comparison and the snapshot update run under
 *   a per-agent lock, so two reads racing on the same edit record it once.
 * - **DorkOS's own writes are not "outside".** {@link PermissionObserver.writing}
 *   moves a per-agent generation counter around the write and the snapshot with
 *   it; a read whose ticket predates the write is discarded, never compared.
 * - **The event comes first.** The snapshot moves only after the history event
 *   is written, so a record that cannot be saved never absorbs a change.
 * - **Keyed by agent id**, so an agent registered anew at an old folder starts
 *   fresh instead of inheriting its predecessor's record.
 * - **The first sighting is silent.** An agent with no snapshot yet (a fresh
 *   install, a new agent, the first boot after an upgrade) is seeded, not
 *   reported: there is nothing to compare against.
 *
 * @module services/core/permissions/permission-observer
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  PERMISSION_AREA_IDS,
  type AgentPermissions,
  type PermissionAreaId,
  type PermissionChange,
  type PermissionState,
} from '@dorkos/shared/permissions';

import type { ActivityService } from '../../activity/activity-service.js';
import { recordPermissionChange, type PermissionWriter } from './permission-history.js';

/** The writer an out-of-band change is recorded under. */
export const OUTSIDE_WRITER: PermissionWriter = {
  attribution: 'outside',
  actorType: 'system',
  actorLabel: 'Changed outside DorkOS',
};

/** The agent a manifest path belongs to, for the event's target. */
export interface ObservedAgentRef {
  id: string;
  name: string;
}

/** What the observer needs. */
export interface PermissionObserverDeps {
  /** Where the last-seen values are kept, inside DorkOS's data directory. */
  snapshotFile: string;
  /** The registered agent at a project path, or `undefined` when none is. Only a registered agent is observed. */
  agentAt: (agentPath: string) => ObservedAgentRef | undefined;
  /** The area an action belongs to, or `null` for an action with none. */
  areaOfAction: (actionId: string) => PermissionAreaId | null | undefined;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'> | undefined;
  /** Where a failure to record is reported; recording never fails a read. */
  logger: { warn: (...args: unknown[]) => void };
}

/** A canonical, comparable form of one agent's settings. */
interface Canonical {
  areas: Record<string, PermissionState>;
  actions: Record<string, PermissionState>;
  filesAndCommands: string | null;
}

/** Sort a record's keys so two equal records serialize the same. */
function sorted<T>(record: Record<string, T> | undefined): Record<string, T> {
  return Object.fromEntries(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/** Absent and empty settings are the same thing: nothing set. */
function canonical(permissions: AgentPermissions | undefined): Canonical {
  return {
    areas: sorted(permissions?.areas),
    actions: sorted(permissions?.actions),
    filesAndCommands: permissions?.filesAndCommands ?? null,
  };
}

/** True for an area DorkOS knows. */
function isArea(value: string): value is PermissionAreaId {
  return (PERMISSION_AREA_IDS as readonly string[]).includes(value);
}

/**
 * Every key whose value differs between two canonical settings. A key DorkOS
 * does not know (an area that does not exist, an action with no area) changes
 * nothing the gate decides, so it is not reported.
 */
function diff(
  before: Canonical,
  after: Canonical,
  target: PermissionChange['target'],
  areaOfAction: PermissionObserverDeps['areaOfAction']
): PermissionChange[] {
  const changes: PermissionChange[] = [];
  for (const area of new Set([...Object.keys(before.areas), ...Object.keys(after.areas)])) {
    const was = before.areas[area] ?? null;
    const now = after.areas[area] ?? null;
    if (was === now || !isArea(area)) continue;
    changes.push({ target, key: { kind: 'area', area }, before: was, after: now });
  }
  for (const action of new Set([...Object.keys(before.actions), ...Object.keys(after.actions)])) {
    const was = before.actions[action] ?? null;
    const now = after.actions[action] ?? null;
    const area = areaOfAction(action);
    if (was === now || !area) continue;
    changes.push({ target, key: { kind: 'action', action, area }, before: was, after: now });
  }
  if (before.filesAndCommands !== after.filesAndCommands) {
    changes.push({
      target,
      key: { kind: 'files' },
      before: before.filesAndCommands,
      after: after.filesAndCommands,
    });
  }
  return changes;
}

/** A generation counter's value, captured before a read. */
export type ReadTicket = { agentId: string; generation: number } | undefined;

/** Records permission changes made to an agent's file outside DorkOS. */
export class PermissionObserver {
  private snapshots: Map<string, string> | undefined;
  /** One lock per agent id, so one agent's slow read never holds up another's. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * Bumped by every DorkOS write, before and after it. A read captures it
   * first; if it has moved by the time the read is compared, the read may
   * predate the write, so it is thrown away rather than taken for an edit.
   */
  private readonly generations = new Map<string, number>();
  /** Persists run one at a time, because they share one file. */
  private persistChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PermissionObserverDeps) {}

  /** Run `fn` after every earlier observation or write for this agent has finished. */
  private exclusive<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(agentId) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(agentId, settled);
    void settled.then(() => {
      if (this.locks.get(agentId) === settled) this.locks.delete(agentId);
    });
    return run;
  }

  /**
   * The last-seen values, read from disk once. A missing file is empty; a file
   * that exists but cannot be read throws, so no agent is re-seeded (and a
   * real change hidden) just because the record was made unreadable.
   */
  private async load(): Promise<Map<string, string>> {
    if (this.snapshots) return this.snapshots;
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.deps.snapshotFile, 'utf-8')) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      raw = {};
    }
    this.snapshots = new Map(
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.entries(raw as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        : []
    );
    return this.snapshots;
  }

  /**
   * Write the last-seen values, atomically. A failure is logged and left for
   * the next change to retry: the in-memory values stay current, so this
   * process records nothing twice, and the history event has already been
   * written by then, so a record that cannot be saved never hides a change.
   */
  private persist(): Promise<void> {
    const run = this.persistChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.deps.snapshotFile), { recursive: true });
        const tmp = `${this.deps.snapshotFile}.${process.pid}.tmp`;
        await fs.writeFile(
          tmp,
          JSON.stringify(Object.fromEntries(this.snapshots ?? []), null, 2),
          'utf-8'
        );
        await fs.rename(tmp, this.deps.snapshotFile);
      } catch (err) {
        this.deps.logger.warn('[Permissions] Could not save the last-seen permissions', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
    this.persistChain = run;
    return run;
  }

  /**
   * Capture the agent's write generation. Call this BEFORE reading the
   * manifest, and hand the ticket to {@link observe} with what the read found.
   *
   * @param agentPath - The agent's project directory.
   */
  ticket(agentPath: string): ReadTicket {
    const agent = this.deps.agentAt(agentPath);
    if (!agent) return undefined;
    return { agentId: agent.id, generation: this.generations.get(agent.id) ?? 0 };
  }

  /**
   * Compare what a read found on an agent's manifest with the last value
   * DorkOS saw, record a difference once, and remember the new value. Never
   * throws: a failure is logged, and the read it rides on goes on.
   *
   * The order is what keeps it honest. A read that may predate a DorkOS write
   * (the generation moved) is discarded. The history event is written BEFORE
   * the snapshot moves, and if it cannot be written the snapshot stays put, so
   * the next read tries again: a change is never absorbed without its event.
   *
   * @param agentPath - The agent's project directory.
   * @param ticket - From {@link ticket}, taken before the read.
   * @param permissions - What the manifest held.
   */
  observe(
    agentPath: string,
    ticket: ReadTicket,
    permissions: AgentPermissions | undefined
  ): Promise<void> {
    if (!ticket) return Promise.resolve();
    const { agentId } = ticket;
    return this.exclusive(agentId, async () => {
      try {
        if ((this.generations.get(agentId) ?? 0) !== ticket.generation) return;
        const agent = this.deps.agentAt(agentPath);
        // Moved, removed, or re-registered as someone else since the ticket.
        if (!agent || agent.id !== agentId) return;
        const snapshots = await this.load();
        const now = canonical(permissions);
        const serialized = JSON.stringify(now);
        const last = snapshots.get(agentId);
        if (last === serialized) return;
        if (last !== undefined) {
          const changes = diff(
            JSON.parse(last) as Canonical,
            now,
            { kind: 'agent', agentId, agentPath, agentName: agent.name },
            this.deps.areaOfAction
          );
          await recordPermissionChange(this.deps.activity, {
            changes,
            surface: 'file-edit',
            writer: OUTSIDE_WRITER,
          });
        }
        snapshots.set(agentId, serialized);
        await this.persist();
      } catch (err) {
        this.deps.logger.warn('[Permissions] Could not check for a change made outside DorkOS', {
          agentPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * Read an agent's settings and observe them, taking the ticket first.
   *
   * @param agentPath - The agent's project directory.
   * @param read - Reads the manifest's permissions.
   * @returns What the read found; a failure to observe never fails it.
   */
  async readObserved(
    agentPath: string,
    read: (agentPath: string) => Promise<AgentPermissions | undefined>
  ): Promise<AgentPermissions | undefined> {
    const ticket = this.ticket(agentPath);
    const permissions = await read(agentPath);
    await this.observe(agentPath, ticket, permissions);
    return permissions;
  }

  /**
   * Run one of DorkOS's own writes to an agent's settings, and move the
   * snapshot with it, so no read reports it as an outside change. The
   * generation moves before and after the write, so a read that overlaps it
   * in any way is discarded.
   *
   * @param agentPath - The agent's project directory.
   * @param next - What the write stores.
   * @param write - The write itself.
   */
  writing(
    agentPath: string,
    next: AgentPermissions | undefined,
    write: () => Promise<void>
  ): Promise<void> {
    const agent = this.deps.agentAt(agentPath);
    if (!agent) return write();
    const agentId = agent.id;
    const bump = () => this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    return this.exclusive(agentId, async () => {
      bump();
      try {
        await write();
      } finally {
        bump();
      }
      try {
        const snapshots = await this.load();
        snapshots.set(agentId, JSON.stringify(canonical(next)));
        await this.persist();
      } catch (err) {
        this.deps.logger.warn('[Permissions] Could not remember a permission write', {
          agentPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
}
