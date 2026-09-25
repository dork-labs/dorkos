/**
 * Notices a change to part of an agent's manifest that nobody made through
 * DorkOS.
 *
 * An agent's own settings live in its `.dork/agent.json`, and that file is the
 * source of truth (ADR-0043). So anything that can edit files on this computer,
 * an agent with file tools included, can change them without going through
 * DorkOS. DorkOS cannot stop that, and login does not either. What it can do is
 * notice: every time something reads the watched part of an agent's manifest
 * through {@link OutsideChangeObserver.readObserved}, this compares it with the
 * last value DorkOS wrote or saw, and hands a difference to the owner once.
 *
 * Two owners use it: the permission history (`PermissionObserver`, spec
 * `agent-permissions`) and an agent's runtime, model and effort
 * (`AgentExecutionObserver`, DOR-2337). This module holds the part that is
 * easy to get wrong, once:
 *
 * - **One report per change.** The comparison and the snapshot update run under
 *   a per-agent lock, so two reads racing on the same edit report it once.
 * - **DorkOS's own writes are not "outside".** {@link OutsideChangeObserver.writing}
 *   moves a per-agent generation counter around the write and the snapshot with
 *   it; a read whose ticket predates the write is discarded, never compared.
 * - **The report comes first.** The snapshot moves only after the owner's
 *   `onChange` has finished, so a report that cannot be made never absorbs a
 *   change: the next read tries again.
 * - **Keyed by agent id**, so an agent registered anew at an old folder starts
 *   fresh instead of inheriting its predecessor's record.
 * - **An unreadable record is said out loud**, once per agent per episode. It
 *   is never treated as empty, which would re-seed every agent and hide a change.
 * - **A failed save is retried** on the next read, so a restart does not
 *   compare against a stale file and report the same edit twice.
 * - **The first sighting is silent.** An agent with no snapshot yet (a fresh
 *   install, a new agent, the first boot after an upgrade) is seeded, not
 *   reported: there is nothing to compare against.
 *
 * The last-seen values live in DorkOS's data directory, keyed by agent id, not
 * in the agent's own folder, so editing the manifest does not also move the
 * value it is compared against. That is a speed bump, not a wall: the data
 * directory is on the same computer, and an agent with a shell that sets out to
 * edit both files can hide a change from this record.
 *
 * @module services/core/agent-observation/outside-change-observer
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** The agent a manifest path belongs to. */
export interface ObservedAgentRef {
  id: string;
  name: string;
}

/** A difference the observer found, in the owner's canonical form. */
export interface OutsideChange<C> {
  /** The agent whose manifest changed. */
  agent: ObservedAgentRef;
  /** The agent's project directory. */
  agentPath: string;
  /** The last value DorkOS wrote or saw. */
  before: C;
  /** What the manifest holds now. */
  after: C;
}

/** What an observer needs from its owner. */
export interface OutsideChangeObserverDeps<V, C> {
  /** Where the last-seen values are kept, inside DorkOS's data directory. */
  snapshotFile: string;
  /** The registered agent at a project path, or `undefined` when none is. Only a registered agent is observed. */
  agentAt: (agentPath: string) => ObservedAgentRef | undefined;
  /** Reads the watched part of an agent's manifest, fresh. */
  read: (agentPath: string) => Promise<V>;
  /**
   * The comparable form of a value. Two values that mean the same thing must
   * give forms that serialize identically, so key order and absent-versus-null
   * are the owner's to settle here.
   */
  canonical: (value: V) => C;
  /**
   * Report a change. Throw to keep the snapshot where it was, so the next read
   * reports it again.
   */
  onChange: (change: OutsideChange<C>) => Promise<void>;
  /**
   * Say that the last-seen record cannot be read, for one agent. Called once
   * per agent per episode; throw when it could not be said, to be asked again.
   */
  reportUnreadable: (agent: ObservedAgentRef, agentPath: string) => Promise<void>;
  /** Where a failure is reported; observing never fails a read. */
  logger: { warn: (...args: unknown[]) => void };
  /** The log prefix, e.g. `[Permissions]`. */
  logLabel: string;
}

/** The last-seen record exists but cannot be read. */
class UnreadableRecordError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'UnreadableRecordError';
  }
}

/** A generation counter's value, captured before a read. */
export type ReadTicket = { agentId: string; generation: number } | undefined;

/** Records changes made to part of an agent's manifest outside DorkOS. */
export class OutsideChangeObserver<V, C> {
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
  /** True while the file on disk is behind the in-memory values. */
  private unsaved = false;
  /**
   * Agents already told, this episode, that the record cannot be read. Cleared
   * when it can be read again, so the next episode is reported afresh.
   */
  private readonly uncheckable = new Set<string>();

