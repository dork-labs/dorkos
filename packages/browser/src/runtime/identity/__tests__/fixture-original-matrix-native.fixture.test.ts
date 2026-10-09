import { it, expect, onTestFinished } from 'vitest';
import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  type InstallResult,
  createRuntimeInstallation,
  resolveInstalledRuntimeConfiguration,
  verifyInstalledNativeJournal,
} from '../../installation/index.js';
import type { ProcessIdentity, ProcessObservation } from '../../../configuration.js';
import { parseRuntimeDescriptor } from '../../../runtime-descriptor.js';
import { NativeIdentitySchema } from '../native-observation.js';
import {
  qualifyFixtureOriginalMatrix,
  MatrixObservationsSchema,
} from './fixture-original-matrix.js';
import { createFixtureOriginalMatrixServer } from './fixture-original-matrix-server.js';
import {
  OriginalProcessIdentitySchema,
  independentlyObserveCandidateReturns,
  candidateOriginals,
} from './fixture-production-cohort.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const InputSchema = z
  .object({
    cacheHome: z.string().startsWith('/'),
    campaignHome: z.string().startsWith('/'),
    cliEntry: z.string().startsWith('/'),
    cliSHA256: digest,
    workerEntry: z.string().startsWith('/'),
    workerSHA256: digest,
    emittedGuard: z.string().startsWith('/'),
    emittedGuardSHA256: digest,
  })
  .strict();
const ReplySchema = z
  .object({
    kind: z.enum(['opened', 'matrix-observation', 'failed', 'closed']),
    nonce: z.string().uuid(),
    sequence: z.number().int().positive().optional(),
    baseline: NativeIdentitySchema.optional(),
    baselineOriginals: z
      .array(
        z.object({ pid: z.number().int().positive(), birth: z.string().min(1).max(128) }).strict()
      )
      .min(1)
      .max(512)
      .optional(),
    knownBaselineOriginals: z
      .array(
        z.object({ pid: z.number().int().positive(), birth: z.string().min(1).max(128) }).strict()
      )
      .min(0)
      .max(512)
      .optional(),
    observations: MatrixObservationsSchema.optional(),
    candidateOriginals: z.array(OriginalProcessIdentitySchema).max(512).optional(),
    candidateCohortComplete: z.boolean().optional(),
    state: z.enum(['closed', 'held']).optional(),
    originalChildReturned: z.boolean().optional(),
    descendantsReturned: z.boolean().optional(),
    profileRemoved: z.boolean().optional(),
    identityAcknowledgementWithheld: z.boolean().optional(),
    root: z
      .object({ pid: z.number().int().positive(), birth: z.string().min(1).max(128) })
      .strict()
      .optional(),
    failure: z
      .object({
        stage: z.enum(['launch', 'sample', 'send', 'close', 'protocol']),
        kind: z.enum(['undefined', 'false', 'opaque']),
      })
      .strict()
      .optional(),
    candidate: z.literal('UNVERIFIED'),
  })
  .strict();
