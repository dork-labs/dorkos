import type { RuntimeRegistry } from '../runtime-registry.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { Db } from '@dorkos/db';
import {
  readClaudeOriginalLockedStream,
  readClaudeOriginalLockedTurnOptions,
} from '../../runtimes/claude-code/claude-code-runtime.js';
import {
  readCodexOriginalLockedStream,
  readCodexOriginalLockedTurnOptions,
} from '../../runtimes/codex/codex-runtime.js';
import {
  readOpenCodeOriginalLockedStream,
  readOpenCodeOriginalLockedTurnOptions,
} from '../../runtimes/opencode/opencode-runtime.js';
import {
  readTestModeOriginalNativeStream,
  readTestModeOriginalNativeTurnOptions,
  readTestModeOriginalStopTerminalData,
} from '../../runtimes/test-mode/test-mode-runtime.js';
import {
  recordRuntimeTurnLevel,
  countRecordedRuntimeTurnStream,
} from '../turn-power/turn-levels.js';

/** Each call owns isolated custody. Only the registry module's private instance authenticates its runtimes. */
export function createIsolatedRuntimeRegistryCustody() {
  const originalRegisteredRuntimes = new WeakMap<
    object,
    {
      registry: RuntimeRegistry;
      slots: Map<string, AgentRuntime>;
      type: string;
      raw: AgentRuntime;
      wrapped: AgentRuntime;
      retired: boolean;
      storedModeOf(sessionId: string): string | null | undefined;
      recorded: WeakMap<object, 'recording' | 'recorded'>;
      acquire(
        sessionId: string,
        clientId: string,
        holder: import('@dorkos/shared/agent-runtime').SseResponse,
        token: symbol
      ): boolean;
      release(sessionId: string, clientId: string, token: symbol): void;
      observe(
        sessionId: string,
        stream: AsyncGenerator<StreamEvent>,
        opts: import('@dorkos/shared/agent-runtime').MessageOpts
      ): AsyncGenerator<StreamEvent>;
    }
  >();
  const originalRuntimeMapGet = Map.prototype.get;
  const originalRuntimeRegistryOwners = new WeakMap<
    object,
    {
      slots: Map<string, AgentRuntime>;
      db?: Db;
      releaseHints: Set<() => void>;
      storedModeOf(sessionId: string): string | null | undefined;
      rekeySettings(principals: object, fromId: string, toId: string): Promise<void>;
    }
  >();
  /** Captured original settings move. This updates DATA, never issues a principal or alias proof. */
  const originalRuntimeSettingOwners = new WeakMap<
    object,
    {
      registry: RuntimeRegistry;
      type: string;
      wrapped: AgentRuntime;
    }
  >();
  /** Rekey settings through the registered runtime's captured original implementation. */
  function rekeyOriginalRuntimeSessionSettings(
    runtime: object,
    principals: object,
    fromId: string,
    toId: string
  ): Promise<void> {
    const binding = originalRuntimeSettingOwners.get(runtime);
    const own = binding && originalRuntimeRegistryOwners.get(binding.registry);
    if (
      !binding ||
      !own?.db ||
      readOriginalRuntimeRegistrySelection(binding.registry, own.db, binding.type) !==
        binding.wrapped ||
      readOriginalRegisteredRuntime(binding.wrapped) !== runtime
    )
      throw new Error('Original registered runtime settings owner required');
    return own.rekeySettings(principals, fromId, toId);
  }
  /** Actual registry/owning Db selection only. Returned wrapper remains subject to slot replacement guards. */
  function readOriginalRuntimeRegistrySelection(registry: RuntimeRegistry, db: Db, type: string) {
    const own = originalRuntimeRegistryOwners.get(registry);
    if (
      !own ||
      own.db !== db ||
      Object.getOwnPropertyDescriptor(registry, 'runtimes')?.value !== own.slots
    )
      throw new Error('Original owning runtime registry required.');
    const selected = originalRuntimeMapGet.call(own.slots, type) as AgentRuntime | undefined;
    if (!selected || !readOriginalRegisteredRuntime(selected)) return undefined;
    return selected;
  }
  /** Subscribe to release of the original registered runtime. */
  function onOriginalRegisteredRuntimeRelease(
    registry: RuntimeRegistry,
    listener: () => void
  ): () => void {
    const own = originalRuntimeRegistryOwners.get(registry);
    if (!own || Object.getOwnPropertyDescriptor(registry, 'runtimes')?.value !== own.slots)
      throw new Error('Original runtime registry required.');
    own.releaseHints.add(listener);
    return () => {
      own.releaseHints.delete(listener);
    };
  }
  /** Acquire the original registered runtime's captured lifetime. */
  function acquireOriginalRegisteredRuntime(
    selection: object,
    sessionId: string,
    clientId: string,
    holder: import('@dorkos/shared/agent-runtime').SseResponse,
    token: symbol
  ): boolean {
    const own = originalRegisteredRuntimes.get(selection);
    if (!own || !readOriginalRegisteredRuntime(selection)) return false;
    const acquired = own.acquire(sessionId, clientId, holder, token);
    if (acquired && !readOriginalRegisteredRuntime(selection)) {
      own.release(sessionId, clientId, token);
      return false;
    }
    return acquired;
  }
  /** Cleanup retains exact original registration capture even after its selected authority retires. */
  function releaseOriginalRegisteredRuntime(
    selection: object,
    sessionId: string,
    clientId: string,
    token: symbol
  ) {
    const own = originalRegisteredRuntimes.get(selection);
    if (!own) throw new Error('Original runtime release is foreign.');
    own.release(sessionId, clientId, token);
  }
  /** Lookup-only genuine registration result. Replacement refuses the old wrapper; no copied proxy/type match. */
  function readOriginalRegisteredRuntime(runtime: object): AgentRuntime | undefined {
    const own = originalRegisteredRuntimes.get(runtime);
    if (
      !own ||
      own.retired ||
      Object.getOwnPropertyDescriptor(own.registry, 'runtimes')?.value !== own.slots ||
      originalRuntimeMapGet.call(own.slots, own.type) !== own.wrapped
    )
      return undefined;
    return own.raw;
  }

  const originalRecordedLevels = new WeakMap<
    object,
    import('@dorkos/shared/agent-runtime').TurnPermissionLevel
  >();
  const originalCountingStreams = new WeakSet<object>();
  const originalCountedStreams = new WeakMap<object, AsyncGenerator<StreamEvent>>();
  const originalObservedStreams = new WeakMap<
    object,
    { selection: object; raw: AsyncGenerator<StreamEvent> }
  >();
  function originalStreamCurrent(selection: object, sessionId: string, stream: object): boolean {
    const raw = readOriginalRegisteredRuntime(selection);
    return (
      !!raw &&
      (readClaudeOriginalLockedStream(raw, sessionId, stream) ||
        readCodexOriginalLockedStream(raw, sessionId, stream) ||
        readOpenCodeOriginalLockedStream(raw, sessionId, stream) ||
        !!readTestModeOriginalNativeStream(raw, stream))
    );
  }
  /** Same registration observers over a genuine raw locked/native stream; no second provider entry. */
  function observeOriginalRegisteredRuntimeStream(
    selection: object,
    sessionId: string,
    stream: AsyncGenerator<StreamEvent>
  ): AsyncGenerator<StreamEvent> {
    const own = originalRegisteredRuntimes.get(selection);
    if (!own || !originalStreamCurrent(selection, sessionId, stream))
      throw new Error('Current original registered native stream required.');
    const opened =
      readClaudeOriginalLockedTurnOptions(own.raw, sessionId, stream) ??
      readCodexOriginalLockedTurnOptions(own.raw, sessionId, stream) ??
      readOpenCodeOriginalLockedTurnOptions(own.raw, sessionId, stream) ??
      readTestModeOriginalNativeTurnOptions(own.raw, sessionId, stream);
    if (!opened) throw new Error('Original native turn options required.');
    if (own.recorded.get(stream) === 'recording' || originalCountingStreams.has(stream))
      throw new Error('Original native turn recording reentered.');
    if (!own.recorded.has(stream)) {
      own.recorded.set(stream, 'recording');
      try {
        let stored: string | null | undefined;
        try {
          stored = own.storedModeOf(sessionId);
        } catch {
          stored = undefined;
        }
        const level = recordRuntimeTurnLevel(own.raw, stored, sessionId, opened.options, () => {
          if (!originalStreamCurrent(selection, sessionId, stream))
            throw new Error('Original runtime selection retired during turn recording.');
        });
        originalRecordedLevels.set(stream, level);
        own.recorded.set(stream, 'recorded');
      } catch (cause) {
        own.recorded.delete(stream);
        originalRecordedLevels.delete(stream);
        throw cause;
      }
    }
    let counted = originalCountedStreams.get(stream);
    if (!counted) {
      const level = originalRecordedLevels.get(stream);
      if (!level) throw new Error('Original native turn level required.');
      originalCountingStreams.add(stream);
      try {
        counted = countRecordedRuntimeTurnStream(
          own.raw,
          sessionId,
          opened.options,
          level,
          stream,
          () => {
            if (!originalStreamCurrent(selection, sessionId, stream))
              throw new Error('Original runtime selection retired during outsider placement.');
          }
        );
        originalCountedStreams.set(stream, counted);
      } finally {
        originalCountingStreams.delete(stream);
      }
    }
    if (!originalStreamCurrent(selection, sessionId, stream))
      throw new Error('Original runtime selection retired before stream observation.');
    const observed = own.observe(sessionId, counted, opened.options);
    const returned: AsyncGenerator<StreamEvent> = {
      next: async (value) => {
        try {
          if (
            !originalStreamCurrent(selection, sessionId, stream) &&
            !(
              readOriginalRegisteredRuntime(selection) &&
              readTestModeOriginalStopTerminalData(
                readOriginalRegisteredRuntime(selection)!,
                stream
              )
            )
          )
            throw new Error('Original runtime selection retired.');
          const result = await observed.next(value);
          // Natural end retires the raw entry; selection itself must remain current even at end.
          if (
            !readOriginalRegisteredRuntime(selection) ||
            (!result.done &&
              !originalStreamCurrent(selection, sessionId, stream) &&
              !readTestModeOriginalStopTerminalData(
                readOriginalRegisteredRuntime(selection)!,
                stream,
                result.value
              ))
          )
            throw new Error('Original runtime selection retired during held stream.');
          return result;
        } catch (first) {
          // The original read/refusal cause wins, including undefined; every cleanup duty is attempted.
          try {
            await stream.return(undefined);
          } catch {}
          try {
            await observed.return(undefined);
          } catch {}
          throw first;
        }
      },
      return: async (value) => {
        let failed = false,
          first: unknown;
        let result: IteratorResult<StreamEvent, void> | undefined;
        try {
          await stream.return(value);
        } catch (cause) {
          failed = true;
          first = cause;
        }
        try {
          result = await observed.return(value);
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
        if (failed) throw first;
        return result!;
      },
      throw: async (cause) => {
        // The caller's original thrown value wins, including undefined; retirement still runs.
        try {
          await stream.return(undefined);
        } catch {}
        return observed.throw(cause);
      },
      async [Symbol.asyncDispose]() {
        await disposeOriginalStream();
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const disposeOriginalStream = returned.return.bind(returned, undefined);
    originalObservedStreams.set(returned, { selection, raw: stream });
    return returned;
  }
  /** Native consumers retain original stream identity; a retired selection cannot unwrap into authority. */
  function readOriginalRegisteredRuntimeStream(
    selection: object,
    stream: object
  ): object | undefined {
    const own = originalObservedStreams.get(stream);
    return own && own.selection === selection && readOriginalRegisteredRuntime(selection)
      ? own.raw
      : undefined;
  }

  /** Fixed lookup from an actual observed stream to its current selected original stream. */
  function readOriginalRegisteredNativeStream(stream: object): object | undefined {
    const own = originalObservedStreams.get(stream);
    return own && readOriginalRegisteredRuntime(own.selection) ? own.raw : undefined;
  }

  return Object.freeze({
    originalRegisteredRuntimes,
    originalRuntimeRegistryOwners,
    originalRuntimeSettingOwners,
    rekeyOriginalRuntimeSessionSettings,
    readOriginalRuntimeRegistrySelection,
    onOriginalRegisteredRuntimeRelease,
    acquireOriginalRegisteredRuntime,
    releaseOriginalRegisteredRuntime,
    readOriginalRegisteredRuntime,
    observeOriginalRegisteredRuntimeStream,
    readOriginalRegisteredRuntimeStream,
    readOriginalRegisteredNativeStream,
  });
}
