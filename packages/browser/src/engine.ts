import { randomBytes } from 'node:crypto';
import { validateEngineConfiguration } from './configuration.js';
import {
  parseBrowserBinding,
  parseBrowserCommand,
  parseBrowserResult,
  type BrowserBinding,
  type BrowserResult,
} from './contracts.js';
import { parseBrowserId } from './ids.js';
import { hostIdentity } from './runtime/host-identity.js';
import { acquireBrowser } from './lifecycle/acquisition.js';
import { closeRecord } from './lifecycle/close.js';
import { BrowserLifecycleError } from './lifecycle/errors.js';
import type { BrowserRecord, OpenedResult } from './lifecycle/records.js';
import { createBrowserLifetime, ownOperation } from './lifecycle/ownership.js';
import { submitInput, resetInput } from './lifecycle/parent-actions.js';
import type { InputResult, ResetResult } from './input/types.js';
import { until } from './lifecycle/deadline.js';
import { sameBinding } from './input/binding.js';
import { captureTab, type BrowserCapture } from './tabs/capture.js';

/** Private canonical input/capture/lifecycle composition; native production readiness is separate. */
export interface BrowserLifecycleEngine {
  open(command: unknown): Promise<OpenedResult>;
  listTabs(browserId: string, browserGeneration: number): readonly BrowserBinding[];
  capture(command: unknown): Promise<BrowserCapture>;
  input(command: unknown, signal?: AbortSignal): Promise<InputResult>;
  resetInput(binding: unknown): Promise<ResetResult>;
  close(command: unknown): Promise<Extract<BrowserResult, { kind: 'close' }>>;
  shutdown(): Promise<readonly Extract<BrowserResult, { kind: 'close' }>[]>;
}

