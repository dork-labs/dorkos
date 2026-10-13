/** Composition root for one guest runtime, independent of the host OpenCode sidecar. */
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { SessionAttachmentStore } from '../../../session/attachments/index.js';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { ComputerClientProvider, type ComputerProviderOptions } from './provider.js';
import { ComputerSessionMap } from './session-map.js';
import { isRecord } from './wire.js';
import { projectModelOptions } from '../providers/models.js';
export type { ComputerRuntimeEndpoint, ComputerProviderOptions } from './provider.js';

export interface ComputerRuntimeOptions extends ComputerProviderOptions {
  runtimeId: 'computer-local';
  /** Owner-only private parent directory must exist before construction. */
  sessionMapPath: string;
  attachments?: SessionAttachmentStore;
  onRuntimeTools?(tools: ConnectorRuntimeTools): void;
}

function refuseCredits(value: unknown): void {
  if (
    isRecord(value) &&
    typeof value.model === 'string' &&
    value.model.startsWith('dorkos-credits/')
  ) {
    throw new Error('COMPUTER_CREDITS_REFUSED');
  }
  if (
    isRecord(value) &&
    Array.isArray(value.additionalDirectories) &&
    value.additionalDirectories.length
  ) {
    throw new Error('COMPUTER_DIRECTORY_REFUSED');
  }
}

/** Change only Session metadata, never arbitrary tool payloads or text. */
function runtimeMetadata(value: unknown, runtimeId: string): unknown {
  if (Array.isArray(value)) return value.map((row) => runtimeMetadata(row, runtimeId));
  if (!isRecord(value)) return value;
  if (
    typeof value.id === 'string' &&
    typeof value.cwd === 'string' &&
    value.runtime === 'opencode'
  ) {
    return { ...value, runtime: runtimeId };
  }
  if (Array.isArray(value.sessions))
    return { ...value, sessions: runtimeMetadata(value.sessions, runtimeId) };
  if (isRecord(value.session))
    return { ...value, session: runtimeMetadata(value.session, runtimeId) };
  return value;
}

/** Host composition owns enabling, endpoint observations and durable runtime registration. */
export function createComputerRuntime(options: ComputerRuntimeOptions): {
  runtime: AgentRuntime;
  provider: ComputerClientProvider;
  revoke(): Promise<void>;
  interruptTurns(): Promise<void>;
} {
  const provider = new ComputerClientProvider(options);
  const sessionMap = new ComputerSessionMap(options.sessionMapPath);
  const concrete = new OpenCodeRuntime({
    provider,
    runtimeId: options.runtimeId,
    runsOnCredits: () => false,
    modelDirectory: options.anchor,
    sessionMap,
    attachments: options.attachments,
  });
  // Bind methods to the actual instance: its private policy identity is computer-local.
  const runtime = new Proxy(concrete, {
    get(target, property, receiver) {
      if (property === 'setConnectorRuntimeTools')
        return (tools: ConnectorRuntimeTools) => {
          options.onRuntimeTools?.(tools);
          concrete.setConnectorRuntimeTools(tools);
        };
      if (property === 'getConnectedProvider') return () => null;
      if (property === 'getCapabilities')
        return () => ({
          ...target.getCapabilities(),
          type: options.runtimeId,
          // Sign-in and settings belong to the guest, not the host OpenCode sidecar.
          credits: undefined,
          settings: { configSection: null, supportsEffort: false, sections: [] },
        });
      if (property === 'getSupportedModels')
        return async () => {
          const client = await provider.getClient(options.anchor);
          const result = await client.provider.list({ query: { directory: options.anchor } });
          if (!result.data) throw new Error('COMPUTER_SIGN_IN_REQUIRED');
          return projectModelOptions(result.data).filter(
            (model) => !model.value.startsWith('dorkos-credits/')
          );
        };
      if (property === 'checkDependencies')
        return async () => {
          try {
            const client = await provider.getClient(options.anchor);
            const result = await client.provider.list({ query: { directory: options.anchor } });
            if (!result.data) throw new Error('COMPUTER_SIGN_IN_REQUIRED');
            return [
              {
                name: 'Computer sign-in',
                description: 'Guest runtime sign-in',
                status: result.data.connected.length ? 'satisfied' : 'missing',
                installHint: 'Sign in inside the computer.',
              },
            ];
          } catch {
            return [
              {
                name: 'Agent computer',
                description: 'Guest runtime availability',
                status: 'missing',
                installHint: 'Start the computer and sign in.',
              },
            ];
          }
        };
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (
          ['ensureSession', 'sendMessage', 'updateSession', 'executeCommandIntent'].includes(
            String(property)
          )
        ) {
          if (!options.currentEnabled()) throw new Error('COMPUTER_DISABLED');
          for (const arg of args) refuseCredits(arg);
        }
        if (property === 'ensureSession' || property === 'sendMessage') {
          const opts = property === 'ensureSession' ? args[1] : args[2];
          if (isRecord(opts) && opts.cwd !== undefined) provider.wire.toGuest(opts.cwd);
        }
        const result: unknown = Reflect.apply(value, target, args);
        if (result instanceof Promise)
          return result.then((data: unknown) => runtimeMetadata(data, options.runtimeId));
        return runtimeMetadata(result, options.runtimeId);
      };
    },
  });
  return {
    runtime,
    provider,
    async interruptTurns() {
      const results = await Promise.all(
        sessionMap.listAll().map(({ sessionId }) => concrete.interruptQuery(sessionId))
      );
      if (
        results.some((result) => result.outcome === 'failed' || result.outcome === 'unconfirmed')
      ) {
        throw new Error('COMPUTER_INTERRUPT_UNCONFIRMED');
      }
    },
    async revoke() {
      provider.invalidate();
    },
  };
}
