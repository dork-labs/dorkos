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
 * It is started after a person finishes setup or chooses managed access, and
 * at boot when the boot rule allows it (`remote-boot.ts`: an explicit
 * `TUNNEL_ENABLED` keeps it down for the whole process, until a person asks).
 * Boot only reconnects the stream: nothing opens until Cloud sends an `open`,
 * and that still runs every local rule. It stops on withdrawal, unlink and
 * shutdown, and on its own when the link it opened under ends or the
 * enrolment goes.
 *
 * ## Kept in step after boot
 *
 * Whether it may run changes without anyone asking: login turns on or off,
 * the link changes, Cloud stops offering it. {@link ManagedCommandService.reconcile}
 * runs on every such change and on a jittered beat: a stream that may no
 * longer run stops, and one that may now run starts.
 *
 * ## Activity and shutdown
 *
 * Each session also carries the activity sender (`activity-sender.ts`) over the
 * durable outbox (`activity-outbox.ts`); the activity window itself is
 * `managed-activity.ts`. {@link ManagedCommandService.shutdown} cancels the
 * stream, closes managed access gently within the active drain deadline (new
 * requests refused at once), gives what is owed one bounded chance to go out,
 * and leaves the rest in the database for the next start.
 *
 * @module services/core/remote/managed-command-service
 */
import { V1_ROUTES } from '@dork-labs/cloud-api';
import type { Db } from '@dorkos/db';

import { logger } from '../../../lib/logger.js';
import { scheduleJittered, type JitteredSchedule } from '../../../lib/jittered-schedule.js';
import { configManager } from '../config-manager.js';
import {
  captureCloudV1Context,
  openCloudV1Stream,
  type CloudV1Context,
} from '../cloud/v1-client.js';
import { tunnelManager, type TunnelManager } from '../tunnel-manager.js';
import { ActivityOutbox, type RemoteEventBatch } from './activity-outbox.js';
import { ActivitySender } from './activity-sender.js';
import { CommandAcks, type CommandAcksDeps } from './command-acks.js';
import { CommandDispatcher, type CommandLink } from './command-dispatcher.js';
import { CommandJournal } from './command-journal.js';
import { CommandStream, type CommandStreamDeps } from './command-stream.js';
import { ManagedActivity, type OpenedWindow } from './managed-activity.js';
import { managedAvailability, type ManagedAvailability } from './managed-availability.js';
import { setManagedAdmissionListener, setManagedUpgradeListener } from './ingress-mark.js';
import { MANAGED_DRAIN_DEADLINE_MS } from './managed-ingress.js';
import { errorName } from './managed-remote-support.js';
import { remoteCredentials } from './remote-credentials.js';
import {
  isEnrolledUnder,
  readRemoteState,
  updateRemoteState,
  type RemoteState,
} from './remote-state.js';

/**
 * The longest {@link ManagedCommandService.shutdown} takes in all: the command
 * under way, the gentle close and the last send together. Well inside the
 * desktop app's grace before it kills the server.
 */
export const SHUTDOWN_BUDGET_MS = 3_000;
/** The share of what is left of the budget the gentle close may spend draining. */
export const SHUTDOWN_DRAIN_SHARE = 0.7;

/** What the service touches, injectable for tests. */
export interface ManagedCommandServiceDeps {
  availability: Pick<ManagedAvailability, 'enabled' | 'read' | 'markAbsent'>;
  captureContext: () => CloudV1Context | null;
  readRemoteState: () => RemoteState;
  canExpose: () => boolean | Promise<boolean>;
  /** Build the dispatcher over the attached journal. */
  dispatcher: (
    journal: CommandJournal,
    onSettled: () => void,
    onOpened: (window: OpenedWindow) => void
  ) => CommandDispatcher;
  /** The activity window an applied open starts; absent in tests that do not need it. */
  activity?: Pick<ManagedActivity, 'opened' | 'stop' | 'drainDeadlineMs'>;
  /** The tunnel, for the gentle close at shutdown. */
  tunnel?: Pick<TunnelManager, 'getManagedPhase' | 'closeManaged'>;
  /** Calls `onChange` whenever login, the link or the account changes; returns the unsubscribe. */
  watchChanges?: (onChange: () => void) => () => void;
  /** Open the command stream under a link. */
  openStream: (context: CloudV1Context, signal: AbortSignal) => Promise<Response>;
  /** Seams passed through to the stream, for tests. */
  stream?: Pick<CommandStreamDeps, 'sleep' | 'random' | 'timers'>;
  /** Seams passed through to the acknowledgement sender, for tests. */
  acks?: ConstructorParameters<typeof CommandAcks>[1]['timers'];
  /** Seams passed through to the activity sender and the reconcile beat, for tests. */
  random?: () => number;
}

/** How often, on average, the service re-checks whether the stream may run. */
export const RECONCILE_INTERVAL_MS = 60_000;