/** Build a private engine; every runtime/root arrives from its trusted caller, never home discovery. */
export function createBrowserEngine(configuration: unknown): BrowserLifecycleEngine {
  const config = validateEngineConfiguration(configuration);
  const records = new Map<string, BrowserRecord>();
  const opening = new Set<Promise<OpenedResult>>();
  let stopping = false;
  let shutdownPromise: ReturnType<BrowserLifecycleEngine['shutdown']> | undefined;
  const find = (browserId: string, generation: number): BrowserRecord => {
    const record = records.get(browserId);
    if (!record || record.browserGeneration !== generation)
      throw new BrowserLifecycleError('STALE_BINDING');
    return record;
  };
  const close = (
    record: BrowserRecord,
    callerEnd?: number
  ): Promise<import('./lifecycle/records.js').CloseOutcome> => {
    return closeRecord(config, record, callerEnd);
  };
  const result = async (
    record: BrowserRecord,
    requestId: string,
    callerEnd?: number
  ): Promise<Extract<BrowserResult, { kind: 'close' }>> =>
    parseBrowserResult({
      kind: 'close',
      requestId,
      browserId: record.browserId,
      browserGeneration: record.browserGeneration,
      ...(await close(record, callerEnd)),
    }) as Extract<BrowserResult, { kind: 'close' }>;
  const open = async (value: unknown): Promise<OpenedResult> => {
    const command = parseBrowserCommand(value);
    if (command.kind !== 'open') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
    if (stopping) throw new BrowserLifecycleError('ENGINE_STOPPED');
    if (
      command.mode === 'persistent' &&
      [...records.values()].some(
        (record) => record.profileId === command.profileId && record.status !== 'stopped'
      )
    )
      throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
    const manager = hostIdentity(process.pid);
    if (!manager) throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    const browserId = parseBrowserId(randomBytes(16).toString('base64url'));
    const record: BrowserRecord = {
      browserId,
      lifetime: createBrowserLifetime(browserId, 0),
      browserGeneration: 0,
      mode: command.mode,
      ...(command.mode === 'persistent' ? { profileId: command.profileId } : {}),
      manager,
      launchEntered: false,
      rootAttributed: false,
      identities: [],
      inventoryComplete: false,
      status: 'opening',
      tabs: new Map(),
    };
    record.lifetime.retire = () => {
      void close(record);
    };
    records.set(record.browserId, record);
    try {
      await acquireBrowser(
        config,
        record,
        () => stopping || record.lifetime.gate.stopped || record.status !== 'opening'
      );
      if (stopping || record.status !== 'running' || record.lifetime.gate.stopped)
        throw new BrowserLifecycleError('ENGINE_STOPPED');
      const first = record.tabs.values().next().value;
      if (!first) throw new BrowserLifecycleError('PAGE_UNAVAILABLE');
      if (!record.lifetime.inputs.get(first)?.ready)
        throw new BrowserLifecycleError('BROWSER_STOPPED');
      return parseBrowserResult({
        kind: 'opened',
        requestId: command.requestId,
        browserId: record.browserId,
        browserGeneration: record.browserGeneration,
        mode: record.mode,
        ...(record.profileId ? { profileId: record.profileId } : {}),
        tab: first.binding,
      }) as OpenedResult;
    } catch (error) {
      const originalCleanup =
        error instanceof BrowserLifecycleError ? error.cleanupCode : undefined;
      // A refused setup cleanup owns no returned reservation, but still requires quarantine.
      if (originalCleanup === 'PROFILE_UNCERTAIN') record.setupCleanupUncertain = true;
      const cleanup = await close(record);
      const primary = error instanceof BrowserLifecycleError ? error.code : 'OPEN_FAILED';
      throw new BrowserLifecycleError(
        primary,
        originalCleanup ?? (cleanup.cleanup === 'observed' ? undefined : cleanup.reason)
      );
    }
  };
  return Object.freeze({
    open(command: unknown) {
      const operation = open(command);
      opening.add(operation);
      void operation.then(
        () => opening.delete(operation),
        () => opening.delete(operation)
      );
      return operation;
    },
    listTabs(browserId: string, browserGeneration: number) {
      const record = find(browserId, browserGeneration);
      if (record.status !== 'running') throw new BrowserLifecycleError('BROWSER_STOPPED');
      return Object.freeze(
        [...record.tabs.values()]
          .filter((tab) => !tab.stopped)
          .map((tab) => Object.freeze({ ...tab.binding }))
      );
    },
    async capture(value: unknown) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'capture') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
      const record = find(command.binding.browserId, command.binding.browserGeneration);
      const tab = record.tabs.get(command.binding.tabId);
      const capture = await ownOperation(record, () => captureTab(config, record, command)).catch(
        (error: unknown) => {
          // The unchanged capture deadline bounds waiting, not an underlying Page effect.
          if (
            error instanceof BrowserLifecycleError &&
            (error.code === 'CAPTURE_TIMEOUT' || error.code === 'COUNTER_EXHAUSTED')
          ) {
            record.lifetime.uncertain = true;
            record.lifetime.gate.stop();
            record.lifetime.retire?.();
          }
          throw error;
        }
      );
      if (
        !tab ||
        record.tabs.get(command.binding.tabId) !== tab ||
        record.lifetime.gate.stopped ||
        !sameBinding(tab.binding, command.binding)
      )
        throw new BrowserLifecycleError('STALE_BINDING');
      return capture;
    },
    input(value: unknown, signal?: AbortSignal) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'input') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
      return submitInput(
        find(command.binding.browserId, command.binding.browserGeneration),
        command,
        signal
      );
    },
    resetInput(value: unknown) {
      const binding = parseBrowserBinding(value);
      return resetInput(find(binding.browserId, binding.browserGeneration), binding);
    },
    async close(value: unknown) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'close') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
      return result(find(command.browserId, command.browserGeneration), command.requestId);
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      const end = performance.now() + 5000;
      let resolve!: (value: readonly Extract<BrowserResult, { kind: 'close' }>[]) => void;
      shutdownPromise = new Promise((done) => {
        resolve = done;
      });
      const closing = [...records.values()].map((record) =>
        result(record, randomBytes(16).toString('base64url'), end)
      );
      void (async () => {
        await until(Promise.allSettled([...opening]), end, 'ENGINE_STOPPED').catch(() => {});
        // Every record close was entered before waiting for opening ownership; these share fixed ends.
        const outcomes = await Promise.all(closing);
        resolve(Object.freeze(outcomes));
      })();
      return shutdownPromise;
    },
  });
}