// eslint-disable-next-line no-restricted-syntax -- Private installed-fixture arm is captured at module scope, outside public app configuration.
const fixturePath = process.env.DORKOS_BROWSER_CHROME_MATRIX_FIXTURE;
const retained = new Set<object>();
function checkOriginalCampaignAdmission(
  first: Readonly<{ value: unknown }> | undefined,
  stopped: boolean,
  closedAdmission: Error
): void {
  if (first) throw first.value;
  if (stopped) throw closedAdmission;
}
// The same admission check used after actual installer producers must consume a
// latched deadline before their delayed success can acquire any next producer.
it.each([false, undefined, new Error('original preparation failure')])(
  'refuses delayed successful verification after the first preparation failure %#',
  async (cause) => {
    const retainedFailure: { first?: Readonly<{ value: unknown }> } = {};
    const closed = new Error('ordinary close'),
      abort = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquisitions = 0;
    const next = held.then(() => {
      checkOriginalCampaignAdmission(retainedFailure.first, false, closed);
      acquisitions++;
    });
    const result = next.then(
      () => ({ passed: true as const }),
      (value: unknown) => ({ passed: false as const, value })
    );
    retainedFailure.first = { value: cause };
    abort.abort();
    release();
    const observed = await result;
    expect(abort.signal.aborted).toBe(true);
    expect(observed.passed).toBe(false);
    if (!observed.passed) expect(observed.value).toBe(cause);
    expect(acquisitions).toBe(0);
  }
);
function requireOriginalMatrixReuse(value: InstallResult) {
  if (value.state !== 'verified-reused' || value.platform !== 'darwin' || value.arch !== 'arm64')
    throw new Error('CHROME_MATRIX_ORIGINAL_VERIFICATION_REQUIRED');
  return value;
}
it.each(['verified-installed', 'refused'] as const)(
  'refuses a non-reused installation result before matrix acquisition: %s',
  (state) => {
    const result: InstallResult =
      state === 'refused'
        ? {
            state,
            cause: 'VERIFICATION_UNAVAILABLE',
            publicationMayHaveChanged: false,
            readiness: { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' },
          }
        : {
            state,
            cause: null,
            installationId: 'original',
            attemptId: 'original',
            generation: 1,
            observedVersion: '153.0.7998.0',
            executableSHA256: 'a'.repeat(64),
            platform: 'darwin',
            arch: 'arm64',
            currentManifestDigest: 'b'.repeat(64),
            journalDigest: 'c'.repeat(64),
            readiness: { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' },
          };
    expect(() => requireOriginalMatrixReuse(result)).toThrow(
      'CHROME_MATRIX_ORIGINAL_VERIFICATION_REQUIRED'
    );
  }
);

/** Explicit installed-package campaign only. Public Chrome mode remains unavailable even on pass. */
it.skipIf(!fixturePath || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'original installed Chrome context/HTTPS matrix and genuine missing-ACK refusal',
  async () => {
    let stopped = false,
      first: Readonly<{ value: unknown }> | undefined;
    const closedAdmission = new Error('CHROME_MATRIX_CAMPAIGN_CLOSED');
    const originals = new Set<Promise<unknown>>();
    const installationAbort = new AbortController();
    const children = new Map<
      ChildProcess,
      { stop: () => void; terminal: Promise<void>; pipes: Promise<void> }
    >();
    const owners: {
      whole?: Promise<void>;
      server?: ReturnType<typeof createFixtureOriginalMatrixServer>;
      closing?: Promise<void>;
      observeBaseline?: (original: ProcessIdentity) => Promise<ProcessObservation>;
      knownBaseline: Map<string, ProcessIdentity>;
      knownCandidate: Map<string, ProcessIdentity>;
    } = { knownBaseline: new Map(), knownCandidate: new Map() };
    retained.add(owners);
    const note = (value: unknown) => {
      if (value !== closedAdmission) first ??= { value };
    };
    const guard = () => {
      checkOriginalCampaignAdmission(first, stopped, closedAdmission);
    };
    const own = <T>(producer: () => Promise<T> | T): Promise<T> => {
      const work = Promise.resolve().then(producer);
      originals.add(work);
      void work.then(
        () => originals.delete(work),
        (value) => {
          note(value);
          originals.delete(work);
        }
      );
      return work;
    };
    const stopChildren = () => {
      for (const child of children.values())
        try {
          child.stop();
        } catch (value) {
          note(value);
        }
    };
    const close = () => {
      stopped = true;
      installationAbort.abort();
      stopChildren();
      return (owners.closing ??= Promise.resolve().then(async () => {
        stopChildren();
        const serverClose = owners.server?.close();
        const duties = [
          ...(serverClose ? [serverClose] : []),
          ...(owners.whole ? [owners.whole] : []),
          ...[...children.values()].flatMap((child) => [child.terminal, child.pipes]),
          ...originals,
        ];
        for (const result of await Promise.allSettled(duties))
          if (result.status === 'rejected') note(result.reason);
        while (originals.size)
          for (const result of await Promise.allSettled([...originals]))
            if (result.status === 'rejected') note(result.reason);
        // Terminal replies can carry originals even when baseline admission never opened.
        // Join all independently after original worker/whole return; a rejection cannot skip siblings.
        const nativeReturns = await Promise.allSettled(
          [...owners.knownBaseline.values(), ...owners.knownCandidate.values()].map((original) =>
            own(() => {
              if (!owners.observeBaseline)
                throw new Error('CHROME_MATRIX_BASELINE_OBSERVER_MISSING');
              return owners.observeBaseline(original);
            })
          )
        );
        for (const result of nativeReturns)
          if (result.status === 'rejected') note(result.reason);
          else if (result.value.status !== 'dead')
            note(new Error('CHROME_MATRIX_BASELINE_RETURN_UNVERIFIED'));
        if (first) throw first.value;
        retained.delete(owners);
      }));
    };
    // The whole admission and all independent stop/join duties precede every acquisition.
    onTestFinished(close);
    function captureChild(child: ChildProcess, stop: () => void) {
      const terminal = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve());
      });
      const pipe = async (stream: ChildProcess['stdout']) => {
        if (!stream) throw new Error('CHROME_MATRIX_ORIGINAL_PIPE_MISSING');
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 262144) throw new Error('CHROME_MATRIX_ORIGINAL_PIPE_BOUND');
        }
      };
      const pipes = Promise.all([pipe(child.stdout), pipe(child.stderr)]).then(() => {});
      children.set(child, { stop, terminal, pipes });
      void terminal.catch(note);
      void pipes.catch(note);
      return { terminal, pipes };
    }
    owners.whole = own(async () => {
      guard();
      const input = InputSchema.parse(JSON.parse(await readFile(fixturePath!, 'utf8')));
      guard();
      if (
        (await realpath(input.campaignHome)) !== input.campaignHome ||
        !input.campaignHome.includes('/T/') ||
        !basename(input.campaignHome).startsWith('chrome-matrix-')
      )
        throw new Error('CHROME_MATRIX_EXCLUSIVE_HOME_REQUIRED');
      if (
        (await realpath(input.cacheHome)) !== input.cacheHome ||
        input.cacheHome === input.campaignHome
      )
        throw new Error('CHROME_MATRIX_DISTINCT_INSTALLED_CACHE_HOME_REQUIRED');
      guard();
      const guardBytes = await readFile(input.emittedGuard);
      guard();
      if (createHash('sha256').update(guardBytes).digest('hex') !== input.emittedGuardSHA256)
        throw new Error('CHROME_MATRIX_EMIT_GUARD_CHANGED');
      const emits = z
        .object({ files: z.record(z.string(), digest) })
        .strict()
        .parse(JSON.parse(guardBytes.toString('utf8')));
      if (
        input.workerEntry !==
        join(
          dirname(input.cliEntry),
          '..',
          'browser',
          'native',
          'fixture-original-chrome-supervisor-worker.mjs'
        )
      )
        throw new Error('CHROME_MATRIX_FIXED_WORKER_ENTRY_REQUIRED');
      if (
        emits.files[input.cliEntry] !== input.cliSHA256 ||
        emits.files[input.workerEntry] !== input.workerSHA256 ||
        Object.keys(emits.files).length < 4
      )
        throw new Error('CHROME_MATRIX_OWNED_EMITS_REQUIRED');
      const checkEmits = async () => {
        for (const [path, sha] of Object.entries(emits.files)) {
          guard();
          const bytes = await own(() => readFile(path));
          guard();
          if (createHash('sha256').update(bytes).digest('hex') !== sha)
            throw new Error('CHROME_MATRIX_EMIT_CHANGED');
        }
      };
      await checkEmits();
      guard();
      // Fresh existing-only verification uses the retained installation cache. The
      // campaign scratch/profiles are separate; the unchanged 90s matrix starts afterwards.
      const configuration = await own(() =>
        resolveInstalledRuntimeConfiguration(pathToFileURL(input.cliEntry), input.cacheHome)
      );
      guard();
      const installation = createRuntimeInstallation(configuration),
        verify = installation.verifyExisting.bind(installation),
        inspect = installation.inspectExisting.bind(installation);
      guard();
      const { verified, native } = await own(async () => {
        const deadline = setTimeout(() => {
          note(new Error('CHROME_MATRIX_INSTALLATION_DEADLINE'));
          installationAbort.abort();
        }, 900000);
        try {
          const verified = requireOriginalMatrixReuse(
            await own(() => verify({ signal: installationAbort.signal }))
          );
          guard();
          const current = await own(() => inspect({ signal: installationAbort.signal }));
          guard();
          if (
            current.state !== 'installed-files' ||
            current.installationId !== verified.installationId ||
            current.executableSHA256 !== verified.executableSHA256 ||
            current.currentManifestDigest !== verified.currentManifestDigest ||
            current.lastFreshVerifiedVersion !== verified.observedVersion
          )
            throw new Error('CHROME_MATRIX_ORIGINAL_INSTALLATION_CHANGED');
          const native = await own(() => verifyInstalledNativeJournal(configuration));
          guard();
          return { verified, native };
        } finally {
          clearTimeout(deadline);
        }
      });
      const originalProcesses = native.processes,
        originalObserve = originalProcesses.observe.bind(originalProcesses);
      owners.observeBaseline = (original) =>
        originalObserve(original, new AbortController().signal);
      const runtime = parseRuntimeDescriptor({
        library: {
          package: 'playwright-core',
          version: '1.63.0',
          rootDir: configuration.libraryRoot,
          assets: { manifest: 'browsers.json', cli: 'cli.js' },
        },
        executable: {
          path: join(
            configuration.cacheRoot,
            'candidates',
            verified.installationId,
            'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
          ),
          sha256: verified.executableSHA256,
          revision: '1243',
          version: verified.observedVersion,
          platform: 'darwin',
          arch: 'arm64',
        },
        identity: { mode: 'native', policyRevision: 1 },
      });
      const compatible = parseRuntimeDescriptor({
        ...runtime,
        identity: { mode: 'chrome-compatible', policyRevision: 1 },
      });
      const runtimeInput = join(input.campaignHome, 'matrix-runtime.json');
      await own(() =>
        writeFile(
          runtimeInput,
          JSON.stringify({
            executablePath: runtime.executable.path,
            executableSHA256: runtime.executable.sha256,
            observedVersion: runtime.executable.version,
          }),
          { flag: 'wx', mode: 0o600 }
        )
      );
      guard();
      const keyPath = join(input.campaignHome, 'matrix-key.pem'),
        certPath = join(input.campaignHome, 'matrix-cert.pem');
      const cert = spawn(
        '/usr/bin/openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=identity-alpha.test',
          '-addext',
          'subjectAltName=DNS:identity-alpha.test,DNS:identity-beta.test',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } }
      );
      let certStopped = false;
      const certOriginals = captureChild(cert, () => {
        if (!certStopped && cert.exitCode === null && cert.signalCode === null) {
          certStopped = true;
          cert.kill('SIGTERM');
        }
      });
      const certTimer = setTimeout(() => {
        note(new Error('CHROME_MATRIX_CERTIFICATE_DEADLINE'));
        children.get(cert)!.stop();
      }, 5000);
      try {
        await certOriginals.terminal;
        await certOriginals.pipes;
      } finally {
        clearTimeout(certTimer);
      }
      guard();
      if (cert.exitCode !== 0 || cert.signalCode !== null)
        throw new Error('CHROME_MATRIX_ORIGINAL_CERTIFICATE_FAILED');
      const key = await own(() => readFile(keyPath)),
        certificate = await own(() => readFile(certPath));
      guard();
      const certificateSPKI = createHash('sha256')
        .update(new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64');
      owners.server = createFixtureOriginalMatrixServer(key, certificate);
      guard();
      const port = await own(() => owners.server!.listen());
      guard();
      const end = performance.now() + 90000;
      const campaignTimer = setTimeout(() => {
        note(new Error('CHROME_MATRIX_CAMPAIGN_DEADLINE'));
        stopped = true;
        stopChildren();
        void owners.server?.close().catch(note);
      }, 90000);
      try {
        for (const mutant of [undefined, 'missing-first-init-ack'] as const) {
          guard();
          if (performance.now() >= end) throw new Error('CHROME_MATRIX_CAMPAIGN_DEADLINE');
          const nonce = randomUUID();
          let disconnected = false,
            sequence = 0,
            protocolFailure: Readonly<{ value: unknown }> | undefined;
          const worker = spawn(
            process.execPath,
            [
              '--input-type=module',
              '--eval',
              `import {runFixtureOriginalChromeSupervisorWorker as run} from ${JSON.stringify(pathToFileURL(input.workerEntry).href)};await run();`,
            ],
            { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: '/usr/bin:/bin' } }
          );
          const disconnect = worker.disconnect.bind(worker),
            transmit = worker.send.bind(worker);
          const raw = captureChild(worker, () => {
            if (!disconnected && worker.connected) {
              disconnected = true;
              disconnect();
            }
          });
          const replies: z.infer<typeof ReplySchema>[] = [];
          const waiters = new Set<() => void>();
          worker.on('message', (message) => {
            try {
              if (Buffer.byteLength(JSON.stringify(message)) > 65536)
                throw new Error('CHROME_MATRIX_REPLY_BOUND');
              const reply = ReplySchema.parse(message);
              if (reply.nonce !== nonce) throw new Error('CHROME_MATRIX_REPLY_BINDING');
              if (replies.length >= 16) throw new Error('CHROME_MATRIX_REPLY_COUNT');
              for (const original of [
                ...(reply.baselineOriginals ?? []),
                ...(reply.knownBaselineOriginals ?? []),
              ])
                owners.knownBaseline.set(
                  original.pid + ':' + original.birth,
                  Object.freeze({ ...original })
                );
              for (const original of reply.candidateOriginals ?? []) {
                const name = original.pid + ':' + original.birth;
                if (!owners.knownCandidate.has(name) && owners.knownCandidate.size >= 1024)
                  throw new Error('CHROME_MATRIX_CAMPAIGN_CANDIDATE_BIRTH_BOUND');
                owners.knownCandidate.set(name, Object.freeze({ ...original }));
              }
              replies.push(reply);
            } catch (value) {
              protocolFailure ??= { value };
            }
            for (const wake of waiters) wake();
          });
          worker.once('close', () => {
            for (const wake of waiters) wake();
          });
          const wait = (kinds: readonly z.infer<typeof ReplySchema>['kind'][]) =>
            own(
              () =>
                new Promise<z.infer<typeof ReplySchema>>((resolve, reject) => {
                  const timer = setTimeout(
                    () => {
                      waiters.delete(wake);
                      reject(new Error('CHROME_MATRIX_ORIGINAL_RPC_DEADLINE'));
                      children.get(worker)!.stop();
                    },
                    Math.min(20000, Math.max(1, end - performance.now()))
                  );
                  const wake = () => {
                    const found = replies.find((reply) => kinds.includes(reply.kind));
                    if (
                      found ||
                      protocolFailure ||
                      worker.exitCode !== null ||
                      worker.signalCode !== null
                    ) {
                      clearTimeout(timer);
                      waiters.delete(wake);
                      if (protocolFailure) reject(protocolFailure.value);
                      else if (found) resolve(found);
                      else reject(new Error('CHROME_MATRIX_ORIGINAL_WORKER_RETURNED'));
                    }
                  };
                  waiters.add(wake);
                  wake();
                })
            );
          const send = (message: Parameters<typeof transmit>[0]) =>
            own(
              () =>
                new Promise<void>((resolve, reject) => {
                  try {
                    transmit(message, (error) => (error == null ? resolve() : reject(error)));
                  } catch (value) {
                    reject(value);
                  }
                })
            );
          // The closed observation is awaited only after an entered command, never invented from EOF.
          await send({
            kind: 'launch',
            nonce,
            nativeRuntime: runtime,
            compatibleRuntime: compatible,
            runtimeInput,
            profileHome: input.campaignHome,
            manager: native.manager,
            artifact: native.journal.artifact,
            fixtureURL: `https://identity-alpha.test:${port}/baseline`,
            hostResolverRules:
              'MAP identity-alpha.test 127.0.0.1, MAP identity-beta.test 127.0.0.1',
            certificateSPKI,
            ...(mutant ? { mutant } : {}),
          });
          guard();
          const opened = await wait(['opened', 'failed']);
          guard();
          if (opened.kind === 'opened') {
            if (!opened.baselineOriginals?.length)
              throw new Error('CHROME_MATRIX_BASELINE_NATIVE_COHORT_UNOBSERVED');
            const observations = await own(() =>
              Promise.allSettled(
                opened.baselineOriginals!.map((original) =>
                  native.processes.observe(original, new AbortController().signal)
                )
              )
            );
            guard();
            for (const observation of observations) {
              if (observation.status === 'rejected') throw observation.reason;
              expect(observation.value.status).toBe('dead');
            }
          }

          let sample: z.infer<typeof ReplySchema> | undefined;
          if (opened.kind === 'opened') {
            await send({ kind: 'sample-matrix', nonce, sequence: ++sequence });
            guard();
            sample = await wait(['matrix-observation', 'failed']);
            guard();
          }
          if (!mutant) {
            if (
              opened.kind !== 'opened' ||
              !opened.baseline ||
              sample?.kind !== 'matrix-observation'
            )
              throw new Error('CHROME_MATRIX_ORIGINAL_SAMPLE_UNAVAILABLE');
            expect(
              qualifyFixtureOriginalMatrix(
                opened.baseline,
                sample.observations,
                owners.server.requests()
              ).status
            ).toBe('qualified');
            await send({ kind: 'close', nonce, sequence: ++sequence });
          } else if (sample?.kind === 'matrix-observation')
            throw new Error('CHROME_MATRIX_MISSING_ACK_MUTANT_QUALIFIED');
          const closed = await wait(['closed']);
          guard();
          expect(closed.originalChildReturned).toBe(true);
          expect(closed.descendantsReturned).toBe(true);
          expect(closed.profileRemoved).toBe(true);
          expect(closed.identityAcknowledgementWithheld).toBe(!!mutant);
          if (!mutant) expect(closed.state).toBe('closed');
          else expect(closed.state).toBe('held');
          await raw.terminal;
          await raw.pipes;
          guard();
          expect(worker.exitCode).toBe(mutant ? 1 : 0);
          expect(worker.signalCode).toBe(null);
          if (!closed.root) throw new Error('CHROME_MATRIX_ORIGINAL_ROOT_MISSING');
          if (closed.candidateCohortComplete !== true)
            throw new Error('CHROME_MATRIX_CANDIDATE_COHORT_INCOMPLETE');
          // Child cleanup booleans cannot establish native return. Retain the exact bounded
          // root/cohort before independently observing every birth after genuine terminal/pipes.
          const originals = candidateOriginals(closed.root, closed.candidateOriginals);
          await independentlyObserveCandidateReturns(
            closed.root,
            originals,
            (original) => native.processes.observe(original, new AbortController().signal),
            own
          );
          guard();
        }
        await checkEmits();
        guard();
      } finally {
        clearTimeout(campaignTimer);
      }
    });
    void owners.whole.catch(note);
    try {
      await owners.whole;
    } finally {
      await close();
    }
    expect(retained.size).toBe(0);
  },
  1050000
);
