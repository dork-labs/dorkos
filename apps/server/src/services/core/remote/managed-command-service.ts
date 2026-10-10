/**
 * When the managed remote access command stream runs (DOR-2086), and the
 * pieces it runs with: the stream (`command-stream.ts`), the dispatcher
 * (`command-dispatcher.ts`) and the acknowledgement sender (`command-acks.ts`),
 * over one durable journal (`command-journal.ts`).
 *
 * ## Dormant unless everything is in place
 *
 * {@link ManagedCommandService.start} connects only when all of these hold,
 * and otherwise does nothing:
 *
 * 1. the server's database is attached (boot does it);
 * 2. the `DORKOS_MANAGED_REMOTE` switch is on and availability reads
 *    `available` (linked, current, entitled, Cloud answering);
 * 3. a person's enrolment is active here, made under the same instance id the
 *    link resolves to now;
 * 4. a credential is stored;
 * 5. `canExpose()` allows publishing this computer.
 *
 * It is started after a person finishes setup, and at boot when the computer
 * is already enrolled. Boot only reconnects the stream: nothing opens until
 * Cloud sends an `open`, and that still runs every local rule. It stops on
 * withdrawal, unlink and shutdown, and on its own when the link it opened
 * under ends or the enrolment goes.
 *
 * @module services/core/remote/managed-command-service
 */
import { V1_ROUTES } from '@dork-labs/cloud-api';
import type { Db } from '@dorkos/db';

import { logger } from '../../../lib/logger.js';
import {
  captureCloudV1Context,
  openCloudV1Stream,
  type CloudV1Context,
} from '../cloud/v1-client.js';
import { tunnelManager } from '../tunnel-manager.js';
import { CommandAcks, type CommandAcksDeps } from './command-acks.js';
import { CommandDispatcher, type CommandLink } from './command-dispatcher.js';
import { CommandJournal } from './command-journal.js';
import { CommandStream, type CommandStreamDeps } from './command-stream.js';
import { managedAvailability, type ManagedAvailability } from './managed-availability.js';
import { errorName } from './managed-remote-support.js';
import { remoteCredentials } from './remote-credentials.js';
import {
  isEnrolledUnder,
  readRemoteState,
  updateRemoteState,
  type RemoteState,
} from './remote-state.js';

/** The longest shutdown waits for the command under way to finish. */
export const SHUTDOWN_IDLE_BOUND_MS = 3_000;

/** What the service touches, injectable for tests. */
export interface ManagedCommandServiceDeps {
  availability: Pick<ManagedAvailability, 'enabled' | 'read' | 'markAbsent'>;
  captureContext: () => CloudV1Context | null;
  readRemoteState: () => RemoteState;
  canExpose: () => boolean | Promise<boolean>;
  /** Build the dispatcher over the attached journal. */
  dispatcher: (journal: CommandJournal, onSettled: () => void) => CommandDispatcher;
  /** Open the command stream under a link. */
  openStream: (context: CloudV1Context, signal: AbortSignal) => Promise<Response>;
  /** Seams passed through to the stream, for tests. */
  stream?: Pick<CommandStreamDeps, 'sleep' | 'random' | 'timers'>;
  /** Seams passed through to the acknowledgement sender, for tests. */
  acks?: ConstructorParameters<typeof CommandAcks>[1]['timers'];
}

interface Session {
  link: CommandLink;
  stream: CommandStream;
  acks: CommandAcks;
}

/** The command stream's lifecycle. One per process: {@link managedRemoteCommands}. */
export class ManagedCommandService {
  private journal: CommandJournal | null = null;
  private dispatcher: CommandDispatcher | null = null;
  private session: Session | null = null;
  /** Bumped by every stop, so a start overtaken by one opens nothing. */
  private epoch = 0;

  /**
   * Build the service. Nothing runs until {@link attach} and {@link start}.
   *
   * @param deps - Everything it touches; the module singleton wires the real ones.
   */
  constructor(private readonly deps: ManagedCommandServiceDeps) {}

  /** Whether a command stream is running. */
  get running(): boolean {
    return this.session !== null;
  }

  /** The dispatcher, once attached; for tests that wait on it. */
  get commands(): CommandDispatcher | null {
    return this.dispatcher;
  }

  /**
   * Attach the server's database. A command left half-done by the previous
   * process is settled `failed` (repeating an effect blind could repeat a
   * destructive one), and the journal is pruned.
   *
   * @param db - The server's database.
   */
  attach(db: Db): void {
    if (this.journal) return;
    const journal = new CommandJournal(db);
    const interrupted = journal.settleInterrupted();
    journal.prune();
    if (interrupted > 0) {
      logger.warn('[RemoteAccess] Commands interrupted by a restart settled as failed', {
        count: interrupted,
      });
    }
    this.journal = journal;
    this.dispatcher = this.deps.dispatcher(journal, () => void this.session?.acks.flush());
  }

  /**
   * Attach the database and reconnect the command stream when this computer
   * is already set up. Never opens managed access by itself.
   *
   * @param db - The server's database.
   */
  boot(db: Db): void {
    this.attach(db);
    void this.start();
  }

