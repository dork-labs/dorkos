/** Loopback-only temporary consumer writer/build/note fixture, never production routing. */
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createHook } from 'node:async_hooks';
import { setTimeout as timeoutScheduler, setInterval as intervalScheduler } from 'node:timers';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsumerVault, type FaultStage } from './writer.js';
import {
  openNativeConsumerStore,
  reopenNativeConsumerStore,
  ConsumerChannelStore,
} from './channel-store.js';
import { dashboardHtml } from './dashboard.js';
import type {
  NativeEmissionIntegrityCase,
  NativeEmissionIntegrityData,
} from './native-emission-integrity-control.js';

const startupPhases = [
  'admission-import',
  'native-fixture',
  'vault-create',
  'api-listen',
  'writer-listen',
  'boundary-import',
  'boundary-init',
  'native-store',
  'app-import',
  'agents-import',
  'upgrade-import',
  'stream-routes-import',
  'preview-import',
  'vite-import',
  'vite-create',
  'vite-listen',
  'config-import',
  'standalone-token',
] as const;
let startupSequence = 0;
function startupFrontier(
  phase: (typeof startupPhases)[number],
  state: 'begin' | 'done' | 'failed',
  causeType: 'undefined' | 'error' | 'other' | null = null
) {
  if (process.argv[2] !== '--consumer-native-worker' || !process.connected || startupSequence >= 64)
    return;
  try {
    process.send?.(
      { kind: 'startup-frontier', sequence: ++startupSequence, phase, state, causeType },
      () => {
        /* Diagnostic delivery cannot replace an original setup cause. */
      }
    );
  } catch {
    /* Diagnostics are secondary to original readiness and cleanup. */
  }
}
async function startupAwait<T>(phase: (typeof startupPhases)[number], run: () => Promise<T>) {
  startupFrontier(phase, 'begin');
  try {
    const result = await run();
    startupFrontier(phase, 'done');
    return result;
  } catch (cause) {
    startupFrontier(
      phase,
      'failed',
      cause === undefined ? 'undefined' : cause instanceof Error ? 'error' : 'other'
    );
    throw cause;
  }
}

