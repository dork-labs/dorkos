import { captureOriginalQualificationGrant } from './qualification-grant.fixture.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open as openLogFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Socket, createServer, type Server } from 'node:net';
import { createServer as createHTTPServer, type Server as HTTPServer } from 'node:http';
import { it, expect, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import {
  createRuntimeInstallation,
  resolveInstalledRuntimeConfiguration,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import { BrowserFrameBodyDecoder } from '@dorkos/shared/browser-frame-wire';
import {
  BrowserProductionStatusSchema,
  BrowserProductionOpenReceiptSchema,
  BrowserProductionProfileCreateReceiptSchema,
  BrowserProfileSchema,
  BrowserControlSchema,
  BrowserActionReceiptSchema,
  BrowserCloseReceiptSchema,
  BrowserViewerSchema,
} from '@dorkos/shared/browser-schemas';
import type { BrowserBinding } from '@dorkos/shared/browser-schemas';
import { joinOriginalPublicNativeReturn } from './public-native-return.js';
import type { ProcessIdentity } from '@dorkos/browser';
import {
  createOriginalNativeProjectionReceiver,
  type OriginalNativeBirth,
} from '../private-native-projection.js';
import { readPublicNativeInput, verifyPublicNativeEmits } from './public-native-input.js';
type ColdSocketResult =
  Readonly<{ state: 'connected' }> | Readonly<{ state: 'refused'; cause: unknown }>;
/** Only an actual error event from this exact original Socket may be a cold refusal.
 * Callback-free own fields distinguish it; TypeError/HTTP/error-class shapes confer nothing. */
async function connectOriginalColdListener(
  port: number,
  sockets: Map<Socket, () => void>,
  guard: () => void
): Promise<ColdSocketResult> {
  guard();
  const originalConnect = Socket.prototype.connect,
    originalDestroy = Socket.prototype.destroy;
  const socket = new Socket();
  let destroying = false,
    stopFailed = false;
  const destroy = () => {
    if (!destroying) {
      destroying = true;
      try {
        Reflect.apply(originalDestroy, socket, []);
      } catch (value) {
        stopFailed = true;
        throw value;
      }
    }
  };
  sockets.set(socket, destroy);
  let first: Readonly<{ value: unknown }> | undefined,
    observedError: Readonly<{ value: unknown }> | undefined;
  let resolveReady!: () => void,
    rejectReady!: (value: unknown) => void,
    readySettled = false;
  const ready = new Promise<void>((yes, no) => {
    resolveReady = yes;
    rejectReady = no;
  });
  const terminal = new Promise<void>((resolve) =>
    socket.once('close', () => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error('PUBLIC_NATIVE_ORIGINAL_SOCKET_CLOSED'));
      }
      resolve();
    })
  );
  void ready.then(
    () => {},
    () => {}
  );
  socket.once('connect', () => {
    readySettled = true;
    resolveReady();
  });
  socket.once('error', (value) => {
    observedError = { value };
    readySettled = true;
    rejectReady(value);
  });
  const connect = originalConnect.bind(socket);
  const timer = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error('PUBLIC_NATIVE_ORIGINAL_SOCKET_HELD'));
    }
    try {
      destroy();
    } catch (value) {
      first ??= { value };
    }
  }, 1000);
  try {
    guard();
    connect({ host: '127.0.0.1', port });
    await ready;
    guard();
  } catch (value) {
    first ??= { value };
  }
  clearTimeout(timer);
  try {
    destroy();
  } catch (value) {
    first ??= { value };
  }
  const joined = await Promise.allSettled([ready, terminal]);
  for (const result of joined) if (result.status === 'rejected') first ??= { value: result.reason };
  sockets.delete(socket);
  if (first) {
    const original = observedError?.value;
    const data = (name: string) => {
      if (!original || typeof original !== 'object') return undefined;
      const field = Object.getOwnPropertyDescriptor(original, name);
      return field && Object.prototype.hasOwnProperty.call(field, 'value')
        ? field.value
        : undefined;
    };
    if (
      observedError &&
      !stopFailed &&
      Object.is(first.value, original) &&
      data('code') === 'ECONNREFUSED' &&
      data('syscall') === 'connect' &&
      data('address') === '127.0.0.1' &&
      data('port') === port
    )
      return Object.freeze({ state: 'refused', cause: original });
    throw first.value;
  }
  return Object.freeze({ state: 'connected' });
}

