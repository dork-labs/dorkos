/**
 * The permissions a person set for each agent, kept where the agent cannot
 * write (DOR-3107).
 *
 * An agent's own settings live in its `.dork/agent.json`, and the agent can
 * edit that file with its own tools. Until now such an edit was recorded, not
 * blocked, so one turn could raise its agent to Full autonomy. This record is
 * the floor under that file: every write DorkOS makes to an agent's settings
 * lands here too, and every read takes, key by key, the STRICTER of the file
 * and this record (`stricterPermissions`). The file can tighten an agent; it
 * can never loosen one past what a person set.
 *
 * It lives in DorkOS's own data directory, beside the observer's snapshot, so
 * an agent that can edit its own folder without asking cannot reach it.
 *
 * Fails closed, like `ArrivalRecord`: while the record cannot be read, or
 * before it has been seeded once from history (`seedPersonSetPermissions`),
 * every agent's floor is the defaults, so its file can only narrow it.
 *
 * @module services/core/permissions/person-set-permissions
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentPermissions } from '@dorkos/shared/permissions';

/** Where the record lives, and where to report a failure. */
export interface PersonSetPermissionsDeps {
  /** The JSON file, inside DorkOS's data directory. */
  file: string;
  /** Where read and write failures are reported. */
  logger: { warn: (...args: unknown[]) => void };
}

/** The file's shape: each agent's person-set settings, by agent id. */
interface RecordFile {
  version: 1;
  agents: Record<string, AgentPermissions>;
}

/** The person-set floor under every agent's own settings file. */
export class PersonSetPermissions {
  private agents = new Map<string, AgentPermissions>();
  /** Writes made before the first seed lands, applied on top of it. */
  private pending = new Map<string, AgentPermissions | undefined>();
  private seeded = false;
  private broken = false;

  /**
   * Load the record from disk.
   *
   * @param deps - The file and the logger.
   */
  constructor(private readonly deps: PersonSetPermissionsDeps) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.file, 'utf-8')) as Partial<RecordFile>;
      if (raw.version !== 1 || typeof raw.agents !== 'object' || raw.agents === null) {
        throw new Error('the record has an unknown shape');
      }
      this.agents = new Map(Object.entries(raw.agents));
      this.seeded = true;
      this.broken = false;
    } catch (err) {
      // No file yet is the one normal miss: it is seeded from history once.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    if (!this.broken) {
      this.deps.logger.warn(
        '[Permissions] The record of what a person set for each agent could not be used; every agent follows the defaults until it can',
        { err: err instanceof Error ? err.message : String(err) }
      );
    }
    this.broken = true;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.${process.pid}.tmp`;
      const body: RecordFile = { version: 1, agents: Object.fromEntries(this.agents) };
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf-8');
      fs.renameSync(tmp, this.deps.file);
      // One failed save must not hold every agent at the defaults for good.
      this.broken = false;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Whether the record has been seeded once, so its floors can be trusted. */
  isSeeded(): boolean {
    return this.seeded && !this.broken;
  }

  /**
   * The floor for one agent: what a person set, or `undefined` for the
   * defaults. Also `undefined` for every agent while the record is unseeded or
   * broken, which is the fail-closed answer.
   *
   * @param agentId - The agent.
   */
  get(agentId: string): AgentPermissions | undefined {
    if (!this.isSeeded()) return undefined;
    return this.agents.get(agentId);
  }

  /**
   * Record what DorkOS just wrote to an agent's settings.
   *
   * @param agentId - The agent.
   * @param next - Its settings as written, or `undefined` for the defaults.
   */
  set(agentId: string, next: AgentPermissions | undefined): void {
    // Before the first seed, kept and applied after it: the seed may have read
    // the history before this write was recorded.
    if (!this.seeded) {
      this.pending.set(agentId, next);
      return;
    }
    if (next) this.agents.set(agentId, next);
    else this.agents.delete(agentId);
    this.save();
  }

  /**
   * Write the first floors, once, from history (see
   * `seedPersonSetPermissions`). A no-op once seeded.
   *
   * @param floors - Each agent's floor, by agent id.
   */
  seed(floors: ReadonlyMap<string, AgentPermissions>): void {
    if (this.seeded) return;
    this.agents = new Map(floors);
    for (const [agentId, next] of this.pending) {
      if (next) this.agents.set(agentId, next);
      else this.agents.delete(agentId);
    }
    this.pending.clear();
    this.seeded = true;
    this.broken = false;
    this.save();
  }
}
