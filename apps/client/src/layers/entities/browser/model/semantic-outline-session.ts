import {
  SemanticActionV1Schema,
  SemanticSnapshotV1Schema,
  SemanticEventV1Schema,
  SemanticReceiptV1Schema,
  SemanticEditCorrelationV1Schema,
  type SemanticEventV1,
  type SemanticSnapshotV1,
  type SemanticNodeV1,
  type SemanticActionV1,
} from '@dorkos/shared/browser-semantic-schemas';
import type {
  BrowserSemanticTransport,
  BrowserSemanticScope,
  BrowserSemanticStream,
} from '@dorkos/shared/transport';
export interface SemanticOutlineState {
  readonly snapshot?: SemanticSnapshotV1;
  readonly pending: boolean;
  readonly stale: boolean;
  readonly failed: boolean;
  /** Expiry retains a local target only; it grants no authority to act. */
  readonly expired?: boolean;
  /** One exact focused field; other outline refs stay suspended. */
  readonly continuedRef?: string;
}
/** Local RAM-only outline lifetime; secret text is never retained in this model. */
export class SemanticOutlineSession {
  private state: SemanticOutlineState = Object.freeze({
    pending: false,
    stale: true,
    failed: false,
  });
  private readonly listeners = new Set<() => void>();
  private readonly originals = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private stream?: BrowserSemanticStream;
  private streamSetup?: Promise<BrowserSemanticStream>;
  private streamSignal?: AbortSignal;
  private streamCancellation?: AbortController;
  private closing?: Promise<void>;
  private first?: Readonly<{ value: unknown }>;
  private closed = false;
  private readonly cancellation = new Error('SEMANTIC_LOCAL_CANCELLED');
  private sequence = 0;
  private reading = false;
  private snapshotController?: string;
  private continuationDeadline = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  private edit?: {
    request: SemanticActionV1;
    previousEventSequence: number;
    events: SemanticEventV1[];
    invalid: boolean;
    wake?: () => void;
  };
  private invalidateEdit() {
    this.continuationDeadline = 0;
    clearTimeout(this.expiry);
    if (this.edit) {
      this.edit.invalid = true;
      this.edit.wake?.();
    }
  }
  constructor(
    private readonly delivery: BrowserSemanticTransport,
    private readonly scope: BrowserSemanticScope,
    private readonly control: () => string | undefined,
    loss: AbortSignal
  ) {
    const abort = () => {
      // Admission is fenced synchronously; the same retained close joins late stream birth and remote cleanup.
      void this.close().catch(() => {});
    };
    const add = loss.addEventListener.bind(loss),
      remove = loss.removeEventListener.bind(loss);
    this.removeLoss = () => remove('abort', abort);
    add('abort', abort, { once: true });
    if (loss.aborted) abort();
  }
  private readonly removeLoss: () => void;
  readonly snapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: SemanticOutlineState) {
    this.state = Object.freeze(value);
    for (const listener of this.listeners) listener();
  }
  private checkLive(signal: AbortSignal = this.controller.signal): void {
    if (this.first) throw this.first.value;
    if (this.closed) throw this.cancellation;
    signal.throwIfAborted();
  }
  private own<T>(
    producer: () => Promise<T>,
    signal: AbortSignal = this.controller.signal,
    known: (value: unknown) => boolean = () => false
  ): Promise<T> {
    const original = Promise.resolve().then(() => {
      this.checkLive(signal);
      return producer();
    });
    this.originals.add(original);
    void original.then(
      () => this.originals.delete(original),
      (value) => {
        if (
          !known(value) &&
          !(
            Object.is(value, this.cancellation) &&
            (this.closed || (signal.aborted && Object.is(signal.reason, value)))
          )
        )
          this.first ??= { value };
        this.originals.delete(original);
      }
    );
    return original;
  }
  /** Explicit user read; no disclosure enters at mount or on a transport change. */
  read(): Promise<void> {
    if (this.first) return Promise.reject(this.first.value);
    if (this.closed || this.reading || this.state.pending)
      return Promise.reject(new Error('SEMANTIC_LOCAL_CLOSED'));
    this.reading = true;
    return this.own(async () => {
      try {
        this.checkLive();
        this.publish({ pending: true, stale: true, failed: false });
        this.checkLive();
        const controllerId = this.control();
        const value = await this.freshRead();
        if (this.control() !== controllerId) throw new Error('SEMANTIC_TARGET_CHANGED');
        this.checkLive();
        this.snapshotController = controllerId;
        this.publish({
          snapshot: value,
          pending: false,
          stale: false,
          failed: false,
        });
      } catch (value) {
        if (!Object.is(value, this.cancellation)) this.first ??= { value };
        if (!this.closed) {
          try {
            this.publish({ pending: false, stale: true, failed: true });
          } catch (failure) {
            this.first ??= { value: failure };
          }
        }
        throw value;
      } finally {
        this.reading = false;
      }
    });
  }
  private matchesBinding(value: SemanticSnapshotV1) {
    return Object.entries(this.scope.binding).every(
      ([key, part]) => value[key as keyof SemanticSnapshotV1] === part
    );
  }
  private async freshRead(): Promise<SemanticSnapshotV1> {
    this.invalidateEdit();
    const old = this.stream,
      oldSignal = this.streamSignal;
    this.stream = undefined;
    this.streamSignal = undefined;
    this.streamCancellation?.abort(this.cancellation);
    this.streamCancellation = undefined;
    if (old)
      try {
        await old.close();
      } catch (value) {
        if (!(
          oldSignal?.aborted &&
          Object.is(oldSignal.reason, this.cancellation) &&
          Object.is(value, this.cancellation)
        ))
          throw value;
      }
    this.checkLive();
    const read = this.delivery.readBrowserSemantic.bind(this.delivery);
    this.checkLive();
    const value = SemanticSnapshotV1Schema.parse(await read(this.scope, this.controller.signal));
    this.checkLive();
    if (!this.matchesBinding(value)) throw new Error('SEMANTIC_BINDING_MISMATCH');
    const cancellation = new AbortController(),
      signal = AbortSignal.any([this.controller.signal, cancellation.signal]);
    this.streamCancellation = cancellation;
    this.streamSignal = signal;
    this.sequence = 0;
    const setup = (this.streamSetup = Promise.resolve().then(() => {
      this.checkLive(signal);
      const open = this.delivery.openBrowserSemanticStream.bind(this.delivery);
      this.checkLive(signal);
      return open(this.scope, value.semanticLeaseId, signal);
    }));
    const stream = await setup;
    this.stream = stream;
    this.checkLive(signal);
    void this.watch(stream, signal).catch(() => {
      if (!this.closed && this.stream === stream)
        this.publish({ pending: false, stale: true, failed: true });
    });
    return value;
  }
  private watch(stream: BrowserSemanticStream, signal: AbortSignal): Promise<void> {
    return this.own(async () => {
      while (!this.closed && this.stream === stream) {
        this.checkLive(signal);
        const next = stream.next.bind(stream);
        this.checkLive(signal);
        const event = await next(signal);
        this.checkLive(signal);
        if (event) {
          const parsed = SemanticEventV1Schema.parse(event);
          if (
            parsed.eventStreamId !== stream.eventStreamId ||
            parsed.sequence !== ++this.sequence ||
            Object.entries(this.scope.binding).some(
              ([key, value]) => parsed.identity[key as keyof typeof parsed.identity] !== value
            )
          )
            throw new Error('SEMANTIC_STREAM_ORDER');
          if (parsed.type === 'ready' && this.edit) {
            if (this.edit.events.length) this.invalidateEdit();
            else this.edit.previousEventSequence = parsed.sequence;
          }
          if (parsed.type !== 'ready') {
            const edit = this.edit;
            if (
              edit &&
              !edit.invalid &&
              (parsed.type === 'dirty' ||
                (parsed.type === 'focusChanged' && parsed.reason === 'selectionChanged')) &&
              parsed.editRequestId === edit.request.requestId &&
              edit.events.length < 128
            ) {
              edit.events.push(parsed);
              edit.wake?.();
              // Keep local editor focus, but admit no second commit before receipt + watermark.
              continue;
            }
            this.invalidateEdit();
            const expired = parsed.type === 'reset' && parsed.reason === 'leaseExpired';
            const prior = this.state.snapshot;
            const retained = prior?.nodes.filter(
              (node) =>
                node.nodeRef === prior.focusedRef &&
                node.editKind === 'secret' &&
                node.states.focused
            );
            this.publish({
              ...(expired && prior && retained?.length === 1
                ? {
                    snapshot: {
                      ...prior,
                      nodes: retained,
                      rootRefs: [retained[0].nodeRef],
                    },
                    expired: true,
                  }
                : {}),
              pending: false,
              stale: true,
              failed: false,
            });
            if (!expired) return;
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    }, signal);
  }
  /** One current action. No action/request is persisted or published to subscribers. */
  act(node: SemanticNodeV1, action: SemanticActionV1['action']): Promise<void> {
    if (this.first) return Promise.reject(this.first.value);
    const current = this.state.snapshot,
      stream = this.stream;
    if (
      this.closed ||
      this.reading ||
      this.state.pending ||
      (this.state.stale && (!this.state.expired || action.kind !== 'writeSecret')) ||
      !current ||
      !stream ||
      !node.actions.includes(action.kind)
    )
      return Promise.reject(new Error('SEMANTIC_ACTION_REFUSED'));
    this.reading = true;
    const targetChanged = new Error('SEMANTIC_TARGET_CHANGED');
    return this.own(
      async () => {
        try {
          this.checkLive();
          const controllerId = this.control();
          this.checkLive();
          if (!controllerId || controllerId !== this.snapshotController) throw targetChanged;
          this.publish({ ...this.state, pending: true });
          this.checkLive();
          const continuing =
            this.state.continuedRef === node.nodeRef && Date.now() < this.continuationDeadline;
          if (this.state.continuedRef && !continuing) throw targetChanged;
          const fresh = continuing ? current : await this.freshRead();
          const target = fresh.nodes.find((value) => value.nodeRef === node.nodeRef);
          if (
            !target ||
            fresh.treeId !== current.treeId ||
            target.frameId !== node.frameId ||
            target.frameNavigationGeneration !== node.frameNavigationGeneration ||
            target.role !== node.role ||
            target.editKind !== node.editKind ||
            !target.actions.includes(action.kind) ||
            (action.kind === 'writeSecret' &&
              (!target.states.focused || fresh.focusedRef !== target.nodeRef))
          )
            throw targetChanged;
          const identity = {
            version: fresh.version,
            browserId: fresh.browserId,
            browserGeneration: fresh.browserGeneration,
            tabId: fresh.tabId,
            navigationGeneration: fresh.navigationGeneration,
            viewportVersion: fresh.viewportVersion,
            treeId: fresh.treeId,
            treeRevision: fresh.treeRevision,
            epoch: fresh.epoch,
            inputGeneration: fresh.inputGeneration,
            grantRevision: fresh.grantRevision,
            semanticLeaseId: fresh.semanticLeaseId,
          };
          const edit =
            ['insertText', 'replaceText', 'writeSecret'].includes(action.kind) ||
            (action.kind === 'key' && target.editKind === 'plainText');
          const originalStream = this.stream;
          if (!originalStream || this.control() !== controllerId) throw targetChanged;
          this.checkLive();
          const request = SemanticActionV1Schema.parse({
            requestId: crypto.randomUUID(),
            identity,
            frameId: target.frameId,
            frameNavigationGeneration: target.frameNavigationGeneration,
            nodeRef: target.nodeRef,
            focusRevision: fresh.focusRevision,
            ...(edit ? { eventStreamId: originalStream.eventStreamId } : {}),
            action,
          });
          this.checkLive();
          const started = Date.now();
          const pendingEdit = edit
            ? {
                request,
                previousEventSequence: this.sequence,
                events: [] as SemanticEventV1[],
                invalid: false,
                wake: undefined as (() => void) | undefined,
              }
            : undefined;
          this.edit = pendingEdit;
          this.continuationDeadline = 0;
          clearTimeout(this.expiry);
          const act = this.delivery.actionBrowserSemantic.bind(this.delivery);
          this.checkLive();
          const result = SemanticReceiptV1Schema.parse(
            await act(
              this.scope,
              controllerId,
              request,
              edit
                ? AbortSignal.any([this.controller.signal, AbortSignal.timeout(2000)])
                : this.controller.signal
            )
          );
          this.checkLive();
          if (result.requestId !== request.requestId)
            throw new Error('SEMANTIC_ACTION_UNCONFIRMED');
          // An admitted refusal requires an explicit read; it does not poison the local transport.
          if (result.outcome !== 'completed') throw targetChanged;
          const continuation = result.editContinuation;
          if (pendingEdit && continuation) {
            const deadline = Math.min(started + 2000, Date.now() + continuation.expiresInMs);
            while (!pendingEdit.invalid && this.sequence < continuation.coveredEventSequence) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw targetChanged;
              await new Promise<void>((resolve) => {
                const wake = () => {
                  clearTimeout(timeout);
                  this.controller.signal.removeEventListener('abort', wake);
                  pendingEdit.wake = undefined;
                  resolve();
                };
                const timeout = setTimeout(wake, remaining);
                pendingEdit.wake = wake;
                this.controller.signal.addEventListener('abort', wake, { once: true });
              });
              this.checkLive();
            }
            if (pendingEdit.invalid || this.control() !== controllerId || Date.now() >= deadline)
              throw targetChanged;
            SemanticEditCorrelationV1Schema.parse({
              request,
              receipt: result,
              previousEventSequence: pendingEdit.previousEventSequence,
              events: pendingEdit.events,
            });
            this.checkLive();
            if (this.control() !== controllerId) throw targetChanged;
            // Receipt confirms only authority, never page content or an edited value.
            const { value: _value, text: _text, description: _description, ...safeTarget } = target;
            const next = {
              ...safeTarget,
              nodeRef: continuation.nodeRef,
              parentRef: null,
              childRefs: [],
              actions: [...continuation.allowedKinds],
              states: { ...target.states, focused: true },
            };
            this.edit = undefined;
            this.continuationDeadline = deadline;
            this.expiry = setTimeout(() => {
              this.invalidateEdit();
              if (!this.closed) this.publish({ pending: false, stale: true, failed: false });
            }, deadline - Date.now());
            this.publish({
              snapshot: {
                ...fresh,
                ...continuation.identity,
                capturedAt: new Date().toISOString(),
                expiresInMs: Math.max(1, deadline - Date.now()),
                nodes: [next],
                rootRefs: [next.nodeRef],
                focusRevision: continuation.focusRevision,
                focusedRef: next.nodeRef,
                focusState: 'node',
              },
              continuedRef: next.nodeRef,
              pending: false,
              stale: false,
              failed: false,
            });
          } else {
            this.invalidateEdit();
            this.publish({ pending: false, stale: true, failed: false });
          }
        } catch (value) {
          this.invalidateEdit();
          if (
            !Object.is(value, targetChanged) &&
            !(
              Object.is(value, this.cancellation) &&
              (this.closed ||
                (this.controller.signal.aborted && Object.is(this.controller.signal.reason, value)))
            )
          )
            this.first ??= { value };
          if (!this.closed)
            try {
              this.publish({ pending: false, stale: true, failed: true });
            } catch (failure) {
              this.first ??= { value: failure };
            }
          throw value;
        } finally {
          this.edit = undefined;
          this.reading = false;
        }
      },
      this.controller.signal,
      (value) => Object.is(value, targetChanged)
    );
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.invalidateEdit();
    this.closing = Promise.resolve().then(async () => {
      try {
        this.controller.abort(this.cancellation);
      } catch (value) {
        this.first ??= { value };
      }
      try {
        this.publish({ pending: false, stale: true, failed: false });
      } catch (value) {
        this.first ??= { value };
      }
      try {
        this.streamCancellation?.abort(this.cancellation);
      } catch (value) {
        this.first ??= { value };
      }
      const setup = this.streamSetup;
      let stream = this.stream;
      if (setup)
        try {
          stream = await setup;
        } catch (value) {
          if (!Object.is(value, this.cancellation)) this.first ??= { value };
        }
      const close = stream ? Promise.resolve().then(() => stream.close()) : undefined;
      await Promise.allSettled([...this.originals]);
      if (close)
        try {
          await close;
        } catch (value) {
          if (!Object.is(value, this.cancellation)) this.first ??= { value };
        }
      try {
        this.removeLoss();
      } catch (value) {
        if (!Object.is(value, this.cancellation)) this.first ??= { value };
      }
      if (this.first) throw this.first.value;
    });
    return this.closing;
  }
}
