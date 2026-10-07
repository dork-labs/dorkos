import { captureOriginalQualificationGrant } from './qualification-grant.fixture.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { BrowserBinding } from '@dorkos/shared/browser-schemas';
import {
  BrowserProductionStatusSchema,
  BrowserProductionOpenReceiptSchema,
  BrowserProductionProfileCreateReceiptSchema,
  BrowserProductionNavigateReceiptSchema,
  BrowserLocalDestinationReceiptSchema,
  BrowserControlSchema,
  BrowserViewerSchema,
  BrowserBindingSchema,
} from '@dorkos/shared/browser-schemas';
import { BrowserFrameBodyDecoder } from '@dorkos/shared/browser-frame-wire';
import { z } from 'zod';
import {
  resolveInstalledRuntimeConfiguration,
  createRuntimeInstallation,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import {
  createOriginalNativeProjectionReceiver,
  type OriginalViewerCensus,
} from '../private-native-projection.js';
import { createOriginalProjectedResourceBank } from './private-projected-resource-bank.fixture.js';
import { connectOriginalColdListener } from './private-frame-cold-listener.fixture.js';
import { verifyPublicNativeEmits, type PublicNativeInput } from './public-native-input.js';
import { joinOriginalPublicNativeReturn } from './public-native-return.js';
import {
  createOriginalStorageOrigin,
  requireOriginalStorage,
  requireOriginalClean,
  requireOriginalMutationSequence,
} from './private-storage-origin.fixture.js';

type Native = Awaited<ReturnType<typeof verifyInstalledNativeJournal>>;
/** Built CLI only: the fixture owns original child/IPC/pipes and every projected native birth.
 * No SDK Page, raw CDP, renderer substitute or storage-state injection is used. */
export async function withOriginalInstalledBrowserRound(
  options: {
    input: PublicNativeInput;
    node: string;
    artifacts: string;
    round: number;
    native: Native;
    signal: AbortSignal;
    current(): void;
    retainRetirement?: (report: unknown) => Promise<void>;
  },
  body: (ports: {
    signal: AbortSignal;
    request(path: string, document?: unknown): Promise<unknown>;
    bytes(path: string, document: unknown): Promise<Uint8Array>;
    birth(binding: BrowserBinding): Promise<void>;
    zero(bindings: readonly BrowserBinding[], at: number): Promise<void>;
    finishZero(): void;
    observations(): readonly OriginalViewerCensus[];
    originalProjection(): ReturnType<typeof createOriginalNativeProjectionReceiver>;
  }) => Promise<void>
) {
  const roundLifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, roundLifetime.signal]);
  const jobs = new Set<Promise<unknown>>(),
    logs: FileHandle[] = [];
  let first: Readonly<{ value: unknown }> | undefined;
  const fail = (value: unknown) => {
    first ??= { value };
    roundLifetime.abort(first.value);
    for (const wake of censusWaiters) wake();
  };
  const own = <T>(original: Promise<T>) => {
    jobs.add(original);
    void original.then(
      () => jobs.delete(original),
      (value) => {
        fail(value);
        jobs.delete(original);
      }
    );
    return original;
  };
  let cli: ChildProcess | undefined, returned: Promise<void> | undefined;
  let projection: ReturnType<typeof createOriginalNativeProjectionReceiver> | undefined;
  let bank: ReturnType<typeof createOriginalProjectedResourceBank> | undefined;
  const census: OriginalViewerCensus[] = [],
    censusWaiters = new Set<() => void>();
  const nativeBirths = new Map<
    string,
    import('../private-native-projection.js').OriginalNativeBirth
  >();
  const extraKnown = new Map<string, import('@dorkos/browser').ProcessIdentity>();
  let zero = true,
    stopping = false,
    cookie = '',
    pipes: Promise<void>[] = [];
  let offObservation: 'observed' | 'refused' = 'refused';
  const origin = 'http://127.0.0.1:' + options.input.port;
  const retainRetirement = options.retainRetirement?.bind(options);
  const guard = () => {
    if (first) throw first.value;
    options.current();
    signal.throwIfAborted();
    projection?.assertCurrent();
  };
  const requestBytes = async (
    path: string,
    document?: unknown,
    requestSignal = signal,
    check = guard
  ) => {
    check();
    const response = await own(
      fetch(origin + path, {
        method: document === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        ...(document === undefined ? {} : { body: JSON.stringify(document) }),
        signal: requestSignal,
      })
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('STORAGE_ORIGINAL_HTTP_BODY_REQUIRED');
    const chunks: Uint8Array[] = [];
    let size = 0,
      reason: { value: unknown } | undefined;
    try {
      for (;;) {
        const next = await own(reader.read());
        check();
        if (next.done) break;
        chunks.push(next.value);
        size += next.value.length;
        if (size > 2 * 1024 * 1024) throw new Error('STORAGE_ORIGINAL_HTTP_BOUND');
      }
    } catch (value) {
      reason = { value };
    }
    for (const cleanup of [() => reader.cancel(), () => reader.releaseLock()])
      try {
        await cleanup();
      } catch (value) {
        reason ??= { value };
      }
    if (reason) throw reason.value;
    if (response.status !== 200)
      throw new Error('STORAGE_ORIGINAL_HTTP_REFUSED:' + response.status);
    return Buffer.concat(chunks);
  };
  const request = async (path: string, document?: unknown) =>
    JSON.parse((await requestBytes(path, document)).toString('utf8')) as unknown;
  try {
    guard();
    for (const name of ['stdout', 'stderr'])
      logs.push(
        await own(
          open(
            join(options.artifacts, 'storage-round-' + options.round + '.' + name + '.raw'),
            'wx',
            0o600
          )
        )
      );
    const qualificationGrant = await own(captureOriginalQualificationGrant(options.input, guard));
    cli = spawn(
      options.node,
      [
        options.input.cliEntry,
        '--no-open',
        '--no-tasks',
        '--port',
        String(options.input.port),
        '--dir',
        options.input.home,
        '--boundary',
        options.input.home,
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
          DORK_HOME: options.input.home,
          DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
          DORKOS_HOST: '127.0.0.1',
          DORKOS_TELEMETRY_DISABLED: '1',
          OTEL_SDK_DISABLED: 'true',
          DORKOS_BROWSER_PRIVATE_NATIVE_ACCEPTANCE: '1',
        },
      }
    );
    const original = cli;
    const stop = () => {
      fail(signal.reason);
      stopping = true;
      try {
        if (original.exitCode === null && original.signalCode === null) original.kill('SIGTERM');
      } catch (value) {
        fail(value);
      }
    };
    // Body failure fences its work; only the existing parent lifetime can stop
    // the CLI before authenticated Off cleanup has had its original turn.
    options.signal.addEventListener('abort', stop, { once: true });
    returned = own(
      new Promise<void>((yes, no) => {
        original.once('error', no);
        original.once('close', (code, originalStop) => {
          options.signal.removeEventListener('abort', stop);
          if (stopping && code === 0 && originalStop === null) yes();
          else no(new Error('STORAGE_ORIGINAL_CLI_RETURN_REFUSED'));
        });
      })
    );
    let total = 0;
    const drain = async (stream: Readable, log: FileHandle) => {
      for await (const chunk of stream) {
        total += Buffer.byteLength(chunk);
        if (total > 32 * 1024 * 1024) throw new Error('STORAGE_ORIGINAL_RAW_BOUND');
        await log.write(Buffer.from(chunk));
      }
      if (!stream.readableEnded) throw new Error('STORAGE_ORIGINAL_PIPE_EOF_REQUIRED');
    };
    pipes = [own(drain(original.stdout!, logs[0]!)), own(drain(original.stderr!, logs[1]!))];
    bank = createOriginalProjectedResourceBank({
      parent: options.native.manager,
      identity: options.native.identity,
      attributeRoot: options.native.attributeRoot,
      cli: original,
      processes: options.native.processes,
      signal,
      current: guard,
      own,
    });
    if (!original.pid) throw new Error('STORAGE_ORIGINAL_CLI_PID_REQUIRED');
    projection = createOriginalNativeProjectionReceiver({
      qualification: qualificationGrant,
      pid: original.pid,
      channel: {
        send: (message, callback) => original.send(message, (error) => callback(error)),
        on: (event, callback) => original.on(event, callback),
        off: (event, callback) => original.off(event, callback),
        disconnect: () => {
          if (original.connected) original.disconnect();
        },
      },
      async retainBirth(birth) {
        await own(bank!.retainBirth(birth));
        nativeBirths.set(birth.browserId + ':' + birth.browserGeneration, birth);
      },
      async retainViewerSample(sample) {
        if (zero && !sample.closed) {
          const value = new Error('STORAGE_ZERO_VIEWER_REQUIRED');
          fail(value);
          throw value;
        }
      },
      async retainViewerCensus(value) {
        if (census.length >= 8192) {
          const reason = new Error('STORAGE_CENSUS_BOUND');
          fail(reason);
          throw reason;
        }
        census.push(value);
        if (zero && (value.closed || value.subscriptions !== 0)) {
          const reason = new Error('STORAGE_ZERO_VIEWER_REQUIRED');
          fail(reason);
          throw reason;
        }
        for (const wake of censusWaiters) wake();
      },
    });
    await own(bank.captureCli());
    const sockets = new Map<Socket, () => void>();
    for (;;) {
      guard();
      if (original.exitCode !== null || original.signalCode !== null)
        throw new Error('STORAGE_ORIGINAL_CLI_RETURNED');
      if (
        (await own(connectOriginalColdListener(options.input.port, sockets, guard))).state ===
        'connected'
      )
        break;
      await own(new Promise<void>((yes) => setTimeout(yes, 50)));
    }
    const login = await own(
      fetch(origin + '/api/auth/sign-in/email', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: options.input.email, password: options.input.password }),
        signal,
      })
    );
    await own(login.arrayBuffer());
    if (login.status !== 200) throw new Error('STORAGE_ORIGINAL_OWNER_SIGN_IN_REQUIRED');
    cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    if (!cookie) throw new Error('STORAGE_ORIGINAL_OWNER_COOKIE_REQUIRED');
    const enabled = BrowserProductionStatusSchema.parse(
      await request('/api/browser/runtime/enable', { enabled: true })
    );
    if (enabled.state !== 'qualification' || !enabled.enabled)
      throw new Error('STORAGE_ORIGINAL_ENGINE_UNAVAILABLE');
    await body({
      signal,
      request,
      bytes: requestBytes,
      async birth(binding) {
        guard();
        const birth = nativeBirths.get(binding.browserId + ':' + binding.browserGeneration);
        if (!birth || !birth.complete) throw new Error('STORAGE_ORIGINAL_OPEN_BIRTH_REQUIRED');
        const rows = await own(options.native.processes.descendants(birth.root, signal));
        for (const row of rows.identities.slice(0, 512))
          extraKnown.set(row.pid + ':' + row.birth, Object.freeze({ ...row }));
        if (extraKnown.size > 8192 || rows.identities.length > 512)
          throw new Error('STORAGE_ORIGINAL_BIRTH_BOUND');
        if (
          rows.status !== 'complete' ||
          !rows.identities.some(
            (row) => row.pid === birth.root.pid && row.birth === birth.root.birth
          )
        )
          throw new Error('STORAGE_ORIGINAL_TREE_UNKNOWN');
        for (const row of rows.identities) {
          if ((await own(options.native.processes.observe(row, signal))).status !== 'alive')
            throw new Error('STORAGE_ORIGINAL_BIRTH_UNKNOWN');
        }
      },
      zero(bindings, at) {
        return own(
          new Promise<void>((yes, no) => {
            const finish = () => {
              censusWaiters.delete(check);
              signal.removeEventListener('abort', abort);
            };
            const check = () => {
              try {
                guard();
                if (
                  bindings.some(
                    (binding) =>
                      !census.some(
                        (value) =>
                          value.browserId === binding.browserId &&
                          value.browserGeneration === binding.browserGeneration &&
                          value.at >= at &&
                          value.subscriptions === 0 &&
                          !value.closed
                      )
                  )
                )
                  return;
                finish();
                yes();
              } catch (value) {
                finish();
                no(value);
              }
            };
            const abort = () => {
              finish();
              no(signal.reason);
            };
            censusWaiters.add(check);
            signal.addEventListener('abort', abort, { once: true });
            check();
          })
        );
      },
      finishZero() {
        zero = false;
      },
      observations: () => Object.freeze([...census]),
      originalProjection: () => {
        guard();
        if (!projection) throw new Error('STORAGE_ORIGINAL_PROJECTION_REQUIRED');
        return projection;
      },
    });
    zero = false;
  } catch (value) {
    fail(value);
  } finally {
    zero = false;
    // Shutdown is independent of the body and original admission; only original ChildProcess is signalled.
    await joinOriginalPublicNativeReturn({
      body: (async () => {
        if (first) throw first.value;
      })(),
      async close() {
        // Body failure must not skip the genuine authenticated Off producer. This
        // cleanup has no new deadline: the original lifetime still bounds it.
        const off = new AbortController();
        const abortOff = () => off.abort(options.signal.reason);
        options.signal.addEventListener('abort', abortOff, { once: true });
        try {
          if (!cookie) throw new Error('STORAGE_ORIGINAL_OFF_OWNER_REQUIRED');
          const original = requestBytes(
            '/api/browser/runtime/enable',
            { enabled: false },
            off.signal,
            () => {}
          );
          // Enter the original request even after body cancellation; an expired
          // lifetime cannot authorize extra time or prove its delivery/success.
          if (options.signal.aborted) abortOff();
          const disabled = BrowserProductionStatusSchema.parse(
            JSON.parse((await original).toString('utf8'))
          );
          if (disabled.state !== 'disabled' || disabled.enabled)
            throw new Error('STORAGE_ORIGINAL_OFF_REQUIRED');
          offObservation = 'observed';
        } catch (value) {
          fail(value);
        } finally {
          options.signal.removeEventListener('abort', abortOff);
        }
        stopping = true;
        try {
          if (cli && cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM');
        } catch (value) {
          fail(value);
        }
        for (const original of [returned, ...pipes])
          if (original)
            try {
              await original;
            } catch (value) {
              fail(value);
            }
        if (projection)
          try {
            await projection.close();
          } catch (value) {
            fail(value);
          }
        for (const log of logs) {
          try {
            await log.sync();
          } catch (value) {
            fail(value);
          }
          try {
            await log.close();
          } catch (value) {
            fail(value);
          }
        }
        for (const result of await Promise.allSettled([...jobs]))
          if (result.status === 'rejected') fail(result.reason);
        if (first) throw first.value;
      },
      async observe() {
        const known = new Map<string, import('@dorkos/browser').ProcessIdentity>();
        for (const row of [...(bank?.originalKnownBirths() ?? []), ...extraKnown.values()])
          known.set(row.pid + ':' + row.birth, row);
        for (const birth of nativeBirths.values())
          for (const row of [birth.root, birth.supervisor, birth.manager, ...birth.identities])
            known.set(row.pid + ':' + row.birth, row);
        let failure: { value: unknown } | undefined;
        const observed: Array<{ pid: number; birth: string; status: string }> = [];
        const originals = [...known.values()].filter(
          (row) =>
            row.pid !== options.native.manager.pid || row.birth !== options.native.manager.birth
        );
        for (const row of known.values()) {
          if (row.pid === options.native.manager.pid && row.birth === options.native.manager.birth)
            continue;
          try {
            const status = (
              await options.native.processes.observe(row, new AbortController().signal)
            ).status;
            observed.push({ pid: row.pid, birth: row.birth, status });
            if (status !== 'dead') throw new Error('STORAGE_ORIGINAL_BIRTH_RETIREMENT_UNVERIFIED');
          } catch (value) {
            if (!observed.some((result) => result.pid === row.pid && result.birth === row.birth))
              observed.push({ pid: row.pid, birth: row.birth, status: 'error' });
            failure ??= { value };
          }
        }
        // Export only original retained identities and the existing post-join observation results.
        // This port admits no authority, process query or cleanup completion substitute.
        try {
          await retainRetirement?.({
            kind: 'original-storage-retirement',
            round: options.round,
            offCleanup: offObservation,
            knownBirths: originals,
            observed,
            entryManagerExcluded: options.native.manager,
          });
        } catch (value) {
          failure ??= { value };
        }
        if (failure) throw failure.value;
      },
    });
  }
}

