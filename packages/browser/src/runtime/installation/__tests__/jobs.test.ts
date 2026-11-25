import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstallationJobs } from '../jobs.js';
import {
  INSTALLATION_LIMITS,
  INSTALLATION_TARGET,
  canonicalDigest,
  sha256,
  type AttemptBinding,
  type FileIdentity,
  type FileSnapshot,
  type InstallationConfiguration,
  type InstallationJobSink,
  type InstallerRequest,
  type JobBirth,
  type JobFacts,
  type JobIntent,
  type RawWriter,
  type VerifierRequest,
} from '../contracts.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

/** Semantic original-object fixture only. This never supplies native/download acceptance. */
class OriginalChild extends EventEmitter {
  readonly pid = 431;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable | null;
  readonly input: Buffer[] = [];
  readonly kill = vi.fn(() => true);
  constructor(pipeInput = false) {
    super();
    this.stdin = pipeInput
      ? new Writable({
          write: (chunk, _encoding, done) => {
            this.input.push(Buffer.from(chunk));
            done();
          },
        })
      : null;
  }
  launch(): void {
    queueMicrotask(() => this.emit('spawn'));
  }
  finish(code: number | null = 0, signal: string | null = null, out = 'installed', err = ''): void {
    let remaining = 2;
    const closed = (): void => {
      if (--remaining === 0) this.emit('close', code, signal);
    };
    this.stdout.once('close', closed);
    this.stderr.once('close', closed);
    this.emit('exit', code, signal);
    this.stdout.end(out);
    this.stderr.end(err);
  }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function file(path: string, bytes: string): Promise<FileSnapshot> {
  await writeFile(path, bytes);
  const s = await lstat(path, { bigint: true });
  const identity: FileIdentity = {
    device: String(s.dev),
    inode: String(s.ino),
    size: String(s.size),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
    uid: Number(s.uid),
    mode: Number(s.mode),
    type: 'file',
  };
  return { path, identity, bytes: Buffer.byteLength(bytes), sha256: sha256(Buffer.from(bytes)) };
}
async function directoryIdentity(path: string): Promise<FileIdentity> {
  const s = await lstat(path, { bigint: true });
  return {
    device: String(s.dev),
    inode: String(s.ino),
    size: String(s.size),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
    uid: Number(s.uid),
    mode: Number(s.mode),
    type: 'directory',
  };
}
function sinkFixture() {
  const order: string[] = [];
  const captured: { intent?: JobIntent; birth?: JobBirth; receipt?: JobFacts } = {};
  const stdout: RawWriter = {
    write: vi.fn(async () => {
      order.push('stdout-write');
    }),
    finish: vi.fn(async () => {
      order.push('stdout-finish');
    }),
  };
  const stderr: RawWriter = {
    write: vi.fn(async () => {
      order.push('stderr-write');
    }),
    finish: vi.fn(async () => {
      order.push('stderr-finish');
    }),
  };
  const sink: InstallationJobSink = {
    prepare: vi.fn(async (intent) => {
      order.push('intent');
      captured.intent = intent;
      return { stdout, stderr };
    }),
    birth: vi.fn(async (birth) => {
      order.push('birth');
      captured.birth = birth;
    }),
    receipt: vi.fn(async (receipt) => {
      order.push('receipt');
      captured.receipt = receipt;
    }),
  };
  return { sink, stdout, stderr, order, captured };
}

describe('installation original jobs (semantic controls, no native acceptance)', () => {
  let root: string;
  let config: InstallationConfiguration;
  let request: InstallerRequest;
  let clock: number;
  let platform: PropertyDescriptor;
  let arch: PropertyDescriptor;
  const binding: AttemptBinding = {
    transactionId: 'transaction',
    attemptId: 'attempt',
    nonce: 'nonce',
    generation: 1,
    installationId: 'installation',
  };
  beforeEach(async () => {
    spawnMock.mockReset();
    clock = 1_000;
    platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
    // These only select the branch in semantic tests; they are never production platform evidence.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    root = await mkdtemp(join(tmpdir(), 'installation-jobs-semantic-'));
    // Resolve macOS /var alias once, matching production's real absolute roots.
    const { realpath } = await import('node:fs/promises');
    root = await realpath(root);
    const libraryRoot = join(root, 'library');
    const cacheRoot = join(root, 'cache');
    const attemptRoot = join(cacheRoot, 'attempts', binding.attemptId);
    const candidateRoot = join(cacheRoot, 'candidates', binding.installationId);
    for (const path of [
      libraryRoot,
      join(attemptRoot, 'home'),
      join(attemptRoot, 'tmp'),
      join(attemptRoot, 'diagnostics'),
      join(candidateRoot, 'payload'),
    ])
      await mkdir(path, { recursive: true });
    const node = await file(join(root, 'node-original'), 'pinned node fixture bytes');
    const controller = await file(join(root, 'controller.mjs'), 'same vintage controller');
    const verifier = await file(join(root, 'verifier.mjs'), 'same vintage verifier');
    const source = await file(
      join(root, 'source.json'),
      JSON.stringify({
        schemaVersion: 1,
        controllerSHA256: controller.sha256,
        verifierSHA256: verifier.sha256,
      })
    );
    const cli = await file(join(libraryRoot, 'cli.js'), 'official CLI fixture bytes');
    const browsersManifest = await file(
      join(libraryRoot, 'browsers.json'),
      'pinned manifest fixture bytes'
    );
    config = {
      cacheRoot,
      libraryRoot,
      nodeExecutable: node.path,
      nodeExecutableSHA256: node.sha256,
      verifierEntry: verifier.path,
      controllerEntry: controller.path,
      sourceManifestPath: source.path,
      sourceVintage: {
        sourceManifestSHA256: source.sha256,
        controllerSHA256: controller.sha256,
        verifierSHA256: verifier.sha256,
      },
      platform: 'darwin',
      arch: 'arm64',
      workMilliseconds: 1_000,
      finalMilliseconds: 2_000,
    };
    request = {
      binding,
      bounds: { origin: 1_000, workEnd: 2_000, finalEnd: 3_000 },
      attempt: {
        kind: 'installation-attempt',
        binding,
        attemptRoot,
        homeRoot: join(attemptRoot, 'home'),
        temporaryRoot: join(attemptRoot, 'tmp'),
        identity: await directoryIdentity(attemptRoot),
      },
      candidate: {
        kind: 'installation-candidate',
        binding,
        candidateRoot,
        payloadRoot: join(candidateRoot, 'payload'),
        reuse: false,
      },
      library: {
        distributionSHA256: INSTALLATION_TARGET.libraryDistributionSHA256,
        files: [cli, browsersManifest],
        cli,
        browsersManifest,
      },
      sink: sinkFixture().sink,
    };
  });
  afterEach(async () => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
    await rm(root, { recursive: true, force: true });
  });
  const jobs = () => createInstallationJobs(config, { ownerKind: 'controller', now: () => clock });
  function installChild(child: OriginalChild, body: () => void): void {
    spawnMock.mockImplementation(() => {
      child.launch();
      queueMicrotask(body);
      return child as unknown as ChildProcess;
    });
  }
  async function verifierRequest(sink: InstallationJobSink): Promise<VerifierRequest> {
    return {
      ...request,
      sink,
      request: {
        schemaVersion: 1,
        binding,
        bounds: request.bounds,
        cacheRoot: config.cacheRoot,
        candidateRoot: request.candidate.candidateRoot,
        libraryRoot: config.libraryRoot,
        attemptRoot: request.attempt.attemptRoot,
        attemptIdentity: request.attempt.identity,
        nodeExecutable: config.nodeExecutable,
        nodeExecutableSHA256: config.nodeExecutableSHA256,
        controllerEntry: config.controllerEntry,
        verifierEntry: config.verifierEntry,
        sourceManifestPath: config.sourceManifestPath,
        sourceVintage: config.sourceVintage,
        executablePath: INSTALLATION_TARGET.executablePath,
        executableSHA256: 'a'.repeat(64),
        executableIdentity: request.library.cli.identity,
        libraryDistributionSHA256: request.library.distributionSHA256,
        expectedVersion: INSTALLATION_TARGET.observedVersion,
        chromiumRevision: INSTALLATION_TARGET.chromiumRevision,
        platform: 'darwin',
        arch: 'arm64',
      },
    };
  }

  it('runs the exact official argv with closed environment, intent before spawn and original settlement', async () => {
    const s = sinkFixture();
    const child = new OriginalChild();
    spawnMock.mockImplementation((_command: string, _argv: string[], _options: SpawnOptions) => {
      expect(s.order).toEqual(['intent']);
      child.launch();
      queueMicrotask(() => child.finish());
      return child as unknown as ChildProcess;
    });
    const producer = jobs();
    const run = await producer.runInstaller({ ...request, sink: s.sink });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, argv, spawnOptions] = spawnMock.mock.calls[0];
    expect(command).toBe(config.nodeExecutable);
    expect(argv).toEqual([
      request.library.cli.path,
      'install',
      'chromium',
      '--no-shell',
      '--no-remove',
    ]);
    expect(spawnOptions).toMatchObject({
      shell: false,
      detached: false,
      cwd: request.attempt.attemptRoot,
    });
    expect(Object.keys(spawnOptions.env).sort()).toEqual(
      [
        'HOME',
        'LANG',
        'LC_ALL',
        'NODE_DISABLE_COMPILE_CACHE',
        'PATH',
        'PLAYWRIGHT_BROWSERS_PATH',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
      ].sort()
    );
    expect(spawnOptions.env.PLAYWRIGHT_BROWSERS_PATH).toBe(request.candidate.payloadRoot);
    expect(run.facts.birth?.environmentDigest).toBe(canonicalDigest(spawnOptions.env));
    expect(producer.requireReturned(run.handle)).toEqual(run.facts);
    expect(run.facts.descendantDisposition).toBe('trusted-installer-return');
    expect(run.facts.stdout).toMatchObject({ eof: true, closed: true, rawFlushedClosed: true });
    expect(s.order.indexOf('receipt')).toBeGreaterThan(s.order.indexOf('stdout-finish'));
    expect(s.order.indexOf('receipt')).toBeGreaterThan(s.order.indexOf('stderr-finish'));
    expect(producer.custody()).toEqual({ pending: 0, firstCause: null });
    expect(() => producer.requireReturned({ ...run.handle })).toThrow('CUSTODY_UNCERTAIN');
    expect(() => jobs().requireReturned(run.handle)).toThrow('CUSTODY_UNCERTAIN');
    await expect(producer.runInstaller(request)).rejects.toThrow('CUSTODY_UNCERTAIN');
  });

