import { createOriginalHostDiagnosticForwarders } from './server-host/server-host-diagnostic-data.js';
/** Loopback-only temporary consumer writer/build/note fixture, never production routing. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NativeEmissionIntegrityCase } from './native-emission-integrity-control.js';

import { startupPhases } from './server-startup-data.js';
import { createOriginalHostReader } from './server-host/server-host-reader.js';
import { createOriginalHostScenarioData } from './server-host/server-host-scenario-data.js';
import { createOriginalHostRoomActions } from './server-host/server-host-room-actions.js';
import { createOriginalHostFileActions } from './server-host/server-host-file-actions.js';
export type OwnedEvidenceReader = <T>(
  kind:
    | 'read-room-scenario-data'
    | 'read-native-integrity-data'
    | 'start-native-integrity-observation'
    | 'read-checkbox-pair-data'
    | 'read-canonical-recovery-data'
    | 'read-selection-data'
    | 'read-reviewed-replay-data'
    | 'read-saved-data'
    | 'read-presence-data'
    | 'read-mcp-app-data',
  responseKind: string,
  validate: (value: unknown) => value is T
) => Promise<T>;
type HostContext = Awaited<ReturnType<typeof constructOriginalHostContext>> & {
  readOwnedEvidence: OwnedEvidenceReader;
};
const hostOwners = new WeakMap<object, HostContext>();
const originalGet = WeakMap.prototype.get,
  originalSet = WeakMap.prototype.set,
  originalApply = Reflect.apply;
const hostDiagnosticOwners = new WeakSet<object>();
const originalDiagnosticAdd = WeakSet.prototype.add,
  originalDiagnosticHas = WeakSet.prototype.has;
/** Only a private key registered by the original host constructor can forward owned DATA. */
export function requireOriginalHostDiagnosticOwner(key: object): void {
  if (!originalApply(originalDiagnosticHas, hostDiagnosticOwners, [key]))
    throw new Error('Original host diagnostic owner required');
}
/** Exact private host constructor key only; no structural context or public registration. */
export function requireOriginalHostOperations(key: object): HostContext {
  const context = originalApply(originalGet, hostOwners, [key]) as HostContext | undefined;
  if (!context) throw new Error('Original host operation owner required');
  return context;
}
async function prospectiveLoopbackPort() {
  const holder = createServer();
  holder.listen(0, '127.0.0.1');
  let port: number | undefined;
  let failed = false;
  let first: unknown;
  try {
    await once(holder, 'listening');
    const address = holder.address();
    if (!address || typeof address === 'string') throw new Error('Owned port unavailable');
    port = address.port;
  } catch (cause) {
    failed = true;
    first = cause;
  }
  try {
    if (holder.listening)
      await new Promise<void>((resolve, reject) =>
        holder.close((cause) => (cause ? reject(cause) : resolve()))
      );
  } catch (cause) {
    if (!failed) {
      failed = true;
      first = cause;
    }
  }
  if (failed) throw first;
  return port!;
}

/** Own a fresh process, home and app globals. The source entry is this same
 * fixture file, selected only by the fixed argument and IPC channel. */