/** Three clean original CLI restarts, durable/clean stores and two live native Pages with no viewers. */
export async function runPrivateOriginalStorageWindow(options: {
  input: PublicNativeInput;
  node: string;
  artifacts: string;
  signal: AbortSignal;
  current(): void;
  retain(report: unknown): Promise<void>;
  retainRetirement?: (report: unknown) => Promise<void>;
}) {
  const retainRetirement = options.retainRetirement?.bind(options);
  const guard = () => {
    options.current();
    options.signal.throwIfAborted();
  };
  await verifyPublicNativeEmits(options.input, guard);
  const configuration = await resolveInstalledRuntimeConfiguration(
    pathToFileURL(options.input.cliEntry),
    options.input.home
  );
  if (
    (await createRuntimeInstallation(configuration).inspectExisting()).state !== 'installed-files'
  )
    throw new Error('STORAGE_ORIGINAL_INSTALLATION_REQUIRED');
  const native = await verifyInstalledNativeJournal(configuration),
    fixture = await createOriginalStorageOrigin(options.signal);
  const profiles = new Map<'A' | 'B', string>(),
    httpHits = new Map<'A' | 'B', number>();
  const oldPages: BrowserBinding[] = [];
  let first: { value: unknown } | undefined;
  try {
    for (let round = 0; round <= 3; round++)
      await withOriginalInstalledBrowserRound(
        { ...options, native, round, retainRetirement },
        async (port) => {
          const live = new Map<'A' | 'B', BrowserBinding>();
          const open = async (subject: 'A' | 'B' | 'clean') => {
            guard();
            if (subject !== 'clean' && round === 0) {
              const id = randomUUID();
              const created = BrowserProductionProfileCreateReceiptSchema.parse(
                await port.request('/api/browser/runtime/profiles', {
                  requestId: id,
                  label: 'Storage fixture ' + subject,
                })
              );
              if (created.requestId !== id) throw new Error('STORAGE_PROFILE_RECEIPT_REQUIRED');
              profiles.set(subject, created.profile.profileId);
            }
            const requestId = randomUUID();
            const receipt = BrowserProductionOpenReceiptSchema.parse(
              await port.request('/api/browser/runtime/open', {
                workspaceId: options.input.workspaceId,
                request: {
                  requestId,
                  mode: subject === 'clean' ? 'ephemeral' : 'persistent',
                  ...(subject === 'clean' ? {} : { profileId: profiles.get(subject) }),
                },
              })
            );
            if (
              receipt.requestId !== requestId ||
              receipt.instance.mode !== (subject === 'clean' ? 'ephemeral' : 'persistent') ||
              (subject !== 'clean' &&
                (receipt.instance.mode !== 'persistent' ||
                  receipt.instance.profileId !== profiles.get(subject)))
            )
              throw new Error('STORAGE_ORIGINAL_PROFILE_REQUIRED');
            if (
              oldPages.some(
                (old) =>
                  old.browserId === receipt.binding.browserId || old.tabId === receipt.binding.tabId
              )
            )
              throw new Error('STORAGE_RESTART_OLD_PAGE_REUSED');
            oldPages.push(receipt.binding);
            await port.birth(receipt.binding);
            const control = BrowserControlSchema.parse(
              await port.request('/api/browser/control', receipt.binding)
            );
            if (control.status !== 'ready' || !control.controllerId)
              throw new Error('STORAGE_ORIGINAL_CONTROL_REQUIRED');
            const allowedId = randomUUID();
            const permission = BrowserLocalDestinationReceiptSchema.parse(
              await port.request('/api/browser/runtime/local-destination', {
                requestId: allowedId,
                binding: control.binding,
                endpoint: fixture.origin + '/',
                ttlMilliseconds: 300000,
              })
            );
            if (permission.requestId !== allowedId || permission.endpoint !== fixture.origin)
              throw new Error('STORAGE_ORIGINAL_DESTINATION_REQUIRED');
            const navigationId = randomUUID();
            const url = new URL('/page', fixture.origin);
            for (const [key, value] of Object.entries({
              subject,
              round: String(round),
              pageId: receipt.binding.tabId,
              seed: subject !== 'clean' && round === 0 ? '1' : '0',
            }))
              url.searchParams.set(key, value);
            const navigated = BrowserProductionNavigateReceiptSchema.parse(
              await port.request('/api/browser/runtime/navigate', {
                controllerId: control.controllerId,
                command: {
                  kind: 'navigate',
                  requestId: navigationId,
                  binding: control.binding,
                  url: url.href,
                },
              })
            );
            if (
              navigated.requestId !== navigationId ||
              navigated.binding.tabId !== receipt.binding.tabId ||
              navigated.binding.browserId !== receipt.binding.browserId
            )
              throw new Error('STORAGE_ORIGINAL_PAGE_CHANGED');
            return navigated.binding;
          };
          for (const subject of ['A', 'B'] as const) {
            const binding = await open(subject);
            live.set(subject, binding);
            const report = await fixture.ready(subject, round, binding.tabId, port.signal);
            if (round === 0) httpHits.set(subject, report.httpCache);
            requireOriginalStorage(report, {
              subject,
              round,
              pageId: binding.tabId,
              httpCache: httpHits.get(subject)!,
              mutation: 0,
            });
            await options.retain({ kind: 'actual-storage-restart', round, binding, report });
          }
          if (round === 0) {
            const clean = await open('clean');
            const report = await fixture.ready('clean', 0, clean.tabId, port.signal);
            requireOriginalClean(report, clean.tabId, [...httpHits.values()]);
            await fixture.mutateClean(clean.tabId, port.signal);
            for (const [subject, binding] of live) {
              const preserved = await fixture.checkpoint(subject, 0, binding.tabId, 1, port.signal);
              requireOriginalStorage(preserved, {
                subject,
                round: 0,
                pageId: binding.tabId,
                httpCache: httpHits.get(subject)!,
                mutation: 0,
              });
            }
            await options.retain({ kind: 'actual-clean-isolation', binding: clean, report });
          }
          if (round === 3) {
            const bindings = [...live.values()];
            await port.zero(bindings, Date.now());
            const reports = await Promise.all(
              (['A', 'B'] as const).map(async (subject) => {
                const binding = live.get(subject)!;
                const report = await fixture.mutate100(subject, binding.tabId, port.signal);
                requireOriginalStorage(report, {
                  subject,
                  round: 3,
                  pageId: binding.tabId,
                  httpCache: httpHits.get(subject)!,
                  mutation: 100,
                });
                return report;
              })
            );
            await port.zero(bindings, Date.now());
            for (const binding of live.values()) {
              const tabs = z
                .array(BrowserBindingSchema)
                .max(64)
                .parse(
                  await port.request(
                    '/api/browser/' +
                      binding.browserId +
                      '/tabs?browserGeneration=' +
                      binding.browserGeneration
                  )
                );
              if (
                tabs.length !== 1 ||
                Object.keys(binding).some(
                  (key) => Reflect.get(tabs[0]!, key) !== Reflect.get(binding, key)
                )
              )
                throw new Error('STORAGE_ZERO_VIEWER_PAGE_CHANGED');
              await port.birth(binding);
            }
            port.finishZero();
            for (const binding of bindings) {
              const control = BrowserControlSchema.parse(
                await port.request('/api/browser/control', binding)
              );
              if (control.status !== 'ready' || !control.controllerId)
                throw new Error('STORAGE_ORIGINAL_REATTACH_CONTROL_REQUIRED');
              const issued = z
                .object({
                  viewer: BrowserViewerSchema,
                  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
                })
                .strict()
                .parse(
                  await port.request('/api/browser/viewers/issue', { binding: control.binding })
                );
              if (
                issued.viewer.binding.tabId !== binding.tabId ||
                issued.viewer.binding.browserId !== binding.browserId
              )
                throw new Error('STORAGE_REATTACHED_PAGE_CHANGED');
              const bytes = await port.bytes('/api/browser/viewers/next', {
                ticket: issued.ticket,
              });
              const decoder = new BrowserFrameBodyDecoder();
              decoder.push(bytes);
              const frame = decoder.finish();
              if (
                frame.bytes.length < 100 ||
                frame.metadata.frame.viewerId !== issued.viewer.viewerId ||
                Object.keys(control.binding).some(
                  (key) =>
                    Reflect.get(frame.metadata.frame.binding, key) !==
                    Reflect.get(control.binding, key)
                )
              )
                throw new Error('STORAGE_ORIGINAL_REATTACH_FRAME_REQUIRED');
              const jpeg = frame.metadata.frame.format === 'jpeg';
              if (
                jpeg
                  ? frame.bytes[0] !== 255 ||
                    frame.bytes[1] !== 216 ||
                    frame.bytes.at(-2) !== 255 ||
                    frame.bytes.at(-1) !== 217
                  : ![137, 80, 78, 71, 13, 10, 26, 10].every(
                      (value, index) => frame.bytes[index] === value
                    )
              )
                throw new Error('STORAGE_ORIGINAL_IMAGE_ENCODING_REQUIRED');
              const subject = bindings.indexOf(binding) === 0 ? 'A' : 'B';
              const fresh = await fixture.checkpoint(subject, 3, binding.tabId, 2, port.signal);
              requireOriginalStorage(fresh, {
                subject,
                round: 3,
                pageId: binding.tabId,
                httpCache: httpHits.get(subject)!,
                mutation: 100,
              });
            }
            const sequences = (['A', 'B'] as const).map((subject) =>
              requireOriginalMutationSequence(fixture.reports, subject, live.get(subject)!.tabId)
            );
            await options.retain({
              kind: 'actual-zero-viewer-mutations',
              mutations: sequences.map((rows) => rows.length),
              bindings,
              reports,
              sequences,
              census: port.observations(),
            });
          }
        }
      );
  } catch (value) {
    first = { value };
  } finally {
    try {
      await fixture.close();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
}
