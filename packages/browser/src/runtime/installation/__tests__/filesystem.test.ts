import * as fs from 'node:fs/promises';
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
  opened: [] as { handleId: number; path: string; flags: Parameters<typeof fs.open>[1] }[],
  closeAttempts: [] as { handleId: number; path: string }[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
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
        if (
          name === control.replaceDuringReadPath &&
          !control.readReplacementMade &&
          result.bytesRead > 0
        ) {
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
  executableRelativePath: string = INSTALLATION_TARGET.executablePath
) {
  const configuration = config(),
    producer = createInstallationFilesystem(configuration),
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
  control.opened.length = 0;
  control.closeAttempts.length = 0;
});
afterEach(async () => {
  // Test-owner teardown only: it does not promote the producer's retained uncertainty.
  for (const close of control.cleanup) await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('real installation filesystem', () => {
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
    for (let i = 0; i < 116; i++)
      await fs.writeFile(path.join(config().libraryRoot, `file_${i}`), 'different');
    await expect(createInstallationFilesystem(config()).validateLibrary()).rejects.toMatchObject({
      code: 'LIBRARY_MISMATCH',
    });
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
});
