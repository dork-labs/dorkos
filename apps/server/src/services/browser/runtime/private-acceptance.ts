import type { Server } from 'node:http';
import type { Db } from '@dorkos/db';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { MeshCore } from '@dorkos/mesh';
import type { ConnectorRuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import type { AgentIdentitySnapshotPrincipalPort } from '../../runtimes/connector-mcp/index.js';
import type { ConnectorRuntimeTools } from '../../runtimes/connector-tools.js';
import type { CodexRuntime } from '../../runtimes/codex/codex-runtime.js';
import type { CodexTransport } from '../../runtimes/codex/transport/index.js';
import type { runtimeRegistry } from '../../core/runtime-registry.js';
import type { createProductionBrowserStartupMode } from './startup-mode.js';
import type {
  PrivateBrowserResourceOwner,
  PrivateViewerSampleObserver,
} from './private-native-acceptance.js';

type Mode = ReturnType<typeof createProductionBrowserStartupMode>;
export type OriginalPrincipalComposition = Readonly<{
  principals: ConnectorRuntimePrincipalService;
  snapshots: AgentIdentitySnapshotPrincipalPort;
  connectorTools: ConnectorRuntimeTools;
  runtimeRegistry: typeof runtimeRegistry;
  authors: AuthorRegistry;
  mesh: MeshCore;
  db: Db;
}>;
let active: ReturnType<typeof createOriginalOwner> | undefined;
function createOriginalOwner(
  options: Readonly<{
    resources: PrivateBrowserResourceOwner;
    viewerSamples: PrivateViewerSampleObserver;
    wrapOriginalCodexTransport(original: CodexTransport): CodexTransport;
  }>
) {
  const resources = options.resources,
    viewerSamples = options.viewerSamples;
  const wrapOriginal = options.wrapOriginalCodexTransport.bind(options);
  let mode: Mode | undefined, composition: OriginalPrincipalComposition | undefined;
  let runtime: CodexRuntime | undefined,
    listener: Server | undefined,
    closed = false;
  const transports = new WeakSet<object>();
  let first: Readonly<{ value: unknown }> | undefined;
  let startup: Promise<void> | undefined,
    shutdownServices: (() => Promise<void>) | undefined,
    closing: Promise<void> | undefined;
  let closeListener: (() => Promise<void>) | undefined;
  let listeningResolve!: (original: Server) => void;
  let listeningReject!: (value: unknown) => void;
  const listening = new Promise<Server>((resolve, reject) => {
    listeningResolve = resolve;
    listeningReject = reject;
  });
  void listening.catch(() => {});
  const current = () => {
    if (first) throw first.value;
    if (closed) throw new Error('PRIVATE_ACCEPTANCE_BOOTSTRAP_CLOSED');
  };
  const record = <T>(capture: () => T): T => {
    current();
    try {
      return capture();
    } catch (value) {
      first ??= { value };
      listeningReject(first.value);
      throw value;
    }
  };
  const owner = Object.freeze({
    resources,
    viewerSamples,
    captureStartup(original: Promise<void>) {
      record(() => {
        if (startup) throw new Error('PRIVATE_ACCEPTANCE_STARTUP_REPLACED');
        startup = original;
        void original.catch((value) => {
          first ??= { value };
          listeningReject(first.value);
        });
      });
    },
    captureShutdownServices(original: () => Promise<void>) {
      record(() => {
        if (shutdownServices) throw new Error('PRIVATE_ACCEPTANCE_SHUTDOWN_REPLACED');
        shutdownServices = original;
      });
    },
    captureMode(original: Mode) {
      record(() => {
        if (mode && mode !== original) throw new Error('PRIVATE_ACCEPTANCE_MODE_REPLACED');
        mode = original;
      });
    },
    capturePrincipalComposition(original: OriginalPrincipalComposition) {
      record(() => {
        if (composition) throw new Error('PRIVATE_ACCEPTANCE_PRINCIPAL_COMPOSITION_REPLACED');
        composition = Object.freeze({ ...original });
      });
    },
    wrapCodexTransport(original: CodexTransport) {
      return record(() => {
        if (transports.has(original)) throw new Error('PRIVATE_ACCEPTANCE_TRANSPORT_REPLACED');
        transports.add(original);
        return wrapOriginal(original);
      });
    },
    captureCodexRuntime(original: CodexRuntime) {
      record(() => {
        if (runtime) throw new Error('PRIVATE_ACCEPTANCE_CODEX_RUNTIME_REPLACED');
        runtime = original;
      });
    },
    captureOriginalListener(original: Server) {
      // Retain cleanup before any admission check or listening callback.
      if (listener && listener !== original)
        throw new Error('PRIVATE_ACCEPTANCE_LISTENER_REPLACED');
      if (listener) return;
      const close = original.close.bind(original),
        stopConnections = original.closeAllConnections.bind(original);
      listener = original;
      const originalReady = original.listening
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const settle = (result: { ok: true } | { ok: false; value: unknown }) => {
              original.off('listening', ready);
              original.off('error', failed);
              original.off('close', closed);
              if (result.ok) resolve();
              else reject(result.value);
            };
            const ready = () => settle({ ok: true }),
              failed = (value: unknown) => settle({ ok: false, value }),
              closed = () =>
                settle({
                  ok: false,
                  value: new Error('PRIVATE_ACCEPTANCE_ORIGINAL_CLOSED_BEFORE_LISTENING'),
                });
            original.once('listening', ready);
            original.once('error', failed);
            original.once('close', closed);
          });
      void originalReady.catch((value) => {
        first ??= { value };
        listeningReject(first.value);
      });
      closeListener = async () => {
        try {
          await originalReady;
        } catch (value) {
          first ??= { value };
        }
        if (!original.listening) return;
        const returned = new Promise<void>((resolve, reject) => {
          try {
            close((value) => (value ? reject(value) : resolve()));
          } catch (value) {
            reject(value);
          }
        });
        try {
          stopConnections();
        } catch (value) {
          first ??= { value };
        }
        return returned;
      };
    },
    captureListener(original: Server) {
      record(() => {
        if (listener !== original || !original.listening)
          throw new Error('PRIVATE_ACCEPTANCE_ORIGINAL_LISTENER_REQUIRED');
        listeningResolve(original);
      });
    },
    waitForListener: () => listening,
    originals() {
      return record(() => {
        if (!mode || !composition || !runtime || !listener)
          throw new Error('PRIVATE_ACCEPTANCE_ORIGINAL_COMPOSITION_INCOMPLETE');
        return Object.freeze({ mode, composition, runtime, listener });
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      // Parent joins original startup before the final service/listener drain. No process.exit surrogate.
      closing = Promise.resolve().then(async () => {
        if (startup)
          try {
            await startup;
          } catch (value) {
            first ??= { value };
          }
        listeningReject(
          first ? first.value : new Error('PRIVATE_ACCEPTANCE_CLOSED_BEFORE_LISTENING')
        );
        const jobs: Promise<void>[] = [];
        for (const effect of [shutdownServices, closeListener])
          if (effect) {
            try {
              jobs.push(effect());
            } catch (value) {
              first ??= { value };
            }
          }
        for (const result of await Promise.allSettled(jobs))
          if (result.status === 'rejected') first ??= { value: result.reason };
        mode = undefined;
        composition = undefined;
        runtime = undefined;
        listener = undefined;
        if (active === owner) active = undefined;
        if (first) throw first.value;
      });
      return closing;
    },
  });
  return owner;
}
/** Private in-process test bootstrap only. No env flag, request DTO, imported copied handle or route mints it. */
export function installPrivateBrowserAcceptance(
  options: Parameters<typeof createOriginalOwner>[0]
) {
  if (active) throw new Error('PRIVATE_ACCEPTANCE_BOOTSTRAP_ALREADY_OWNED');
  return (active = createOriginalOwner(options));
}
/** Real constructors snapshot this exact original once; ordinary production has no observer. */
export function readPrivateBrowserAcceptance() {
  return active;
}

/** Join original IPC duties after startup failure without replacing its exact cause.
 * Native-mode cleanup owns its independent close path; this retains sender callbacks. */
export function joinOriginalProjectionStartupFailure(
  projection: Readonly<{ beginClose(): void; close(): Promise<void> }> | undefined,
  cause: unknown
): Promise<Readonly<{ cause: unknown; cleanup: readonly PromiseSettledResult<void>[] }>> {
  const jobs: Promise<void>[] = [];
  const effects: Array<() => void | Promise<void>> = [];
  if (projection) {
    // Capture both originals before any reentrant close callback can replace a facade.
    for (const name of ['beginClose', 'close'] as const) {
      try {
        effects.push(projection[name].bind(projection));
      } catch (value) {
        jobs.push(Promise.reject(value));
      }
    }
  }
  for (const effect of effects) {
    try {
      jobs.push(Promise.resolve(effect()));
    } catch (value) {
      jobs.push(Promise.reject(value));
    }
  }
  return Promise.allSettled(jobs).then((cleanup) =>
    Object.freeze({ cause, cleanup: Object.freeze(cleanup) })
  );
}
