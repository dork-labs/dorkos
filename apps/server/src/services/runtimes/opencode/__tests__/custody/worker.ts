/** Worker rendezvous contains metadata only. A caller opens its own authenticated scope. */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { openOwnedInbox } from './inbox.js';
import {
  decodeReply,
  encodeMetadata,
  validRunDescriptor,
  type ConnectionDescriptor,
} from './metadata.js';
import type { ProvidedCustody } from './run-main.js';

const POLL_MS = 25;
const CLOSE_MS = 5_000;

type Step = 'pending' | 'closed' | 'failed';
type CloseProgress = { channel: Step; request: Step };

/** Sanitized cleanup facts remain observable if an adapter settles after the join deadline. */
export class WorkerCleanupError extends Error {
  constructor(
    private readonly progress: CloseProgress,
    private readonly reason: 'deadline' | 'adapter-failed'
  ) {
    super('OpenCode custody worker close could not be confirmed');
    this.name = 'WorkerCleanupError';
  }

  get receipt() {
    return { kind: 'cleanup-uncertain' as const, reason: this.reason, ...this.progress };
  }
}

interface ScopeChannel {
  close(): void | Promise<void>;
}
interface WorkerOptions<Channel extends ScopeChannel> {
  /** Result of the existing caller-specific gate, evaluated before any acquisition. */
  admitted: boolean;
  provided: ProvidedCustody;
  signal: AbortSignal;
  deadline: number | null;
  scopeId?: string;
  connect(reply: ConnectionDescriptor, signal: AbortSignal): Promise<Channel>;
}

/**
 * Acquire the worker half only after gates. The scope channel stays separate
 * from the main writer. Actual argv and env can be sent only after this returns.
 */
export async function acquireWorkerCustody<Channel extends ScopeChannel>(
  options: WorkerOptions<Channel>
): Promise<{ channel: Channel; close(): Promise<void> }> {
  if (!options.admitted) throw new Error('OpenCode custody gate did not admit this caller');
  if (options.provided.kind !== 'available')
    throw new Error('OpenCode custody owner-private inbox is unavailable');
  const { run } = options.provided;
  const scopeId = options.scopeId ?? randomBytes(16).toString('hex');
  if (
    !validRunDescriptor(run) ||
    !/^[a-f0-9]{32}$/.test(scopeId) ||
    (options.deadline !== null &&
      (!Number.isSafeInteger(options.deadline) || options.deadline <= 0))
  )
    throw new Error('Invalid OpenCode custody worker metadata');
  if (options.signal.aborted || (options.deadline !== null && options.deadline <= Date.now()))
    throw new Error('OpenCode custody worker deadline or owner expired');

  const controller = new AbortController();
  const requestId = randomBytes(16).toString('hex');
  const inbox = await openOwnedInbox(options.provided.inbox);
  const coordinates = { requestId, scopeId };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectionAttempt: Promise<Channel | undefined> | undefined;
  let requested = false;
  let closing: Promise<void> | undefined;

  function expired() {
    return options.deadline !== null && options.deadline <= Date.now();
  }
  function requireCurrent() {
    if (controller.signal.aborted || expired())
      throw new Error('OpenCode custody worker deadline or owner expired');
  }
  function close() {
    if (closing) return closing;
    const progress: CloseProgress = { channel: 'pending', request: 'pending' };
    const runStep = (step: keyof CloseProgress, work: () => Promise<void>) =>
      Promise.resolve()
        .then(work)
        .then(
          () => {
            progress[step] = 'closed';
          },
          () => {
            progress[step] = 'failed';
          }
        );
    const steps = Promise.all([
      runStep('channel', async () => {
        const candidate = await connectionAttempt;
        await candidate?.close();
      }),
      runStep('request', async () => {
        if (!requested) return;
        await inbox.write(
          'cancel',
          requestId,
          encodeMetadata(run, { ...coordinates, kind: 'cancel' }),
          new AbortController().signal
        );
      }),
    ]);
    let joinTimer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      joinTimer = setTimeout(() => resolve(false), CLOSE_MS);
    });
    closing = Promise.race([steps.then(() => true), expired])
      .then((joined) => {
        if (!joined) throw new WorkerCleanupError(progress, 'deadline');
        if (progress.channel === 'failed' || progress.request === 'failed')
          throw new WorkerCleanupError(progress, 'adapter-failed');
      })
      .finally(() => clearTimeout(joinTimer));
    controller.abort();
    clearTimeout(timer);
    options.signal.removeEventListener('abort', ownerLost);
    process.off('disconnect', ownerLost);
    return closing;
  }
  function ownerLost() {
    void close().catch(() => undefined);
  }
  function armDeadline() {
    if (options.deadline === null) return;
    timer = setTimeout(
      () => {
        if (expired()) ownerLost();
        else armDeadline();
      },
      Math.min(2_147_483_647, Math.max(0, options.deadline - Date.now()))
    );
    timer.unref();
  }

  async function connectScoped(reply: ConnectionDescriptor) {
    connectionAttempt = Promise.resolve()
      .then(() => {
        requireCurrent();
        return options.connect(reply, controller.signal);
      })
      .catch(() => undefined);
    const ended = () => new Error('OpenCode custody worker deadline or owner expired');
    let abort!: () => void;
    const lost = new Promise<never>((_, reject) => {
      abort = () => reject(ended());
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const channel = await Promise.race([connectionAttempt, lost]);
      requireCurrent();
      if (!channel) throw new Error('OpenCode custody scope connection could not be established');
      return channel;
    } finally {
      controller.signal.removeEventListener('abort', abort);
    }
  }

  options.signal.addEventListener('abort', ownerLost, { once: true });
  process.once('disconnect', ownerLost);
  try {
    if (options.signal.aborted || process.connected === false) ownerLost();
    requireCurrent();
    armDeadline();
    // Mark before starting publication so cancellation cannot miss an in-flight request.
    requested = true;
    await inbox.write(
      'request',
      requestId,
      encodeMetadata(run, { ...coordinates, kind: 'acquire', deadline: options.deadline }),
      controller.signal
    );
    while (true) {
      requireCurrent();
      const bytes = await inbox.readReply(requestId);
      requireCurrent();
      if (!bytes) {
        await sleep(POLL_MS, undefined, { signal: controller.signal });
        continue;
      }
      const reply = decodeReply(run, coordinates, bytes);
      if (!reply) throw new Error('OpenCode custody reply could not be authenticated');
      if (reply.kind === 'refused')
        throw new Error(`OpenCode custody request refused (${reply.reason})`);
      const channel = await connectScoped(reply.connection);
      requireCurrent();
      clearTimeout(timer);
      return { channel, close };
    }
  } catch (error) {
    const primary =
      controller.signal.aborted && error instanceof Error && error.name === 'AbortError'
        ? new Error('OpenCode custody worker deadline or owner expired', { cause: error })
        : error;
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        'OpenCode custody worker failed and cleanup is uncertain',
        { cause: cleanup }
      );
    }
    throw primary;
  }
}
