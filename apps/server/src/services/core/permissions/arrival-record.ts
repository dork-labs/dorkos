/**
 * Which agents arrived and have not yet had their folder's settings screened
 * into their file (spec `agent-permissions`, review D1).
 *
 * The screen writes an arriving agent's settings back narrowed to what is
 * strictly stricter than the defaults. Until that write lands, and whenever it
 * cannot land (a read-only file, a full disk), the agent is PENDING here, and
 * every reader of its settings narrows them the same way on the fly. So an
 * agent's own settings are never honoured as the folder wrote them, whether or
 * not the write ever succeeds: the property is held by the reader, and the
 * write only makes the file say what the reader already decided.
 *
 * The record is kept in DorkOS's data directory, so a restart in the middle of
 * a screen does not forget an agent. It fails CLOSED: a record that cannot be
 * read or written treats every agent as pending, which narrows what they may
 * do and never widens it.
 *
 * @module services/core/permissions/arrival-record
 */
import fs from 'node:fs';
import path from 'node:path';

/** What the record needs. */
export interface ArrivalRecordDeps {
  /** Where the pending ids are kept, inside DorkOS's data directory. */
  file: string;
  /** Where a failure to read or save is reported. */
  logger: { warn: (...args: unknown[]) => void };
}

/** The pending arrivals, read once and kept current. */
export class ArrivalRecord {
  private pending = new Set<string>();
  /** True when the record could not be read or saved: every agent is pending. */
  private broken = false;

  /**
   * Load the record. A missing file is empty; any other failure breaks it.
   *
   * @param deps - Where it lives and where to report.
   */
  constructor(private readonly deps: ArrivalRecordDeps) {
    this.load();
  }

  /** Read the record from disk, merging it into what is held. Returns whether it could. */
  private load(): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.file, 'utf-8')) as unknown;
      if (!Array.isArray(raw)) {
        this.fail(new Error('the record is not a list'));
        return false;
      }
      for (const id of raw) if (typeof id === 'string') this.pending.add(id);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      this.fail(err);
      return false;
    }
  }

  /**
   * A record that broke is read again on the next write, not only at the next
   * restart: once it reads cleanly the agents it does not name are no longer
   * narrowed.
   */
  private recover(): void {
    if (!this.broken) return;
    if (this.load()) this.broken = false;
  }

  /** Whether the record could be read and saved; `false` means every agent is narrowed. */
  isHealthy(): boolean {
    return !this.broken;
  }

  /** Report a failure once, and treat every agent as pending from now on. */
  private fail(err: unknown): void {
    if (!this.broken) {
      this.deps.logger.warn(
        "[Permissions] The record of new agents' settings could not be used; every agent's own settings are narrowed until it can",
        { err: err instanceof Error ? err.message : String(err) }
      );
    }
    this.broken = true;
  }

  /** Save the record, synchronously, so a pending mark holds before anything reads. */
  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.pending]), 'utf-8');
      fs.renameSync(tmp, this.deps.file);
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Mark an agent as arrived and not yet screened. Synchronous, so it holds
   * before the first read of the agent's settings can happen.
   *
   * @param agentId - The arriving agent.
   */
  markPending(agentId: string): void {
    this.recover();
    this.pending.add(agentId);
    this.save();
  }

  /**
   * The screen wrote the agent's file back: its settings are now its own.
   *
   * @param agentId - The screened agent.
   */
  clear(agentId: string): void {
    this.recover();
    if (!this.pending.delete(agentId)) return;
    this.save();
  }

  /**
   * Whether an agent's settings must be narrowed when read.
   *
   * @param agentId - The agent.
   */
  isPending(agentId: string): boolean {
    return this.broken || this.pending.has(agentId);
  }

  /** Every agent still waiting for its screen, for a retry at boot. */
  pendingIds(): string[] {
    return [...this.pending];
  }
}