async function constructOriginalHostContext(
  target: 'session' | 'room' = 'session',
  integrityCase: NativeEmissionIntegrityCase = 'none',
  standalone: 'none' | 'bearer' | 'canonical' = 'none',
  frameMode: 'routed' | 'log-only' = 'routed'
) {
  if (
    !['none', 'select-builder', 'event-codec'].includes(integrityCase) ||
    (integrityCase !== 'none' && target !== 'room')
  )
    throw new Error('Finite original native integrity case required');
  if (target !== 'session' && target !== 'room') throw new Error('Finite original scope required');
  if (
    (standalone !== 'none' && standalone !== 'bearer' && standalone !== 'canonical') ||
    (standalone !== 'none' && (target !== 'room' || integrityCase !== 'none'))
  )
    throw new Error('Finite original standalone bootstrap required');
  if (
    !['routed', 'log-only'].includes(frameMode) ||
    (frameMode === 'log-only' &&
      (target !== 'session' || integrityCase !== 'none' || standalone !== 'none'))
  )
    throw new Error('Finite original frame declaration mode required');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'doc-consumer-host-')));
  let child: ReturnType<typeof spawn> | undefined;
  let ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let retired = false,
    failed = false;
  let first: unknown;
  let originalChildClosed = false;
  let retirement: Promise<void> | undefined;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  let captured = 0;
  const rawOutput = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const setupDiagnostic = { undefinedCause: false, stdout: '', stderr: '' };
  const widgetDiagnostic = { undefinedCause: false, stdout: '', stderr: '' };
  const diagnosticKey = Object.freeze({});
  originalApply(originalDiagnosticAdd, hostDiagnosticOwners, [diagnosticKey]);
  const { forwardCloseDiagnostic, forwardResourceDiagnostic } =
    createOriginalHostDiagnosticForwarders(diagnosticKey);
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (stream === 'stderr') {
      forwardCloseDiagnostic(chunk);
      forwardResourceDiagnostic(chunk);
    }
    captured += chunk.length;
    if (captured > 1048576) remember(new Error('Owned fixture output frontier exceeded'));
    else {
      rawOutput[stream] = Buffer.concat([rawOutput[stream], chunk]);
    }
    // Continue draining after overflow. Retained raw bytes are diagnostic DATA only.
  };
  const close = () => {
    if (retirement) return retirement;
    retired = true;
    retirement = (async () => {
      let closeDiagnosticSequence = 0;
      const closeData = (phase: 'child-close' | 'home-remove', state: 'begin' | 'done') => {
        try {
          console.error(
            `ORIGINAL_MCP_CLOSE_STAGE parent ${++closeDiagnosticSequence} ${Date.now()} ${phase} ${state}`
          );
        } catch {
          // Diagnostic DATA cannot change lifecycle authority or first cause.
        }
      };
      closeData('child-close', 'begin');
      if (child && child.connected) {
        try {
          child.send({ kind: 'close' }, (cause) => {
            if (cause) remember(cause);
          });
        } catch (cause) {
          remember(cause);
        }
      }
      if (ended) {
        try {
          const exit = await ended;
          closeData('child-close', 'done');
          // Child close follows both owned stdio closures; attach only drained bounded bytes.
          widgetDiagnostic.stdout = rawOutput.stdout.toString('utf8');
          widgetDiagnostic.stderr = rawOutput.stderr.toString('utf8');
          if (exit.code !== 0 || exit.signal)
            remember(new Error('Owned fixture did not close cleanly'));
          else originalChildClosed = true;
        } catch (cause) {
          remember(cause);
        }
      }
      // No broad kill or time-as-closure. Unresolved child wait retains custody.
      if (!failed && (!child || originalChildClosed)) {
        try {
          closeData('home-remove', 'begin');
          await rm(home, { recursive: true, force: true });
          closeData('home-remove', 'done');
        } catch (cause) {
          remember(cause);
        }
      }
      if (failed) throw first;
    })();
    return retirement;
  };
  try {
    const apiPort = await prospectiveLoopbackPort(),
      vitePort = await prospectiveLoopbackPort();
    if (apiPort === vitePort) throw new Error('Distinct owned origins required');
    const require = createRequire(import.meta.url);
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      DORK_HOME: home,
      DORKOS_BOUNDARY: home,
      DORKOS_HOST: '127.0.0.1',
      DORKOS_PORT: String(apiPort),
      VITE_PORT: String(vitePort),
      DORKOS_CORS_ORIGIN: 'http://127.0.0.1:' + vitePort,
      DORKOS_TEST_RUNTIME: 'true',
      DORKOS_E2E_NO_HMR: 'true',
      DO_NOT_TRACK: '1',
      DORKOS_TELEMETRY_DISABLED: 'true',
    }; // Never inherit provider credentials, NODE_OPTIONS or personal DORK_HOME.
    child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(require.resolve('tsx')).href,
        fileURLToPath(new URL('./server.ts', import.meta.url)),
        '--consumer-native-worker',
        target,
        integrityCase,
        standalone,
        frameMode,
      ],
      {
        env: environment,
        cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }
    );
    const launched = child;
    ended = new Promise((resolve) => {
      launched.on('error', remember);
      launched.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Capture rejection immediately while startup readiness is pending.
    void ended.catch(remember);
    launched.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    launched.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
    const ready = await new Promise<{
      origin: string;
      apiOrigin: string;
      sessionId: string;
      roomId?: string;
      documentId: string;
      root: string;
      standaloneToken?: string;
      frameDeclarationAbsent: boolean;
    }>((resolve, reject) => {
      let frontierSequence = 0;
      let settled = false;
      const cleanup = () => {
        launched.off('message', message);
        launched.off('error', error);
        launched.off('close', exit);
      };
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        run();
      };
      const error = (cause: unknown) => finish(() => reject(cause));
      const exit = () => error(new Error('Owned worker closed before readiness'));
      const message = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as Record<string, unknown>;
        if (row.kind === 'startup-frontier') {
          // Only finite labels and cause classes cross this diagnostic channel: no paths,
          // tokens, environment values, exception messages or arbitrary child output.
          if (
            Object.keys(row).length !== 5 ||
            !['kind', 'sequence', 'phase', 'state', 'causeType'].every((key) =>
              Object.hasOwn(row, key)
            ) ||
            row.sequence !== frontierSequence + 1 ||
            frontierSequence >= 64 ||
            !startupPhases.includes(row.phase as (typeof startupPhases)[number]) ||
            typeof row.state !== 'string' ||
            !['begin', 'done', 'failed'].includes(row.state) ||
            ![null, 'undefined', 'error', 'other'].includes(row.causeType as null | string) ||
            (row.state !== 'failed' && row.causeType !== null)
          )
            return;
          frontierSequence++;
          try {
            const bytes = Buffer.from(
              JSON.stringify({
                kind: 'owned-consumer-startup',
                pid: launched.pid,
                sequence: row.sequence,
                phase: row.phase,
                state: row.state,
                causeType: row.causeType,
              }) + '\n'
            );
            if (bytes.length <= 256) writeSync(2, bytes);
          } catch {
            /* Bounded secondary diagnostics never replace the setup cause. */
          }
          return;
        }
        if (row.kind === 'failed') {
          setupDiagnostic.undefinedCause = row.undefinedCause === true;
          setupDiagnostic.stdout = rawOutput.stdout.toString('utf8');
          setupDiagnostic.stderr = rawOutput.stderr.toString('utf8');
          try {
            writeSync(
              2,
              JSON.stringify({
                kind: 'owned-consumer-setup-failed',
                pid: launched.pid,
                undefinedCause: setupDiagnostic.undefinedCause,
              }) + '\n'
            );
          } catch {
            /* First setup failure stays primary even if diagnostic stderr fails. */
          }
          error(new Error('Owned worker setup failed', { cause: setupDiagnostic }));
          return;
        }
        if (row.kind !== 'ready') return;
        if (
          failed ||
          row.origin !== 'http://127.0.0.1:' + vitePort ||
          row.apiOrigin !== 'http://127.0.0.1:' + apiPort ||
          typeof row.sessionId !== 'string' ||
          typeof row.documentId !== 'string' ||
          typeof row.root !== 'string' ||
          typeof row.frameDeclarationAbsent !== 'boolean' ||
          row.frameDeclarationAbsent !== (frameMode === 'log-only') ||
          (target === 'room' ? typeof row.roomId !== 'string' : row.roomId !== undefined) ||
          (standalone === 'bearer'
            ? typeof row.standaloneToken !== 'string' ||
              !/^dct_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(row.standaloneToken)
            : row.standaloneToken !== undefined) ||
          !row.root.startsWith(home + '/')
        ) {
          error(new Error('Owned worker readiness mismatch'));
          return;
        }
        finish(() =>
          resolve(
            row as unknown as {
              origin: string;
              apiOrigin: string;
              sessionId: string;
              roomId?: string;
              documentId: string;
              root: string;
              standaloneToken?: string;
              frameDeclarationAbsent: boolean;
            }
          )
        );
      };
      launched.on('message', message);
      launched.once('error', error);
      launched.once('close', exit);
    });
    return {
      launched,
      target,
      integrityCase,
      standalone,
      ready,
      widgetDiagnostic,
      close,
      get retired() {
        return retired;
      },
      get failed() {
        return failed;
      },
      async fail(cause: unknown): Promise<never> {
        remember(cause);
        try {
          await close();
        } catch {}
        setupDiagnostic.stdout = rawOutput.stdout.toString('utf8');
        setupDiagnostic.stderr = rawOutput.stderr.toString('utf8');
        throw cause;
      },
    };
  } catch (cause) {
    remember(cause);
    try {
      await close();
    } catch {}
    // Original close waits for child close, which follows both owned stdio closures.
    // This is diagnostic DATA; it does not reconstruct or replace the child raw cause.
    setupDiagnostic.stdout = rawOutput.stdout.toString('utf8');
    setupDiagnostic.stderr = rawOutput.stderr.toString('utf8');
    throw cause;
  }
}