async function json(response: ServerResponse, status: number, value: unknown) {
  const bytes = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(bytes);
}
/** Start the owned loopback consumer host and its genuine native document store. */
export async function startConsumerFixture() {
  const vault = await createConsumerVault();
  let channel: ConsumerChannelStore | undefined;
  let store!: ConsumerChannelStore;
  let channelStarted = false;
  let server: ReturnType<typeof createServer> | undefined;
  let loseResponse = false;
  let crashAt: FaultStage | undefined;
  let builds = 0;
  let retired = false;
  const counters = { legacyNotifier: 0, ackWatcherResends: 0 }; // Migrated fixture has NO dispatch/resend implementation.
  async function dispose() {
    retired = true;
    let failed = false;
    let first: unknown;
    try {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve()))
        );
    } catch (cause) {
      failed = true;
      first = cause;
    }
    try {
      await channel?.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    try {
      if (channelStarted && (!channel || failed))
        throw new Error('Original native channel closure UNKNOWN; vault retained');
      await vault.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
  }
  try {
    server = createServer(async (request, response) => {
      try {
        if (retired || !store) throw new Error('Fixture retired or native owner not ready');
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/dashboard') {
          const html = dashboardHtml();
          response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
          response.end(html);
          return;
        }
        if (request.method === 'GET' && url.pathname === '/snapshot') {
          await json(response, 200, {
            ...(await vault.snapshot()),
            documentId: store.documentId,
            counters,
            builds,
          });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/pending') {
          await json(response, 200, await vault.pending());
          return;
        }
        let raw = '',
          bytes = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for await (const block of request) {
          bytes += block.length;
          if (bytes > 16384) throw new Error('Request size refused');
          raw += decoder.decode(block, { stream: true });
        }
        raw += decoder.decode();
        const body = raw ? JSON.parse(raw) : {};
        if (request.method !== 'POST') {
          await json(response, 404, { error: 'Not found' });
          return;
        }
        let result: unknown;
        if (url.pathname === '/write') {
          result = await vault.write(body, (stage) => {
            if (stage === crashAt) {
              crashAt = undefined;
              throw new Error('Injected crash:' + stage);
            }
          });
          if (loseResponse) {
            loseResponse = false;
            response.destroy();
            return;
          }
        } else if (url.pathname === '/handoff/begin')
          result = await vault.beginHandoff(body.operationId);
        else if (url.pathname === '/handoff/receipt') {
          const op = (await vault.snapshot()).ledger.operations[body.operationId];
          if (!op) throw new Error('Writer operation unavailable');
          const receipt = await store.confirm(op);
          if (
            body.receipt?.receipt?.id !== receipt.receipt.id ||
            body.receipt.receipt.docSeq !== receipt.receipt.docSeq
          )
            throw new Error('Offered receipt does not match actual store');
          result = await vault.recordChannel(body.operationId, receipt);
        } else if (url.pathname === '/note.open') result = await vault.noteOpen();
        else if (url.pathname === '/build') {
          builds++;
          result = { builds, markdown: (await vault.snapshot()).markdown };
        } else if (url.pathname === '/ack-audit') {
          await vault.auditAck(body);
          result = { auditMirrorOnly: true };
        } else {
          await json(response, 404, { error: 'Not found' });
          return;
        }
        await json(response, 200, result);
      } catch (cause) {
        if (!response.destroyed)
          await json(response, 409, {
            error: cause instanceof Error ? cause.message : 'Writer failed',
          });
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Loopback fixture address unavailable');
    const origin = 'http://127.0.0.1:' + address.port;
    channelStarted = true;
    channel = await ConsumerChannelStore.open(vault, origin + '/dashboard');
    store = channel;
    return {
      origin,
      vault,
      channel: store,
      loseNextWriterResponse() {
        loseResponse = true;
      },
      crashNextWrite(stage: FaultStage) {
        crashAt = stage;
      },
      async recover() {
        return vault.reopen();
      },
      /** Store proof-only adapter, not a browser SDK or authority issuer. Flush only pre-admission. */
      async flushStore() {
        const accepted = [];
        for (const op of await vault.pending()) {
          await vault.beginHandoff(op.request.operationId);
          await store.emit(op.event);
          const receipt = await store.confirm(op);
          await vault.recordChannel(op.request.operationId, receipt);
          accepted.push(receipt);
        }
        return accepted;
      },
      /** Query genuine persisted receipt after unknown channel response; never re-emit admitted work. */
      async reconcileHandoff(id: string) {
        const op = (await vault.snapshot()).ledger.operations[id];
        if (!op) throw new Error('Writer operation unavailable');
        const receipt = await store.confirm(op);
        return vault.recordChannel(id, receipt);
      },
      close: dispose,
    };
  } catch (cause) {
    try {
      await dispose();
    } catch {}
    throw cause;
  }
}
export type ConsumerFixture = Awaited<ReturnType<typeof startConsumerFixture>>;
export type NativeRoomScenarioData = Awaited<
  ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalRoomScenarioData']>
>;

/** Reserve a prospective port without claiming its later availability. A raced
 * bind is a setup failure, never a fallback to an unbound origin/auth policy. */
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
export async function startIsolatedConsumerHost(
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
  let closeDiagnosticRemainder = '';
  let closeDiagnosticRecords = 0;
  const forwardCloseDiagnostic = (chunk: Buffer) => {
    // Finite close DATA only; arbitrary worker output remains in original bounded custody.
    const lines = (closeDiagnosticRemainder + chunk.toString('utf8')).split('\n');
    closeDiagnosticRemainder = (lines.pop() ?? '').slice(-256);
    for (const line of lines) {
      if (
        closeDiagnosticRecords < 40 &&
        /^ORIGINAL_MCP_CLOSE_STAGE child [1-9][0-9]? [0-9]{13} (startup|reviewed-stop|reviewed-join|saved-stop|saved-join|selection-stop|selection-join|mcp-stop|mcp-join|widget-join|canonical-join|vite-close|previews-close|fixture-close|complete) (begin|done|failed)$/.test(
          line
        )
      ) {
        closeDiagnosticRecords++;
        try {
          console.error(line);
        } catch {
          // Diagnostic transport cannot replace the original close result.
        }
      }
    }
  };
  let resourceDiagnosticRemainder = '';
  let resourceDiagnosticRecords = 0;
  const forwardResourceDiagnostic = (chunk: Buffer) => {
    const lines = (resourceDiagnosticRemainder + chunk.toString('utf8')).split('\n');
    resourceDiagnosticRemainder = (lines.pop() ?? '').slice(-4096);
    for (const line of lines) {
      if (resourceDiagnosticRecords >= 3 || Buffer.byteLength(line + '\n', 'utf8') > 4096) continue;
      try {
        const row: unknown = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const data = row as Record<string, unknown>;
        if (
          Object.keys(data).sort().join(',') !==
          'at,counts,kind,phase,resourceCount,sequence,timeoutOrigins,truncated'
        )
          continue;
        if (
          data.kind !== 'ORIGINAL_MCP_POST_CLOSE_RESOURCES' ||
          data.sequence !== resourceDiagnosticRecords + 1
        )
          continue;
        if (
          !['closed-before-disconnect', 'closed-after-disconnect', 'before-exit'].includes(
            String(data.phase)
          )
        )
          continue;
        if (typeof data.at !== 'number' || !Number.isSafeInteger(data.at) || data.at < 0) continue;
        if (
          typeof data.resourceCount !== 'number' ||
          !Number.isInteger(data.resourceCount) ||
          data.resourceCount < 0 ||
          data.resourceCount > 65
        )
          continue;
        if (typeof data.truncated !== 'boolean' || data.truncated !== (data.resourceCount === 65))
          continue;
        if (!data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts)) continue;
        const entries = Object.entries(data.counts);
        if (
          entries.length > 64 ||
          entries.some(
            ([kind, count]) =>
              !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(kind) ||
              typeof count !== 'number' ||
              !Number.isInteger(count) ||
              count < 1 ||
              count > 64
          )
        )
          continue;
        const sum = entries.reduce((total, [, count]) => total + Number(count), 0);
        if (sum > 64 || sum > data.resourceCount) continue;
        if (
          !data.timeoutOrigins ||
          typeof data.timeoutOrigins !== 'object' ||
          Array.isArray(data.timeoutOrigins)
        )
          continue;
        const origins = data.timeoutOrigins as Record<string, unknown>;
        if (
          Object.keys(origins).sort().join(',') !==
          'captures,entries,moduleLevelImportBlindspot,overflow,trackedCount'
        )
          continue;
        if (
          typeof origins.trackedCount !== 'number' ||
          !Number.isInteger(origins.trackedCount) ||
          origins.trackedCount < 0 ||
          origins.trackedCount > 64
        )
          continue;
        if (typeof origins.overflow !== 'boolean' || origins.moduleLevelImportBlindspot !== true)
          continue;
        if (
          !Array.isArray(origins.entries) ||
          origins.entries.length > 4 ||
          origins.entries.some(
            (frames: unknown) =>
              !Array.isArray(frames) ||
              frames.length > 6 ||
              frames.some(
                (frame: unknown) =>
                  typeof frame !== 'string' ||
                  !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(frame) ||
                  frame.startsWith('/') ||
                  frame.includes('..')
              )
          )
        )
          continue;
        if (
          !Array.isArray(origins.captures) ||
          origins.captures.length !== origins.entries.length ||
          origins.captures.some((value: unknown) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
            const capture = value as Record<string, unknown>;
            if (
              Object.keys(capture).sort().join(',') !==
              'mode,outsideScope,rawFrameCount,scaffolding,truncated,unparsed,unsafe'
            )
              return true;
            if (
              !['timeout-caller', 'interval-caller', 'hook-fallback'].includes(
                String(capture.mode)
              ) ||
              typeof capture.truncated !== 'boolean'
            )
              return true;
            return ['rawFrameCount', 'unparsed', 'outsideScope', 'unsafe', 'scaffolding'].some(
              (key) =>
                typeof capture[key] !== 'number' ||
                !Number.isInteger(capture[key]) ||
                Number(capture[key]) < 0 ||
                Number(capture[key]) > 64
            );
          })
        )
          continue;
        resourceDiagnosticRecords++;
        console.error(line);
      } catch {
        // Invalid or unavailable resource DATA never changes the original first cause.
      }
    }
  };
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
        fileURLToPath(import.meta.url),
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
    let controlSequence = 0,
      controlPending = false;
    let evidenceSequence = 0,
      evidencePending = false;
    const readOwnedEvidence = <T>(
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
    ) =>
      new Promise<T>((resolve, reject) => {
        if (
          (target !== 'room' &&
            !(
              target === 'session' &&
              ((kind === 'read-checkbox-pair-data' && responseKind === 'checkbox-pair-data') ||
                (kind === 'read-selection-data' && responseKind === 'selection-data') ||
                (kind === 'read-reviewed-replay-data' && responseKind === 'reviewed-replay-data') ||
                (kind === 'read-saved-data' && responseKind === 'saved-data') ||
                (kind === 'read-presence-data' && responseKind === 'presence-data') ||
                (kind === 'read-mcp-app-data' && responseKind === 'mcp-app-data'))
            )) ||
          retired ||
          failed ||
          !launched.connected ||
          evidencePending ||
          evidenceSequence >= 96
        ) {
          reject(new Error('Owned Room evidence control unavailable'));
          return;
        }
        evidencePending = true;
        const id = ++evidenceSequence;
        const cleanup = () => {
          evidencePending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Owned Room evidence child closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as {
            kind?: unknown;
            id?: unknown;
            data?: unknown;
            ok?: unknown;
            failureMessage?: unknown;
            undefinedCause?: unknown;
          };
          if (row.kind !== responseKind || row.id !== id) return;
          cleanup();
          if (row.ok !== true || !validate(row.data)) {
            console.error(
              'ORIGINAL_NATIVE_EVIDENCE_FAILURE',
              JSON.stringify({
                responseKind,
                nativeReadSucceeded: row.ok === true,
                rawUndefined: row.undefinedCause === true,
                reason:
                  typeof row.failureMessage === 'string'
                    ? row.failureMessage.slice(0, 512)
                    : undefined,
              })
            );
            reject(new Error('Owned original Room evidence mismatch'));
            return;
          }
          resolve(row.data);
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind, id }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    const readOriginalRoomScenarioData = () =>
      readOwnedEvidence(
        'read-room-scenario-data',
        'room-scenario-data',
        (value): value is NativeRoomScenarioData => {
          const data = value as NativeRoomScenarioData | undefined;
          return (
            !!data &&
            data.documentId === ready.documentId &&
            data.scope === 'room:' + ready.roomId &&
            data.meaning === 'PROVIDER_BOUNDARY_DATA_ONLY_ABSENCE_UNKNOWN' &&
            typeof data.targetSessionId === 'string' &&
            /^[0-9a-f-]{36}$/i.test(data.targetSessionId) &&
            typeof data.targetLocked === 'boolean' &&
            Array.isArray(data.batches) &&
            data.batches.length <= 32
          );
        }
      );
    const startNativeEmissionIntegrityObservation = () =>
      readOwnedEvidence(
        'start-native-integrity-observation',
        'native-integrity-started',
        (value): value is { started: true } =>
          !!value &&
          typeof value === 'object' &&
          Object.keys(value).length === 1 &&
          (value as { started?: unknown }).started === true
      );
    const readNativeEmissionIntegrityData = () =>
      readOwnedEvidence(
        'read-native-integrity-data',
        'native-integrity-data',
        (value): value is NativeEmissionIntegrityData => {
          if (!value || typeof value !== 'object') return false;
          const data = value as NativeEmissionIntegrityData;
          return (
            data.caseName === integrityCase &&
            ['waiting', 'armed', 'restored'].includes(data.phase) &&
            (data.ackId === null ||
              (typeof data.ackId === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                  data.ackId
                ))) &&
            Number.isSafeInteger(data.replacementCalls) &&
            data.replacementCalls >= 0 &&
            (data.retired === null || typeof data.retired === 'boolean') &&
            typeof data.observerFailed === 'boolean' &&
            (data.observerFailure === null ||
              (typeof data.observerFailure === 'string' && data.observerFailure.length <= 512)) &&
            data.observerFailed === (data.observerFailure !== null)
          );
        }
      );
    let canonicalSequence = 0,
      canonicalPending = false;
    const canonicalAction = (action: 'pause' | 'capture' | 'restart') =>
      new Promise<{ canonicalId?: string; closed?: boolean }>((resolve, reject) => {
        const expected = ['pause', 'capture', 'restart'][canonicalSequence];
        if (
          standalone !== 'canonical' ||
          target !== 'room' ||
          retired ||
          failed ||
          canonicalPending ||
          !launched.connected ||
          action !== expected
        )
          return reject(new Error('Original canonical fixture action unavailable'));
        canonicalPending = true;
        const id = ++canonicalSequence;
        const cleanup = () => {
          canonicalPending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Original canonical fixture child closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
          if (row.kind !== 'native-canonical-result' || row.id !== id) return;
          cleanup();
          const data = row.data as { canonicalId?: unknown; closed?: unknown } | undefined;
          if (
            row.ok !== true ||
            !data ||
            (action !== 'pause' &&
              (typeof data.canonicalId !== 'string' ||
                !/^[0-9a-f-]{36}$/i.test(data.canonicalId))) ||
            (action === 'restart' && data.closed !== true)
          )
            return reject(new Error('Original canonical fixture action unconfirmed'));
          resolve(data as { canonicalId?: string; closed?: boolean });
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind: 'native-canonical-action', id, action }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    const readCanonicalRecoveryData = () =>
      readOwnedEvidence(
        'read-canonical-recovery-data',
        'canonical-recovery-data',
        (value): value is { canonicalId: string; closed: boolean } =>
          !!value &&
          typeof value === 'object' &&
          typeof (value as { canonicalId?: unknown }).canonicalId === 'string' &&
          typeof (value as { closed?: unknown }).closed === 'boolean'
      );
    const loseNextWriterResponse = () =>
      new Promise<void>((resolve, reject) => {
        if (retired || failed || !launched.connected || controlPending || controlSequence >= 16) {
          reject(new Error('Owned writer fault control refused'));
          return;
        }
        controlPending = true;
        const id = ++controlSequence;
        const cleanup = () => {
          controlPending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Owned writer fault control closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as { kind?: unknown; id?: unknown; ok?: unknown };
          if (row.kind !== 'writer-fault-armed' || row.id !== id) return;
          cleanup();
          if (row.ok === true) resolve();
          else reject(new Error('Owned writer fault control unavailable'));
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind: 'lose-writer-response', id }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    type CheckboxPairData = Awaited<
      ReturnType<
        Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalCheckboxPairData']
      >
    >;
    const readOriginalCheckboxPairData = () =>
      readOwnedEvidence<CheckboxPairData>(
        'read-checkbox-pair-data',
        'checkbox-pair-data',
        (value): value is CheckboxPairData => {
          if (!value || typeof value !== 'object') return false;
          const data = value as CheckboxPairData;
          return (
            typeof data.documentId === 'string' &&
            typeof data.baselineRestored === 'boolean' &&
            Array.isArray(data.events) &&
            data.events.length <= 2 &&
            Array.isArray(data.receipts) &&
            data.receipts.length <= 2 &&
            Array.isArray(data.savedEvents) &&
            data.savedEvents.length <= 1 &&
            Array.isArray(data.deliveries) &&
            data.deliveries.length <= 2 &&
            Array.isArray(data.batches) &&
            data.batches.length <= 2 &&
            [data.admissions, data.spend, data.privateAdmissions, data.scenarioStarts].every(
              (n) => Number.isSafeInteger(n) && n >= 0
            ) &&
            typeof data.targetLocked === 'boolean'
          );
        }
      );
    type SavedData = Awaited<
      ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalSavedData']>
    >;
    type PresenceData = Awaited<
      ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalPresenceData']>
    >;
    const readOriginalPresenceData = () =>
      readOwnedEvidence<PresenceData>(
        'read-presence-data',
        'presence-data',
        (value): value is PresenceData => {
          if (
            !value ||
            typeof value !== 'object' ||
            !('documentId' in value) ||
            typeof value.documentId !== 'string' ||
            !('events' in value) ||
            !Array.isArray(value.events) ||
            value.events.length > 32 ||
            !('batches' in value) ||
            typeof value.batches !== 'number' ||
            !Number.isSafeInteger(value.batches) ||
            value.batches < 0 ||
            !('admissions' in value) ||
            typeof value.admissions !== 'number' ||
            !Number.isSafeInteger(value.admissions) ||
            value.admissions < 0
          )
            return false;
          return value.events.every(
            (event) =>
              event &&
              typeof event === 'object' &&
              'type' in event &&
              ['host.opened', 'host.closed', 'doc.viewers', 'host.focus'].includes(event.type) &&
              'payload' in event
          );
        }
      );
    const readOriginalSavedData = () =>
      readOwnedEvidence<SavedData>('read-saved-data', 'saved-data', (value): value is SavedData => {
        if (!value || typeof value !== 'object') return false;
        const data = value as SavedData;
        return (
          typeof data.documentId === 'string' &&
          /^[a-f0-9]{64}$/.test(data.fileHash) &&
          /^[a-f0-9]{64}$/.test(data.baselineHash) &&
          typeof data.failureArmed === 'boolean' &&
          Array.isArray(data.events) &&
          data.events.length <= 1 &&
          Array.isArray(data.deliveries) &&
          data.deliveries.length <= 1 &&
          Array.isArray(data.admissions) &&
          data.admissions.length <= 1 &&
          Number.isSafeInteger(data.scenarioStarts) &&
          data.scenarioStarts >= 0
        );
      });
    let savedSequence = 0,
      savedPending = false;
    const savedAction = (action: 'open' | 'arm-failure' | 'pump') =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (
          retired ||
          failed ||
          !launched.connected ||
          target !== 'session' ||
          savedPending ||
          action !== ['open', 'pump', 'arm-failure'][savedSequence]
        ) {
          reject(new Error('Original saved FILE action refused'));
          return;
        }
        savedPending = true;
        const id = ++savedSequence;
        const cleanup = () => {
          savedPending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Original saved FILE child closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
          if (row.kind !== 'native-saved-result' || row.id !== id) return;
          cleanup();
          if (row.ok === true && row.data && typeof row.data === 'object')
            resolve(row.data as Record<string, unknown>);
          else reject(new Error('Original saved FILE action failed'));
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind: 'native-saved-action', action, id }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    type SelectionData = Awaited<
      ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalSelectionData']>
    >;
    const readOriginalSelectionData = () =>
      readOwnedEvidence<SelectionData>(
        'read-selection-data',
        'selection-data',
        (value): value is SelectionData => {
          if (!value || typeof value !== 'object') return false;
          const data = value as SelectionData;
          return (
            typeof data.documentId === 'string' &&
            typeof data.fileUnchanged === 'boolean' &&
            Array.isArray(data.events) &&
            data.events.length <= 1 &&
            Array.isArray(data.deliveries) &&
            data.deliveries.length <= 1 &&
            Array.isArray(data.admissions) &&
            data.admissions.length <= 1 &&
            Number.isSafeInteger(data.scenarioStarts) &&
            data.scenarioStarts >= 0
          );
        }
      );
    type ReviewedReplayData = Awaited<
      ReturnType<
        Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalReviewedReplayData']
      >
    >;
    const readOriginalReviewedReplayData = () =>
      readOwnedEvidence<ReviewedReplayData>(
        'read-reviewed-replay-data',
        'reviewed-replay-data',
        (value): value is ReviewedReplayData => {
          if (!value || typeof value !== 'object') return false;
          const data = value as ReviewedReplayData;
          return (
            typeof data.documentId === 'string' &&
            typeof data.baselineUnchanged === 'boolean' &&
            Array.isArray(data.events) &&
            data.events.length <= 1 &&
            Array.isArray(data.batches) &&
            data.batches.length <= 2 &&
            Array.isArray(data.deliveries) &&
            data.deliveries.length <= 1 &&
            Array.isArray(data.receipts) &&
            data.receipts.length <= 1 &&
            Number.isSafeInteger(data.scenarioStarts) &&
            data.scenarioStarts >= 0
          );
        }
      );
    let reviewedSequence = 0,
      reviewedPending = false;
    const reviewedAction = (action: 'open' | 'expire' | 'pump') =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (
          retired ||
          failed ||
          !launched.connected ||
          target !== 'session' ||
          reviewedPending ||
          action !== ['open', 'expire', 'pump'][reviewedSequence]
        ) {
          reject(new Error('Original reviewed replay action refused'));
          return;
        }
        reviewedPending = true;
        const id = ++reviewedSequence;
        const cleanup = () => {
          reviewedPending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Original reviewed replay child closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
          if (row.kind !== 'native-reviewed-replay-result' || row.id !== id) return;
          cleanup();
          if (row.ok === true && row.data && typeof row.data === 'object')
            resolve(row.data as Record<string, unknown>);
          else reject(new Error('Original reviewed replay action failed'));
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind: 'native-reviewed-replay-action', action, id }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    type McpAppData = Awaited<
      ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalMcpAppData']>
    >;
    const readOriginalMcpAppData = () =>
      readOwnedEvidence<McpAppData>(
        'read-mcp-app-data',
        'mcp-app-data',
        (value): value is McpAppData =>
          !!value &&
          typeof value === 'object' &&
          'documentId' in value &&
          typeof value.documentId === 'string' &&
          'events' in value &&
          Array.isArray(value.events) &&
          value.events.length <= 6
      );
    let mcpSequence = 0,
      mcpPending = false;
    const mcpAction = (action: 'open' | 'pump' | 'emit') =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (
          retired ||
          failed ||
          !launched.connected ||
          target !== 'session' ||
          mcpPending ||
          action !== ['open', 'pump', 'emit'][mcpSequence]
        ) {
          reject(new Error('Original MCP App action refused'));
          return;
        }
        mcpPending = true;
        const id = ++mcpSequence;
        const cleanup = () => {
          mcpPending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Original MCP App child closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
          if (row.kind !== 'native-mcp-app-result' || row.id !== id) return;
          cleanup();
          if (row.ok === true && row.data && typeof row.data === 'object')
            resolve(row.data as Record<string, unknown>);
          else reject(new Error('Original MCP App action failed'));
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind: 'native-mcp-app-action', action, id }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    let selectionSequence = 0,
      selectionPending = false;
    const selectionAction = (action: 'open' | 'pump') =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (
          retired ||
          failed ||
          !launched.connected ||
          target !== 'session' ||
          selectionPending ||
          action !== ['open', 'pump'][selectionSequence]
        ) {
          reject(new Error('Original selection action refused'));
          return;
        }
        selectionPending = true;
        const id = ++selectionSequence;
        const cleanup = () => {
          selectionPending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Original selection child closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
          if (row.kind !== 'native-selection-result' || row.id !== id) return;
          cleanup();
          if (row.ok === true && row.data && typeof row.data === 'object')
            resolve(row.data as Record<string, unknown>);
          else reject(new Error('Original selection action failed'));
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind: 'native-selection-action', action, id }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    let checkboxControlSequence = 0,
      checkboxControlPending = false;
    const checkboxAction = (action: 'open' | 'pump') =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (
          retired ||
          failed ||
          !launched.connected ||
          (target !== 'room' && target !== 'session') ||
          checkboxControlPending ||
          checkboxControlSequence >= 2
        ) {
          reject(new Error('Owned native checkbox action refused'));
          return;
        }
        checkboxControlPending = true;
        const id = ++checkboxControlSequence;
        const cleanup = () => {
          checkboxControlPending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Owned native checkbox action closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
          if (row.kind !== 'native-checkbox-result' || row.id !== id) return;
          cleanup();
          if (row.ok !== true || !row.data || typeof row.data !== 'object')
            reject(new Error('Owned native checkbox action failed'));
          else resolve(row.data as Record<string, unknown>);
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind: 'native-checkbox-action', action, id }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    let widgetControlSequence = 0,
      widgetControlPending = false;
    const widgetAction = (action: 'open' | 'patch' | 'disconnect' | 'next' | 'reset' | 'revoke') =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (
          retired ||
          failed ||
          !launched.connected ||
          target !== 'session' ||
          widgetControlPending ||
          widgetControlSequence >= 6
        ) {
          reject(new Error('Owned native widget action refused'));
          return;
        }
        widgetControlPending = true;
        const id = ++widgetControlSequence;
        const cleanup = () => {
          widgetControlPending = false;
          launched.off('message', receive);
          launched.off('close', unavailable);
        };
        const unavailable = () => {
          cleanup();
          reject(new Error('Owned native widget action closed'));
        };
        const receive = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const row = value as {
            kind?: unknown;
            id?: unknown;
            ok?: unknown;
            data?: unknown;
            undefinedCause?: unknown;
          };
          if (row.kind !== 'native-widget-result' || row.id !== id) return;
          cleanup();
          if (row.ok !== true || !row.data || typeof row.data !== 'object') {
            widgetDiagnostic.undefinedCause = row.undefinedCause === true;
            reject(new Error('Owned native widget action failed', { cause: widgetDiagnostic }));
          } else resolve(row.data as Record<string, unknown>);
        };
        launched.on('message', receive);
        launched.once('close', unavailable);
        try {
          launched.send({ kind: 'native-widget-action', action, id }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      });
    return {
      ...ready,
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
      close,
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

/** Actual app/router/auth/host construction on the same owned FILE database.
 * Caller must supply the original startup admission owner; no fixture boolean or
 * callback manufactures it. This function neither fabricates a terminal lease
 * nor starts a model provider. Built shell/current app-source gates remain required.
 */
export async function startNativeConsumerFixture(
  admission: import('../../../server/src/services/core/lifecycle/main-request-admission.js').MainRequestAdmission,
  port = 0,
  temporaryParent = tmpdir(),
  target: 'session' | 'room' = 'session',
  integrityCase: NativeEmissionIntegrityCase = 'none',
  frameMode: 'routed' | 'log-only' = 'routed'
) {
  const vault = await startupAwait('vault-create', () =>
    createConsumerVault(() => Date.now(), temporaryParent)
  );
  let native: Awaited<ReturnType<typeof openNativeConsumerStore>> | undefined;
  let nativeConstructionStarted = false,
    nativeClosed = false;
  let replacementUnknown = false,
    restartStarted = false;
  let restartFailure: { cause: unknown } | undefined;
  let app: ReturnType<typeof import('../../../server/src/app.js').createApp> | undefined;
  let loseWriterResponse = false;
  // Separate temporary writer origin: the real preview listener authorizes its
  // own bootstrap/cookie before proxying, and never forwards operator cookies.
  // This upstream has no /api, actor/issuer or model-start endpoint. It accesses
  // only its own sanitary vault and confirms existing native receipts.
  const writerServer = createServer(async (request, response) => {
    try {
      if (retired) throw new Error('Owned writer retired');
      if (!native) {
        await json(response, 503, { error: 'Owned native store starting' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        request.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/consumer/dashboard')
      ) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(dashboardHtml());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/snapshot') {
        await json(response, 200, await vault.snapshot());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/pending') {
        await json(response, 200, await vault.pending());
        return;
      }
      if (request.method !== 'POST') {
        await json(response, 404, { error: 'Not found' });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error('Owned writer request bound');
        chunks.push(chunk);
      }
      if (retired) throw new Error('Owned writer retired during request');
      const body = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      );
      let value: unknown;
      if (url.pathname === '/write') {
        value = await vault.write(body);
        if (loseWriterResponse) {
          loseWriterResponse = false;
          response.destroy();
          return;
        }
      } else if (url.pathname === '/handoff/begin')
        value = await vault.beginHandoff(body.operationId);
      else if (url.pathname === '/handoff/receipt') {
        const op = (await vault.snapshot()).ledger.operations[body.operationId];
        if (!op) throw new Error('Original writer operation unavailable');
        const receipt = await native.confirm(op);
        if (
          body.receipt?.receipt?.id !== receipt.receipt.id ||
          body.receipt.receipt.docSeq !== receipt.receipt.docSeq
        )
          throw new Error('Original native receipt mismatch');
        value = await vault.recordChannel(op.request.operationId, receipt);
      } else if (url.pathname === '/note.open') value = await vault.noteOpen();
      else if (url.pathname === '/build') value = { markdown: (await vault.snapshot()).markdown };
      else if (url.pathname === '/ack-audit') {
        await vault.auditAck(body);
        value = { auditMirrorOnly: true };
      } else {
        await json(response, 404, { error: 'Not found' });
        return;
      }
      await json(response, 200, value);
    } catch {
      if (!response.destroyed)
        await json(response, 409, { error: 'Original writer operation unconfirmed' });
    }
  });
  const server = createServer((request, response) => {
    if (!app) {
      response.writeHead(503);
      response.end('Native fixture starting');
      return;
    }
    app(request, response);
  });
  const apiSockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    apiSockets.add(socket);
    socket.once('close', () => apiSockets.delete(socket));
  });
  // Observe only original upgrades on this owned API listener. The production
  // router still performs all credential/admission checks and opens the stream.
  const widgetSessionSockets = new Set<import('node:net').Socket>();
  server.on('upgrade', (request, socket) => {
    if (target !== 'session' || !native) return;
    const owned = [...apiSockets].find((candidate) => candidate === socket);
    if (!owned || request.url?.split('?', 1)[0] !== '/api/sessions/' + native.sessionId + '/events')
      return;
    widgetSessionSockets.add(owned);
    owned.once('close', () => widgetSessionSockets.delete(owned));
  });
  let widgetStreamDisconnected = false;
  const ownedSockets = new Set<import('node:net').Socket>();
  for (const listener of [server, writerServer])
    listener.on('connection', (socket) => {
      ownedSockets.add(socket);
      socket.once('close', () => ownedSockets.delete(socket));
    });
  let retired = false;
  let retirement: Promise<void> | undefined;
  const close = () => {
    if (retirement) return retirement;
    retired = true;
    retirement = Promise.resolve().then(async () => {
      let failed = false,
        first: unknown;
      const drain = async (run: () => unknown) => {
        try {
          await run();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      };
      await drain(() => admission.close());
      // Exact sockets accepted by these two owned listeners, including upgraded
      // durable streams. Destroying them delivers original socket-close cleanup;
      // admission is already permanently closed. Never search/kill other sockets.
      for (const socket of ownedSockets) await drain(() => socket.destroy());
      await drain(() =>
        writerServer.listening
          ? new Promise<void>((resolve, reject) =>
              writerServer.close((cause) => (cause ? reject(cause) : resolve()))
            )
          : undefined
      );
      await drain(() =>
        server.listening
          ? new Promise<void>((resolve, reject) =>
              server.close((cause) => (cause ? reject(cause) : resolve()))
            )
          : undefined
      );
      await drain(async () => {
        if (native) {
          await native.close();
          if (!replacementUnknown) nativeClosed = true;
        }
      });
      if (restartFailure)
        await drain(() => {
          throw restartFailure!.cause;
        });
      else if (replacementUnknown)
        await drain(() => {
          throw new Error('Original replacement construction closure UNKNOWN');
        });
      if (!nativeConstructionStarted || nativeClosed) await drain(() => vault.close());
      if (failed) throw first;
    });
    return retirement;
  };
  try {
    server.listen(port, '127.0.0.1');
    await startupAwait('api-listen', () => once(server!, 'listening'));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Native fixture loopback unavailable');
    const origin = 'http://127.0.0.1:' + address.port;
    writerServer.listen(0, '127.0.0.1');
    await startupAwait('writer-listen', () => once(writerServer, 'listening'));
    const writerAddress = writerServer.address();
    if (!writerAddress || typeof writerAddress === 'string')
      throw new Error('Owned writer origin unavailable');
    const writerOrigin = 'http://127.0.0.1:' + writerAddress.port;
    // InstallationFileWrites captures the real boundary during native construction.
    const { initBoundary } = await startupAwait(
      'boundary-import',
      () => import('../../../server/src/lib/boundary.js')
    );
    await startupAwait('boundary-init', () => initBoundary(vault.root));
    nativeConstructionStarted = true;
    native = await startupAwait('native-store', () =>
      openNativeConsumerStore(
        vault,
        writerOrigin,
        true,
        target,
        integrityCase,
        undefined,
        frameMode
      )
    );
    const original = native;
    const { createApp, finalizeApp } = await startupAwait(
      'app-import',
      () => import('../../../server/src/app.js')
    );
    const { createAgentsRouter } = await startupAwait(
      'agents-import',
      () => import('../../../server/src/routes/agents.js')
    );
    app = createApp({ admission }); // Retains actual host/session/cookie/parser admission order.
    app.locals.docChannelHttp = original.http;
    // Production mounts original agent identity routes after core app admission.
    app.use('/api/agents', createAgentsRouter());
    app.use('/api/canvas/docs', original.managementRouter);
    app.use('/api/approvals', original.approvalRouter);
    const { attachUpgradeRouter } = await startupAwait(
      'upgrade-import',
      () => import('../../../server/src/services/core/streams/upgrade-router.js')
    );
    const { durableStreamRoutes } = await startupAwait(
      'stream-routes-import',
      () => import('../../../server/src/routes/stream-sockets.js')
    );
    attachUpgradeRouter(server, durableStreamRoutes, admission); // Original credential/current-origin gate, no fixture classifier.
    finalizeApp(app);
    return {
      origin,
      writerOrigin,
      vault,
      get native() {
        if (!native) throw new Error('Original native fixture unavailable');
        return native;
      },
      async disconnectBoundWidgetStream() {
        if (
          retired ||
          target !== 'session' ||
          integrityCase !== 'none' ||
          !native ||
          widgetStreamDisconnected
        )
          throw new Error('Original widget stream interruption unavailable');
        const sockets = [...widgetSessionSockets];
        if (sockets.length !== 1 || sockets[0].destroyed || !apiSockets.has(sockets[0]))
          throw new Error('Original widget session socket custody unavailable');
        // Consume the single fixture fault before any close callback can reenter.
        widgetStreamDisconnected = true;
        const socket = sockets[0];
        const closed = once(socket, 'close');
        socket.destroy();
        await closed;
        if (!socket.destroyed || apiSockets.has(socket) || widgetSessionSockets.has(socket))
          throw new Error('Original widget session socket closure UNKNOWN');
        return { socketCount: 1, closed: true };
      },
      async restartOriginalNativeRoom() {
        if (
          retired ||
          restartStarted ||
          target !== 'room' ||
          integrityCase !== 'none' ||
          !native ||
          !app
        )
          throw new Error('Original canonical native restart unavailable');
        const prior = native;
        const observed = prior.readCanonicalRecoveryData();
        if (!observed.closed) throw new Error('Original canonical producer closure UNKNOWN');
        restartStarted = true;
        try {
          // Refuse new API work while the old native boot is retiring. Keep both
          // real listeners and the preview upstream; the physical iframe stays mounted.
          app = undefined;
          let socketFailed = false,
            socketCause: unknown;
          const rememberSocket = (cause: unknown) => {
            if (!socketFailed) {
              socketFailed = true;
              socketCause = cause;
            }
          };
          await Promise.allSettled(
            [...apiSockets].map((socket) =>
              Promise.resolve()
                .then(async () => {
                  const closed = once(socket, 'close');
                  socket.destroy();
                  await closed;
                })
                .catch(rememberSocket)
            )
          );
          if (socketFailed) throw socketCause;
          await prior.close();
          nativeClosed = true;
          nativeClosed = false;
          replacementUnknown = true;
          try {
            const successor = await reopenNativeConsumerStore(prior);
            native = successor;
            replacementUnknown = false;
            app = createApp({ admission });
            app.locals.docChannelHttp = successor.http;
            app.use('/api/agents', createAgentsRouter());
            app.use('/api/canvas/docs', successor.managementRouter);
            app.use('/api/approvals', successor.approvalRouter);
            finalizeApp(app);
            return { canonicalId: successor.sessionId, closed: true };
          } catch (cause) {
            restartFailure = { cause };
            throw cause;
          }
        } catch (cause) {
          if (!restartFailure) restartFailure = { cause };
          throw cause;
        }
      },
      app,
      loseNextWriterResponse: () => {
        if (retired) throw new Error('Owned writer retired');
        loseWriterResponse = true;
      },
      close,
    };
  } catch (cause) {
    try {
      await close();
    } catch {
      /* Preserve primary setup cause. */
    }
    throw cause;
  }
}

/** Child-only bootstrap. All module globals die with this owned process, and
 * every returned resource is registered before the next startup await. */
async function runNativeConsumerWorker() {
  type TimeoutCapture = {
    mode: 'timeout-caller' | 'interval-caller' | 'hook-fallback';
    rawFrameCount: number;
    unparsed: number;
    outsideScope: number;
    unsafe: number;
    scaffolding: number;
    truncated: boolean;
  };
  const timeoutOrigins = new Map<
    number,
    { resource: WeakRef<object>; frames: string[]; capture: TimeoutCapture }
  >();
  let timeoutOriginOverflow = false;
  const scrubTimeoutFrames = (stack: string | undefined, mode: TimeoutCapture['mode']) => {
    const lines = (stack ?? '').split('\n').slice(1);
    const capture: TimeoutCapture = {
      mode,
      rawFrameCount: Math.min(lines.length, 64),
      unparsed: 0,
      outsideScope: 0,
      unsafe: 0,
      scaffolding: 0,
      truncated: lines.length > 64,
    };
    const frames: string[] = [];
    const root = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/\/+$/, '');
    for (const line of lines.slice(0, 64)) {
      const match = line.match(/(?:\(|\s)((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?$/);
      if (!match) {
        capture.unparsed++;
        continue;
      }
      const location = match[1].replace(/^file:\/\//, '');
      let tag: string;
      if (location.startsWith('node:')) tag = location;
      else if (location.startsWith(root + '/') && !location.includes('/node_modules/'))
        tag = location.slice(root.length + 1);
      else if (location.includes('/node_modules/'))
        tag = 'dependency/' + location.slice(location.lastIndexOf('/node_modules/') + 14);
      else {
        capture.outsideScope++;
        continue;
      }
      const frame = `${tag}:${match[2]}:${match[3]}`;
      if (!/^[A-Za-z0-9_./:@+-]{1,160}$/.test(frame) || frame.includes('..')) {
        capture.unsafe++;
        continue;
      }
      if (
        frame.startsWith('node:internal/async_hooks:') ||
        frame.startsWith('node:internal/timers:') ||
        frame.startsWith('node:timers:') ||
        (mode === 'hook-fallback' &&
          frame.startsWith('apps/e2e/fixtures/doc-channel-consumer/server.ts:'))
      ) {
        capture.scaffolding++;
        continue;
      }
      if (frames.length < 6) frames.push(frame);
    }
    return { frames, capture };
  };
  function captureTimeoutOrigin() {
    for (const [mode, scheduler] of [
      ['timeout-caller', timeoutScheduler],
      ['interval-caller', intervalScheduler],
    ] as const) {
      const target: { stack?: string } = {};
      Error.captureStackTrace(target, scheduler);
      const origin = scrubTimeoutFrames(target.stack, mode);
      if (origin.frames.length > 0) return origin;
    }
    const target: { stack?: string } = {};
    Error.captureStackTrace(target, captureTimeoutOrigin);
    return scrubTimeoutFrames(target.stack, 'hook-fallback');
  }
  const timeoutOriginHook = createHook({
    init(id, type, _trigger, resource: object) {
      if (type !== 'Timeout') return;
      try {
        if (timeoutOrigins.size >= 64) {
          timeoutOriginOverflow = true;
          return;
        }
        timeoutOrigins.set(id, { resource: new WeakRef(resource), ...captureTimeoutOrigin() });
      } catch {
        timeoutOriginOverflow = true;
      }
    },
    destroy(id) {
      timeoutOrigins.delete(id);
    },
  });
  timeoutOriginHook.enable();
  const currentTimeoutOrigins = () => {
    const entries: string[][] = [];
    const captures: TimeoutCapture[] = [];
    for (const item of timeoutOrigins.values()) {
      try {
        const resource = item.resource.deref();
        if (!resource || typeof (resource as { hasRef?: unknown }).hasRef !== 'function') continue;
        if (!(resource as { hasRef(): boolean }).hasRef()) continue;
        if (entries.length < 4) {
          entries.push(item.frames);
          captures.push(item.capture);
        }
      } catch {
        timeoutOriginOverflow = true;
      }
    }
    return {
      trackedCount: timeoutOrigins.size,
      overflow: timeoutOriginOverflow,
      moduleLevelImportBlindspot: true,
      entries,
      captures,
    };
  };
  let postCloseResourceSequence = 0;
  let postCloseWitnessInstalled = false;
  const postCloseResources = (
    phase: 'closed-before-disconnect' | 'closed-after-disconnect' | 'before-exit'
  ) => {
    if (postCloseResourceSequence >= 3) return;
    try {
      const resources = process.getActiveResourcesInfo();
      const counts: Record<string, number> = {};
      for (const kind of resources.slice(0, 64)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(kind)) continue;
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      const data = JSON.stringify({
        kind: 'ORIGINAL_MCP_POST_CLOSE_RESOURCES',
        sequence: ++postCloseResourceSequence,
        phase,
        at: Date.now(),
        resourceCount: Math.min(resources.length, 65),
        truncated: resources.length > 64,
        counts,
        timeoutOrigins: currentTimeoutOrigins(),
      });
      if (Buffer.byteLength(data + '\n', 'utf8') <= 4096) writeSync(2, data + '\n');
    } catch {
      // Resource DATA cannot change natural exit, retirement or the first cause.
    }
  };
  let fixture: Awaited<ReturnType<typeof startNativeConsumerFixture>> | undefined;
  let vite: { close(): Promise<void>; resolvedUrls: { local: string[] } | null } | undefined;
  let previews: { close(): Promise<void> } | undefined;
  let joinViteStartup: (() => Promise<void>) | undefined;
  let retired = false;
  let retirement: Promise<void> | undefined;
  let canonicalActionWork: Promise<void> | undefined;
  let canonicalActionFailure: { cause: unknown } | undefined;
  let scenarioReadCount = 0,
    scenarioReadPending = false;
  // A close received while an owning constructor is awaiting its resource
  // must drain that eventual resource too. Settlement is not a timeout.
  let savedActionSequence = 0,
    savedActionPending = false;
  let savedActionWork: Promise<void> | undefined;
  let savedActionFailure: { cause: unknown } | undefined;
  let selectionActionSequence = 0,
    selectionActionPending = false;
  let selectionActionWork: Promise<void> | undefined;
  let reviewedActionWork: Promise<void> | undefined;
  let reviewedActionFailure: { cause: unknown } | undefined;
  let reviewedActionSequence = 0,
    reviewedActionPending = false;
  let selectionActionFailure: { cause: unknown } | undefined;
  let mcpActionSequence = 0,
    mcpActionPending = false;
  let mcpActionWork: Promise<void> | undefined;
  let mcpActionFailure: { cause: unknown } | undefined;
  let widgetActionCount = 0,
    widgetActionPending = false;
  let widgetActionWork: Promise<void> | undefined;
  let widgetActionFailure: { cause: unknown } | undefined;
  let settleStartup!: () => void;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  const close = () => {
    if (retirement) return retirement;
    retired = true;
    retirement = (async () => {
      let closeDiagnosticSequence = 0;
      const closeData = (phase: string, state: 'begin' | 'done' | 'failed') => {
        if (closeDiagnosticSequence >= 40) return;
        try {
          writeSync(
            2,
            `ORIGINAL_MCP_CLOSE_STAGE child ${++closeDiagnosticSequence} ${Date.now()} ${phase} ${state}\n`
          );
        } catch {
          // Diagnostic DATA cannot replace the original owning close result.
        }
      };
      closeData('startup', 'begin');
      await startupSettled;
      closeData('startup', 'done');
      let failed = false,
        first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      const priorActionFailure =
        mcpActionFailure ??
        canonicalActionFailure ??
        widgetActionFailure ??
        selectionActionFailure ??
        savedActionFailure ??
        reviewedActionFailure;
      if (priorActionFailure) remember(priorActionFailure.cause);
      const drain = async (phase: string, run: () => unknown) => {
        closeData(phase, 'begin');
        try {
          await run();
          closeData(phase, 'done');
        } catch (cause) {
          closeData(phase, 'failed');
          remember(cause);
        }
      };
      // Initiate actual pump cancellation before joining an action that may await that pump.
      await drain('reviewed-stop', () => fixture?.native.stopOriginalReviewedReplay());
      if (reviewedActionWork) await drain('reviewed-join', () => reviewedActionWork);
      await drain('saved-stop', () => fixture?.native.stopOriginalSavedDispatch());
      if (savedActionWork) await drain('saved-join', () => savedActionWork);
      await drain('selection-stop', () => fixture?.native.stopOriginalSelectionDispatch());
      if (selectionActionWork) await drain('selection-join', () => selectionActionWork);
      await drain('mcp-stop', () => fixture?.native.stopOriginalMcpAppDispatch());
      if (mcpActionWork) await drain('mcp-join', () => mcpActionWork);
      if (widgetActionWork) await drain('widget-join', () => widgetActionWork);
      if (canonicalActionWork) await drain('canonical-join', () => canonicalActionWork);
      const actionFailure =
        mcpActionFailure ??
        canonicalActionFailure ??
        widgetActionFailure ??
        selectionActionFailure ??
        savedActionFailure ??
        reviewedActionFailure;
      if (actionFailure) remember(actionFailure.cause);
      await drain('vite-close', () => vite?.close());
      await drain('previews-close', () => previews?.close());
      await drain('fixture-close', () => fixture?.close());
      closeData('complete', failed ? 'failed' : 'done');
      if (failed) throw first;
    })();
    return retirement;
  };
  process.on('message', (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'native-canonical-action'
    ) {
      const row = message as { id?: unknown; action?: unknown };
      if (
        (row.id !== 1 && row.id !== 2 && row.id !== 3) ||
        !['pause', 'capture', 'restart'].includes(String(row.action))
      )
        return;
      if (canonicalActionWork) return;
      canonicalActionWork = (async () => {
        let ok = false,
          data: unknown;
        try {
          if (!fixture || retired) throw new Error('Original canonical fixture retired');
          data =
            row.action === 'pause'
              ? (await fixture.native.pauseCanonicalRoomPump(), {})
              : row.action === 'capture'
                ? fixture.native.captureCanonicalRecovery()
                : await fixture.restartOriginalNativeRoom();
          ok = true;
        } catch (cause) {
          if (!canonicalActionFailure) canonicalActionFailure = { cause };
        }
        try {
          if (process.connected)
            process.send?.({ kind: 'native-canonical-result', id: row.id, ok, data });
        } catch (cause) {
          if (!canonicalActionFailure) canonicalActionFailure = { cause };
        }
      })().finally(() => {
        canonicalActionWork = undefined;
      });
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      [
        'read-room-scenario-data',
        'read-native-integrity-data',
        'start-native-integrity-observation',
        'read-checkbox-pair-data',
        'read-canonical-recovery-data',
        'read-selection-data',
        'read-reviewed-replay-data',
        'read-saved-data',
        'read-presence-data',
        'read-mcp-app-data',
      ].includes(String((message as { kind?: unknown }).kind))
    ) {
      const reviewed = (message as { kind?: unknown }).kind === 'read-reviewed-replay-data';
      const mcpApp = (message as { kind?: unknown }).kind === 'read-mcp-app-data';
      const presence = (message as { kind?: unknown }).kind === 'read-presence-data';
      const saved = (message as { kind?: unknown }).kind === 'read-saved-data';
      const selection = (message as { kind?: unknown }).kind === 'read-selection-data';
      const canonical = (message as { kind?: unknown }).kind === 'read-canonical-recovery-data';
      const integrity = (message as { kind?: unknown }).kind === 'read-native-integrity-data';
      const integrityStart =
        (message as { kind?: unknown }).kind === 'start-native-integrity-observation';
      const checkbox = (message as { kind?: unknown }).kind === 'read-checkbox-pair-data';
      const responseKind = integrityStart
        ? 'native-integrity-started'
        : mcpApp
          ? 'mcp-app-data'
          : reviewed
            ? 'reviewed-replay-data'
            : presence
              ? 'presence-data'
              : saved
                ? 'saved-data'
                : selection
                  ? 'selection-data'
                  : canonical
                    ? 'canonical-recovery-data'
                    : checkbox
                      ? 'checkbox-pair-data'
                      : integrity
                        ? 'native-integrity-data'
                        : 'room-scenario-data';
      const id = (message as { id?: unknown }).id;
      if (!Number.isInteger(id) || (id as number) < 1 || (id as number) > 96) return;
      if (scenarioReadPending || scenarioReadCount >= 96 || id !== scenarioReadCount + 1) {
        if (process.connected) process.send?.({ kind: responseKind, id, ok: false });
        return;
      }
      scenarioReadCount++;
      scenarioReadPending = true;
      // Original local owner reads or starts observation of its own retained delivery IDs;
      // the IPC request carries no batch/source/principal or supplied count.
      void (async () => {
        try {
          if (!fixture || retired) throw new Error('Owned Room fixture retired');
          const data = integrityStart
            ? fixture.native.startNativeEmissionIntegrityObservation()
            : mcpApp
              ? fixture.native.readOriginalMcpAppData()
              : reviewed
                ? await fixture.native.readOriginalReviewedReplayData()
                : presence
                  ? fixture.native.readOriginalPresenceData()
                  : saved
                    ? await fixture.native.readOriginalSavedData()
                    : selection
                      ? await fixture.native.readOriginalSelectionData()
                      : canonical
                        ? fixture.native.readCanonicalRecoveryData()
                        : checkbox
                          ? await fixture.native.readOriginalCheckboxPairData()
                          : integrity
                            ? fixture.native.readNativeEmissionIntegrityData()
                            : await fixture.native.readOriginalRoomScenarioData();
          if (retired) throw new Error('Owned Room fixture retired during read');
          if (process.connected) process.send?.({ kind: responseKind, id, ok: true, data });
        } catch (cause) {
          // Diagnostic DATA only; opaque causes stay in this owned stderr capture.
          console.error(
            'Original native evidence read failed; raw undefined:',
            cause === undefined
          );
          console.error(cause);
          if (process.connected)
            process.send?.({
              kind: responseKind,
              id,
              ok: false,
              failureMessage: cause instanceof Error ? cause.message.slice(0, 512) : undefined,
              undefinedCause: cause === undefined,
            });
        } finally {
          scenarioReadPending = false;
        }
      })();
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'native-checkbox-action'
    ) {
      const row = message as { id?: unknown; action?: unknown };
      if ((row.id !== 1 && row.id !== 2) || (row.action !== 'open' && row.action !== 'pump'))
        return;
      void (async () => {
        let ok = false,
          data: unknown;
        try {
          if (!fixture || retired) throw new Error('Original checkbox fixture retired');
          data =
            row.action === 'open'
              ? await fixture.native.openCheckboxFile()
              : await fixture.native.pumpCheckboxAfterRelease();
          ok = true;
        } catch {
          /* Actual original drains retain custody on failure. */
        }
        if (process.connected)
          process.send?.({ kind: 'native-checkbox-result', id: row.id, ok, data });
      })();
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'native-saved-action'
    ) {
      const row = message as { id?: unknown; action?: unknown };
      if (
        retired ||
        savedActionPending ||
        row.id !== savedActionSequence + 1 ||
        row.action !== ['open', 'pump', 'arm-failure'][savedActionSequence]
      )
        return;
      savedActionSequence++;
      savedActionPending = true;
      savedActionWork = (async () => {
        let ok = false,
          data: unknown;
        try {
          if (!fixture || retired) throw new Error('Original saved FILE fixture retired');
          data =
            row.action === 'open'
              ? await fixture.native.openDocumentSaveFile()
              : row.action === 'arm-failure'
                ? fixture.native.armOriginalSavedInsertFailure()
                : await fixture.native.pumpOriginalSavedDocument();
          ok = true;
        } catch (cause) {
          if (!savedActionFailure) savedActionFailure = { cause };
          console.error('Original saved FILE action failed; raw undefined:', cause === undefined);
          console.error(cause);
        }
        if (process.connected)
          process.send?.({ kind: 'native-saved-result', id: row.id, ok, data });
      })()
        .catch((cause) => {
          if (!savedActionFailure) savedActionFailure = { cause };
        })
        .finally(() => {
          savedActionPending = false;
          savedActionWork = undefined;
        });
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'native-reviewed-replay-action'
    ) {
      const row = message as { id?: unknown; action?: unknown };
      if (
        retired ||
        reviewedActionPending ||
        row.id !== reviewedActionSequence + 1 ||
        row.action !== ['open', 'expire', 'pump'][reviewedActionSequence]
      )
        return;
      reviewedActionSequence++;
      reviewedActionPending = true;
      reviewedActionWork = (async () => {
        let ok = false,
          data: unknown;
        try {
          if (!fixture || retired) throw new Error('Original reviewed replay fixture retired');
          data =
            row.action === 'open'
              ? await fixture.native.openReviewedReplayFile()
              : row.action === 'expire'
                ? await fixture.native.expireOriginalReviewedReplay()
                : await fixture.native.pumpOriginalReviewedReplay();
          ok = true;
        } catch (cause) {
          if (!reviewedActionFailure) reviewedActionFailure = { cause };
        }
        if (process.connected)
          process.send?.({ kind: 'native-reviewed-replay-result', id: row.id, ok, data });
      })()
        .catch((cause) => {
          if (!reviewedActionFailure) reviewedActionFailure = { cause };
        })
        .finally(() => {
          reviewedActionPending = false;
          reviewedActionWork = undefined;
        });
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'native-mcp-app-action'
    ) {
      const row = message as { id?: unknown; action?: unknown };
      if (
        retired ||
        mcpActionPending ||
        row.id !== mcpActionSequence + 1 ||
        row.action !== ['open', 'pump', 'emit'][mcpActionSequence]
      )
        return;
      mcpActionSequence++;
      mcpActionPending = true;
      mcpActionWork = (async () => {
        let ok = false,
          data: unknown;
        try {
          if (!fixture || retired) throw new Error('Original MCP App fixture retired');
          data =
            row.action === 'open'
              ? await fixture.native.openOriginalMcpApp()
              : row.action === 'pump'
                ? await fixture.native.pumpOriginalMcpApp()
                : await fixture.native.emitOriginalMcpAppDownstream();
          ok = true;
        } catch (cause) {
          mcpActionFailure ??= { cause };
          console.error('Original MCP App action failed; raw undefined:', cause === undefined);
          console.error(cause);
        }
        if (process.connected)
          process.send?.({ kind: 'native-mcp-app-result', id: row.id, ok, data });
      })()
        .catch((cause) => {
          mcpActionFailure ??= { cause };
        })
        .finally(() => {
          mcpActionPending = false;
          mcpActionWork = undefined;
        });
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'native-selection-action'
    ) {
      const row = message as { id?: unknown; action?: unknown };
      if (
        retired ||
        selectionActionPending ||
        row.id !== selectionActionSequence + 1 ||
        row.action !== ['open', 'pump'][selectionActionSequence]
      )
        return;
      selectionActionSequence++;
      selectionActionPending = true;
      selectionActionWork = (async () => {
        let ok = false,
          data: unknown;
        try {
          if (!fixture || retired) throw new Error('Original selection fixture retired');
          data =
            row.action === 'open'
              ? await fixture.native.openSelectionFile()
              : await fixture.native.pumpOriginalSelection();
          ok = true;
        } catch (cause) {
          if (!selectionActionFailure) selectionActionFailure = { cause };
          console.error('Original selection action failed; raw undefined:', cause === undefined);
          console.error(cause);
        }
        if (process.connected)
          process.send?.({ kind: 'native-selection-result', id: row.id, ok, data });
      })()
        .catch((cause) => {
          if (!selectionActionFailure) selectionActionFailure = { cause };
        })
        .finally(() => {
          selectionActionPending = false;
          selectionActionWork = undefined;
        });
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'native-widget-action'
    ) {
      const row = message as { id?: unknown; action?: unknown };
      if (
        !Number.isInteger(row.id) ||
        Number(row.id) < 1 ||
        Number(row.id) > 6 ||
        !['open', 'patch', 'disconnect', 'next', 'reset', 'revoke'].includes(String(row.action))
      )
        return;
      if (
        retired ||
        widgetActionPending ||
        widgetActionCount >= 6 ||
        row.id !== widgetActionCount + 1 ||
        row.action !== ['open', 'patch', 'disconnect', 'next', 'reset', 'revoke'][widgetActionCount]
      )
        return;
      widgetActionCount++;
      widgetActionPending = true;
      widgetActionWork = (async () => {
        let ok = false,
          data: unknown;
        let undefinedCause = false;
        try {
          if (!fixture || retired) throw new Error('Original widget fixture retired');
          data =
            row.action === 'open'
              ? await fixture.native.openBoundWidget()
              : row.action === 'patch'
                ? await fixture.native.patchBoundWidget()
                : row.action === 'disconnect'
                  ? await fixture.disconnectBoundWidgetStream()
                  : row.action === 'next'
                    ? await fixture.native.patchBoundWidget(true)
                    : row.action === 'reset'
                      ? await fixture.native.resetBoundWidgetHistory()
                      : await fixture.native.revokeBoundWidgetGrant();
          ok = true;
        } catch (cause) {
          if (!widgetActionFailure) widgetActionFailure = { cause };
          undefinedCause = cause === undefined;
        }
        if (process.connected)
          process.send?.({ kind: 'native-widget-result', id: row.id, ok, data, undefinedCause });
      })()
        .catch((cause) => {
          if (!widgetActionFailure) widgetActionFailure = { cause };
        })
        .finally(() => {
          widgetActionPending = false;
          widgetActionWork = undefined;
        });
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'lose-writer-response'
    ) {
      const id = (message as { id?: unknown }).id;
      if (!Number.isInteger(id) || (id as number) < 1 || (id as number) > 16) return;
      let ok = false;
      if (fixture && !retired) {
        fixture.loseNextWriterResponse();
        ok = true;
      }
      if (process.connected) process.send?.({ kind: 'writer-fault-armed', id, ok });
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { kind?: unknown }).kind === 'close'
    ) {
      const disconnectAfterClose = () => {
        const firstCloseWitness = !postCloseWitnessInstalled;
        postCloseWitnessInstalled = true;
        if (firstCloseWitness) {
          postCloseResources('closed-before-disconnect');
          process.once('beforeExit', () => postCloseResources('before-exit'));
        }
        if (process.connected) process.disconnect();
        if (firstCloseWitness) postCloseResources('closed-after-disconnect');
      };
      void close().then(disconnectAfterClose, () => {
        process.exitCode = 1;
        disconnectAfterClose();
      });
    }
  });
  process.once('disconnect', () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
  try {
    const apiPort = Number(process.env.DORKOS_PORT),
      vitePort = Number(process.env.VITE_PORT),
      home = process.env.DORK_HOME;
    if (
      !process.send ||
      process.env.DORKOS_TEST_RUNTIME !== 'true' ||
      !home ||
      !Number.isInteger(apiPort) ||
      !Number.isInteger(vitePort) ||
      apiPort < 1 ||
      apiPort > 65535 ||
      vitePort < 1 ||
      vitePort > 65535 ||
      apiPort === vitePort
    )
      throw new Error('Owned bootstrap environment unavailable');
    const { MainRequestAdmission } = await startupAwait(
      'admission-import',
      () => import('../../../server/src/services/core/lifecycle/main-request-admission.js')
    );
    const target = process.argv[3];
    if (target !== 'session' && target !== 'room')
      throw new Error('Finite original scope required');
    const integrityCase = process.argv[4];
    const standalone = process.argv[5];
    const frameMode = process.argv[6];
    if (
      process.argv.length !== 7 ||
      (frameMode !== 'routed' && frameMode !== 'log-only') ||
      (frameMode === 'log-only' &&
        (target !== 'session' || integrityCase !== 'none' || standalone !== 'none')) ||
      (standalone !== 'none' && standalone !== 'bearer' && standalone !== 'canonical') ||
      (standalone !== 'none' && (target !== 'room' || integrityCase !== 'none')) ||
      (integrityCase !== 'none' &&
        integrityCase !== 'select-builder' &&
        integrityCase !== 'event-codec') ||
      (integrityCase !== 'none' && target !== 'room')
    )
      throw new Error('Finite original native integrity startup required');
    const clientRoot = fileURLToPath(new URL('../../../client/', import.meta.url));
    const clientRequire = createRequire(new URL('../../../client/package.json', import.meta.url));
    // Resolve the installed Vite module; its owned resource startup below overlaps native setup.
    // Reflect rejection immediately so fixture failure remains the original first cause.
    const viteModuleWork = Promise.resolve()
      .then(() => import(pathToFileURL(clientRequire.resolve('vite')).href))
      .then(
        (module) => ({ ok: true as const, module }),
        (cause: unknown) => ({ ok: false as const, cause })
      );
    const privateApiOrigin = 'http://127.0.0.1:' + apiPort;
    // Start only this owned Vite resource. Readiness still waits for every native prerequisite.
    // Reflect failure immediately; original native/preview failure remains the first cause.
    const viteStartupWork = (async () => {
      if (retired) throw new Error('Owned bootstrap retired');
      const { createServer: createViteServer } = await startupAwait('vite-import', async () => {
        const result = await viteModuleWork;
        if (!result.ok) throw result.cause;
        return result.module;
      });
      if (retired) throw new Error('Owned bootstrap retired');
      vite = await startupAwait('vite-create', () =>
        createViteServer({
          root: clientRoot,
          configFile: join(clientRoot, 'vite.config.ts'),
          cacheDir: join(home, 'vite-cache'),
          server: {
            warmup: { clientFiles: ['./src/main.tsx'] },
            host: '127.0.0.1',
            port: vitePort,
            strictPort: true,
            hmr: false,
            proxy: { '/api': { target: privateApiOrigin, changeOrigin: true, ws: true } },
          },
        })
      );
      if (retired) throw new Error('Owned bootstrap retired');
      await startupAwait('vite-listen', () =>
        (vite as typeof vite & { listen(): Promise<void> }).listen()
      );
      if (retired) throw new Error('Owned bootstrap retired');
    })().then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause })
    );
    joinViteStartup = async () => {
      await viteStartupWork;
    };
    fixture = await startupAwait('native-fixture', () =>
      startNativeConsumerFixture(
        new MainRequestAdmission(),
        apiPort,
        home,
        target,
        integrityCase,
        frameMode
      )
    );
    if (retired) throw new Error('Owned bootstrap retired');
    if (standalone === 'canonical') fixture.native.prepareCanonicalRecovery();
    const { previewListeners } = await startupAwait(
      'preview-import',
      () => import('../../../server/src/services/workbench-serve/preview-listener.js')
    );
    previews = previewListeners; // Same singleton used by authenticated workbench/sign, owned only here.
    if (retired) throw new Error('Owned bootstrap retired');
    if (fixture.origin !== privateApiOrigin) throw new Error('Owned native API origin mismatch');
    const viteResult = await viteStartupWork;
    if (!viteResult.ok) throw viteResult.cause;
    if (retired) throw new Error('Owned bootstrap retired');
    // Original Better Auth API created the owner before native grant capture.
    // The browser signs in over actual HTTP to obtain its genuine cookie; no
    // DB-inserted cookie/public actor DTO or synthetic session is supplied.
    const { configManager } = await startupAwait(
      'config-import',
      () => import('../../../server/src/services/core/config-manager.js')
    );
    configManager.set('auth', { enabled: true });
    if (retired) throw new Error('Owned bootstrap retired');
    const standaloneToken =
      standalone === 'bearer'
        ? await startupAwait('standalone-token', () => fixture!.native.issueStandaloneToken())
        : undefined;
    if (retired) throw new Error('Owned bootstrap retired');
    settleStartup();
    process.send({
      kind: 'ready',
      ...(standaloneToken === undefined ? {} : { standaloneToken }),
      origin: 'http://127.0.0.1:' + vitePort,
      apiOrigin: fixture.origin,
      sessionId: fixture.native.sessionId,
      roomId: fixture.native.roomId,
      documentId: fixture.native.documentId,
      frameDeclarationAbsent: fixture.native.readOriginalFrameDeclarationAbsent(),
      root: fixture.vault.root,
    });
  } catch (cause) {
    // Join eventual Vite ownership before startup settlement and original ordered retirement.
    // A separate Vite failure does not replace the original fixture/setup failure.
    await joinViteStartup?.();
    settleStartup();
    console.error('Original owned worker setup cause:', cause);
    if (process.connected) {
      try {
        process.send?.({ kind: 'failed', undefinedCause: cause === undefined }, () => {
          /* Original setup cause remains primary on disconnected delivery. */
        });
      } catch {
        /* Preserve setup cause before cooperative cleanup. */
      }
    }
    try {
      await close();
    } catch {
      /* Preserve setup cause; no readiness on failure. */
    }
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}

// Ordinary test imports cannot start an app, provider, child or native turn.
if (process.argv[2] === '--consumer-native-worker' && process.send) void runNativeConsumerWorker();
