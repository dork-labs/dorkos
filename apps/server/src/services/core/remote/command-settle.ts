/**
 * Records each command's outcome in the journal (DOR-2086), and keeps it in
 * memory when the journal will not take it.
 *
 * An effect that has already run must be acknowledged with what it did. If
 * the journal write fails, the row stays without an outcome, and the next boot
 * would settle it `failed` though the effect applied. So the write is retried a
 * few times; when it still fails the outcome is held here, offered to the
 * acknowledgement sender alongside the journal's, and written again whenever
 * the sender asks. A held outcome lives only as long as this process.
 *
 * @module services/core/remote/command-settle
 */
import type { RemoteCommandOutcome } from '@dork-labs/cloud-api';

import { logger } from '../../../lib/logger.js';
import type { CommandJournal, PendingAck } from './command-journal.js';
import { errorName } from './managed-remote-support.js';

/** How many times one outcome is written before it is held in memory. */
export const SETTLE_ATTEMPTS = 3;

interface Held {
  leaseToken: string;
  outcome: RemoteCommandOutcome;
  instanceId: string;
}

/** The outcome writer. One per dispatcher. */
export class CommandSettler {
  private readonly held = new Map<string, Held>();

  /**
   * Build the writer.
   *
   * @param journal - Where outcomes are recorded.
   */
  constructor(private readonly journal: Pick<CommandJournal, 'settle'>) {}

  /**
   * Record an outcome, retrying; hold it in memory when every attempt fails.
   * Never throws.
   *
   * @param command - The command id and the lease token it arrived with.
   * @param instanceId - The instance id of the link it arrived on.
   * @param outcome - What this computer did.
   */
  settle(
    command: { id: string; leaseToken: string },
    instanceId: string,
    outcome: RemoteCommandOutcome
  ): void {
    let last: unknown;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
      try {
        this.journal.settle(command.id, outcome);
        return;
      } catch (error) {
        last = error;
      }
    }
    this.held.set(command.id, { leaseToken: command.leaseToken, outcome, instanceId });
    logger.warn('[RemoteAccess] Could not journal an outcome; holding it in memory', {
      commandId: command.id,
      outcome,
      error: errorName(last),
    });
  }

  /**
   * The held outcome for a redelivered command, now under its new lease, or
   * `null` when none is held.
   *
   * @param commandId - Cloud's command id.
   * @param leaseToken - The lease token the redelivery carried.
   */
  redelivered(commandId: string, leaseToken: string): RemoteCommandOutcome | null {
    const held = this.held.get(commandId);
    if (!held) return null;
    held.leaseToken = leaseToken;
    return held.outcome;
  }

  /**
   * The held outcomes for one link, as acknowledgements owed. Each is written
   * to the journal again first; one that lands there is dropped from memory
   * and is the journal's to offer from then on.
   *
   * @param instanceId - The link's instance id.
   */
  pending(instanceId: string): PendingAck[] {
    const owed: PendingAck[] = [];
    for (const [id, held] of this.held) {
      if (held.instanceId !== instanceId) continue;
      try {
        this.journal.settle(id, held.outcome);
        this.held.delete(id);
      } catch {
        owed.push({ id, leaseToken: held.leaseToken, outcome: held.outcome, attempts: 0 });
      }
    }
    return owed;
  }

  /**
   * Forget held outcomes whose acknowledgement is finished, for the lease
   * token that was sent.
   *
   * @param items - The commands and the lease tokens their acknowledgement carried.
   */
  release(items: ReadonlyArray<{ id: string; leaseToken: string }>): void {
    for (const item of items) {
      if (this.held.get(item.id)?.leaseToken === item.leaseToken) this.held.delete(item.id);
    }
  }
}
