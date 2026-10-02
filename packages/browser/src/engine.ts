import { randomBytes } from 'node:crypto';
import { validateEngineConfiguration } from './configuration.js';
import {
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
import { captureTab, type BrowserCapture } from './tabs/capture.js';

/** This complete fixture-only slice exports no input/navigation or recovery placeholders. */
export interface BrowserLifecycleEngine {
  open(command: unknown): Promise<OpenedResult>;
  listTabs(browserId: string, browserGeneration: number): readonly BrowserBinding[];
  capture(command: unknown): Promise<BrowserCapture>;
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
  const close = (record: BrowserRecord): Promise<import('./lifecycle/records.js').CloseOutcome> => {
    if (record.status === 'stopped') return Promise.resolve({ cleanup: 'observed' });
    record.closePromise ??= closeRecord(config, record);
    return record.closePromise;
  };
  const result = async (
    record: BrowserRecord,
    requestId: string
  ): Promise<Extract<BrowserResult, { kind: 'close' }>> =>
    parseBrowserResult({
      kind: 'close',
      requestId,
      browserId: record.browserId,
      browserGeneration: record.browserGeneration,
      ...(await close(record)),
    }) as Extract<BrowserResult, { kind: 'close' }>;
  const open = async (value: unknown): Promise<OpenedResult> => {
    const command = parseBrowserCommand(value);
    if (command.kind !== 'open') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
    if (stopping) throw new BrowserLifecycleError('ENGINE_STOPPED');
    const manager = hostIdentity(process.pid);
    if (!manager) throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    const record: BrowserRecord = {
      browserId: parseBrowserId(randomBytes(16).toString('base64url')),
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
    records.set(record.browserId, record);
    try {
      await acquireBrowser(config, record, () => stopping);
      if (stopping) throw new BrowserLifecycleError('ENGINE_STOPPED');
      const first = record.tabs.values().next().value;
      if (!first) throw new BrowserLifecycleError('PAGE_UNAVAILABLE');
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
      return captureTab(
        config,
        find(command.binding.browserId, command.binding.browserGeneration),
        command
      );
    },
    async close(value: unknown) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'close') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
      return result(find(command.browserId, command.browserGeneration), command.requestId);
    },
    shutdown() {
      stopping = true;
      shutdownPromise ??= (async () => {
        await Promise.allSettled([...opening]);
        return Object.freeze(
          await Promise.all(
            [...records.values()].map((record) =>
              result(record, randomBytes(16).toString('base64url'))
            )
          )
        );
      })();
      return shutdownPromise;
    },
  });
}