it.each([
  undefined,
  false,
  new TypeError('Original unknown producer'),
  Object.assign(new Error('Original shaped producer'), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port: 4242,
  }),
])(
  'does not retry an original unknown connect producer failure %s as a cold socket event',
  async (original) => {
    const sockets = new Map<Socket, () => void>();
    const producer = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
      this: Socket
    ) {
      expect(this).toBeInstanceOf(Socket);
      throw original;
    });
    onTestFinished(() => producer.mockRestore());
    await expect(connectOriginalColdListener(4242, sockets, () => {})).rejects.toBe(original);
    expect(producer).toHaveBeenCalledOnce();
    expect(sockets.size).toBe(0);
  }
);
it('admits only a genuine original loopback refusal before HTTP and joins its exact socket', async () => {
  const originals: {
    server?: Server;
    listen?: Promise<number>;
    close?: Promise<void>;
    probe?: Promise<ColdSocketResult>;
  } = {};
  const sockets = new Map<Socket, () => void>();
  const close = () =>
    (originals.close ??= new Promise<void>((resolve, reject) =>
      originals.server!.close((value) => (value === undefined ? resolve() : reject(value)))
    ));
  onTestFinished(async () => {
    for (const stop of sockets.values()) stop();
    if (originals.server) close();
    const results = await Promise.allSettled([
      ...(originals.listen ? [originals.listen] : []),
      ...(originals.close ? [originals.close] : []),
      ...(originals.probe ? [originals.probe] : []),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  originals.server = createServer();
  originals.listen = new Promise<number>((resolve, reject) => {
    originals.server!.once('error', reject);
    originals.server!.listen(0, '127.0.0.1', () => {
      const address = originals.server!.address();
      if (!address || typeof address === 'string')
        reject(new Error('Original listener unavailable'));
      else resolve(address.port);
    });
  });
  const port = await originals.listen;
  await close();
  originals.probe = connectOriginalColdListener(port, sockets, () => {});
  const result = await originals.probe;
  expect(result.state).toBe('refused');
  if (result.state !== 'refused') throw new Error('Expected actual original socket refusal');
  expect(Object.getOwnPropertyDescriptor(result.cause, 'code')?.value).toBe('ECONNREFUSED');
  expect(sockets.size).toBe(0);
});

// Explicit one-campaign fixture input only. Default quality runs never acquire an installer/browser.
const fixturePath = process.env.DORKOS_BROWSER_PUBLIC_ACCEPTANCE_FIXTURE;
const retainedCampaigns = new Set<object>();
type PublicRequestPhase = 'start' | 'response' | 'body' | 'complete' | 'failure' | 'deadline';
const publicRequestEndpoints = new Set([
  '/api/health',
  '/api/auth/sign-in/email',
  '/api/browser/runtime/status',
  '/api/browser/runtime/open',
  '/api/browser/runtime/enable',
  '/api/browser/runtime/profiles',
  '/api/browser/control',
  '/api/browser/viewers/issue',
  '/api/browser/viewers/next',
  '/api/browser/input',
  '/api/browser/viewers/disconnect',
  '/api/browser/instances/close',
  '/api/browser/profiles',
]);
/** Fixed endpoint/phase timing is observational only. It cannot replace an original failure. */
async function observePublicNativeRequest<T>(
  endpoint: string,
  sequence: number,
  original: (mark: (phase: PublicRequestPhase) => void) => Promise<T>,
  emit: (record: string) => void
): Promise<T> {
  const started = performance.now();
  const mark = (phase: PublicRequestPhase, failure?: Readonly<{ value: unknown }>) => {
    try {
      emit(
        JSON.stringify({
          fixture: 'production-public-native-request',
          endpoint: publicRequestEndpoints.has(endpoint) ? endpoint : 'unknown',
          sequence,
          phase,
          elapsedMilliseconds: Math.round(performance.now() - started),
          ...(failure
            ? {
                failure:
                  failure.value === undefined
                    ? 'undefined'
                    : failure.value === false
                      ? 'false'
                      : 'opaque',
              }
            : {}),
        })
      );
    } catch {
      // A diagnostic sink has no authority over the original HTTP operation or shutdown.
    }
  };
  mark('start');
  try {
    const result = await original(mark);
    mark('complete');
    return result;
  } catch (value) {
    mark('failure', { value });
    throw value;
  }
}
it.each([undefined, false, new Error('original request')])(
  'request timing preserves original %s rejection when diagnostics fail',
  async (failure) => {
    let entered = 0;
    const original = observePublicNativeRequest(
      '/api/browser/runtime/enable',
      1,
      async (mark) => {
        entered++;
        mark('response');
        throw failure;
      },
      () => {
        throw new Error('diagnostic sink');
      }
    );
    await expect(original).rejects.toBe(failure);
    expect(entered).toBe(1);
  }
);
it('request timing emits fixed phases without documents or failure properties', async () => {
  const rows: Record<string, unknown>[] = [];
  const failure = Object.create(null, {
    message: {
      get: () => {
        throw new Error('foreign getter');
      },
    },
  });
  const original = observePublicNativeRequest(
    '/private/unknown?secret=hidden',
    4,
    async (mark) => {
      mark('response');
      throw failure;
    },
    (row) => rows.push(JSON.parse(row))
  );
  await expect(original).rejects.toBe(failure);
  expect(rows.map((row) => row.phase)).toEqual(['start', 'response', 'failure']);
  expect(rows.every((row) => row.endpoint === 'unknown')).toBe(true);
  expect(rows[2]?.failure).toBe('opaque');
  expect(rows.every((row) => typeof row.elapsedMilliseconds === 'number')).toBe(true);
});

const LIMITS = Object.freeze({
  campaign: 180000,
  request: 20000,
  enablePreparation: 60000,
  shutdown: 5000,
  stream: 262144,
  frame: 2 * 1024 * 1024 + 16388,
});
/** A positive enable performs actual file inspection and fresh verification before readiness.
 * Only its exact data-only true request receives this preparation allowance. Ordinary/Off stay20s. */
function ownPublicNativeRequestDeadline(
  path: string,
  document: unknown,
  remaining: number,
  abort: AbortController,
  mark: (phase: PublicRequestPhase) => void
) {
  const enablePreparation =
    path === '/api/browser/runtime/enable' &&
    document !== null &&
    typeof document === 'object' &&
    Object.getOwnPropertyDescriptor(document, 'enabled')?.value === true;
  const duration = Math.min(
    enablePreparation ? LIMITS.enablePreparation : LIMITS.request,
    Math.max(1, remaining)
  );
  const originalAbort = abort.abort.bind(abort);
  return setTimeout(() => {
    try {
      mark('deadline');
    } catch {
      // Observational timing cannot prevent the original deadline abort.
    }
    originalAbort();
  }, duration);
}
it.each([
  ['/api/browser/runtime/status', undefined, 20000],
  ['/api/browser/runtime/enable', { enabled: false }, 20000],
  ['/api/browser/runtime/enable', { enabled: true }, 60000],
] as const)(
  'original held HTTP body for %s retains its scoped deadline and joins abort',
  async (path, document, deadline) => {
    const abort = new AbortController();
    const admissionClosed = new Error('PUBLIC_NATIVE_DEADLINE_CONTROL_CLOSED');
    let closed = false,
      bodyReturned = false;
    const bank: {
      server?: HTTPServer;
      listen?: Promise<void>;
      fetch?: Promise<Response>;
      body?: Promise<string>;
      close?: Promise<void>;
      originalClose?: () => Promise<void>;
      timer?: ReturnType<typeof setTimeout>;
      expectedAbort?: Readonly<{ value: unknown }>;
      sockets: Set<Socket>;
    } = { sockets: new Set() };
    // Bank disposal before the real listener/fetch/body and before any fake clock is installed.
    onTestFinished(async () => {
      closed = true;
      abort.abort();
      if (bank.timer) clearTimeout(bank.timer);
      let first: Readonly<{ value: unknown }> | undefined;
      try {
        for (const socket of bank.sockets)
          try {
            socket.destroy();
          } catch (value) {
            first ??= { value };
          }
        const joined = await Promise.allSettled([
          ...(bank.listen ? [bank.listen] : []),
          ...(bank.fetch ? [bank.fetch] : []),
          ...(bank.body ? [bank.body] : []),
        ]);
        for (const result of joined)
          if (
            result.status === 'rejected' &&
            !(bank.expectedAbort && result.reason === bank.expectedAbort.value) &&
            result.reason !== admissionClosed
          )
            first ??= { value: result.reason };
        if (bank.originalClose) {
          bank.close ??= bank.originalClose();
          try {
            await bank.close;
          } catch (value) {
            first ??= { value };
          }
        }
      } finally {
        vi.useRealTimers();
      }
      if (first) throw first.value;
    });
    const server = createHTTPServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.flushHeaders(); // The exact original body remains held until its own request abort.
    });
    bank.server = server;
    const close = server.close.bind(server);
    server.on('connection', (socket) => {
      bank.sockets.add(socket);
      socket.once('close', () => bank.sockets.delete(socket));
      if (closed) socket.destroy();
    });
    bank.listen = Promise.resolve().then(() => {
      if (closed) throw admissionClosed;
      bank.originalClose = () =>
        new Promise<void>((resolve, reject) =>
          close((value) => (value === undefined ? resolve() : reject(value)))
        );
      return new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    });
    await bank.listen;
    if (closed) throw admissionClosed;
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('PUBLIC_NATIVE_DEADLINE_CONTROL_LISTENER');
    bank.fetch = fetch(`http://127.0.0.1:${address.port}${path}`, {
      signal: abort.signal,
      method: document === undefined ? 'GET' : 'POST',
      ...(document === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(document) }),
    });
    const response = await bank.fetch;
    if (closed) throw admissionClosed;
    bank.body = response.text();
    void bank.body.then(
      () => {
        bodyReturned = true;
      },
      (value) => {
        bodyReturned = true;
        if (abort.signal.aborted) bank.expectedAbort = { value };
      }
    );
    // Keep actual network/reader originals; advance only this fixture's deadline timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let deadlines = 0;
    bank.timer = ownPublicNativeRequestDeadline(path, document, LIMITS.campaign, abort, () => {
      deadlines++;
    });
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(abort.signal.aborted).toBe(false);
    expect(bodyReturned).toBe(false);
    expect(deadlines).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(abort.signal.aborted).toBe(true);
    await expect(bank.body).rejects.toMatchObject({ name: 'AbortError' });
    expect(deadlines).toBe(1);
    expect(bodyReturned).toBe(true);
  }
);
it.skipIf(!fixturePath || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'actual installed public owner activation/view/input/retained reopen/Off',
  async () => {
    const originals: {
      whole?: Promise<void>;
      child?: ChildProcess;
      terminal?: Promise<void>;
      streams?: Promise<void>;
      finalizing?: Promise<void>;
      projection?: ReturnType<typeof createOriginalNativeProjectionReceiver>;
      native?: Awaited<ReturnType<typeof verifyInstalledNativeJournal>>;
    } = {};
    const logs: FileHandle[] = [];
    const knownNative = new Map<string, ProcessIdentity>();
    const births = new Map<string, OriginalNativeBirth>();
    retainedCampaigns.add(originals);
    const work = new Set<Promise<unknown>>(),
      controllers = new Set<AbortController>(),
      coldSockets = new Map<Socket, () => void>();
    let closed = false,
      first: { value: unknown } | undefined,
      returned = false;
    const failures = (value: unknown) => {
      first ??= { value };
    };
    const own = <T>(original: Promise<T>): Promise<T> => {
      work.add(original);
      void original.then(
        () => work.delete(original),
        (value) => {
          failures(value);
          work.delete(original);
        }
      );
      return original;
    };
    const closedAdmission = new Error('PUBLIC_NATIVE_ADMISSION_CLOSED');
    const guard = () => {
      if (closed) throw closedAdmission;
    };
    const cleanup = () => {
      closed = true;
      return (originals.finalizing ??= Promise.resolve().then(async () => {
        // Start all original cancellations before joins; never fake exit/EOF or retry an original close.
        for (const controller of controllers) {
          try {
            controller.abort();
          } catch (value) {
            failures(value);
          }
        }
        for (const stop of coldSockets.values()) {
          try {
            stop();
          } catch (value) {
            failures(value);
          }
        }
        const child = originals.child;
        if (child && child.exitCode === null && child.signalCode === null) {
          try {
            if (!child.kill('SIGTERM')) throw new Error('PUBLIC_NATIVE_ORIGINAL_SIGNAL_REFUSED');
          } catch (value) {
            failures(value);
          }
        }
        const shutdownTimer = setTimeout(
          () => failures(new Error('PUBLIC_NATIVE_ORIGINAL_SHUTDOWN_HELD')),
          LIMITS.shutdown
        );
        const joined = await Promise.allSettled([
          ...(originals.whole ? [originals.whole] : []),
          ...work,
          ...(originals.terminal ? [originals.terminal] : []),
          ...(originals.streams ? [originals.streams] : []),
          ...(originals.projection ? [originals.projection.close()] : []),
        ]);
        clearTimeout(shutdownTimer);
        for (const result of joined)
          if (result.status === 'rejected' && result.reason !== closedAdmission)
            failures(result.reason);
        // Both stream jobs returned before flushing/closing each original raw file independently.
        for (const log of logs) {
          try {
            await log.sync();
          } catch (value) {
            failures(value);
          }
          try {
            await log.close();
          } catch (value) {
            failures(value);
          }
        }
        if (first) throw first.value;
      }));
    };
    onTestFinished(cleanup); // Whole acquisition/read/HTTP/child bank exists before the first producer.
    const end = performance.now() + LIMITS.campaign;
    const timer = setTimeout(() => {
      failures(new Error('PUBLIC_NATIVE_CAMPAIGN_HELD'));
      void cleanup().catch(() => {});
    }, LIMITS.campaign);
    originals.whole = Promise.resolve().then(async () => {
      guard();
      const input = await own(readPublicNativeInput(fixturePath!, guard));
      guard();
      const configuration = await own(
        resolveInstalledRuntimeConfiguration(pathToFileURL(input.cliEntry), input.home)
      );
      guard();
      const installation = createRuntimeInstallation(configuration);
      const installed = await own(installation.inspectExisting());
      if (installed.state !== 'installed-files')
        throw new Error('PUBLIC_NATIVE_OWN_INSTALLATION_REQUIRED');
      guard();
      const native = await own(verifyInstalledNativeJournal(configuration));
      guard();
      originals.native = native;
      const observeIdentity = native.identity.bind(native),
        attributeRoot = native.attributeRoot.bind(native);
      // Exclusive fresh-home files retain exact CLI diagnostics; no shared logs or inherited personal paths.
      const stdoutLog = await own(
        openLogFile(join(input.home, 'public-native-cli.stdout.raw'), 'wx', 0o600)
      );
      logs.push(stdoutLog);
      guard();
      const stderrLog = await own(
        openLogFile(join(input.home, 'public-native-cli.stderr.raw'), 'wx', 0o600)
      );
      logs.push(stderrLog);
      guard();
      // Original child is captured synchronously, with terminal and both stream duties before HTTP/native work.
      const qualificationGrant = await own(captureOriginalQualificationGrant(input, guard));
      const child = (originals.child = spawn(
        process.execPath,
        [
          input.cliEntry,
          '--no-open',
          '--no-tasks',
          '--port',
          String(input.port),
          '--dir',
          input.home,
          '--boundary',
          input.home,
        ],
        {
          shell: false,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C',
            LC_ALL: 'C',
            NODE_ENV: 'production',
            DORK_HOME: input.home,
            DORKOS_HOST: '127.0.0.1',
            DORKOS_BROWSER_PRIVATE_NATIVE_ACCEPTANCE: '1',
            DORKOS_TELEMETRY_DISABLED: '1',
            OTEL_SDK_DISABLED: 'true',
          },
        }
      ));
      let terminalFailure: { value: unknown } | undefined;
      originals.terminal = new Promise<void>((yes, no) => {
        child.once('error', (value) => {
          terminalFailure ??= { value };
          failures(value);
        });
        child.once('close', (code, signal) => {
          returned = true;
          if (terminalFailure) no(terminalFailure.value);
          else if (code !== 0 || signal !== null)
            no(new Error('PUBLIC_NATIVE_ORIGINAL_SERVER_RETURN_REFUSED'));
          else yes();
        });
      });
      void originals.terminal.catch(failures);
      const drain = async (stream: ChildProcess['stdout'], log: FileHandle) => {
        if (!stream) throw new Error('PUBLIC_NATIVE_ORIGINAL_PIPE_MISSING');
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > LIMITS.stream) throw new Error('PUBLIC_NATIVE_ORIGINAL_PIPE_LIMIT');
          const data = Buffer.from(chunk);
          for (let offset = 0; offset < data.byteLength;) {
            const result = await log.write(data, offset, data.byteLength - offset, null);
            if (
              !Number.isSafeInteger(result.bytesWritten) ||
              result.bytesWritten <= 0 ||
              result.bytesWritten > data.byteLength - offset
            )
              throw new Error('PUBLIC_NATIVE_ORIGINAL_LOG_WRITE_UNKNOWN');
            offset += result.bytesWritten;
          }
        }
        if (!stream.readableEnded) throw new Error('PUBLIC_NATIVE_ORIGINAL_PIPE_UNKNOWN');
      };
      originals.streams = Promise.allSettled([
        own(drain(child.stdout, stdoutLog)),
        own(drain(child.stderr, stderrLog)),
      ]).then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      });
      void originals.streams.catch(failures);
      if (!child.pid) throw new Error('PUBLIC_NATIVE_ORIGINAL_CHILD_PID_REQUIRED');
      const cliPid = child.pid;
      // Constructor captures only this actual child birth. No parent tree or journal chooses a root.
      const manager = own(
        Promise.resolve().then(async () => {
          const original = await own(observeIdentity(cliPid));
          if (original)
            knownNative.set(`${original.pid}:${original.birth}`, Object.freeze({ ...original }));
          guard();
          if (!original || !(await own(attributeRoot(native.manager, original))))
            throw new Error('PUBLIC_NATIVE_ORIGINAL_CLI_BIRTH_UNKNOWN');
          guard();
          return Object.freeze({ ...original });
        })
      );
      originals.projection = createOriginalNativeProjectionReceiver({
        qualification: qualificationGrant,
        pid: cliPid,
        channel: {
          send: child.send.bind(child),
          disconnect: () => {
            if (child.connected) child.disconnect();
          },
          on: (event, callback) => {
            child.on(event, callback);
          },
          off: (event, callback) => {
            child.off(event, callback);
          },
        },
        async retainBirth(value) {
          // Retain original rows before fallible async validation, including an incomplete cohort.
          for (const row of [value.manager, value.supervisor, value.root, ...value.identities])
            knownNative.set(`${row.pid}:${row.birth}`, row);
          births.set(`${value.browserId}:${value.browserGeneration}`, value);
          const original = await manager;
          guard();
          if (value.manager.pid !== original.pid || value.manager.birth !== original.birth)
            throw new Error('PUBLIC_NATIVE_ORIGINAL_MANAGER_SUBSTITUTED');
        },
        retainViewerSample: async () => {},
      });

      const body = async (response: Response): Promise<Uint8Array> => {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('PUBLIC_NATIVE_HTTP_BODY_MISSING');
        const chunks: Uint8Array[] = [];
        let size = 0,
          failure: { value: unknown } | undefined;
        try {
          while (true) {
            guard();
            const result = await own(reader.read());
            guard();
            if (result.done) break;
            size += result.value.byteLength;
            if (size > LIMITS.frame) throw new Error('PUBLIC_NATIVE_HTTP_BODY_LIMIT');
            chunks.push(result.value);
          }
        } catch (value) {
          failure = { value };
        }
        if (failure) {
          try {
            await own(reader.cancel());
          } catch (value) {
            failure ??= { value };
          }
        }
        try {
          reader.releaseLock();
        } catch (value) {
          failure ??= { value };
        }
        if (failure) throw failure.value;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      };
      const origin = `http://127.0.0.1:${input.port}`;
      let cookie = '',
        requestSequence = 0;
      const emitRequestTiming = console.info.bind(console);
      const request = (path: string, document?: unknown, allowed = [200]) =>
        observePublicNativeRequest(
          path,
          ++requestSequence,
          async (mark) => {
            guard();
            if (returned || performance.now() >= end)
              throw new Error('PUBLIC_NATIVE_SERVER_UNAVAILABLE');
            const abort = new AbortController();
            controllers.add(abort);
            const requestTimer = ownPublicNativeRequestDeadline(
              path,
              document,
              Math.max(1, end - performance.now()),
              abort,
              mark
            );
            try {
              const response = await own(
                fetch(`${origin}${path}`, {
                  method: document === undefined ? 'GET' : 'POST',
                  headers: {
                    Origin: origin,
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...(document === undefined ? {} : { 'Content-Type': 'application/json' }),
                  },
                  ...(document === undefined ? {} : { body: JSON.stringify(document) }),
                  signal: abort.signal,
                  redirect: 'error',
                })
              );
              mark('response');
              guard();
              if (!allowed.includes(response.status)) {
                await own(body(response));
                throw new Error(`PUBLIC_NATIVE_HTTP_${response.status}`);
              }
              const length = response.headers.get('content-length'),
                declared = length === null ? undefined : Number(length);
              if (
                declared !== undefined &&
                (!Number.isSafeInteger(declared) || declared < 0 || declared > LIMITS.frame)
              )
                throw new Error('PUBLIC_NATIVE_HTTP_LENGTH_REFUSED');
              const bytes = await own(body(response));
              mark('body');
              guard();
              if (declared !== undefined && bytes.byteLength !== declared)
                throw new Error('PUBLIC_NATIVE_HTTP_TRUNCATED');
              return { response, bytes };
            } finally {
              clearTimeout(requestTimer);
              controllers.delete(abort);
            }
          },
          emitRequestTiming
        );
      await manager;
      guard();
      // Retry only a genuine original Socket connection-refused event before HTTP.
      // Once connected, health/auth/body failures retain their original rejection with no retry.
      let coldRefusal: Readonly<{ value: unknown }> | undefined;
      while (true) {
        guard();
        if (returned || performance.now() >= end)
          throw new Error('PUBLIC_NATIVE_SERVER_UNAVAILABLE', { cause: coldRefusal?.value });
        const probe = await own(
          Promise.resolve().then(() => connectOriginalColdListener(input.port, coldSockets, guard))
        );
        guard();
        if (probe.state === 'connected') break;
        coldRefusal = { value: probe.cause };
        await own(new Promise<void>((yes) => setTimeout(yes, 50)));
        guard();
      }
      await request('/api/health');
      const signIn = await request('/api/auth/sign-in/email', {
        email: input.email,
        password: input.password,
      });
      cookie = signIn.response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      if (!cookie) throw new Error('PUBLIC_NATIVE_OWNER_COOKIE_REQUIRED');
      const json = (bytes: Uint8Array): unknown =>
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const status = async () =>
        BrowserProductionStatusSchema.parse(
          json((await request('/api/browser/runtime/status')).bytes)
        );
      expect(await status()).toEqual({ state: 'disabled', enabled: false });
      await request(
        '/api/browser/runtime/open',
        { workspaceId: input.workspaceId, request: { requestId: randomUUID(), mode: 'ephemeral' } },
        [404, 503]
      );
      const enabled = BrowserProductionStatusSchema.parse(
        json((await request('/api/browser/runtime/enable', { enabled: true })).bytes)
      );
      if (
        enabled.state !== 'qualification' ||
        !enabled.workspaces.some((value) => value.workspaceId === input.workspaceId)
      )
        throw new Error('PUBLIC_NATIVE_ACTUAL_MODE_NOT_READY');
      const open = async (profileId?: string) => {
        const requestId = randomUUID(),
          mode = profileId ? 'persistent' : 'ephemeral';
        const receipt = BrowserProductionOpenReceiptSchema.parse(
          json(
            (
              await request('/api/browser/runtime/open', {
                workspaceId: input.workspaceId,
                request: { requestId, mode, ...(profileId ? { profileId } : {}) },
              })
            ).bytes
          )
        );
        expect(receipt.requestId).toBe(requestId);
        expect(receipt.instance.mode).toBe(mode);
        if (profileId) {
          if (receipt.instance.mode !== 'persistent')
            throw new Error('PUBLIC_NATIVE_PROFILE_MODE_SUBSTITUTED');
          expect(receipt.instance.profileId).toBe(profileId);
        }
        originals.projection!.assertCurrent();
        if (!births.has(`${receipt.instance.browserId}:${receipt.instance.browserGeneration}`))
          throw new Error('PUBLIC_NATIVE_ORIGINAL_OPEN_BIRTH_UNKNOWN');
        return receipt;
      };
      const clean = await open();
      const profileRequest = { requestId: randomUUID(), label: 'Public native saved fixture' };
      const metadata = BrowserProductionProfileCreateReceiptSchema.parse(
        json((await request('/api/browser/runtime/profiles', profileRequest)).bytes)
      );
      expect(metadata.requestId).toBe(profileRequest.requestId);
      expect(metadata.profile.status).toBe('available');
      const saved = await open(metadata.profile.profileId);
      expect(knownNative.size).toBeGreaterThan(0);
      const same = (left: BrowserBinding, right: BrowserBinding) => expect(left).toEqual(right);
      const control = BrowserControlSchema.parse(
        json((await request('/api/browser/control', saved.binding)).bytes)
      );
      if (control.status !== 'ready' || !control.controllerId)
        throw new Error('PUBLIC_NATIVE_ACTUAL_CONTROL_REFUSED');
      expect(control.binding.epoch).toBe(saved.binding.epoch + 1);
      expect(control.binding.inputGeneration).toBe(saved.binding.inputGeneration + 1);
      const issue = json(
        (await request('/api/browser/viewers/issue', { binding: control.binding })).bytes
      );
      const viewer = z
        .object({ viewer: BrowserViewerSchema, ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) })
        .strict()
        .parse(issue);
      same(viewer.viewer.binding, control.binding);
      const frameWire = await request('/api/browser/viewers/next', { ticket: viewer.ticket });
      expect(frameWire.response.headers.get('content-type')).toBe(
        'application/vnd.dorkos.browser-frame'
      );
      const decoder = new BrowserFrameBodyDecoder();
      decoder.push(frameWire.bytes);
      const frame = decoder.finish();
      same(frame.metadata.frame.binding, control.binding);
      expect(frame.bytes.length).toBeGreaterThan(100);
      expect(frame.metadata.frame.viewerId).toBe(viewer.viewer.viewerId);
      if (frame.metadata.frame.format === 'jpeg') {
        expect([...frame.bytes.subarray(0, 2)]).toEqual([255, 216]);
        expect([...frame.bytes.subarray(-2)]).toEqual([255, 217]);
      } else expect([...frame.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(frame.metadata.geometry.cssViewport.width).toBeGreaterThan(0);
      expect(frame.metadata.geometry.cssViewport.height).toBeGreaterThan(0);
      // Raster/wire validation is not a decoded-and-drawn receipt: none is fabricated here.
      const command = {
        kind: 'input',
        requestId: randomUUID(),
        binding: control.binding,
        steps: [
          { kind: 'keyDown', key: 'Tab' },
          { kind: 'keyUp', key: 'Tab' },
        ],
      };
      const inputReceipt = BrowserActionReceiptSchema.parse(
        json(
          (await request('/api/browser/input', { command, controllerId: control.controllerId }))
            .bytes
        )
      );
      expect(inputReceipt.requestId).toBe(command.requestId);
      same(inputReceipt.binding, control.binding);
      expect(inputReceipt.outcome).toBe('completed');
      const staleCommand = { ...command, requestId: randomUUID(), binding: saved.binding };
      const stale = await request(
        '/api/browser/input',
        { command: staleCommand, controllerId: control.controllerId },
        [200, 403, 404]
      );
      if (stale.response.status === 200) {
        const refused = BrowserActionReceiptSchema.parse(json(stale.bytes));
        expect(refused.requestId).toBe(staleCommand.requestId);
        expect(refused.outcome).not.toBe('completed');
      }
      await request('/api/browser/viewers/disconnect', { ticket: viewer.ticket });
      const close = async (instance: typeof saved.instance) => {
        const command = {
          requestId: randomUUID(),
          browserId: instance.browserId,
          browserGeneration: instance.browserGeneration,
        };
        const receipt = BrowserCloseReceiptSchema.parse(
          json((await request('/api/browser/instances/close', command)).bytes)
        );
        expect(receipt).toEqual({ ...command, cleanup: 'observed' });
      };
      await close(saved.instance);
      await close(clean.instance);
      const profiles = z
        .object({ profiles: z.array(BrowserProfileSchema) })
        .strict()
        .parse(json((await request('/api/browser/profiles')).bytes));
      expect(
        profiles.profiles.find((value) => value.profileId === metadata.profile.profileId)?.status
      ).toBe('available');
      const reopened = await open(metadata.profile.profileId);
      expect(reopened.instance.browserId).not.toBe(saved.instance.browserId);
      await close(reopened.instance);
      const disabled = BrowserProductionStatusSchema.parse(
        json((await request('/api/browser/runtime/enable', { enabled: false })).bytes)
      );
      expect(disabled).toEqual({ state: 'disabled', enabled: false });
      expect(await status()).toEqual(disabled);
      await request(
        '/api/browser/runtime/open',
        { workspaceId: input.workspaceId, request: { requestId: randomUUID(), mode: 'ephemeral' } },
        [404, 503]
      );
      await own(verifyPublicNativeEmits(input, guard));
      guard();
      console.info(
        JSON.stringify({
          fixture: 'production-public-native',
          offOnOff: true,
          nativeInputReceipt: inputReceipt.outcome,
          rasterBytes: frame.bytes.byteLength,
          retainedProfileReopened: true,
          originalNativeCount: knownNative.size,
          controlledDOMMutation: 'unverified',
          cookiePersistence: 'unverified',
          chromeCompatibility: 'unavailable',
        })
      );
    });
    void originals.whole.catch((value) => {
      if (value !== closedAdmission) failures(value);
    });
    await joinOriginalPublicNativeReturn({
      body: originals.whole,
      close: async () => {
        clearTimeout(timer);
        await cleanup();
      },
      observe: async () => {
        expect(returned).toBe(true);
        let physicalFailure: Readonly<{ value: unknown }> | undefined;
        try {
          expect(originals.child?.stdout?.readableEnded).toBe(true);
          expect(originals.child?.stderr?.readableEnded).toBe(true);
        } catch (value) {
          physicalFailure = { value };
        }
        // Original terminal and pipe jobs joined; failed EOF remains failed while known births are independently read.
        if (!originals.native) throw new Error('PUBLIC_NATIVE_ORIGINAL_OBSERVER_REQUIRED');
        if (!originals.projection || knownNative.size === 0)
          physicalFailure ??= { value: new Error('PUBLIC_NATIVE_ORIGINAL_BIRTH_BANK_REQUIRED') };
        const observe = originals.native.processes.observe.bind(originals.native.processes);
        const work = [...knownNative.values()].map(async (original) => {
          const observation = await observe(original, new AbortController().signal);
          expect(observation.status).toBe('dead'); // Unknown/zombie remains unverified; no exclusion or retry.
        });
        const results = await Promise.allSettled(work);
        for (const result of results)
          if (result.status === 'rejected') physicalFailure ??= { value: result.reason };
        if (physicalFailure) throw physicalFailure.value;
        retainedCampaigns.delete(originals);
      },
    });
    console.info(
      JSON.stringify({
        fixture: 'production-public-native-original-return',
        originalServerReturned: true,
        originalPipesReturned: true,
        heldCampaigns: retainedCampaigns.size,
      })
    );
  },
  190000
);
