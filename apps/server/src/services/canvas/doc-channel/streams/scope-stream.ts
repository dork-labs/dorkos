/** Authorized document notifications multiplexed onto an existing scope stream. */
import type { CanvasChannelNotification } from '@dorkos/shared/canvas-channel-schemas';
import type { CanvasDocumentStore } from '../../canvas-document-store.js';
import type { DocChannelActor } from '../authorization.js';
import type { DocChannelService } from '../service.js';
import { DocChannelLiveBuffer } from './live-buffer.js';
import type { DocScopeNotificationStream } from './registry.js';

/** Existing scope authorization remains mandatory before even listing document IDs. */
export interface DocScopeStreamPorts {
  resolveScope(scope: string): string;
  requireScopeCurrent(scope: string, actor: DocChannelActor): undefined;
  requireDocumentCurrent(documentId: string, scope: string, actor: DocChannelActor): undefined;
}
/** Capture live hints before durable replay; payloads always come from current authorized storage. */
export class DocScopeStream {
  constructor(
    private readonly documents: CanvasDocumentStore,
    private readonly service: DocChannelService,
    private readonly live: DocChannelLiveBuffer,
    private readonly ports: DocScopeStreamPorts
  ) {}

  /** Attach eagerly so a commit during asynchronous scope hydration remains buffered. */
  subscribe(
    scope: string,
    actor: DocChannelActor,
    signal: AbortSignal
  ): DocScopeNotificationStream {
    const cancellation = new AbortController();
    const hints = this.live.subscribe(scope, actor, AbortSignal.any([signal, cancellation.signal]));
    const iterator = hints[Symbol.asyncIterator]();
    const generator = async function* (this: DocScopeStream) {
      const cursors = new Map<string, number>();
      try {
        this.requireCurrent(scope, actor);
        const currentScope = this.resolveScope(scope);
        const documents = this.documents.identities(currentScope, 1001);
        if (documents.length > 1000) throw new Error('Document scope replay exceeds its bound.');
        for (const document of documents) {
          if (signal.aborted) return;
          yield* this.replay(document.id, scope, actor, cursors, signal);
        }
        for (;;) {
          const hint = await iterator.next();
          if (hint.done || signal.aborted) return;
          yield* this.replay(hint.value.documentId, scope, actor, cursors, signal);
        }
      } finally {
        await iterator.return?.();
      }
    }.call(this);
    const wrapped: AsyncIterator<CanvasChannelNotification> = {
      next: () => generator.next(),
      return: async () => {
        cancellation.abort();
        await iterator.return?.();
        return generator.return(undefined);
      },
    };
    return {
      [Symbol.asyncIterator]: () => wrapped,
      prepareForSend: (notification) => {
        if (signal.aborted || cancellation.signal.aborted)
          throw new Error('Document stream ended.');
        this.requireCurrent(scope, actor, notification.documentId);
        const currentScope = this.resolveScope(scope);
        const identity = this.documents.lookupIdentity(notification.documentId);
        if (!identity || identity.scope !== currentScope)
          throw new Error('Document scope changed.');
        return { ...notification, scope: currentScope };
      },
    };
  }

  private resolveScope(scope: string): string {
    const current = this.ports.resolveScope(scope);
    if (typeof current !== 'string' || current.length === 0 || current.length > 200) {
      void Promise.resolve(current).catch(() => {});
      throw new Error('Invalid document scope identity.');
    }
    return current;
  }

  private requireCurrent(scope: string, actor: DocChannelActor, documentId?: string): void {
    const result = this.ports.requireScopeCurrent(scope, actor);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw new Error('Invalid document scope authority.');
    }
    if (documentId !== undefined) {
      const current = this.ports.requireDocumentCurrent(
        documentId,
        this.resolveScope(scope),
        actor
      );
      if (current !== undefined) {
        void Promise.resolve(current).catch(() => {});
        throw new Error('Invalid document read authority.');
      }
    }
  }

  private async *replay(
    documentId: string,
    scope: string,
    actor: DocChannelActor,
    cursors: Map<string, number>,
    signal: AbortSignal
  ): AsyncGenerator<CanvasChannelNotification> {
    // Full snapshots also repair status/state changes that have no newer transcript cursor.
    let since = cursors.get(documentId) ?? 0;
    let target: number | undefined;
    for (;;) {
      this.requireCurrent(scope, actor, documentId);
      const snapshot = await this.service.replay(documentId, actor, since, 200);
      if (signal.aborted) return;
      this.requireCurrent(scope, actor, documentId);
      const currentScope = this.resolveScope(scope);
      const identity = this.documents.lookupIdentity(documentId);
      if (!identity || identity.scope !== currentScope) throw new Error('Document scope changed.');
      // Freeze one replay cutover so continuous commits cannot starve live delivery.
      const cutoff = target ?? snapshot.highWatermark;
      target = cutoff;
      const { events: pageEvents, ...current } = snapshot;
      const events = pageEvents.filter((event) => event.docSeq <= cutoff);
      yield { type: 'canvas_channel_snapshot', scope: currentScope, documentId, snapshot: current };
      for (const event of events) {
        if (signal.aborted) return;
        this.requireCurrent(scope, actor, documentId);
        // A canonical rekey may happen while replay or the preceding frame is awaited.
        yield { ...event, scope: this.resolveScope(scope) };
      }
      // Receipt summaries can be ordered newest-first on reset; they never advance payload replay.
      const last = Math.max(since, ...events.map((event) => event.docSeq));
      if (last >= target || pageEvents.length < 200) {
        cursors.set(documentId, target);
        return;
      }
      if (last <= since) throw new Error('Document replay made no progress.');
      since = last;
    }
  }
}