interface Session {
  link: CommandLink;
  stream: CommandStream;
  acks: CommandAcks;
  sender: ActivitySender;
}

/** The command stream's lifecycle. One per process: {@link managedRemoteCommands}. */
export class ManagedCommandService {
  private journal: CommandJournal | null = null;
  private dispatcher: CommandDispatcher | null = null;
  private outbox: ActivityOutbox | null = null;
  private session: Session | null = null;
  /** Bumped by every stop, so a start overtaken by one opens nothing. */
  private epoch = 0;
  /** Set when the boot rule keeps the stream down for this process, until a person asks. */
  private suppressed = false;
  private watching: { beat: JitteredSchedule; unsubscribe: () => void } | null = null;

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

  /** Whether the running stream's activity reports have kept failing to reach Cloud. */
  get activityReportsStuck(): boolean {
    return this.session?.sender.stuck ?? false;
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
    this.dispatcher = this.deps.dispatcher(
      journal,
      () => void this.session?.acks.flush(),
      (window) => this.deps.activity?.opened(window)
    );
    this.outbox = new ActivityOutbox(db);
    this.outbox.prune();
  }

  /**
   * Persist an activity batch, then hand it to the sender. Persisted before
   * any send, so a crash between the two loses nothing. Never throws.
   *
   * @param batch - What the activity window reported.
   */
  reportActivity(batch: RemoteEventBatch): void {
    if (!this.outbox) return;
    try {
      if (this.outbox.enqueue(batch)) void this.session?.sender.flush();
    } catch (error) {
      logger.warn('[RemoteAccess] Could not store an activity report', { error: errorName(error) });
    }
  }

  /**
   * Attach the database, reconnect the command stream when the boot rule
   * allows it and this computer is set up, and keep it in step from then on.
   * Never opens managed access by itself.
   *
   * @param db - The server's database.
   * @param plan - The boot rule's answer (`remote-boot.ts`).
   * @param plan.reconnectManaged - Whether the stream may come back on its own.
   */
  boot(db: Db, plan: { reconnectManaged: boolean } = { reconnectManaged: true }): void {
    this.attach(db);
    this.suppressed = !plan.reconnectManaged;
    if (!this.suppressed) void this.connect();
    this.watch();
  }

  /**
   * Connect the command stream because a person asked (finished setup, chose
   * managed access): lifts the boot rule's hold, then connects when every
   * condition in the module doc holds.
   *
   * @returns Whether a stream is running afterwards. Never rejects.
   */
  start(): Promise<boolean> {
    this.suppressed = false;
    return this.connect();
  }

  /**
   * Bring the stream in step with whether it may run now: stop one that may
   * not, start one that may. Does nothing while the boot rule holds it down.
   * Never rejects.
   */
  async reconcile(): Promise<void> {
    if (this.suppressed) return;
    if (!this.session) {
      await this.connect();
      return;
    }
    const session = this.session;
    try {
      if (await this.mayKeepRunning()) return;
    } catch {
      return;
    }
    if (this.session !== session) return;
    logger.info('[RemoteAccess] Command stream no longer allowed here; stopping it');
    this.stop();
  }

