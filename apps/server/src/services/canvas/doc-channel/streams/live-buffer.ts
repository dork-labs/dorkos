/** Bounded scope hints wake authorized readers; durable document rows remain the history. */
import type { DocChannelActor } from '../authorization.js';
import type { DocChannelStore } from '../store.js';

/** A committed high watermark, never a transcript or room entry cursor. */
export interface DocChannelHint {
  documentId: string;
  scope: string;
  highWatermark: number;
}
/** Current scope authority is required before subscribing and before each disclosure. */
export interface DocChannelStreamAuthority {
  resolveScope(scope: string): string;
  requireScopeCurrent(scope: string, actor: DocChannelActor): undefined;
}
interface Reader {
  scope: string;
  actor: DocChannelActor;
  pending: Map<string, DocChannelHint>;
  wake: (() => void) | undefined;
  ended: boolean;
  detach?: () => void;
}

/** Subscribe synchronously before capturing replay high watermarks. */
export class DocChannelLiveBuffer {
  private readonly readers = new Set<Reader>();
  /** Reuse the production channel store and its current canonical scope authority. */
  constructor(
    private readonly store: DocChannelStore,
    private readonly authority: DocChannelStreamAuthority,
    private readonly maxBufferedDocuments = 1000
  ) {
    if (!Number.isInteger(maxBufferedDocuments) || maxBufferedDocuments < 1)
      throw new RangeError('Invalid document stream buffer limit.');
  }
  /** Call only after the surrounding SQLite transaction has committed. */
  notifyCommitted(documentId: string): void {
    const channel = this.store.getChannel(documentId);
    if (!channel || channel.closedAt !== null) return;
    const hint = {
      documentId,
      scope: channel.scope,
      highWatermark: channel.nextDocSeq - 1,
    };
    for (const reader of this.readers) {
      if (reader.ended) continue;
      try {
        if (this.resolveScope(reader.scope) !== hint.scope) continue;
        this.requireCurrent(hint.scope, reader.actor);
      } catch {
        this.end(reader);
        continue;
      }
      if (!reader.pending.has(documentId) && reader.pending.size >= this.maxBufferedDocuments) {
        // Closing makes the reader replay durable rows instead of silently dropping a gap.
        this.end(reader);
        continue;
      }
      const previous = reader.pending.get(documentId);
      if (!previous || hint.highWatermark > previous.highWatermark)
        reader.pending.set(documentId, hint);
      reader.wake?.();
      reader.wake = undefined;
    }
  }
  /** Attach immediately; iterator creation must not defer the replay/live cutover. */
  subscribe(
    scope: string,
    actor: DocChannelActor,
    signal: AbortSignal
  ): AsyncIterable<DocChannelHint> {
    scope = this.resolveScope(scope);
    this.requireCurrent(scope, actor);
    const reader: Reader = {
      scope,
      actor,
      pending: new Map(),
      wake: undefined,
      ended: signal.aborted,
    };
    const abort = () => this.end(reader);
    if (!reader.ended) {
      this.readers.add(reader);
      signal.addEventListener('abort', abort, { once: true });
      reader.detach = () => signal.removeEventListener('abort', abort);
    }
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      this.end(reader);
    };
    const next = async (): Promise<IteratorResult<DocChannelHint>> => {
      for (;;) {
        if (reader.ended) return { done: true, value: undefined };
        const first = reader.pending.entries().next();
        if (!first.done) {
          const [id, hint] = first.value;
          reader.pending.delete(id);
          try {
            this.requireCurrent(hint.scope, actor);
          } catch {
            cleanup();
            return { done: true, value: undefined };
          }
          return { done: false, value: hint };
        }
        await new Promise<void>((resolve) => {
          reader.wake = resolve;
        });
      }
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next,
        return: async () => {
          cleanup();
          return { done: true, value: undefined };
        },
      }),
    };
  }
  private resolveScope(scope: string): string {
    const result: unknown = this.authority.resolveScope(scope);
    if (typeof result !== 'string' || !result || result.length > 200) {
      observeUnexpectedPromise(result);
      throw new Error('Document stream scope is unavailable.');
    }
    return result;
  }
  private requireCurrent(scope: string, actor: DocChannelActor): void {
    const result: unknown = this.authority.requireScopeCurrent(scope, actor);
    if (result !== undefined) {
      observeUnexpectedPromise(result);
      throw new Error('Document stream authority must be synchronous.');
    }
  }
  private end(reader: Reader): void {
    reader.detach?.();
    reader.detach = undefined;
    reader.ended = true;
    reader.pending.clear();
    this.readers.delete(reader);
    reader.wake?.();
    reader.wake = undefined;
  }
}

/** Observe rejected asynchronous ports while refusing their authority immediately. */
function observeUnexpectedPromise(value: unknown): void {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value)
    void Promise.resolve(value).catch(() => {});
}
