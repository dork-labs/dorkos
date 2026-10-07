import { grantOriginalSignedDesktopQualification } from './signed-desktop/qualification.js';
import { retainOriginalPackagedAppTerminal } from './signed-desktop/app-terminal.js';
import { _electron, expect, type ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createDarwinEngineProcesses } from '../../../packages/browser/src/runtime/darwin-engine-processes.js';
import { validateJournalSnapshot } from '../../../packages/browser/src/lifecycle/process-journal.js';
import type { ProcessIdentity } from '../../../packages/browser/src/configuration.js';
import {
  absoluteElectronPage,
  exercisePackagedManagedBrowser,
} from './packaged-managed-browser-actor';
import { ownPackagedManagedReceiver } from './packaged-managed-browser-receiver';
import {
  originalTool,
  sha,
  signedBundleTree,
  verifySignedDesktop,
  SignedDesktopAcceptanceSchema,
  type SignedDesktopAcceptance,
} from './signed-desktop/verification';
export {
  parseSignedDesktopArtifact,
  signedBundleTree,
  verifySignedDesktop,
  SignedDesktopAcceptanceSchema,
  type Artifact,
  type SignedDesktopAcceptance,
} from './signed-desktop/verification';

/** Genuine signed A -> signed B -> signed A rollback. No substitute CLI server, trust or auth override. */
export async function runSignedPackagedManagedBrowser(
  config: SignedDesktopAcceptance,
  signal: AbortSignal
): Promise<void> {
  config = SignedDesktopAcceptanceSchema.parse(config);
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('SIGNED_DESKTOP_PLATFORM_UNAVAILABLE');
  if (!config.first.qualificationSubject || !config.upgrade.qualificationSubject)
    throw new Error('SIGNED_DESKTOP_QUALIFICATION_SUBJECT_REQUIRED');
  if (config.first.treeSHA256 === config.upgrade.treeSHA256)
    throw new Error('TWO_SIGNED_VINTAGES_REQUIRED');
  await mkdir(config.artifacts, { recursive: false, mode: 0o700 });
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dorkos-signed-managed-desktop-')));
  await mkdir(join(home, '.dork'), { mode: 0o700 });
  const repo = join(home, 'fixture-project');
  await mkdir(repo, { mode: 0o700 });
  // Only supported environment inputs; no inherited account/key/application configuration.
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: tmpdir(),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT: '1',
    DORKOS_PRIVATE_DESKTOP_QUALIFICATION: '1',
    DORKOS_DEFAULT_CWD: repo,
    DORKOS_BOUNDARY: home,
  };
  await originalTool('/usr/bin/git', ['init', repo], env, signal);
  await writeFile(join(repo, 'README.md'), 'Disposable signed desktop browser acceptance.\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await originalTool('/usr/bin/git', ['-C', repo, 'add', 'README.md'], env, signal);
  await originalTool(
    '/usr/bin/git',
    [
      '-C',
      repo,
      '-c',
      'user.name=Acceptance',
      '-c',
      'user.email=acceptance@example.invalid',
      'commit',
      '-m',
      'Disposable fixture',
    ],
    env,
    signal
  );
  const email = `desktop-${randomUUID()}@example.invalid`,
    password = randomUUID() + randomUUID();
  let first: { value: unknown } | undefined;
  const receipts: unknown[] = [];
  const sharedReceiver = await ownPackagedManagedReceiver();
  const cacheDigests = new Map<string, string>();
  const priorJournals = new Set<string>();
  try {
    for (const [index, artifact] of [config.first, config.upgrade, config.first].entries()) {
      if (first) break;
      signal.throwIfAborted();
      const parentSignal = signal;
      const lifetime = new AbortController();
      const expire = setTimeout(
        () => lifetime.abort(new Error('SIGNED_DESKTOP_ORIGINAL_180S_EXPIRED')),
        180_000
      );
      const forward = () => lifetime.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', forward, { once: true });
      if (parentSignal.aborted) forward();
      signal = AbortSignal.any([parentSignal, lifetime.signal]);
      const leg = join(config.artifacts, String(index));
      try {
        await mkdir(leg, { mode: 0o700 });
        const verified = await verifySignedDesktop(artifact, env, signal);
        const observer = createDarwinEngineProcesses({
          path: verified.native,
          sha256: artifact.observerSHA256,
        });
        let app: ElectronApplication | undefined;
        let receiver: Awaited<ReturnType<typeof ownPackagedManagedReceiver>> | undefined;
        let terminal: ReturnType<typeof retainOriginalPackagedAppTerminal> | undefined;
        let appCloseFacts: Awaited<ReturnType<NonNullable<typeof terminal>['join']>> | undefined;
        let appReturn: { exitCode: number | null; signalCode: string | null } | undefined;
        const originalPipes: Promise<void>[] = [];
        let ownerPage: ReturnType<typeof absoluteElectronPage> | undefined;
        let origin: string | undefined;
        const births = new Map<string, ProcessIdentity>();
        const retain = (identity: ProcessIdentity) => {
          if (
            !Number.isSafeInteger(identity.pid) ||
            identity.pid <= 0 ||
            !identity.birth.startsWith('darwin-bsd-start:') ||
            births.size >= 1024
          )
            throw new Error('ORIGINAL_DESKTOP_BIRTH_REQUIRED');
          births.set(identity.pid + ':' + identity.birth, identity);
        };
        const recordFailure = (value: unknown) => {
          first ??= { value };
        };
        let appRoot: ProcessIdentity | undefined;
        let managerPids: number[] = [];
        const originalJournals: unknown[] = [];
        const retainOriginalProcesses = async () => {
          if (!app || !appRoot) throw new Error('ORIGINAL_APP_REQUIRED');
          const tree = await observer.processes.descendants(appRoot, new AbortController().signal);
          if (tree.status !== 'complete') throw new Error('DESKTOP_CHILD_COHORT_UNKNOWN');
          for (const original of tree.identities) retain(original);
          const originalHome = await app.evaluate(({ app }) => app.getPath('home'));
          const userData = await app.evaluate(({ app }) => app.getPath('userData'));
          const userDataRelative = relative(home, await realpath(userData));
          if (userDataRelative.startsWith('..') || isAbsolute(userDataRelative))
            throw new Error('DESKTOP_USER_DATA_NOT_ISOLATED');
          if ((await realpath(originalHome)) !== home) throw new Error('DESKTOP_HOME_NOT_ISOLATED');
          managerPids = await app.evaluate(({ app }) =>
            app
              .getAppMetrics()
              .filter((metric) => metric.type === 'Utility')
              .map((metric) => metric.pid)
          );
          if (
            !managerPids.length ||
            managerPids.some((pid) => !tree.identities.some((identity) => identity.pid === pid))
          )
            throw new Error('PACKAGED_SERVER_UTILITY_NOT_OWNED');
        };
        const scan = async (dir: string): Promise<void> => {
          let entries;
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch (value) {
            if ((value as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw value;
          }
          for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isSymbolicLink()) throw new Error('DESKTOP_DATA_LINK_UNQUALIFIED');
            if (entry.isDirectory()) await scan(path);
            else if (
              entry.name === 'snapshot.json' &&
              dir.split('/').at(-1)?.startsWith('journal-')
            ) {
              const fd = await open(path, 'r');
              let bytes: Buffer;
              try {
                const before = await fd.stat();
                if (!before.isFile() || before.size > 1024 * 1024 || originalJournals.length >= 128)
                  throw new Error('DESKTOP_JOURNAL_BOUND');
                bytes = await fd.readFile();
                const after = await fd.stat();
                if (
                  bytes.length !== before.size ||
                  before.dev !== after.dev ||
                  before.ino !== after.ino ||
                  before.size !== after.size ||
                  before.mtimeMs !== after.mtimeMs
                )
                  throw new Error('DESKTOP_JOURNAL_CHANGED');
              } finally {
                await fd.close();
              }
              const snapshot = validateJournalSnapshot(JSON.parse(bytes.toString('utf8')));
              if (priorJournals.has(snapshot.binding.journalId)) continue;
              if (!managerPids.includes(snapshot.binding.manager.pid))
                throw new Error('JOURNAL_NOT_PACKAGED_SERVER_ACTOR');
              for (const original of snapshot.retainedIdentities) retain(original.identity);
              originalJournals.push({ path: relative(home, path), sha256: sha(bytes), snapshot });
              await writeFile(join(leg, 'journal-' + snapshot.binding.journalId + '.json'), bytes, {
                flag: 'wx',
                mode: 0o600,
              });
              expect(snapshot.phase).toBe('observation-ended');
              expect(snapshot.gaps).toEqual([]);
              expect(snapshot.firstCause).toBeNull();
            }
          }
        };
        let closing: Promise<void> | undefined;
        const close = () => {
          if (closing) return closing;
          closing = Promise.resolve().then(async () => {
            if (app) await app.close();
          });
          void closing.catch(recordFailure);
          return closing;
        };
        const abort = () => {
          recordFailure(signal.reason);
          try {
            const child = app?.process();
            if (child && child.exitCode === null && child.signalCode === null)
              child.kill('SIGTERM');
          } catch (value) {
            recordFailure(value);
          }
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          app = await _electron.launch({
            executablePath: verified.executable,
            cwd: repo,
            env: env as Record<string, string>,
            artifactsDir: leg,
            timeout: 120_000,
          });
          const originalChild = app.process();
          terminal = retainOriginalPackagedAppTerminal(originalChild);
          originalChild.once('error', recordFailure);
          for (const pipe of [originalChild.stdout, originalChild.stderr]) {
            if (!pipe) {
              recordFailure(new Error('ORIGINAL_APP_PIPE_REQUIRED'));
              continue;
            }
            pipe.once('error', recordFailure);
            let ended = pipe.readableEnded;
            pipe.once('end', () => {
              ended = true;
            });
            const closed = () => {
              if (!ended && !pipe.readableEnded)
                recordFailure(new Error('ORIGINAL_APP_PIPE_EOF_UNVERIFIED'));
            };
            if (pipe.closed) {
              closed();
              originalPipes.push(Promise.resolve());
            } else
              originalPipes.push(
                new Promise<void>((yes) =>
                  pipe.once('close', () => {
                    closed();
                    yes();
                  })
                )
              );
          }
          if (!terminal.enteredLive) throw new Error('ORIGINAL_APP_LAUNCH_RETURN_NOT_LIVE');
          const observedRoot = await observer.identity(originalChild.pid!);
          if (!observedRoot) throw new Error('ORIGINAL_APP_BIRTH_REQUIRED');
          appRoot = observedRoot;
          retain(appRoot);
          if (signal.aborted) abort();
          signal.throwIfAborted();
          await grantOriginalSignedDesktopQualification(originalChild, verified, home, signal);
          signal.throwIfAborted();
          const rawPage = await app.firstWindow({ timeout: 120_000 });
          signal.throwIfAborted();
          await expect
            .poll(() => rawPage.url(), { timeout: 120_000 })
            .toMatch(/^http:\/\/localhost:\d+\//);
          signal.throwIfAborted();
          const appOrigin = new URL(rawPage.url());
          appOrigin.pathname = '/';
          appOrigin.search = '';
          appOrigin.hash = '';
          const page = absoluteElectronPage(rawPage, appOrigin.origin);
          ownerPage = page;
          origin = appOrigin.origin;
          signal.throwIfAborted();
          await page.goto('/');
          // These are actual packaged-server auth requests; no cookie fabrication or disabling login.
          signal.throwIfAborted();
          const auth = await page.request.post(
            index === 0 ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email',
            {
              data: {
                email,
                password,
                ...(index === 0 ? { name: 'Disposable desktop owner' } : {}),
              },
              headers: { Origin: appOrigin.origin },
            }
          );
          expect(auth.status()).toBe(200);
          signal.throwIfAborted();
          const session = await page.request.get('/api/auth/get-session');
          expect(session.status()).toBe(200);
          expect((await session.json()).user.email).toBe(email);
          await retainOriginalProcesses();
          const workspaceInput = {
            projectKey: 'signed-desktop-fixture',
            key: 'acceptance',
            source: repo,
            provider: 'clone',
          };
          signal.throwIfAborted();
          let workspace = await page.request.post('/api/workspaces', {
            data: workspaceInput,
            headers: { Origin: appOrigin.origin },
          });
          if (workspace.status() === 409) {
            const review = await workspace.json();
            if (typeof review.workspace?.reviewHash !== 'string')
              throw new Error('ACTUAL_WORKSPACE_REVIEW_REQUIRED');
            signal.throwIfAborted();
            workspace = await page.request.post('/api/workspaces', {
              data: { ...workspaceInput, approvedReviewHash: review.workspace.reviewHash },
              headers: { Origin: appOrigin.origin },
            });
          }
          expect(workspace.status()).toBe(201);
          const observationStart = sharedReceiver.observations.length,
            visitStart = sharedReceiver.visits.length;
          receiver = Object.freeze({
            url: sharedReceiver.url,
            get observations() {
              return sharedReceiver.observations.slice(observationStart);
            },
            get visits() {
              return sharedReceiver.visits.slice(visitStart);
            },
            close: sharedReceiver.close,
          });
          signal.throwIfAborted();
          await exercisePackagedManagedBrowser(page, receiver, {
            testId: 'signed-desktop',
            checkAdmission: () => signal.throwIfAborted(),
            reuseSaved: index > 0,
            initialSavedCookie: index > 0,
            outputPath: (name) => join(leg, name),
            attach: (name, value) =>
              writeFile(join(leg, name + '.json'), value.body, { flag: 'wx', mode: 0o600 }),
            retainOriginalProcesses,
          });
          await retainOriginalProcesses();
          expect(await signedBundleTree(artifact.appPath)).toBe(artifact.treeSHA256);
          const runtime = join(home, '.dork/browser/runtime/playwright-1.63.0');
          const caches = await readdir(runtime, { withFileTypes: true });
          expect(caches.length).toBeGreaterThan(0);
          for (const cache of caches) {
            if (!cache.isDirectory() || !/^[a-f0-9]{64}$/.test(cache.name))
              throw new Error('DESKTOP_CACHE_VINTAGE_UNQUALIFIED');
            const path = join(runtime, cache.name),
              actual = await signedBundleTree(await realpath(path));
            const previous = cacheDigests.get(path);
            if (previous !== undefined && previous !== actual)
              throw new Error('PRIOR_DESKTOP_CACHE_CHANGED');
            cacheDigests.set(path, actual);
          }
          for (const [path, original] of cacheDigests)
            expect(await signedBundleTree(path)).toBe(original);
        } catch (value) {
          recordFailure(value);
        } finally {
          // All independent closes enter, even after a false/undefined primary or app close refusal.
          if (ownerPage && origin) {
            try {
              const off = await ownerPage.request.post('/api/browser/runtime/enable', {
                data: { enabled: false },
                headers: { Origin: origin },
                timeout: 30_000,
              });
              expect(off.status()).toBe(200);
              expect(await off.json()).toMatchObject({ state: 'disabled', enabled: false });
            } catch (value) {
              recordFailure(value);
            }
          }
          try {
            if (appRoot && app) await retainOriginalProcesses();
            await scan(join(home, '.dork/browser/journals'));
            expect(originalJournals.length).toBeGreaterThan(0);
            for (const value of originalJournals)
              priorJournals.add(
                (value as { snapshot: { binding: { journalId: string } } }).snapshot.binding
                  .journalId
              );
            expect(
              originalJournals.some(
                (value) =>
                  (value as { snapshot: { root: { kind: string } } }).snapshot.root.kind ===
                  'attributed'
              )
            ).toBe(true);
          } catch (value) {
            recordFailure(value);
          }
          const tasks = [close()];
          for (const task of tasks) void task.catch(recordFailure);
          await Promise.allSettled(tasks);
          await Promise.allSettled(originalPipes);
          if (terminal) {
            try {
              appCloseFacts = await terminal.join();
              appReturn = appCloseFacts.returned ?? undefined;
              if (appCloseFacts.close !== 'observed')
                recordFailure(new Error('ORIGINAL_APP_CLOSE_UNAVAILABLE'));
            } catch (value) {
              recordFailure(value);
            }
          }
          if (!appReturn || appReturn.exitCode !== 0 || appReturn.signalCode !== null)
            recordFailure(new Error('ORIGINAL_APP_RETURN_REFUSED'));
          signal.removeEventListener('abort', abort);
          const observed = [];
          for (const birth of births.values()) {
            const outcome = await observer.processes.observe(birth, new AbortController().signal);
            observed.push({ identity: birth, status: outcome.status });
            if (outcome.status !== 'dead')
              recordFailure(new Error('DESKTOP_ORIGINAL_DEATH_UNVERIFIED'));
          }
          receipts.push({
            index,
            version: artifact.version,
            treeSHA256: artifact.treeSHA256,
            signature: verified,
            home,
            root: appRoot,
            appReturn,
            originalAppClose: appCloseFacts ?? {
              close: 'unavailable',
              returned: null,
              pending: true,
            },
            originalPipesJoined: !first,
            originalJournals,
            knownBirths: [...births.values()],
            observed,
            failed: !!first,
          });
          await writeFile(join(leg, 'RESULT.json'), JSON.stringify(receipts.at(-1), null, 2), {
            flag: 'wx',
            mode: 0o600,
          }).catch(recordFailure);
        }
      } catch (value) {
        first ??= { value };
      } finally {
        if (signal.aborted) first ??= { value: signal.reason };
        clearTimeout(expire);
        parentSignal.removeEventListener('abort', forward);
        signal = parentSignal;
      }
    }
  } finally {
    try {
      await sharedReceiver.close();
    } catch (value) {
      first ??= { value };
    }
  }
  await writeFile(
    join(config.artifacts, 'RESULT.json'),
    JSON.stringify({ home, vintages: receipts, passed: !first }, null, 2),
    { flag: 'wx', mode: 0o600 }
  ).catch((value) => {
    first ??= { value };
  });
  if (first) throw first.value;
  expect(receipts).toHaveLength(3);
}
