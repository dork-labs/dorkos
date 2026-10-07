import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalDigest,
  INSTALLATION_LIMITS,
  INSTALLATION_TARGET,
  recordBytes,
  sha256,
  type AttemptBinding,
  type AttemptBounds,
  type CandidateSnapshot,
  type InstallationConfiguration,
  type JobFacts,
  type JobIntent,
  type Manifest,
  type VerificationRecord,
} from '../contracts.js';
import { createInstallationFilesystem } from '../filesystem.js';
import { createRuntimeStatus } from '../status.js';

// Real fs originals remain underneath these narrow fault adapters. This suite never
// launches Chromium or manufactures J's authentic process-return registry.
const control = vi.hoisted(() => ({
  syncPath: '',
  closePath: '',
  postRenameSyncPath: '',
  renamed: false,
  syncFaultFired: false,
  closeOnlyAfterSync: false,
  rejectAfterCurrentRename: false,
  replaceDuringReadPath: '',
  readReplacementMade: false,
  closeCalls: [] as string[],
  cleanup: [] as (() => Promise<void>)[],
  reads: [] as { path: string; handleId: number; buffer: NodeJS.ArrayBufferView; bytes: number }[],
  holdReadPath: '',
  holdReadPrefix: '',
  releaseFault: undefined as Promise<void> | undefined,
  faultReadArrived: false,
  rootMutationLstatPath: '',
  rootMutationEntry: '',
  rootMutationAfterFile: '',
  rootMutationMade: false,
  heldReadHandles: new Set<number>(),
  releaseReads: undefined as Promise<void> | undefined,
  readFailurePath: '',
  readFailure: undefined as Readonly<{ value: unknown }> | undefined,
  closeFailurePath: '',
  closeFailure: undefined as Readonly<{ value: unknown }> | undefined,
  opened: [] as { handleId: number; path: string; flags: Parameters<typeof fs.open>[1] }[],
  closeAttempts: [] as { handleId: number; path: string }[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      if (
        String(args[0]) === control.rootMutationLstatPath &&
        !control.rootMutationMade &&
        control.closeAttempts.some((value) => value.path === control.rootMutationAfterFile)
      ) {
        control.rootMutationMade = true;
        // Real root entry mutation after the captured descendant stat returns.
        await actual.writeFile(control.rootMutationEntry, 'late-entry', { mode: 0o600 });
      }
      return stat;
    }) as typeof actual.lstat,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args),
        name = String(args[0]);
      const handleId = control.opened.length + 1;
      control.opened.push({ handleId, path: name, flags: args[1] });
      const sync = handle.sync.bind(handle),
        close = handle.close.bind(handle);
      let closed = false;
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: [NodeJS.ArrayBufferView, number, number, number]) => {
        const result = await read(...readArgs);
        control.reads.push({ path: name, handleId, buffer: readArgs[0], bytes: result.bytesRead });
        if (
          (name === control.holdReadPath ||
            (!!control.holdReadPrefix && name.startsWith(control.holdReadPrefix))) &&
          result.bytesRead > 0 &&
          !control.heldReadHandles.has(handleId)
        ) {
          control.heldReadHandles.add(handleId);
          await control.releaseReads;
        }
        if (name === control.readFailurePath && control.readFailure) {
          control.faultReadArrived = true;
          await control.releaseFault;
          throw control.readFailure.value;
        }
        if (
          name === control.replaceDuringReadPath &&
          !control.readReplacementMade &&
          result.bytesRead > 0
        ) {
          control.faultReadArrived = true;
          await control.releaseFault;
          control.readReplacementMade = true;
          await actual.rename(name, name + '.old-read');
          await actual.copyFile(name + '.old-read', name);
        }
        return result;
      }) as unknown as typeof handle.read;
      control.cleanup.push(async () => {
        if (!closed) {
          await close();
          closed = true;
        }
      });
      handle.sync = async () => {
        if (name === control.syncPath || (control.renamed && name === control.postRenameSyncPath)) {
          control.syncFaultFired = true;
          throw Object.assign(new Error('injected sync'), { code: 'EIO' });
        }
        await sync();
      };
      handle.close = async () => {
        control.closeAttempts.push({ handleId, path: name });
        control.closeCalls.push(name);
        await close();
        closed = true;
        if (name === control.closeFailurePath && control.closeFailure)
          throw control.closeFailure.value;
        if (name === control.closePath && (!control.closeOnlyAfterSync || control.syncFaultFired))
          throw Object.assign(new Error('injected close ambiguity'), { code: 'EIO' });
      };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (path.basename(String(args[1])) === 'current.json') {
        control.renamed = true;
        if (control.rejectAfterCurrentRename)
          throw Object.assign(new Error('ambiguous rename response'), { code: 'EIO' });
      }
    },
  };
});

