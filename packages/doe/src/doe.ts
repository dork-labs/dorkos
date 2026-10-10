import { estimateInput, systemFingerprint } from './context-estimation.js';
import { cancellable } from './cancellation.js';
import type {
  BeatRequest,
  BeatResult,
  ContextScope,
  DoeConfig,
  DoeEvent,
  ExtensionContext,
  ModelMessage,
  ModelRunResult,
  ModelUsage,
  QueueDisposition,
  ScopedExecutionOptions,
} from './contracts.js';
import type { Engine, EngineFactory } from './engine.js';
import { businessPrompt } from './prompt.js';
import { PiEngine } from './pi-engine.js';
const locks = new WeakMap<object, Set<string>>();
const durableLocks = new Map<string, Set<string>>();
/** Standalone business agent facade; hosts own resources, tools, credentials and durable storage. */
export class Doe {
  private controller?: AbortController;
  private hostCancellation?: AbortController;
  private mainEngine?: Engine;
  private readonly engines = new Set<Engine>();
  private readonly ownedExecutions = new Set<Promise<ModelRunResult>>();
  private persistenceFailure?: { error: unknown };
  private readonly terminalEvents: DoeEvent[] = [];
  private readonly activeScopes = new Set<ContextScope>();
  /** Bind configuration without loading resources, resolving credentials or sending requests. */
  constructor(
    private readonly config: DoeConfig,
    private readonly factory: EngineFactory = () => new PiEngine()
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(config.sessionId))
      throw new Error('Invalid session id');
  }
  private emit = (event: DoeEvent): void => {
    if (this.controller && ['complete', 'aborted', 'error'].includes(event.type))
      this.terminalEvents.push(event);
    else this.config.onEvent?.(event);
  };
  private writeModelRecord<T>(write: () => T): T {
    try {
      return write();
    } catch (error) {
      // A caller may recover ordinary child errors, but failed durable model writes remain fatal.
      this.persistenceFailure ??= { error };
      throw error;
    }
  }
  private async exclusive<T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    operationScope: ContextScope = 'main',
    finalize?: (result: T) => void
  ): Promise<T> {
    const identity = this.config.store.identity;
    let sessions = identity ? durableLocks.get(identity) : locks.get(this.config.store);
    if (!sessions) {
      sessions = new Set();
      if (identity) durableLocks.set(identity, sessions);
      else locks.set(this.config.store, sessions);
    }
    if (sessions.has(this.config.sessionId)) throw new Error('Session already has active work');
    sessions.add(this.config.sessionId);
    this.controller = new AbortController();
    this.hostCancellation = new AbortController();
    const requested = signal
      ? AbortSignal.any([signal, this.hostCancellation.signal])
      : this.hostCancellation.signal;
    const combined = AbortSignal.any([requested, this.controller.signal]);
    let result: T;
    let failure: { error: unknown } | undefined;
    try {
      try {
        combined.throwIfAborted();
        this.config.store.createSession(this.config.sessionId);
        result = await operation(combined);
      } catch (error) {
        failure = { error };
        this.emit({
          type: combined.aborted ? 'aborted' : 'error',
          scope: operationScope,
          error: error instanceof Error ? error.message : 'Run failed',
        });
      }
      // Host callbacks may be abandoned on cancellation; engines started by this facade remain owned.
      const cancelledBeforeDrain = requested.aborted;
      this.controller?.abort();
      while (this.ownedExecutions.size) {
        const pending = [...this.ownedExecutions];
        this.ownedExecutions.clear();
        await Promise.allSettled(pending);
      }
      if (this.persistenceFailure) failure = this.persistenceFailure;
      let hostCancelled = false;
      // Internal cleanup abort is not a host cancellation; later host cancellation still vetoes success.
      if (!failure && requested.aborted && (finalize || !cancelledBeforeDrain)) {
        failure = { error: requested.reason };
        hostCancelled = true;
      }
      let finalizationFailed = false;
      if (!failure && finalize) {
        try {
          finalize(result!);
        } catch (error) {
          failure = { error };
          finalizationFailed = true;
        }
      }
      if (this.persistenceFailure || finalizationFailed || hostCancelled) {
        const { error } = failure!;
        const remaining = this.terminalEvents.filter(
          (event) => event.scope !== operationScope && event.type !== 'complete'
        );
        this.terminalEvents.splice(0, this.terminalEvents.length, ...remaining, {
          type: hostCancelled ? 'aborted' : 'error',
          scope: operationScope,
          error:
            error instanceof Error
              ? error.message
              : hostCancelled
                ? 'Aborted'
                : 'Model persistence failed',
        });
      }
      for (const event of this.terminalEvents.splice(0)) {
        try {
          this.config.onEvent?.(event);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
      return result!;
    } finally {
      this.persistenceFailure = undefined;
      this.terminalEvents.length = 0;
      sessions.delete(this.config.sessionId);
      if (identity && sessions.size === 0) durableLocks.delete(identity);
      this.controller = undefined;
      this.hostCancellation = undefined;
      this.mainEngine = undefined;
    }
  }

  private context(
    scope: ContextScope,
    signal: AbortSignal,
    messages: readonly ModelMessage[] = []
  ): ExtensionContext {
    return {
      config: this.config,
      scope,
      signal,
      messages,
      records: this.config.store.restore(this.config.sessionId, scope).messages,
      prompt: '',
      tools: [],
      emit: this.emit,
      execute: (options) => this.executeScoped(options, signal),
    };
  }
  private executeScoped(
    options: ScopedExecutionOptions,
    signal: AbortSignal
  ): Promise<ModelRunResult> {
    if (options.scope === 'main')
      return Promise.reject(new Error('Bound execution cannot start main scope'));
    if (!this.controller)
      return Promise.reject(new Error('Bound execution requires an active parent'));
    const execution = this.execute(options, signal);
    this.ownedExecutions.add(execution);
    // The caller may abandon its own wait. Observe rejection immediately and drain ownership later.
    void execution.catch(() => {});
    return execution;
  }
  private async execute(
    options: ScopedExecutionOptions,
    parent: AbortSignal
  ): Promise<ModelRunResult> {
    const signal = options.signal ? AbortSignal.any([parent, options.signal]) : parent;
    signal.throwIfAborted();
    const model = options.model ?? this.config.model;
    if (
      model.payer !== this.config.model.payer ||
      model.historyFamily !== this.config.model.historyFamily ||
      model.protocol !== this.config.model.protocol
    )
      throw new Error('Scoped model must preserve payer and history compatibility');
    const resources = options.resources ?? this.config.resources;
    const workingDirectory = options.workingDirectory ?? this.config.workingDirectory;
    const scope = options.scope;
    const usage: ModelUsage[] = [];
    let currentPrompt = options.prompt;
    let currentTools = options.registry?.selected() ?? options.tools;
    if (this.activeScopes.has(scope)) throw new Error('Scope already active');
    this.activeScopes.add(scope);
    try {
      for (const message of options.messages)
        this.writeModelRecord(() =>
          this.config.store.appendMessage(this.config.sessionId, message, scope)
        );
      const engine = this.factory();
      this.engines.add(engine);
      if (scope === 'main') this.mainEngine = engine;
      const abort = () => engine.abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await engine.run({
          prompt: options.prompt,
          model,
          messages: this.config.store
            .restore(this.config.sessionId, scope)
            .messages.map((record) => record.payload),
          tools: options.registry?.selected() ?? options.tools,
          context: {
            sessionId: this.config.sessionId,
            scope,
            workingDirectory,
            signal,
            emit: this.emit,
            execute: (options) => this.executeScoped(options, signal),
          },
          signal,
          approve: this.config.approve,
          retry: this.config.retry,
          purpose: options.purpose,
          onEvent: this.emit,
          onMessage: async (message) => {
            this.writeModelRecord(() =>
              this.config.store.appendMessage(this.config.sessionId, message, scope)
            );
          },
          onUsage: async (record) => {
            const restored = this.config.store.restore(this.config.sessionId, scope);
            const complete = {
              ...record,
              purpose: options.purpose,
              contextMessageSeq:
                restored.messages.filter((record) => record.seq > 0).at(-1)?.seq ?? 0,
              contextCheckpointSeq: restored.checkpoint?.seq ?? 0,
              contextSystemHash: systemFingerprint(
                currentPrompt,
                currentTools,
                restored.messages.map((record) => record.payload)
              ),
              contextEstimateTokens: estimateInput(
                currentPrompt,
                currentTools,
                restored.messages.map((record) => record.payload)
              ).tokens,
            };
            this.writeModelRecord(() =>
              this.config.store.recordUsage(this.config.sessionId, complete, scope)
            );
            usage.push(complete);
            this.emit({ type: 'usage', scope, usage: complete });
          },
          prepareRequest: async (messages, requestSignal) => {
            requestSignal.throwIfAborted();
            const loaded =
              options.purpose === 'summary'
                ? ''
                : await cancellable(resources.load(), requestSignal);
            requestSignal.throwIfAborted();
            const prompt =
              scope === 'main'
                ? businessPrompt(this.config.profile, loaded)
                : `${options.prompt}${loaded ? '\n\n' + loaded : ''}`;
            const tools =
              scope === 'main'
                ? this.config.registry.selected()
                : (options.registry?.selected() ?? options.tools);
            currentPrompt = prompt;
            currentTools = tools;
            if (options.purpose !== 'summary')
              await this.config.extensions?.beforeRequest?.({
                ...this.context(scope, requestSignal, messages),
                prompt,
                tools,
              });
            return {
              prompt,
              messages: this.config.store
                .restore(this.config.sessionId, scope)
                .messages.map((record) => record.payload),
              tools,
            };
          },
          ...(options.finishTurn ? { finishTurn: options.finishTurn } : {}),
        });
        return { ...result, usage };
      } finally {
        signal.removeEventListener('abort', abort);
        this.engines.delete(engine);
        if (this.mainEngine === engine) this.mainEngine = undefined;
      }
    } finally {
      this.activeScopes.delete(scope);
    }
  }
  /** Run one user message; concurrent work on the same durable session is refused. */
  async run(
    input: string | ModelMessage,
    options: { signal?: AbortSignal } = {}
  ): Promise<ModelRunResult> {
    return this.exclusive(options.signal, async (signal) => {
      const resources = await cancellable(this.config.resources.load(), signal);
      const message =
        typeof input === 'string' ? { role: 'user', content: input, timestamp: Date.now() } : input;
      const result = await this.execute(
        {
          prompt: businessPrompt(this.config.profile, resources),
          messages: [message],
          tools: this.config.registry.selected(),
          scope: 'main',
          purpose: 'run',
        },
        signal
      );
      this.emit({
        type:
          result.stopReason === 'aborted'
            ? 'aborted'
            : result.stopReason === 'error'
              ? 'error'
              : 'complete',
        scope: 'main',
      });
      return result;
    });
  }
  /** Queue steering through Pi's existing queue; idle means no underlying run accepts it. */
  steer(input: string | ModelMessage): QueueDisposition {
    return (
      this.mainEngine?.steer(
        typeof input === 'string' ? { role: 'user', content: input, timestamp: Date.now() } : input
      ) ?? 'idle'
    );
  }
  /** Queue follow-up through Pi's existing queue after natural completion. */
  followUp(input: string | ModelMessage): QueueDisposition {
    return (
      this.mainEngine?.followUp(
        typeof input === 'string' ? { role: 'user', content: input, timestamp: Date.now() } : input
      ) ?? 'idle'
    );
  }
  /** Cancel this facade's active parent, children, pending approvals and tools. */
  abort(): void {
    this.hostCancellation?.abort();
    this.controller?.abort();
    for (const engine of this.engines) engine.abort();
  }
  /** Delegate manual compaction to the host-attached module under the session lock. */
  compact(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.exclusive(options.signal, async (signal) => {
      if (!this.config.extensions?.compact) throw new Error('Compaction extension is not attached');
      const loaded = await cancellable(this.config.resources.load(), signal);
      signal.throwIfAborted();
      await this.config.extensions.compact({
        ...this.context(
          'main',
          signal,
          this.config.store.restore(this.config.sessionId).messages.map((record) => record.payload)
        ),
        prompt: businessPrompt(this.config.profile, loaded),
        tools: this.config.registry.selected(),
      });
    });
  }
  /** Run an isolated beat; commit its outcome and completion only after owned work drains. */
  async runBeat(request: BeatRequest): Promise<BeatResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.id)) throw new Error('Invalid beat id');
    const scope = `beat:${request.id}` as const;
    return this.exclusive(
      request.signal,
      async (signal) => {
        if (!this.config.extensions?.runBeat) throw new Error('Beat extension is not attached');
        return this.config.extensions.runBeat(request, this.context(scope, signal));
      },
      scope,
      (result) => {
        this.config.store.recordOutcome(this.config.sessionId, result, scope);
        this.emit({ type: 'complete', scope });
      }
    );
  }
}