  it('a pending original excludes a second role without a second spawn', async () => {
    const born = deferred<void>();
    const s = sinkFixture();
    s.sink.birth = vi.fn(async () => {
      born.resolve();
    });
    const child = new OriginalChild();
    spawnMock.mockImplementation(() => {
      child.launch();
      return child as unknown as ChildProcess;
    });
    const producer = jobs();
    const pending = producer.runInstaller({ ...request, sink: s.sink });
    await born.promise;
    await expect(producer.runVerifier(await verifierRequest(sinkFixture().sink))).rejects.toThrow(
      'CUSTODY_UNCERTAIN'
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.finish();
    await pending;
  });

  it('retains overflow, drains through EOF and caps memory/raw writes rather than truncating success', async () => {
    const s = sinkFixture();
    const child = new OriginalChild();
    installChild(child, () =>
      child.finish(0, null, 'x'.repeat(INSTALLATION_LIMITS.streamBytes + 17))
    );
    const producer = jobs();
    const run = await producer.runInstaller({ ...request, sink: s.sink });
    expect(run.stdout.byteLength).toBe(INSTALLATION_LIMITS.streamBytes);
    expect(run.facts.stdout).toMatchObject({
      observedBytes: INSTALLATION_LIMITS.streamBytes + 17,
      retainedBytes: INSTALLATION_LIMITS.streamBytes,
      overflow: true,
      eof: true,
      closed: true,
      rawFlushedClosed: true,
    });
    expect(run.facts.firstCause).toBe('RETENTION_EXCEEDED');
    expect(() => producer.requireReturned(run.handle)).toThrow('RETENTION_EXCEEDED');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('requests stop once on abort, awaits actual original return and preserves unknown disposition', async () => {
    const s = sinkFixture();
    const born = deferred<void>();
    const controller = new AbortController();
    s.sink.birth = vi.fn(async () => {
      born.resolve();
    });
    const child = new OriginalChild();
    spawnMock.mockImplementation(() => {
      child.launch();
      return child as unknown as ChildProcess;
    });
    const producer = jobs();
    const pending = producer.runInstaller({ ...request, sink: s.sink, signal: controller.signal });
    await born.promise;
    controller.abort();
    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(producer.custody().pending).toBe(1);
    // A stop request itself does not manufacture exit/close/EOF or release the slot.
    child.finish(null, 'SIGTERM', '', 'stopped');
    const run = await pending;
    expect(run.facts.stopRequested).toBe(true);
    expect(run.facts.firstCause).toBe('ABORTED');
    expect(run.facts.descendantDisposition).toBe('unknown');
    expect(() => producer.requireReturned(run.handle)).toThrow('ABORTED');
  });

  it('pin or binding mismatch refuses before prepare/spawn', async () => {
    const s = sinkFixture();
    await writeFile(request.library.cli.path, 'changed source');
    const run = await jobs().runInstaller({ ...request, sink: s.sink });
    expect(run.facts.firstCause).toBe('HASH_MISMATCH');
    expect(s.sink.prepare).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    const foreign = await jobs().runInstaller({
      ...request,
      sink: s.sink,
      attempt: { ...request.attempt, binding: { ...binding, nonce: 'foreign' } },
    });
    expect(foreign.facts.firstCause).toBe('BINDING_MISMATCH');
  });

  it('installer nonzero exit is not trusted return and cannot be retried', async () => {
    const child = new OriginalChild();
    installChild(child, () => child.finish(1));
    const producer = jobs();
    const run = await producer.runInstaller(request);
    expect(run.facts.firstCause).toBe('INSTALLER_FAILED');
    expect(run.facts.descendantDisposition).toBe('unknown');
    await expect(producer.runVerifier(await verifierRequest(request.sink))).rejects.toThrow(
      'INSTALLER_FAILED'
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('work end requests only the retained original once; final end never fabricates settlement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = sinkFixture();
    const born = deferred<void>();
    s.sink.birth = vi.fn(async () => {
      born.resolve();
    });
    const child = new OriginalChild();
    spawnMock.mockImplementation(() => {
      child.launch();
      return child as unknown as ChildProcess;
    });
    const producer = jobs();
    const pending = producer.runInstaller({ ...request, sink: s.sink });
    await born.promise;
    clock = 2_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(producer.custody().pending).toBe(1);
    clock = 3_001;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(producer.custody().pending).toBe(1);
    child.finish(0);
    const run = await pending;
    expect(run.facts.firstCause).toBe('WORK_EXPIRED');
    expect(run.facts.descendantDisposition).toBe('unknown');
  });

  it('failed original stop stays uncertain and is not retried after abort', async () => {
    const born = deferred<void>();
    const s = sinkFixture();
    const controller = new AbortController();
    s.sink.birth = vi.fn(async () => {
      born.resolve();
    });
    const child = new OriginalChild();
    child.kill.mockReturnValue(false);
    spawnMock.mockImplementation(() => {
      child.launch();
      return child as unknown as ChildProcess;
    });
    const producer = jobs();
    const pending = producer.runInstaller({ ...request, sink: s.sink, signal: controller.signal });
    await born.promise;
    controller.abort();
    expect(producer.custody().pending).toBe(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.finish(0);
    const run = await pending;
    expect(run.facts.firstCause).toBe('ABORTED');
    expect(run.facts.cleanupCauses).toContain('CUSTODY_UNCERTAIN');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(run.facts.descendantDisposition).toBe('unknown');
  });
});