let root: string;
const binding = (suffix = 'one'): AttemptBinding => ({
  transactionId: `transaction_${suffix}`,
  attemptId: `attempt_${suffix}`,
  nonce: `nonce_${suffix}`,
  generation: 1,
  installationId: `installation_${suffix}`,
});
function bounds(): AttemptBounds {
  const origin = Number(process.hrtime.bigint() / 1_000_000n);
  return { origin, workEnd: origin + 60_000, finalEnd: origin + 90_000 };
}
function config(): InstallationConfiguration {
  return {
    cacheRoot: path.join(root, 'cache'),
    libraryRoot: path.join(root, 'library'),
    nodeExecutable: path.join(root, 'node'),
    nodeExecutableSHA256: 'a'.repeat(64),
    controllerEntry: path.join(root, 'controller.js'),
    verifierEntry: path.join(root, 'verifier.js'),
    sourceManifestPath: path.join(root, 'source-manifest.json'),
    sourceVintage: {
      controllerSHA256: 'b'.repeat(64),
      verifierSHA256: 'c'.repeat(64),
      sourceManifestSHA256: 'd'.repeat(64),
    },
    platform: 'darwin',
    arch: 'arm64',
    workMilliseconds: 60_000,
    finalMilliseconds: 90_000,
  };
}
async function staged(
  suffix = 'one',
  executableRelativePath: string = INSTALLATION_TARGET.executablePath,
  producerFactory = createInstallationFilesystem,
  configuration = config()
) {
  const producer = producerFactory(configuration),
    b = binding(suffix),
    end = bounds();
  const reservation = await producer.acquireReservation(b, end),
    attempt = await producer.createAttempt(reservation);
  const candidate = await producer.stageCandidate(reservation, attempt);
  const executable = path.join(candidate.candidateRoot, executableRelativePath);
  await fs.mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
  // Minimal architecture-shaped bytes exercise filesystem observation, not a runnable browser.
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(16777228, 4);
  await fs.writeFile(executable, header, { mode: 0o700 });
  return { configuration, producer, b, end, reservation, attempt, candidate, executable };
}
const stream = (bytes: number) => ({
  observedBytes: bytes,
  retainedBytes: bytes,
  overflow: false,
  eof: true,
  closed: true,
  rawFlushedClosed: true,
});
async function diagnostics(
  fixture: Awaited<ReturnType<typeof staged>>,
  snapshot: CandidateSnapshot,
  beforeReceipt?: (role: JobIntent['role'], raw: string) => Promise<void>
) {
  const { producer, b, end, reservation, attempt, configuration } = fixture;
  const sink = producer.createJobSink(reservation, attempt);
  const reply = {
    schemaVersion: 1 as const,
    binding: b,
    executableSHA256: snapshot.executable.sha256,
    executableIdentity: snapshot.executable.identity,
    libraryDistributionSHA256: INSTALLATION_TARGET.libraryDistributionSHA256,
    sourceManifestSHA256: configuration.sourceVintage.sourceManifestSHA256,
    observedVersion: INSTALLATION_TARGET.observedVersion,
    chromiumRevision: INSTALLATION_TARGET.chromiumRevision,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    machOCPU: 16777228 as const,
    probeReceiptDigest: 'e'.repeat(64),
  };
  const replyBytes = recordBytes(reply, INSTALLATION_LIMITS.replyBytes);
  const finish = async (role: JobIntent['role'], bytes: Uint8Array) => {
    const intent: JobIntent = {
      schemaVersion: 1,
      role,
      jobId: role === 'official-install' ? 'installer' : 'verifier',
      binding: b,
      bounds: end,
      executable: configuration.nodeExecutable,
      argv: [
        role === 'official-install'
          ? path.join(configuration.libraryRoot, 'cli.js')
          : configuration.verifierEntry,
      ],
      cwd: attempt.attemptRoot,
      environmentDigest: 'f'.repeat(64),
    };
    const output = await sink.prepare(intent),
      birth = { ...intent, pid: 12345 };
    await sink.birth(birth);
    await output.stdout.write(bytes);
    await output.stdout.finish();
    await output.stderr.finish();
    if (beforeReceipt)
      await beforeReceipt(
        role,
        path.join(attempt.attemptRoot, 'diagnostics', intent.jobId + '.stdout.raw')
      );
    const facts: JobFacts = {
      schemaVersion: 1,
      jobId: intent.jobId,
      role,
      binding: b,
      birth,
      exitCode: 0,
      signal: null,
      exitObserved: true,
      closeObserved: true,
      stdout: stream(bytes.length),
      stderr: stream(0),
      stopRequested: false,
      firstCause: null,
      cleanupCauses: [],
      descendantDisposition:
        role === 'official-install' ? 'trusted-installer-return' : 'not-applicable',
    };
    await sink.receipt(facts);
    return facts;
  };
  const installer = await finish('official-install', new Uint8Array()),
    verifier = await finish('fresh-verifier', replyBytes);
  const verification: VerificationRecord = {
    schemaVersion: 1,
    canonicalFormat: 'installation-canonical-v1',
    binding: b,
    installer: {
      kind: 'invoked',
      jobId: installer.jobId,
      receiptDigest: canonicalDigest(installer),
    },
    verifier: {
      jobId: verifier.jobId,
      receiptDigest: canonicalDigest(verifier),
      replyDigest: sha256(replyBytes),
    },
    reply,
    candidateInventoryDigest: snapshot.inventoryDigest,
    libraryDistributionSHA256: INSTALLATION_TARGET.libraryDistributionSHA256,
    sourceManifestSHA256: configuration.sourceVintage.sourceManifestSHA256,
  };
  const manifest: Manifest = {
    schemaVersion: 1,
    installationId: b.installationId,
    packageName: INSTALLATION_TARGET.packageName,
    packageVersion: INSTALLATION_TARGET.packageVersion,
    libraryDistributionSHA256: INSTALLATION_TARGET.libraryDistributionSHA256,
    chromiumRevision: INSTALLATION_TARGET.chromiumRevision,
    observedVersion: INSTALLATION_TARGET.observedVersion,
    platform: 'darwin',
    arch: 'arm64',
    executablePath: INSTALLATION_TARGET.executablePath,
    executableSHA256: snapshot.executable.sha256,
    verifierEvidence: {
      attemptId: b.attemptId,
      generation: b.generation,
      evidenceDigest: canonicalDigest(verification),
    },
  };
  return { verification, manifest };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'installation-fs-'));
  control.syncPath = '';
  control.closePath = '';
  control.postRenameSyncPath = '';
  control.renamed = false;
  control.syncFaultFired = false;
  control.closeOnlyAfterSync = false;
  control.rejectAfterCurrentRename = false;
  control.replaceDuringReadPath = '';
  control.readReplacementMade = false;
  control.closeCalls.length = 0;
  control.cleanup.length = 0;
  control.reads.length = 0;
  control.holdReadPath = '';
  control.holdReadPrefix = '';
  control.releaseFault = undefined;
  control.faultReadArrived = false;
  control.rootMutationLstatPath = '';
  control.rootMutationEntry = '';
  control.rootMutationAfterFile = '';
  control.rootMutationMade = false;
  control.heldReadHandles.clear();
  control.releaseReads = undefined;
  control.readFailurePath = '';
  control.readFailure = undefined;
  control.closeFailurePath = '';
  control.closeFailure = undefined;
  control.opened.length = 0;
  control.closeAttempts.length = 0;
});
afterEach(async () => {
  // Test-owner teardown only: it does not promote the producer's retained uncertainty.
  for (const close of control.cleanup) await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('real installation filesystem', () => {
  it('observes the official Chromium 1243 mac-arm64 application layout', async () => {
    // Independent literal from the official installer output: deriving this fixture
    // from INSTALLATION_TARGET previously hid a stale executable-path pin.
    const fixture = await staged(
      'official-layout',
      'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    );
    const snapshot = await fixture.producer.observeCandidate(fixture.candidate);
    expect(snapshot.executable.path).toBe(fixture.executable);
    expect(snapshot.machOCPU).toBe(16777228);
    await expect(
      fs.lstat(
        path.join(
          fixture.candidate.candidateRoot,
          'payload/chromium-1243/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('constructs and observes missing status without creating its cache', async () => {
    const status = createRuntimeStatus(config());
    expect((await status.inspectExisting()).state).toBe('missing');
    await expect(fs.lstat(config().cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports unsupported configuration without touching a configured path', async () => {
    expect(
      (await createRuntimeStatus({ ...config(), platform: 'linux' }).inspectExisting()).state
    ).toBe('unsupported');
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('does not repair malformed current bytes during read-only status', async () => {
    await fs.mkdir(config().cacheRoot, { mode: 0o700 });
    const bytes = Buffer.from('{"schemaVersion":1');
    await fs.writeFile(path.join(config().cacheRoot, 'current.json'), bytes);
    expect((await createRuntimeStatus(config()).inspectExisting()).state).toBe('invalid');
    expect(await fs.readFile(path.join(config().cacheRoot, 'current.json'))).toEqual(bytes);
  });
  it('rejects an ancestor symlink instead of creating through it', async () => {
    await fs.mkdir(path.join(root, 'real'), { mode: 0o700 });
    await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'));
    const producer = createInstallationFilesystem({
      ...config(),
      cacheRoot: path.join(root, 'alias', 'cache'),
    });
    await expect(producer.acquireReservation(binding(), bounds())).rejects.toMatchObject({
      code: 'ROOT_CHANGED',
    });
    expect(await fs.readdir(path.join(root, 'real'))).toEqual([]);
  });
  it('holds exclusive reservation and refuses a foreign writer without stale takeover', async () => {
    const a = createInstallationFilesystem(config()),
      b = createInstallationFilesystem(config());
    const reservation = await a.acquireReservation(binding(), bounds());
    const owner = await fs.readFile(path.join(config().cacheRoot, 'reservation', 'owner.json'));
    await expect(b.acquireReservation(binding('two'), bounds())).rejects.toMatchObject({
      code: 'PUBLICATION_BUSY',
    });
    expect(await fs.readFile(path.join(config().cacheRoot, 'reservation', 'owner.json'))).toEqual(
      owner
    );
    await a.releaseReservation(reservation);
    expect(a.custody(reservation).reservation).toBe('released');
  });
  it('does not reconstruct authority from a copied reservation handle', async () => {
    const producer = createInstallationFilesystem(config()),
      reservation = await producer.acquireReservation(binding(), bounds());
    await expect(producer.createAttempt({ ...reservation })).rejects.toMatchObject({
      code: 'OWNERSHIP_UNCERTAIN',
    });
    await producer.releaseReservation(reservation);
  });
  it('creates private attempt roots before retaining their identity', async () => {
    const producer = createInstallationFilesystem(config()),
      reservation = await producer.acquireReservation(binding(), bounds());
    const attempt = await producer.createAttempt(reservation);
    expect((await fs.readdir(attempt.attemptRoot)).sort()).toEqual(['diagnostics', 'home', 'tmp']);
    expect(String((await fs.lstat(attempt.attemptRoot, { bigint: true })).ino)).toBe(
      attempt.identity.inode
    );
    expect((await fs.stat(attempt.homeRoot)).mode & 0o077).toBe(0);
    await producer.releaseReservation(reservation);
  });
  it('joins actual allocation failures and returns every large-hash admission without exporting the pool', async () => {
    // Fresh concrete module owns a cold private buffer bank; original Node fs remains underneath.
    vi.resetModules();
    const originalModule = await import('../filesystem.js');
    const fixtures: Awaited<ReturnType<typeof staged>>[] = [];
    for (let index = 0; index < 17; index++)
      fixtures.push(
        await staged(
          `allocation-fault-${index}`,
          INSTALLATION_TARGET.executablePath,
          originalModule.createInstallationFilesystem,
          { ...config(), cacheRoot: path.join(root, `allocation-cache-${index}`) }
        )
      );
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(16777228, 4);
    for (const f of fixtures) await fs.writeFile(f.executable, bytes);
    const originalAlloc = Buffer.alloc;
    const allocation = vi
      .spyOn(Buffer, 'alloc')
      .mockImplementation((...args: Parameters<typeof Buffer.alloc>) => {
        if (args[0] === 1048576) throw undefined;
        return Reflect.apply(originalAlloc, Buffer, args) as ReturnType<typeof originalAlloc>;
      });
    try {
      // A leaked admission would saturate 16 slots and let the 17th existing 64KiB path succeed.
      for (const f of fixtures)
        await expect(f.producer.observeCandidate(f.candidate)).rejects.toBeUndefined();
      expect(allocation.mock.calls.filter((args) => args[0] === 1048576)).toHaveLength(17);
      expect(
        control.closeAttempts.filter((value) => fixtures.some((f) => value.path === f.executable))
      ).toHaveLength(17);
    } finally {
      allocation.mockRestore();
    }
  });
  it('overlaps at most sixteen original reads across single-file directories and preserves inventory order', async () => {
    const f = await staged('inventory-overlap');
    const directory = f.candidate.payloadRoot;
    const asset = (index: number) =>
      path.join(directory, `locale-${String(index).padStart(2, '0')}`, 'data');
    for (let index = 0; index < 32; index++) {
      await fs.mkdir(path.dirname(asset(index)), { mode: 0o700 });
      await fs.writeFile(asset(index), Buffer.from(`actual-${index}`), { mode: 0o600 });
    }
    let release!: () => void;
    control.releaseReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    control.holdReadPrefix = directory + path.sep;
    const original = f.producer.observeCandidate(f.candidate);
    void original.catch(() => {});
    try {
      await vi.waitFor(() => expect(control.heldReadHandles.size).toBe(16));
      expect(
        control.reads.filter((value) => value.path.startsWith(directory + path.sep))
      ).toHaveLength(16);
      expect(control.opened.some((value) => value.path === asset(15))).toBe(false);
      control.holdReadPrefix = '';
      release();
      const first = await original;
      expect(first.bytes).toBe(
        32 +
          Array.from({ length: 32 }, (_, index) => Buffer.byteLength(`actual-${index}`)).reduce(
            (sum, bytes) => sum + bytes,
            0
          )
      );
      // Force an early sorted entry to finish after its later sibling on the
      // next observation; completion order must not alter the inventory.
      control.heldReadHandles.clear();
      control.holdReadPath = asset(0);
      control.releaseReads = new Promise<void>((resolve) => {
        release = resolve;
      });
      const before = control.closeAttempts.length;
      const reordered = f.producer.observeCandidate(f.candidate);
      void reordered.catch(() => {});
      try {
        await vi.waitFor(() => {
          expect(control.heldReadHandles.size).toBe(1);
          expect(control.closeAttempts.slice(before).some((value) => value.path === asset(1))).toBe(
            true
          );
        });
        release();
        expect((await reordered).inventoryDigest).toBe(first.inventoryDigest);
      } finally {
        release();
        await Promise.allSettled([reordered]);
      }
    } finally {
      control.holdReadPrefix = '';
      release();
      await Promise.allSettled([original]);
    }
  });
  it.each([undefined, false])(
    'joins a held inventory sibling before propagating original falsy failure %s',
    async (cause) => {
      const f = await staged(`inventory-failure-${String(cause)}`);
      const directory = path.dirname(f.executable),
        failing = path.join(directory, 'asset-00'),
        held = path.join(directory, 'asset-01');
      await fs.writeFile(failing, 'failure', { mode: 0o600 });
      await fs.writeFile(held, 'held', { mode: 0o600 });
      let triggerFault!: () => void;
      control.releaseFault = new Promise<void>((resolve) => {
        triggerFault = resolve;
      });
      let release!: () => void;
      control.releaseReads = new Promise<void>((resolve) => {
        release = resolve;
      });
      control.holdReadPath = held;
      control.readFailurePath = failing;
      control.readFailure = { value: cause };
      control.closeFailurePath = failing;
      control.closeFailure = { value: 'secondary-close' };
      let settled = false;
      const original = f.producer.observeCandidate(f.candidate);
      void original.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      try {
        await vi.waitFor(() => {
          expect(control.heldReadHandles.size).toBe(1);
          expect(control.faultReadArrived).toBe(true);
        });
        triggerFault();
        await vi.waitFor(() => {
          expect(control.heldReadHandles.size).toBe(1);
          expect(control.closeAttempts.some((value) => value.path === failing)).toBe(true);
        });
        expect(settled).toBe(false);
        release();
        await expect(original).rejects.toBe(cause);
        expect(control.closeAttempts.filter((value) => value.path === held)).toHaveLength(1);
        expect(f.producer.custody(f.reservation).unresolvedHandles).toBeGreaterThan(0);
      } finally {
        triggerFault();
        release();
        await Promise.allSettled([original]);
      }
    }
  );
  it('rejects equal-byte inventory replacement and settles an independent held sibling before returning', async () => {
    const f = await staged('inventory-replacement');
    const directory = path.dirname(f.executable),
      replaced = path.join(directory, 'asset-00'),
      held = path.join(directory, 'asset-01');
    await fs.writeFile(replaced, 'identical', { mode: 0o600 });
    await fs.writeFile(held, 'held', { mode: 0o600 });
    let triggerFault!: () => void;
    control.releaseFault = new Promise<void>((resolve) => {
      triggerFault = resolve;
    });
    let release!: () => void;
    control.releaseReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    control.holdReadPath = held;
    control.replaceDuringReadPath = replaced;
    let settled = false;
    const original = f.producer.observeCandidate(f.candidate);
    void original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await vi.waitFor(() => {
        expect(control.heldReadHandles.size).toBe(1);
        expect(control.faultReadArrived).toBe(true);
      });
      triggerFault();
      await vi.waitFor(() => {
        expect(control.heldReadHandles.size).toBe(1);
        expect(control.readReplacementMade).toBe(true);
        expect(control.closeAttempts.some((value) => value.path === replaced)).toBe(true);
      });
      expect(settled).toBe(false);
      release();
      await expect(original).rejects.toMatchObject({ code: 'ROOT_CHANGED' });
      expect(control.closeAttempts.filter((value) => value.path === held)).toHaveLength(1);
    } finally {
      triggerFault();
      release();
      await Promise.allSettled([original]);
    }
  });
  it('rejects a new root entry created during late descendant validation', async () => {
    const f = await staged('postorder-root-mutation');
    control.rootMutationLstatPath = path.dirname(f.executable);
    control.rootMutationEntry = path.join(f.candidate.payloadRoot, 'late-entry');
    control.rootMutationAfterFile = f.executable;
    await expect(f.producer.observeCandidate(f.candidate)).rejects.toMatchObject({
      code: 'ROOT_CHANGED',
    });
    expect(control.rootMutationMade).toBe(true);
    expect(await fs.readFile(control.rootMutationEntry, 'utf8')).toBe('late-entry');
    expect(control.closeAttempts.filter((value) => value.path === f.executable)).toHaveLength(1);
  });
  it('hashes every byte with at most 1MiB original reads and keeps retained metadata at 64KiB', async () => {
    const f = await staged('bounded-hash'),
      bytes = Buffer.alloc(3 * 1024 * 1024 + 32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(16777228, 4);
    await fs.writeFile(f.executable, bytes);
    const snapshot = await f.producer.observeCandidate(f.candidate);
    expect(snapshot.executable.sha256).toBe(sha256(bytes));
    expect(snapshot.machOCPU).toBe(16777228);
    const reads = control.reads.filter((value) => value.path === f.executable);
    // Tree and exact executable revalidation are both retained: two full originals, five calls each.
    expect(reads).toHaveLength(10);
    expect(reads.every((value) => value.buffer.byteLength === 1048576)).toBe(true);
    expect(reads.reduce((sum, value) => sum + value.bytes, 0)).toBe(bytes.length * 2);
    const retained = control.reads.filter((value) => value.path.endsWith('/owner.json'));
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((value) => value.buffer.byteLength === 65536)).toBe(true);
  });
  it('saturates only 16 actual 1MiB buffers and returns each charge before later original reuse', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bank: { originals: Promise<CandidateSnapshot>[] } = { originals: [] };
    let first: Readonly<{ value: unknown }> | undefined;
    try {
      const f = await staged('bounded-pool'),
        bytes = Buffer.alloc(3 * 1024 * 1024 + 32);
      bytes.writeUInt32LE(0xfeedfacf, 0);
      bytes.writeUInt32LE(16777228, 4);
      await fs.writeFile(f.executable, bytes);
      control.holdReadPath = f.executable;
      control.releaseReads = released;
      for (let index = 0; index < 17; index++) {
        const original = f.producer.observeCandidate(f.candidate);
        bank.originals.push(original);
        void original.catch(() => {});
      }
      await vi.waitFor(() => expect(control.heldReadHandles.size).toBe(17));
      const held = control.reads.filter((value) => value.path === f.executable);
      expect(held).toHaveLength(17);
      const large = held.filter((value) => value.buffer.byteLength === 1048576);
      expect(large).toHaveLength(16);
      expect(new Set(large.map((value) => value.buffer)).size).toBe(16);
      expect(held.filter((value) => value.buffer.byteLength === 65536)).toHaveLength(1);
      release();
      await Promise.all(bank.originals);
      control.holdReadPath = '';
      const before = control.reads.length;
      expect((await f.producer.observeCandidate(f.candidate)).executable.sha256).toBe(
        sha256(bytes)
      );
      const fresh = control.reads.slice(before).filter((value) => value.path === f.executable);
      expect(fresh.every((value) => value.buffer.byteLength === 1048576)).toBe(true);
      expect(new Set(large.map((value) => value.buffer)).has(fresh[0]!.buffer)).toBe(true);
    } catch (value) {
      first = { value };
    } finally {
      release();
      const joined = await Promise.allSettled(bank.originals);
      for (const result of joined)
        if (result.status === 'rejected') first ??= { value: result.reason };
    }
    if (first) throw first.value;
  });
  it('retains original undefined read failure over false close while releasing all 17 charged reads', async () => {
    const f = await staged('unknown-hash'),
      bytes = Buffer.alloc(3 * 1024 * 1024 + 32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(16777228, 4);
    await fs.writeFile(f.executable, bytes);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originals: Promise<CandidateSnapshot>[] = [];
    control.holdReadPath = f.executable;
    control.releaseReads = held;
    control.readFailurePath = f.executable;
    control.readFailure = { value: undefined };
    control.closeFailurePath = f.executable;
    control.closeFailure = { value: false };
    try {
      // One durable installation, seventeen independent original descriptor reads.
      // Hold before throwing so every admission is charged before the first failure.
      for (let index = 0; index < 17; index++) {
        const original = f.producer.observeCandidate(f.candidate);
        originals.push(original);
        void original.catch(() => {});
      }
      await vi.waitFor(() => expect(control.heldReadHandles.size).toBe(17));
      const reads = control.reads.filter((value) => value.path === f.executable);
      expect(reads).toHaveLength(17);
      expect(reads.filter((value) => value.buffer.byteLength === 1048576)).toHaveLength(16);
      expect(reads.filter((value) => value.buffer.byteLength === 65536)).toHaveLength(1);
      release();
      for (const result of await Promise.allSettled(originals)) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason).toBeUndefined();
      }
      // Returning all buffers never heals uncertain original descriptor custody.
      expect(f.producer.custody(f.reservation).unresolvedHandles).toBe(19);
      // Faulted custody includes two original reservation directory leases as well.
      // Healthy held leases alone are excluded; neither uncertain reads nor leases heal.
      // Custody exposes a stable failure code; original rejected reads above retain undefined.
      expect(f.producer.custody(f.reservation).firstCause).toBe('IO_FAILED');
      expect(control.closeAttempts.filter((value) => value.path === f.executable)).toHaveLength(17);
    } finally {
      release();
      await Promise.allSettled(originals);
      control.holdReadPath = '';
      control.readFailurePath = '';
      control.closeFailurePath = '';
    }
    // A different producer can acquire a returned large buffer; it cannot heal f.
    const fresh = await staged(
      'after-unknown-hash',
      INSTALLATION_TARGET.executablePath,
      createInstallationFilesystem,
      { ...config(), cacheRoot: path.join(root, 'fresh-cache') }
    );
    await fs.writeFile(fresh.executable, bytes);
    expect((await fresh.producer.observeCandidate(fresh.candidate)).executable.sha256).toBe(
      sha256(bytes)
    );
    const freshReads = control.reads.filter((value) => value.path === fresh.executable);
    expect(freshReads.every((value) => value.buffer.byteLength === 1048576)).toBe(true);
    expect(f.producer.custody(f.reservation).unresolvedHandles).toBe(19);
  });
  it('large original reads still reject replacement of the named inode after reading identical bytes', async () => {
    const f = await staged('large-replacement'),
      bytes = Buffer.alloc(3 * 1024 * 1024 + 32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(16777228, 4);
    await fs.writeFile(f.executable, bytes);
    control.replaceDuringReadPath = f.executable;
    await expect(f.producer.observeCandidate(f.candidate)).rejects.toMatchObject({
      code: 'ROOT_CHANGED',
    });
    expect(control.readReplacementMade).toBe(true);
    expect(
      control.reads.some(
        (value) => value.path === f.executable && value.buffer.byteLength === 1048576
      )
    ).toBe(true);
    expect(control.closeAttempts.some((value) => value.path === f.executable)).toBe(true);
  });
  it('hashes architecture-shaped payload bytes and detects a later byte mutation', async () => {
    const f = await staged(),
      snapshot = await f.producer.observeCandidate(f.candidate);
    expect(snapshot.executable.sha256).toBe(
      createHash('sha256')
        .update(await fs.readFile(f.executable))
        .digest('hex')
    );
    await fs.appendFile(f.executable, Buffer.from([1]));
    await expect(f.producer.revalidateCandidate(f.candidate, snapshot)).rejects.toMatchObject({
      code: 'ROOT_CHANGED',
    });
  });
  it('rejects a wrong Mach-O architecture before durability', async () => {
    const f = await staged(),
      bytes = await fs.readFile(f.executable);
    bytes.writeUInt32LE(16777223, 4);
    await fs.writeFile(f.executable, bytes);
    await expect(f.producer.observeCandidate(f.candidate)).rejects.toMatchObject({
      code: 'INSTALLATION_INVALID',
    });
  });
  it('accepts a confined payload link and rejects an escaping link', async () => {
    const f = await staged();
    await fs.symlink(
      path.relative(f.candidate.payloadRoot, f.executable),
      path.join(f.candidate.payloadRoot, 'inside')
    );
    await expect(f.producer.observeCandidate(f.candidate)).resolves.toMatchObject({
      machOCPU: 16777228,
    });
    await fs.writeFile(path.join(root, 'outside'), 'x');
    await fs.symlink(path.join(root, 'outside'), path.join(f.candidate.payloadRoot, 'escape'));
    await expect(f.producer.observeCandidate(f.candidate)).rejects.toMatchObject({
      code: 'ROOT_CHANGED',
    });
  });
  it('refuses a different library without treating file count as distribution proof', async () => {
    await fs.mkdir(config().libraryRoot, { mode: 0o700 });
    for (let i = 0; i < 114; i++)
      await fs.writeFile(path.join(config().libraryRoot, `file_${i}`), 'different');
    await expect(createInstallationFilesystem(config()).validateLibrary()).rejects.toMatchObject({
      code: 'LIBRARY_MISMATCH',
    });
  });
  it('validates genuine distribution with the observed 13MiB controller and bounded self-bin metadata', async () => {
    // Copy this checkout's genuine distribution and Node binary into private
    // fixture ancestors: CI's tool cache may intentionally be group-writable.
    // Production ancestor validation stays strict; no network or browser launch.
    const ownRequire = createRequire(import.meta.url);
    const installedLibrary = await fs.realpath(
      path.dirname(ownRequire.resolve('playwright-core/package.json'))
    );
    const libraryRoot = path.join(root, 'genuine-library');
    await fs.cp(installedLibrary, libraryRoot, { recursive: true });
    // Actual original21722 CLI was 13,236,583 bytes. These equally sized fixture bytes
    // exercise real controller hashing/limits only and are never executed as native code.
    const controller = Buffer.alloc(13_236_583, 0x2f),
      verifier = Buffer.from('export {};\n');
    const source = recordBytes(
      { schemaVersion: 1, controllerSHA256: sha256(controller), verifierSHA256: sha256(verifier) },
      INSTALLATION_LIMITS.manifestBytes
    );
    await fs.writeFile(config().controllerEntry, controller);
    await fs.writeFile(config().verifierEntry, verifier);
    await fs.writeFile(config().sourceManifestPath, source);
    const toolCache = path.join(root, 'tool-cache');
    await fs.mkdir(toolCache, { mode: 0o700 });
    const nodeExecutable = path.join(toolCache, 'genuine-node');
    await fs.copyFile(await fs.realpath(process.execPath), nodeExecutable);
    await fs.chmod(nodeExecutable, 0o700);
    const node = await fs.open(nodeExecutable, 'r');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(INSTALLATION_LIMITS.bufferBytes);
    let total = 0;
    try {
      while (true) {
        const read = await node.read(buffer, 0, buffer.length, total);
        if (!read.bytesRead) break;
        total += read.bytesRead;
        expect(total).toBeLessThanOrEqual(INSTALLATION_LIMITS.executableBytes);
        hash.update(buffer.subarray(0, read.bytesRead));
      }
    } finally {
      await node.close();
    }
    const configuration: InstallationConfiguration = {
      ...config(),
      libraryRoot,
      nodeExecutable,
      nodeExecutableSHA256: hash.digest('hex'),
      sourceVintage: {
        controllerSHA256: sha256(controller),
        verifierSHA256: sha256(verifier),
        sourceManifestSHA256: sha256(source),
      },
    };
    const producer = createInstallationFilesystem(configuration);
    await fs.chmod(toolCache, 0o770);
    await expect(producer.validateLibrary()).rejects.toMatchObject({
      code: 'OWNERSHIP_UNCERTAIN',
    });
    await fs.chmod(toolCache, 0o700);
    const library = await producer.validateLibrary();
    expect(library.distributionSHA256).toBe(INSTALLATION_TARGET.libraryDistributionSHA256);
    expect(library.files).toHaveLength(114);
    expect(producer.custody().unresolvedHandles).toBe(0);
    // A sparse over-cap controller must refuse before hashing/opening it; this does
    // not widen the pinned official library or verifier file bounds.
    const oversized = await fs.open(configuration.controllerEntry, 'r+');
    try {
      await oversized.truncate(INSTALLATION_LIMITS.controllerBytes + 1);
    } finally {
      await oversized.close();
    }
    const openedBeforeRefusal = control.opened.filter(
      (entry) => entry.path === configuration.controllerEntry
    ).length;
    await expect(producer.validateLibrary()).rejects.toMatchObject({
      code: 'INSTALLATION_INVALID',
    });
    expect(
      control.opened.filter((entry) => entry.path === configuration.controllerEntry)
    ).toHaveLength(openedBeforeRefusal);
    expect(producer.custody().unresolvedHandles).toBe(0);
    await fs.writeFile(configuration.controllerEntry, controller);
    // Copy the test allocation's genuine official source into a test-owned root;
    // generated metadata is independently formed and never executed or hashed as source.
    const copiedRoot = path.join(root, 'installed-library');
    await fs.cp(libraryRoot, copiedRoot, {
      recursive: true,
      filter: (source) =>
        !path.relative(libraryRoot, source).split(path.sep).includes('node_modules'),
    });
    const bins = path.join(copiedRoot, 'node_modules', '.bin'),
      shim = path.join(bins, 'playwright-core');
    await fs.mkdir(bins, { recursive: true, mode: 0o700 });
    await fs.writeFile(shim, '#!/bin/sh\nexec node "$basedir/../../cli.js" "$@"\n', {
      mode: 0o755,
    });
    const validate = () =>
      createInstallationFilesystem({ ...configuration, libraryRoot: copiedRoot }).validateLibrary();
    const installed = await validate();
    expect(installed.distributionSHA256).toBe(INSTALLATION_TARGET.libraryDistributionSHA256);
    expect(installed.files).toHaveLength(114);
    expect(installed.files.some((file) => file.path.includes('/node_modules/'))).toBe(false);
    await fs.writeFile(path.join(copiedRoot, 'node_modules', 'shadow.js'), 'module.exports = {};');
    await expect(validate()).rejects.toMatchObject({ code: 'LIBRARY_MISMATCH' });
    await fs.unlink(path.join(copiedRoot, 'node_modules', 'shadow.js'));
    await fs.writeFile(path.join(bins, 'node'), 'unexpected executable');
    await expect(validate()).rejects.toMatchObject({ code: 'LIBRARY_MISMATCH' });
    await fs.unlink(path.join(bins, 'node'));
    await fs.unlink(shim);
    await fs.mkdir(shim, { mode: 0o700 });
    await expect(validate()).rejects.toMatchObject({ code: 'LIBRARY_MISMATCH' });
    await fs.rmdir(shim);
    await fs.symlink('../../package.json', shim);
    await expect(validate()).rejects.toMatchObject({ code: 'LIBRARY_MISMATCH' });
    await fs.unlink(shim);
    await fs.symlink('../../cli.js', shim);
    expect((await validate()).distributionSHA256).toBe(
      INSTALLATION_TARGET.libraryDistributionSHA256
    );
    await fs.appendFile(path.join(copiedRoot, 'cli.js'), '\n// changed official source\n');
    await expect(validate()).rejects.toMatchObject({ code: 'LIBRARY_MISMATCH' });
  }, 30_000);
  it('caps retained writer chunks before copying and closes both acquired raws', async () => {
    const f = await staged(),
      sink = f.producer.createJobSink(f.reservation, f.attempt);
    const output = await sink.prepare({
      schemaVersion: 1,
      role: 'official-install',
      jobId: 'cap',
      binding: f.b,
      bounds: f.end,
      executable: f.configuration.nodeExecutable,
      argv: [],
      cwd: f.attempt.attemptRoot,
      environmentDigest: 'a'.repeat(64),
    });
    await expect(
      output.stdout.write(new Uint8Array(INSTALLATION_LIMITS.bufferBytes + 1))
    ).rejects.toMatchObject({ code: 'RETENTION_EXCEEDED' });
    await output.stdout.finish();
    await output.stderr.finish();
    expect(f.producer.custody(f.reservation).firstCause).toBe('RETENTION_EXCEEDED');
    const rawOriginals = control.opened.filter((entry) => entry.path.endsWith('.raw'));
    const writers = rawOriginals.filter(
      (entry) => typeof entry.flags === 'number' && (entry.flags & constants.O_WRONLY) !== 0
    );
    expect(writers).toHaveLength(2);
    expect(new Set(writers.map((entry) => entry.path)).size).toBe(2);
    // Separate final-snapshot read acquisitions are real additional originals, not writer double-closes.
    for (const original of rawOriginals)
      expect(
        control.closeAttempts.filter((attempt) => attempt.handleId === original.handleId)
      ).toHaveLength(1);
    await expect(f.producer.releaseReservation(f.reservation)).rejects.toMatchObject({
      code: 'CUSTODY_UNCERTAIN',
    });
  });
  it('keeps payload-sync failure primary when its original close also rejects', async () => {
    const f = await staged(),
      snapshot = await f.producer.observeCandidate(f.candidate);
    control.syncPath = f.executable;
    control.closePath = f.executable;
    control.closeOnlyAfterSync = true;
    await expect(f.producer.makeCandidateDurable(f.candidate, snapshot)).rejects.toMatchObject({
      message: 'injected sync',
    });
    expect(f.producer.custody(f.reservation)).toMatchObject({
      firstCause: 'IO_FAILED',
      reservation: 'held',
    });
    expect(f.producer.custody(f.reservation).unresolvedHandles).toBeGreaterThan(0);
    expect(control.closeCalls.filter((p) => p === f.executable).length).toBeGreaterThan(0);
    await expect(
      fs.lstat(path.join(f.configuration.cacheRoot, 'current.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes exact durable manifest bytes after real payload and diagnostic flushes', async () => {
    const f = await staged(),
      snapshot = await f.producer.observeCandidate(f.candidate),
      records = await diagnostics(f, snapshot);
    await f.producer.makeCandidateDurable(f.candidate, snapshot);
    const facts = await f.producer.publish(
      f.reservation,
      f.candidate,
      records.manifest,
      records.verification,
      { state: 'absent' }
    );
    expect(facts).toMatchObject({ state: 'durable', pointerReplaced: true, firstCause: null });
    const bytes = await fs.readFile(path.join(f.candidate.candidateRoot, 'manifest.json'));
    expect(bytes).toEqual(
      Buffer.from(recordBytes(records.manifest, INSTALLATION_LIMITS.manifestBytes))
    );
    expect(
      JSON.parse(await fs.readFile(path.join(f.configuration.cacheRoot, 'current.json'), 'utf8'))
        .manifestDigest
    ).toBe(sha256(bytes));
    await f.producer.releaseReservation(f.reservation);
    expect(f.producer.custody(f.reservation)).toMatchObject({
      pendingOperations: 0,
      unresolvedHandles: 0,
      reservation: 'released',
    });
  });
  it('returns uncertainty and retains reservation if cache sync fails after pointer rename', async () => {
    const f = await staged(),
      snapshot = await f.producer.observeCandidate(f.candidate),
      records = await diagnostics(f, snapshot);
    await f.producer.makeCandidateDurable(f.candidate, snapshot);
    control.postRenameSyncPath = f.configuration.cacheRoot;
    const facts = await f.producer.publish(
      f.reservation,
      f.candidate,
      records.manifest,
      records.verification,
      { state: 'absent' }
    );
    expect(facts).toMatchObject({
      state: 'uncertain',
      pointerReplaced: true,
      firstCause: 'PUBLICATION_UNCERTAIN',
    });
    expect(f.producer.custody(f.reservation).reservation).toBe('uncertain');
    await expect(f.producer.releaseReservation(f.reservation)).rejects.toMatchObject({
      code: 'OWNERSHIP_UNCERTAIN',
    });
    expect((await fs.lstat(path.join(f.configuration.cacheRoot, 'current.json'))).isFile()).toBe(
      true
    );
  });
  it('carries publicationMayHaveChanged when the rename response is ambiguous', async () => {
    const f = await staged(),
      snapshot = await f.producer.observeCandidate(f.candidate),
      records = await diagnostics(f, snapshot);
    await f.producer.makeCandidateDurable(f.candidate, snapshot);
    control.rejectAfterCurrentRename = true;
    await expect(
      f.producer.publish(f.reservation, f.candidate, records.manifest, records.verification, {
        state: 'absent',
      })
    ).rejects.toMatchObject({ code: 'PUBLICATION_UNCERTAIN', publicationMayHaveChanged: true });
    expect(f.producer.custody(f.reservation).reservation).toBe('uncertain');
    expect((await fs.lstat(path.join(f.configuration.cacheRoot, 'current.json'))).isFile()).toBe(
      true
    );
  });
  it('permits its own serial raw growth and freezes the exact final bytes', async () => {
    const f = await staged(),
      sink = f.producer.createJobSink(f.reservation, f.attempt);
    const output = await sink.prepare({
      schemaVersion: 1,
      role: 'official-install',
      jobId: 'growth',
      binding: f.b,
      bounds: f.end,
      executable: f.configuration.nodeExecutable,
      argv: [],
      cwd: f.attempt.attemptRoot,
      environmentDigest: 'a'.repeat(64),
    });
    await output.stdout.write(Buffer.from('first'));
    await output.stdout.write(Buffer.from('second'));
    await output.stdout.finish();
    await output.stderr.finish();
    expect(
      await fs.readFile(path.join(f.attempt.attemptRoot, 'diagnostics/growth.stdout.raw'), 'utf8')
    ).toBe('firstsecond');
    expect(f.producer.custody(f.reservation)).toMatchObject({
      firstCause: null,
      unresolvedHandles: 0,
    });
  });
  it('rejects a same-byte named replacement while still closing the acquired raw original', async () => {
    const f = await staged(),
      sink = f.producer.createJobSink(f.reservation, f.attempt);
    const output = await sink.prepare({
      schemaVersion: 1,
      role: 'official-install',
      jobId: 'replace',
      binding: f.b,
      bounds: f.end,
      executable: f.configuration.nodeExecutable,
      argv: [],
      cwd: f.attempt.attemptRoot,
      environmentDigest: 'a'.repeat(64),
    });
    const raw = path.join(f.attempt.attemptRoot, 'diagnostics/replace.stdout.raw');
    await output.stdout.write(Buffer.from('same bytes'));
    await fs.rename(raw, raw + '.old');
    await fs.writeFile(raw, 'same bytes', { mode: 0o600 });
    await expect(output.stdout.finish()).rejects.toMatchObject({ code: 'ROOT_CHANGED' });
    await output.stderr.finish();
    expect(await fs.readFile(raw + '.old', 'utf8')).toBe('same bytes');
    expect(control.closeCalls.filter((name) => name === raw)).toHaveLength(1);
    expect(f.producer.custody(f.reservation).firstCause).toBe('ROOT_CHANGED');
    await expect(f.producer.releaseReservation(f.reservation)).rejects.toMatchObject({
      code: 'CUSTODY_UNCERTAIN',
    });
  });
  it('refuses a raw-path symlink alias before writing through its retained original', async () => {
    const f = await staged(),
      sink = f.producer.createJobSink(f.reservation, f.attempt);
    const output = await sink.prepare({
      schemaVersion: 1,
      role: 'official-install',
      jobId: 'alias',
      binding: f.b,
      bounds: f.end,
      executable: f.configuration.nodeExecutable,
      argv: [],
      cwd: f.attempt.attemptRoot,
      environmentDigest: 'a'.repeat(64),
    });
    const raw = path.join(f.attempt.attemptRoot, 'diagnostics/alias.stdout.raw');
    await fs.rename(raw, raw + '.old');
    await fs.symlink(raw + '.old', raw);
    await expect(output.stdout.write(Buffer.from('refused'))).rejects.toMatchObject({
      code: 'ROOT_CHANGED',
    });
    await expect(output.stdout.finish()).rejects.toMatchObject({ code: 'ROOT_CHANGED' });
    await output.stderr.finish();
    expect((await fs.stat(raw + '.old')).size).toBe(0);
    expect(f.producer.custody(f.reservation).firstCause).toBe('ROOT_CHANGED');
  });
  it('binds post-finish publication reads to original snapshots even for equal replacement bytes', async () => {
    const f = await staged(),
      snapshot = await f.producer.observeCandidate(f.candidate),
      records = await diagnostics(f, snapshot);
    const raw = path.join(f.attempt.attemptRoot, 'diagnostics/verifier.stdout.raw'),
      bytes = await fs.readFile(raw);
    await fs.rename(raw, raw + '.old');
    await fs.writeFile(raw, bytes, { mode: 0o600 });
    await f.producer.makeCandidateDurable(f.candidate, snapshot);
    await expect(
      f.producer.publish(f.reservation, f.candidate, records.manifest, records.verification, {
        state: 'absent',
      })
    ).rejects.toMatchObject({ code: 'ROOT_CHANGED' });
    expect(f.producer.custody(f.reservation).firstCause).toBe('ROOT_CHANGED');
    await expect(
      fs.lstat(path.join(f.configuration.cacheRoot, 'current.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a same-byte raw replacement before accepting its receipt', async () => {
    const f = await staged(),
      snapshot = await f.producer.observeCandidate(f.candidate);
    await expect(
      diagnostics(f, snapshot, async (role, raw) => {
        if (role === 'fresh-verifier') {
          const bytes = await fs.readFile(raw);
          await fs.rename(raw, raw + '.old');
          await fs.writeFile(raw, bytes, { mode: 0o600 });
        }
      })
    ).rejects.toMatchObject({ code: 'ROOT_CHANGED' });
    expect(f.producer.custody(f.reservation).firstCause).toBe('ROOT_CHANGED');
    await expect(
      fs.lstat(path.join(f.attempt.attemptRoot, 'diagnostics/verifier.receipt.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('records read replacement as primary before its original close also becomes ambiguous', async () => {
    const f = await staged();
    control.replaceDuringReadPath = f.executable;
    control.closePath = f.executable;
    await expect(f.producer.observeCandidate(f.candidate)).rejects.toMatchObject({
      code: 'ROOT_CHANGED',
    });
    expect(control.readReplacementMade).toBe(true);
    expect(f.producer.custody(f.reservation).firstCause).toBe('ROOT_CHANGED');
    expect(f.producer.custody(f.reservation).unresolvedHandles).toBeGreaterThan(0);
  });
});