  /**
   * Connect the command stream when every condition in the module doc holds.
   *
   * @returns Whether a stream is running afterwards. Never rejects.
   */
  async start(): Promise<boolean> {
    if (this.session) return true;
    const epoch = this.epoch;
    try {
      const link = await this.eligibleLink();
      if (link === null || epoch !== this.epoch) return false;
      if (this.session) return true;
      this.open(link);
      return true;
    } catch (error) {
      logger.warn('[RemoteAccess] Command stream did not start', { error: errorName(error) });
      return false;
    }
  }

  /**
   * Stop for good, at server shutdown: stop the stream, refuse every queued
   * command, and wait (bounded) for the one under way, so no effect runs
   * after this resolves and the tunnel is torn down. Never rejects.
   *
   * @param boundMs - The longest to wait for the command under way.
   */
  async shutdown(boundMs = SHUTDOWN_IDLE_BOUND_MS): Promise<void> {
    this.stop();
    const dispatcher = this.dispatcher;
    if (!dispatcher) return;
    dispatcher.halt();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), boundMs);
      timer.unref?.();
    });
    const result = await Promise.race([dispatcher.idle.then(() => 'idle' as const), bound]);
    clearTimeout(timer);
    if (result === 'timeout') {
      logger.warn('[RemoteAccess] A command was still running at shutdown', { boundMs });
    }
  }

  /** Stop the stream and any acknowledgement retry. Synchronous; safe to call twice. */
  stop(): void {
    this.epoch += 1;
    const session = this.session;
    this.session = null;
    session?.stream.stop();
    session?.acks.stop();
  }

  private async eligibleLink(): Promise<CommandLink | null> {
    const dispatcher = this.dispatcher;
    if (!dispatcher || !this.deps.availability.enabled) return null;
    const snapshot = await this.deps.availability.read();
    if (snapshot.availability !== 'available' || snapshot.instanceId === null) return null;
    const context = this.deps.captureContext();
    if (context === null) return null;
    const state = this.deps.readRemoteState();
    if (!isEnrolledUnder(state, snapshot.instanceId)) return null;
    if (state.credentialId === null) return null;
    if (!(await this.deps.canExpose())) return null;
    if (!context.isCurrent()) return null;
    return { context, instanceId: snapshot.instanceId };
  }

  /** Whether the link a stream was opened under still owns the enrolment. */
  private belongs(link: CommandLink): boolean {
    if (!link.context.isCurrent()) return false;
    const state = this.deps.readRemoteState();
    return isEnrolledUnder(state, link.instanceId);
  }

  private open(link: CommandLink): void {
    const dispatcher = this.dispatcher!;
    const acks = new CommandAcks(link, {
      journal: withHeldOutcomes(this.journal!, dispatcher),
      timers: this.deps.acks,
    });
    const stream = new CommandStream({
      ...this.deps.stream,
      open: (signal) => this.deps.openStream(link.context, signal),
      onCommand: (command) => void dispatcher.dispatch(command, link),
      shouldRun: () => this.belongs(link),
      onAbsent: () => this.deps.availability.markAbsent(),
      onConnected: () => void acks.flush(),
    });
    const session: Session = { link, stream, acks };
    this.session = session;
    logger.info('[RemoteAccess] Command stream started', { instanceId: link.instanceId });
    void stream.start().finally(() => {
      if (this.session === session) {
        this.session = null;
        acks.stop();
        logger.info('[RemoteAccess] Command stream stopped');
      }
    });
  }
}

/**
 * The journal as the acknowledgement sender sees it: outcomes the dispatcher
 * holds in memory (the journal would not take them) come first. A journal that
 * cannot be read owes nothing this round, and a failed attempt count does not
 * stop a held outcome going out; a failed `finish` throws, and the sender
 * retries later.
 */
function withHeldOutcomes(
  journal: CommandJournal,
  dispatcher: CommandDispatcher
): CommandAcksDeps['journal'] {
  const quietly = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      logger.warn('[RemoteAccess] Command journal unavailable', { error: errorName(error) });
      return fallback;
    }
  };
  return {
    pendingAcks: (instanceId, limit = 100) =>
      [
        ...dispatcher.heldAcks(instanceId),
        ...quietly(() => journal.pendingAcks(instanceId, limit), []),
      ].slice(0, limit),
    noteAttempt: (ids) => quietly(() => journal.noteAttempt(ids), undefined),
    finish: (items, state) => {
      dispatcher.releaseHeld(items);
      journal.finish(items, state);
    },
  };
}

/** The process's command stream service, over the live link, tunnel and store. */
export const managedRemoteCommands = new ManagedCommandService({
  availability: managedAvailability,
  captureContext: captureCloudV1Context,
  readRemoteState,
  canExpose: async () => {
    // Loaded lazily, as `tunnel-manager.ts` does: the guard reads config and
    // the auth store, which are not ready when this module is imported.
    const { canExpose } = await import('../auth/exposure-guard.js');
    return canExpose();
  },
  dispatcher: (journal, onSettled) =>
    new CommandDispatcher({
      journal,
      tunnelManager,
      remoteCredentials,
      readRemoteState,
      updateRemoteState,
      onSettled,
    }),
  openStream: (context, signal) => openCloudV1Stream(context, V1_ROUTES.remoteCommands, signal),
});