/** Own the same fresh process/home and original finite native host controls. */
export async function startIsolatedConsumerHost(
  target: 'session' | 'room' = 'session',
  integrityCase: NativeEmissionIntegrityCase = 'none',
  standalone: 'none' | 'bearer' | 'canonical' = 'none',
  frameMode: 'routed' | 'log-only' = 'routed'
) {
  const context = await constructOriginalHostContext(target, integrityCase, standalone, frameMode);
  const ownerKey = Object.freeze({});
  let reader: OwnedEvidenceReader | undefined;
  const owner = {
    ...context,
    get retired() {
      return context.retired;
    },
    get failed() {
      return context.failed;
    },
    get readOwnedEvidence() {
      if (!reader) throw new Error('Original host evidence reader unavailable');
      return reader;
    },
  };
  originalApply(originalSet, hostOwners, [ownerKey, owner]);
  try {
    ({ readOwnedEvidence: reader } = createOriginalHostReader(ownerKey));
    const {
      readOriginalRoomScenarioData,
      startNativeEmissionIntegrityObservation,
      readNativeEmissionIntegrityData,
      readCanonicalRecoveryData,
      readOriginalCheckboxPairData,
      readOriginalPresenceData,
      readOriginalSavedData,
      readOriginalSelectionData,
      readOriginalReviewedReplayData,
      readOriginalMcpAppData,
    } = createOriginalHostScenarioData(ownerKey);
    const { canonicalAction, loseNextWriterResponse, checkboxAction } =
      createOriginalHostRoomActions(ownerKey);
    const { savedAction, reviewedAction, mcpAction, selectionAction, widgetAction } =
      createOriginalHostFileActions(ownerKey);
    return {
      ...context.ready,
      ownerEmail: 'owner@consumer.invalid',
      ownerPassword: 'temporary-consumer-password-123',
      loseNextWriterResponse,
      openCheckboxFile: () => checkboxAction('open'),
      pumpCheckboxAfterRelease: () => checkboxAction('pump'),
      readOriginalCheckboxPairData,
      readOriginalSavedData,
      readOriginalPresenceData,
      openDocumentSaveFile: () => savedAction('open'),
      armOriginalSavedInsertFailure: () => savedAction('arm-failure'),
      pumpOriginalSavedDocument: () => savedAction('pump'),
      readOriginalReviewedReplayData,
      openReviewedReplayFile: () => reviewedAction('open'),
      expireOriginalReviewedReplay: () => reviewedAction('expire'),
      pumpOriginalReviewedReplay: () => reviewedAction('pump'),
      readOriginalSelectionData,
      openSelectionFile: () => selectionAction('open'),
      pumpOriginalSelection: () => selectionAction('pump'),
      openOriginalMcpApp: () => mcpAction('open'),
      pumpOriginalMcpApp: () => mcpAction('pump'),
      emitOriginalMcpAppDownstream: () => mcpAction('emit'),
      readOriginalMcpAppData,
      openBoundWidget: () => widgetAction('open'),
      patchBoundWidget: () => widgetAction('patch'),
      disconnectBoundWidgetStream: () => widgetAction('disconnect'),
      patchNextBoundWidget: () => widgetAction('next'),
      resetBoundWidgetHistory: () => widgetAction('reset'),
      revokeBoundWidgetGrant: () => widgetAction('revoke'),
      readOriginalRoomScenarioData,
      canonicalAction,
      readCanonicalRecoveryData,
      readNativeEmissionIntegrityData,
      startNativeEmissionIntegrityObservation,
      close: context.close,
    };
  } catch (cause) {
    return context.fail(cause);
  }
}