  constructor(protected readonly deps: OutsideChangeObserverDeps<V, C>) {}

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
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new UnreadableRecordError(err);
      raw = {};
    }
    this.uncheckable.clear();
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
   * process reports nothing twice, and the owner has already been told by
   * then, so a record that cannot be saved never hides a change.
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
        this.unsaved = false;
      } catch (err) {
        this.unsaved = true;
        this.deps.logger.warn(`${this.deps.logLabel} Could not save the last-seen values`, {
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
   * DorkOS saw, report a difference once, and remember the new value. Never
   * throws: a failure is logged, and the read it rides on goes on.
   *
   * The order is what keeps it honest. A read that may predate a DorkOS write
   * (the generation moved) is discarded. The owner is told BEFORE the snapshot
   * moves, and if telling it fails the snapshot stays put, so the next read
   * tries again: a change is never absorbed without its report.
   *
   * @param agentPath - The agent's project directory.
   * @param ticket - From {@link ticket}, taken before the read.
   * @param value - What the manifest held.
   */
  observe(agentPath: string, ticket: ReadTicket, value: V): Promise<void> {
    if (!ticket) return Promise.resolve();
    const { agentId } = ticket;
    return this.exclusive(agentId, async () => {
      try {
        if ((this.generations.get(agentId) ?? 0) !== ticket.generation) return;
        const agent = this.deps.agentAt(agentPath);
        // Moved, removed, or re-registered as someone else since the ticket.
        if (!agent || agent.id !== agentId) return;
        const snapshots = await this.load();
        const now = this.deps.canonical(value);
        const serialized = JSON.stringify(now);
        const last = snapshots.get(agentId);
        if (last === serialized) {
          // A save that failed earlier is retried, so a restart does not
          // compare against a stale file and report the same edit twice.
          if (this.unsaved) await this.persist();
          return;
        }
        if (last !== undefined) {
          await this.deps.onChange({
            agent,
            agentPath,
            before: JSON.parse(last) as C,
            after: now,
          });
        }
        snapshots.set(agentId, serialized);
        await this.persist();
      } catch (err) {
        if (err instanceof UnreadableRecordError) {
          await this.reportUncheckable(agentId, agentPath, err);
          return;
        }
        this.deps.logger.warn(
          `${this.deps.logLabel} Could not check for a change made outside DorkOS`,
          {
            agentPath,
            err: err instanceof Error ? err.message : String(err),
          }
        );
      }
    });
  }

  /**
   * Say once per agent, per episode, that its settings cannot be checked for
   * outside changes while the record is unreadable. Quiet on every later read.
   */
  private async reportUncheckable(
    agentId: string,
    agentPath: string,
    err: UnreadableRecordError
  ): Promise<void> {
    this.deps.logger.warn(`${this.deps.logLabel} The last-seen record cannot be read`, {
      agentPath,
      err: err.message,
    });
    if (this.uncheckable.has(agentId)) return;
    const agent = this.deps.agentAt(agentPath);
    if (!agent) return;
    try {
      await this.deps.reportUnreadable(agent, agentPath);
      this.uncheckable.add(agentId);
    } catch (reportErr) {
      this.deps.logger.warn(
        `${this.deps.logLabel} Could not record that outside changes cannot be checked`,
        {
          agentPath,
          err: reportErr instanceof Error ? reportErr.message : String(reportErr),
        }
      );
    }
  }

  /**
   * Read the watched part of an agent's manifest and observe it, taking the
   * ticket first.
   *
   * @param agentPath - The agent's project directory.
   * @param read - Reads the manifest; the observer's own reader by default.
   * @returns What the read found; a failure to observe never fails it.
   */
  async readObserved(
    agentPath: string,
    read: (agentPath: string) => Promise<V> = this.deps.read
  ): Promise<V> {
    const ticket = this.ticket(agentPath);
    const value = await read(agentPath);
    await this.observe(agentPath, ticket, value);
    return value;
  }

  /**
   * Run one of DorkOS's own writes to an agent's manifest, and move the
   * snapshot with it, so no read reports it as an outside change. The
   * generation moves before and after the write, so a read that overlaps it
   * in any way is discarded.
   *
   * @param agentPath - The agent's project directory.
   * @param next - What the write stores in the watched part, or a reader for
   *   it, asked after the write, for a write that merges into what is there.
   * @param write - The write itself.
   */
  writing(
    agentPath: string,
    next: V | (() => Promise<V>),
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
      } catch (writeErr) {
        // The write may have reached the file before failing (the manifest
        // saved, the registry update after it threw). Sync to what is really
        // there, so the next read does not report DorkOS's own half-write as
        // an outside edit.
        try {
          const landed = await this.deps.read(agentPath);
          const snapshots = await this.load();
          snapshots.set(agentId, JSON.stringify(this.deps.canonical(landed)));
          await this.persist();
        } catch {
          // Unknown state: the next read compares against the old record.
        }
        throw writeErr;
      } finally {
        bump();
      }
      try {
        // A reader is asked only now, after the write, and a failure to read
        // is a failure to remember, never a failure of the write.
        const landed = typeof next === 'function' ? await (next as () => Promise<V>)() : next;
        const snapshots = await this.load();
        snapshots.set(agentId, JSON.stringify(this.deps.canonical(landed)));
        await this.persist();
      } catch (err) {
        this.deps.logger.warn(`${this.deps.logLabel} Could not remember a write`, {
          agentPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
}