  private async connect(): Promise<boolean> {
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

  /** Stop the stream and any acknowledgement retry. Synchronous; safe to call twice. */
  stop(): void {
    this.epoch += 1;
    const session = this.session;
    this.session = null;
    session?.stream.stop();
    session?.acks.stop();
    session?.sender.stop();
  }

  /**
   * Shut down, within {@link SHUTDOWN_BUDGET_MS} in all: cancel the stream,
   * refuse every queued command and wait for the one under way, close managed
   * access gently (no new requests from the first moment; admitted ones get
   * what is left of the budget, never more than the active drain deadline),
   * then give what is owed one chance to go out in the time that remains. What
   * does not go out stays stored for the next start, so the budget bounds the
   * wait, never what is kept. Never rejects.
   *
   * @param budgetMs - The longest the whole shutdown may take.
   */
  async shutdown(budgetMs = SHUTDOWN_BUDGET_MS): Promise<void> {
    const deadline = Date.now() + budgetMs;
    const left = () => Math.max(0, deadline - Date.now());
    this.watching?.beat.stop();
    this.watching?.unsubscribe();
    this.watching = null;
    this.epoch += 1;
    const session = this.session;
    this.session = null;
    session?.stream.stop();
    const dispatcher = this.dispatcher;
    if (dispatcher) {
      dispatcher.halt();
      const idle = await within(dispatcher.idle, left());
      if (!idle)
        logger.warn('[RemoteAccess] A command was still running at shutdown', { budgetMs });
    }
    const tunnel = this.deps.tunnel;
    if (tunnel && tunnel.getManagedPhase() !== null) {
      const cloud = this.deps.activity?.drainDeadlineMs;
      const cap = Math.min(MANAGED_DRAIN_DEADLINE_MS, Math.floor(left() * SHUTDOWN_DRAIN_SHARE));
      const closing = tunnel
        .closeManaged({
          immediate: false,
          drainDeadlineMs: Math.min(cloud ?? cap, cap),
          // Cloud's deadline only when it is the one that applies.
          deadlineFrom: cloud !== undefined && cloud <= cap ? 'cloud' : 'local',
          reason: 'shutdown',
        })
        .catch((error: unknown) => {
          logger.warn('[RemoteAccess] Managed close at shutdown failed', {
            error: errorName(error),
          });
        });
      await within(closing, left());
    }
    if (session) {
      await within(Promise.all([session.acks.flush(), session.sender.flush()]), left());
      session.acks.stop();
      session.sender.stop();
    }
    this.deps.activity?.stop();
  }

  private watch(): void {
    if (this.watching) return;
    const onChange = () => void this.reconcile();
    this.watching = {
      beat: scheduleJittered(() => this.reconcile(), RECONCILE_INTERVAL_MS, {
        random: this.deps.random,
      }),
      unsubscribe: this.deps.watchChanges?.(onChange) ?? (() => undefined),
    };
  }

  /** The conditions a running stream must keep; a passing blip in Cloud's status is not one. */
  private async mayKeepRunning(): Promise<boolean> {
    if (!this.deps.availability.enabled) return false;
    if (this.deps.readRemoteState().mode !== 'managed') return false;
    if (!(await this.deps.canExpose())) return false;
    return (await this.deps.availability.read()).availability !== 'hidden';
  }

  private async eligibleLink(): Promise<CommandLink | null> {
    const dispatcher = this.dispatcher;
    if (!dispatcher || !this.deps.availability.enabled) return null;
    const snapshot = await this.deps.availability.read();
    if (snapshot.availability !== 'available' || snapshot.instanceId === null) return null;
    const context = this.deps.captureContext();
    if (context === null) return null;
    const state = this.deps.readRemoteState();
    if (state.mode !== 'managed' || !isEnrolledUnder(state, snapshot.instanceId)) return null;
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
    const sender = new ActivitySender(link, { outbox: this.outbox!, random: this.deps.random });
    const stream = new CommandStream({
      ...this.deps.stream,
      open: (signal) => this.deps.openStream(link.context, signal),
      onCommand: (command) => void dispatcher.dispatch(command, link),
      shouldRun: () => this.belongs(link),
      onAbsent: () => this.deps.availability.markAbsent(),
      onConnected: () => {
        void acks.flush();
        void sender.flush();
      },
    });
    const session: Session = { link, stream, acks, sender };
    this.session = session;
    logger.info('[RemoteAccess] Command stream started', { instanceId: link.instanceId });
    void stream.start().finally(() => {
      if (this.session === session) {
        this.session = null;
        acks.stop();
        sender.stop();
        logger.info('[RemoteAccess] Command stream stopped');
      }
    });
  }
}

/**
 * Wait for `work`, but no longer than `ms`.
 *
 * @returns Whether it finished in time.
 */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      work.then(
        () => true as const,
        () => true as const
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
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
export const managedRemoteCommands: ManagedCommandService = new ManagedCommandService({
  availability: managedAvailability,
  captureContext: captureCloudV1Context,
  readRemoteState,
  canExpose: async () => {
    // Loaded lazily, as `tunnel-manager.ts` does: the guard reads config and
    // the auth store, which are not ready when this module is imported.
    const { canExpose } = await import('../auth/exposure-guard.js');
    return canExpose();
  },
  dispatcher: (journal, onSettled, onOpened) =>
    new CommandDispatcher({
      journal,
      tunnelManager,
      remoteCredentials,
      readRemoteState,
      updateRemoteState,
      onSettled,
      onOpened,
    }),
  openStream: (context, signal) => openCloudV1Stream(context, V1_ROUTES.remoteCommands, signal),
  activity: {
    opened: (window) => managedActivity.opened(window),
    stop: () => managedActivity.stop(),
    get drainDeadlineMs() {
      return managedActivity.drainDeadlineMs;
    },
  },
  tunnel: tunnelManager,
  watchChanges: (onChange) =>
    configManager.onChange((change) => {
      // Login (`canExpose`), the link and the saved choice all live here.
      if (change.sections.some((section) => section === 'auth' || section === 'cloud')) {
        managedAvailability.invalidate();
        onChange();
      }
    }),
});

/**
 * The process's activity window and idle close (`managed-activity.ts`). Every
 * admitted managed request and accepted managed WebSocket is counted here, and each batch it
 * reports is stored and sent through {@link managedRemoteCommands}.
 */
export const managedActivity: ManagedActivity = new ManagedActivity({
  tunnel: tunnelManager,
  report: (batch) => managedRemoteCommands.reportActivity(batch),
});
setManagedAdmissionListener((req, res) => managedActivity.admitted(req, res));
setManagedUpgradeListener((req, socket) => managedActivity.upgraded(req, socket));
