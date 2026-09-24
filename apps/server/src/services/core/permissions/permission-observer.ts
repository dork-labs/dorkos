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
 * The last-seen values live in DorkOS's own data directory, never in the
 * agent's directory, so an agent that rewrites its manifest cannot rewrite the
 * record it is compared against.
 *
 * - **One event per change.** The comparison and the snapshot update run under
 *   one lock, so two reads racing on the same edit record it once.
 * - **DorkOS's own writes are not "outside".** {@link PermissionObserver.writing}
 *   holds the lock across the write and moves the snapshot with it.
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
  /** The registered agent at a project path, or `undefined` when none is. */
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

/** Records permission changes made to an agent's file outside DorkOS. */
export class PermissionObserver {
  private snapshots: Map<string, string> | undefined;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PermissionObserverDeps) {}

  /** Run `fn` after every earlier observation or write has finished. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** The last-seen values, read from disk once. A missing or broken file is empty. */
  private async load(): Promise<Map<string, string>> {
    if (this.snapshots) return this.snapshots;
    try {
      const raw = JSON.parse(await fs.readFile(this.deps.snapshotFile, 'utf-8')) as unknown;
      this.snapshots = new Map(
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? Object.entries(raw as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          : []
      );
    } catch {
      this.snapshots = new Map();
    }
    return this.snapshots;
  }

  /** Write the last-seen values, atomically. */
  private async persist(snapshots: Map<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.deps.snapshotFile), { recursive: true });
    const tmp = `${this.deps.snapshotFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(snapshots), null, 2), 'utf-8');
    await fs.rename(tmp, this.deps.snapshotFile);
  }

  /**
   * Compare what was just read off an agent's manifest with the last value
   * DorkOS saw, record a difference once, and remember the new value. Never
   * throws: a failure to record is logged, and the read it rides on goes on.
   *
   * @param agentPath - The agent's project directory.
   * @param permissions - What its manifest holds now.
   */
  observe(agentPath: string, permissions: AgentPermissions | undefined): Promise<void> {
    return this.exclusive(async () => {
      try {
        const snapshots = await this.load();
        const now = canonical(permissions);
        const serialized = JSON.stringify(now);
        const last = snapshots.get(agentPath);
        if (last === serialized) return;
        snapshots.set(agentPath, serialized);
        await this.persist(snapshots);
        if (last === undefined) return;
        const agent = this.deps.agentAt(agentPath);
        if (!agent) return;
        const changes = diff(
          JSON.parse(last) as Canonical,
          now,
          {
            kind: 'agent',
            agentId: agent.id,
            agentPath,
            agentName: agent.name,
          },
          this.deps.areaOfAction
        );
        await recordPermissionChange(this.deps.activity, {
          changes,
          surface: 'file-edit',
          writer: OUTSIDE_WRITER,
        });
      } catch (err) {
        this.deps.logger.warn('[Permissions] Could not check for a change made outside DorkOS', {
          agentPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * Run one of DorkOS's own writes to an agent's settings, and move the
   * snapshot with it, so the next read does not report it as an outside change.
   * Holds the lock for the whole write, so no read can compare in between.
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
    return this.exclusive(async () => {
      await write();
      try {
        const snapshots = await this.load();
        snapshots.set(agentPath, JSON.stringify(canonical(next)));
        await this.persist(snapshots);
      } catch (err) {
        this.deps.logger.warn('[Permissions] Could not remember a permission write', {
          agentPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
}
