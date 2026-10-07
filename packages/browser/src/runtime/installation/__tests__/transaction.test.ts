import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInstallationTransaction } from '../transaction.js';
import { createRuntimeInstallation } from '../index.js';
import { parsePinnedVersionOutput } from '../fresh-verifier.js';
import {
  canonicalDigest,
  INSTALLATION_TARGET,
  InstallationFailure,
  READINESS_UNAVAILABLE,
  recordBytes,
  sha256,
  type AttemptBinding,
  type CandidateSnapshot,
  type CurrentObservation,
  type ExistingInspection,
  type ExistingInstallation,
  type FileIdentity,
  type FileSnapshot,
  type FreshVerifierReply,
  type InstallationConfiguration,
  type InstallationFilesystem,
  type InstallationJobs,
  type JobBirth,
  type JobFacts,
  type JobHandle,
  type JobIntent,
  type JobOutput,
  type JobRun,
  type Manifest,
  type OwnerRecord,
  type ReuseRecord,
  type VerificationRecord,
} from '../contracts.js';

const composition = vi.hoisted(() => ({ filesystem: vi.fn(), jobs: vi.fn() }));
vi.mock('../filesystem.js', () => ({ createInstallationFilesystem: composition.filesystem }));
vi.mock('../jobs.js', () => ({ createInstallationJobs: composition.jobs }));

/** Semantic producer fixtures only. None of these receipts claims a physical child or filesystem run. */
const hash = 'a'.repeat(64);
const identity: FileIdentity = {
  device: '1',
  inode: '1',
  size: '100',
  mtimeNs: '1',
  ctimeNs: '1',
  type: 'file',
  uid: 501,
  mode: 0o100600,
};
const config: InstallationConfiguration = {
  cacheRoot: '/fixture/cache',
  libraryRoot: '/fixture/library',
  nodeExecutable: '/fixture/node',
  nodeExecutableSHA256: hash,
  verifierEntry: '/fixture/verifier.mjs',
  controllerEntry: '/fixture/cli.mjs',
  sourceManifestPath: '/fixture/source.json',
  sourceVintage: {
    sourceManifestSHA256: hash,
    controllerSHA256: hash,
    verifierSHA256: hash,
  },
  platform: 'darwin',
  arch: 'arm64',
  workMilliseconds: 1000,
  finalMilliseconds: 1100,
};
const file = (path: string, digest = hash): FileSnapshot => ({
  path,
  identity,
  sha256: digest,
  bytes: 100,
});
const candidate = (installationId: string): CandidateSnapshot => {
  const candidateRoot = join(config.cacheRoot, 'candidates', installationId);
  return {
    installationId,
    candidateRoot,
    payloadRoot: join(candidateRoot, 'payload'),
    executable: file(join(candidateRoot, INSTALLATION_TARGET.executablePath)),
    machOCPU: 16777228,
    inventoryDigest: hash,
    entries: 2,
    bytes: 100,
  };
};
const statusCommon = {
  schemaVersion: 1 as const,
  pinnedPackageVersion: '1.63.0' as const,
  chromiumRevision: '1243' as const,
  platform: 'darwin' as const,
  arch: 'arm64' as const,
  observation: 'files-only' as const,
  readiness: READINESS_UNAVAILABLE,
};
const oldBinding: AttemptBinding = {
  transactionId: 'oldtransaction',
  attemptId: 'oldattempt',
  nonce: 'oldnonce',
  generation: 1,
  installationId: 'oldinstallation',
};
function oldInstallation(): ExistingInstallation {
  const reply: FreshVerifierReply = {
    schemaVersion: 1,
    binding: oldBinding,
    executableSHA256: hash,
    executableIdentity: identity,
    libraryDistributionSHA256: INSTALLATION_TARGET.libraryDistributionSHA256,
    sourceManifestSHA256: hash,
    observedVersion: '153.0.8010.12',
    chromiumRevision: '1243',
    platform: 'darwin',
    arch: 'arm64',
    machOCPU: 16777228,
    probeReceiptDigest: hash,
  };
  const verification: VerificationRecord = {
    schemaVersion: 1,
    canonicalFormat: 'installation-canonical-v1',
    binding: oldBinding,
    installer: { kind: 'invoked', jobId: 'oldinstalljob', receiptDigest: hash },
    verifier: { jobId: 'oldverifyjob', receiptDigest: hash, replyDigest: hash },
    reply,
    candidateInventoryDigest: hash,
    libraryDistributionSHA256: INSTALLATION_TARGET.libraryDistributionSHA256,
    sourceManifestSHA256: hash,
  };
  const manifest: Manifest = {
    schemaVersion: 1,
    installationId: oldBinding.installationId,
    packageName: 'playwright-core',
    packageVersion: '1.63.0',
    libraryDistributionSHA256: INSTALLATION_TARGET.libraryDistributionSHA256,
    chromiumRevision: '1243',
    observedVersion: '153.0.8010.12',
    platform: 'darwin',
    arch: 'arm64',
    executablePath: INSTALLATION_TARGET.executablePath,
    executableSHA256: hash,
    verifierEvidence: {
      attemptId: oldBinding.attemptId,
      generation: 1,
      evidenceDigest: canonicalDigest(verification),
    },
  };
  const manifestDigest = sha256(recordBytes(manifest, 16384));
  return {
    current: {
      state: 'present',
      file: file('/fixture/cache/current.json'),
      pointer: { schemaVersion: 1, installationId: oldBinding.installationId, manifestDigest },
    },
    manifest,
    manifestFile: file('/fixture/cache/candidates/oldinstallation/manifest.json', manifestDigest),
    verification,
    verificationFile: file(
      '/fixture/cache/candidates/oldinstallation/verification.json',
      sha256(recordBytes(verification, 65536))
    ),
    candidate: candidate(oldBinding.installationId),
  };
}
function harness(existing: ExistingInstallation | null = null) {
  const events: string[] = [];
  let current: CurrentObservation = existing?.current ?? { state: 'absent' };
  let reservationState: 'held' | 'released' | 'uncertain' = 'released';
  let localBinding: AttemptBinding | undefined;
  let clock = 1;
  let idCount = 0;
  let ownerRecord: OwnerRecord | undefined;
  let writtenReuse: ReuseRecord | undefined;
  let writtenManifest: Manifest | undefined;
  let replyChange: (reply: FreshVerifierReply) => FreshVerifierReply = (value) => value;
  let jobChange: (facts: JobFacts) => JobFacts = (value) => value;
  const jobMembership = new WeakMap<JobHandle, JobFacts>();
  const inspect = (): ExistingInspection => ({
    current,
    installation: existing,
    status: existing
      ? {
          ...statusCommon,
          state: 'installed-files',
          cause: null,
          installationId: existing.manifest.installationId,
          executableSHA256: hash,
          currentManifestDigest: existing.current.pointer.manifestDigest,
          lastFreshVerifiedVersion: existing.manifest.observedVersion,
          historicalAttemptId: existing.manifest.verifierEvidence.attemptId,
          historicalGeneration: existing.manifest.verifierEvidence.generation,
          verificationDigest: existing.verificationFile.sha256,
        }
      : { ...statusCommon, state: 'missing', cause: null },
  });
  const sink = {
    async prepare(_intent: JobIntent): Promise<JobOutput> {
      events.push('intent');
      return {
        stdout: { async write() {}, async finish() {} },
        stderr: { async write() {}, async finish() {} },
      };
    },
    async birth(facts: JobBirth) {
      events.push('birth');
      ownerRecord = { ...ownerRecord!, births: [...(ownerRecord?.births ?? []), facts] };
    },
    async receipt() {
      events.push('receipt');
    },
  };
  const fs: InstallationFilesystem = {
    inspectExisting: vi.fn(async () => {
      events.push('inspect');
      return inspect();
    }),
    validateLibrary: vi.fn(async () => ({
      distributionSHA256: INSTALLATION_TARGET.libraryDistributionSHA256,
      files: [file(join(config.libraryRoot, 'cli.js'))],
      cli: file(join(config.libraryRoot, 'cli.js')),
      browsersManifest: file(join(config.libraryRoot, 'browsers.json')),
    })),
    acquireReservation: vi.fn<InstallationFilesystem['acquireReservation']>(async (binding) => {
      events.push('reserve');
      localBinding = binding;
      reservationState = 'held';
      return { kind: 'installation-reservation', binding };
    }),
    createAttempt: vi.fn<InstallationFilesystem['createAttempt']>(async (reservation) => {
      events.push('attempt-durable');
      const attemptRoot = join(config.cacheRoot, 'attempts', reservation.binding.attemptId);
      return {
        kind: 'installation-attempt',
        binding: reservation.binding,
        attemptRoot,
        homeRoot: join(attemptRoot, 'home'),
        temporaryRoot: join(attemptRoot, 'tmp'),
        identity: { ...identity, type: 'directory' },
      };
    }),
    writeOwner: vi.fn(async (_reservation, _attempt, record) => {
      events.push(`owner:${record.phase}`);
      ownerRecord = record;
    }),
    stageCandidate: vi.fn<InstallationFilesystem['stageCandidate']>(async (reservation) => {
      events.push('stage');
      const snapshot = candidate(reservation.binding.installationId);
      return {
        kind: 'installation-candidate',
        binding: reservation.binding,
        candidateRoot: snapshot.candidateRoot,
        payloadRoot: snapshot.payloadRoot,
        reuse: false,
      };
    }),
    bindExistingCandidate: vi.fn<InstallationFilesystem['bindExistingCandidate']>(
      async (reservation, _attempt, old) => {
        events.push('bind-reuse');
        return {
          kind: 'installation-candidate',
          binding: reservation.binding,
          candidateRoot: old.candidate.candidateRoot,
          payloadRoot: old.candidate.payloadRoot,
          reuse: true,
        };
      }
    ),
    observeCandidate: vi.fn(async (handle) => candidate(handle.binding.installationId)),
    revalidateCandidate: vi.fn(async () => {
      events.push('revalidate');
    }),
    createJobSink: () => sink,
    inspectFreshRequest: async () => {
      throw Error('Verifier entry is outside this semantic fixture');
    },
    createProbeSink: () => sink,
    makeCandidateDurable: vi.fn(async () => {
      events.push('payload-durable');
    }),
    publish: vi.fn<InstallationFilesystem['publish']>(
      async (_reservation, _handle, manifest, verification, before) => {
        events.push('publish');
        writtenManifest = manifest;
        const manifestDigest = sha256(recordBytes(manifest, 16384));
        current = {
          state: 'present',
          file: file(join(config.cacheRoot, 'current.json')),
          pointer: { schemaVersion: 1, installationId: manifest.installationId, manifestDigest },
        };
        return {
          state: 'durable',
          pointerReplaced: true,
          currentBefore: before,
          currentAfter: current,
          manifestDigest,
          verificationDigest: sha256(recordBytes(verification, 65536)),
          firstCause: null,
        };
      }
    ),
    writeReuseJournal: vi.fn(async (_reservation, attempt, record) => {
      events.push('reuse-journal');
      writtenReuse = record;
      return file(join(attempt.attemptRoot, 'reuse.json'), sha256(recordBytes(record, 65536)));
    }),
    releaseReservation: vi.fn(async () => {
      events.push('release');
      reservationState = 'released';
    }),
    custody: () => ({
      pendingOperations: 0,
      unresolvedHandles: 0,
      firstCause: null,
      reservation: reservationState,
    }),
  };
  let jobNumber = 0;
  async function job(
    role: 'official-install' | 'fresh-verifier',
    request: Parameters<InstallationJobs['runInstaller']>[0],
    stdout: Uint8Array
  ): Promise<JobRun> {
    events.push(role);
    const jobId = `job${++jobNumber}`;
    const intent: JobIntent = {
      schemaVersion: 1,
      jobId,
      role,
      binding: request.binding,
      bounds: request.bounds,
      executable: config.nodeExecutable,
      argv:
        role === 'official-install'
          ? [request.library.cli.path, 'install', 'chromium', '--no-shell', '--no-remove']
          : [config.verifierEntry],
      cwd: request.attempt.attemptRoot,
      environmentDigest: hash,
    };
    await request.sink.prepare(intent);
    const birth: JobBirth = { ...intent, pid: jobNumber };
    await request.sink.birth(birth);
    const stream = (length: number) => ({
      observedBytes: length,
      retainedBytes: length,
      overflow: false,
      eof: true,
      closed: true,
      rawFlushedClosed: true,
    });
    const facts = jobChange({
      schemaVersion: 1,
      jobId,
      role,
      binding: request.binding,
      birth,
      exitCode: 0,
      signal: null,
      exitObserved: true,
      closeObserved: true,
      stdout: stream(stdout.byteLength),
      stderr: stream(0),
      stopRequested: false,
      firstCause: null,
      cleanupCauses: [],
      descendantDisposition:
        role === 'official-install' ? 'trusted-installer-return' : 'not-applicable',
    });
    await request.sink.receipt(facts);
    const handle: JobHandle = { kind: 'installation-job', role, jobId };
    jobMembership.set(handle, facts);
    return { handle, facts, stdout, stderr: new Uint8Array() };
  }
  const jobs: InstallationJobs = {
    runInstaller: vi.fn(async (request) => job('official-install', request, new Uint8Array())),
    runVerifier: vi.fn(async (request) => {
      // Actual F fresh admission requires verifying even when the candidate is reused.
      expect(ownerRecord?.phase).toBe('verifying');
      const reply: FreshVerifierReply = {
        schemaVersion: 1,
        binding: request.binding,
        executableSHA256: request.request.executableSHA256,
        executableIdentity: request.request.executableIdentity,
        libraryDistributionSHA256: request.request.libraryDistributionSHA256,
        sourceManifestSHA256: request.request.sourceVintage.sourceManifestSHA256,
        observedVersion: '153.0.8010.12',
        chromiumRevision: '1243',
        platform: 'darwin',
        arch: 'arm64',
        machOCPU: 16777228,
        probeReceiptDigest: hash,
      };
      return job('fresh-verifier', request, recordBytes(replyChange(reply), 4096));
    }),
    runVersionProbe: async () => {
      throw Error('Not a controller role');
    },
    requireReturned(handle) {
      const facts = jobMembership.get(handle);
      if (!facts) throw new InstallationFailure('CUSTODY_UNCERTAIN');
      events.push(`returned:${facts.role}`);
      return facts;
    },
    custody: () => ({ pending: 0, firstCause: null }),
  };
  const transaction = () =>
    createInstallationTransaction(
      config,
      { filesystem: fs, jobs, now: () => clock, createId: () => `id${++idCount}` },
      2
    );
  return {
    fs,
    jobs,
    transaction,
    events,
    inspect,
    setClock(value: number) {
      clock = value;
    },
    changeReply(change: typeof replyChange) {
      replyChange = change;
    },
    changeJob(change: typeof jobChange) {
      jobChange = change;
    },
    get owner() {
      return ownerRecord;
    },
    get reuse() {
      return writtenReuse;
    },
    get manifest() {
      return writtenManifest;
    },
    get binding() {
      return localBinding;
    },
  };
}

describe('installation transaction semantic ordering (physical acceptance UNRUN)', () => {
  it('parses the exact official Darwin product branding and version output', () => {
    expect(
      parsePinnedVersionOutput(Buffer.from('Google Chrome for Testing 153.0.8010.12 \n'))
    ).toBe('153.0.8010.12');
  });

  it.each([
    'Chromium 153.0.8010.12\n',
    'Google Chrome for Testing 153.0.8010.13 \n',
    'Google Chrome for Testing 153.0.8010.12 \nextra\n',
  ])('rejects substituted branding, version or extra output: %s', (output) => {
    expect(() => parsePinnedVersionOutput(Buffer.from(output))).toThrow('VERSION_MISMATCH');
  });

  it('facade retains an uncertain attempt and admits no replacement producer', async () => {
    const h = harness();
    composition.filesystem.mockReset().mockReturnValue(h.fs);
    composition.jobs.mockReset().mockReturnValue(h.jobs);
    h.fs.makeCandidateDurable = vi.fn(async () => {
      throw new InstallationFailure('IO_FAILED');
    });
    const facade = createRuntimeInstallation(config);
    const first = facade.install();
    expect(await first).toMatchObject({ state: 'uncertain', cause: 'IO_FAILED' });
    expect(facade.install({ repair: true })).toBe(first);
    expect(composition.filesystem).toHaveBeenCalledTimes(2); // Status facade and original owner only.
    expect(composition.jobs).toHaveBeenCalledTimes(1);
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it('facade admits a new owner only after genuine producer custody returns cleanly', async () => {
    const first = harness();
    composition.filesystem.mockReset().mockReturnValue(first.fs);
    composition.jobs.mockReset().mockReturnValue(first.jobs);
    const facade = createRuntimeInstallation(config);
    expect((await facade.install()).state).toBe('verified-installed');
    const second = harness();
    composition.filesystem.mockReturnValue(second.fs);
    composition.jobs.mockReturnValue(second.jobs);
    expect((await facade.install()).state).toBe('verified-installed');
    expect(first.jobs.runInstaller).toHaveBeenCalledTimes(1);
    expect(second.jobs.runInstaller).toHaveBeenCalledTimes(1);
  });

  it('publishes only after original return, re-observation and complete payload durability', async () => {
    const h = harness();
    const result = await h.transaction().install();
    expect(result.state).toBe('verified-installed');
    expect(result.readiness).toEqual(READINESS_UNAVAILABLE);
    expect(h.events.indexOf('attempt-durable')).toBeLessThan(h.events.indexOf('official-install'));
    expect(h.events.indexOf('owner:installing')).toBeLessThan(h.events.indexOf('official-install'));
    expect(h.events.indexOf('returned:fresh-verifier')).toBeLessThan(
      h.events.indexOf('payload-durable')
    );
    expect(h.events.indexOf('payload-durable')).toBeLessThan(h.events.indexOf('publish'));
    expect(h.events.indexOf('publish')).toBeLessThan(h.events.indexOf('release'));
    expect(h.owner?.births).toHaveLength(2);
  });

  it('joins one in-progress original and never repeats an installer on the same transaction', async () => {
    const h = harness();
    const transaction = h.transaction();
    const first = transaction.install();
    expect(transaction.install({ repair: true })).toBe(first);
    await first;
    expect(h.jobs.runInstaller).toHaveBeenCalledTimes(1);
    expect(transaction.install()).toBe(first);
  });

  it('reuses through a fresh attempt journal without installer or immutable-chain writes', async () => {
    const old = oldInstallation();
    const before = canonicalDigest(old);
    const h = harness(old);
    const result = await h.transaction().install();
    expect(result.state).toBe('verified-reused');
    expect(old.current.file.sha256).not.toBe(old.current.pointer.manifestDigest);
    expect(result.state === 'verified-reused' && result.currentManifestDigest).toBe(
      old.current.pointer.manifestDigest
    );
    expect(h.reuse?.currentManifestDigest).toBe(old.current.pointer.manifestDigest);
    expect(h.events.indexOf('owner:verifying')).toBeLessThan(h.events.indexOf('fresh-verifier'));
    expect(h.events.indexOf('fresh-verifier')).toBeLessThan(h.events.indexOf('owner:reusing'));
    expect(h.events.indexOf('owner:reusing')).toBeLessThan(h.events.indexOf('reuse-journal'));
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.fs.stageCandidate).not.toHaveBeenCalled();
    expect(h.fs.makeCandidateDurable).not.toHaveBeenCalled();
    expect(h.fs.publish).not.toHaveBeenCalled();
    expect(h.reuse?.installer).toEqual({ kind: 'not-invoked' });
    expect(h.reuse?.freshVerification.installer).toEqual({ kind: 'not-invoked' });
    expect(h.reuse?.binding.attemptId).not.toBe(oldBinding.attemptId);
    expect(canonicalDigest(old)).toBe(before);
    const historical = h.inspect().status;
    expect(historical.state === 'installed-files' && historical.lastFreshVerifiedVersion).toBe(
      '153.0.8010.12'
    );
  });

  it('explicit repair stages a new candidate and preserves the old pointer until publish', async () => {
    const old = oldInstallation();
    const h = harness(old);
    const publish = h.fs.publish;
    h.fs.publish = vi.fn(async (...args: Parameters<InstallationFilesystem['publish']>) => {
      expect(h.inspect().current).toEqual(old.current);
      expect(args[2].installationId).not.toBe(old.manifest.installationId);
      return publish(...args);
    });
    const result = await h.transaction().install({ repair: true });
    expect(result.state).toBe('verified-installed');
    expect(h.jobs.runInstaller).toHaveBeenCalledTimes(1);
    expect(h.fs.bindExistingCandidate).not.toHaveBeenCalled();
  });

  it('concurrent foreign reservation refuses before staging or any native original', async () => {
    const h = harness();
    h.fs.acquireReservation = vi.fn(async () => {
      throw new InstallationFailure('PUBLICATION_BUSY');
    });
    const result = await h.transaction().install();
    expect(result).toMatchObject({
      state: 'refused',
      cause: 'PUBLICATION_BUSY',
      publicationMayHaveChanged: false,
    });
    expect(h.fs.stageCandidate).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it('classifies acquired originals as uncertain even when reservation acquisition rejects before returning its handle', async () => {
    const h = harness();
    const acquire = h.fs.acquireReservation;
    h.fs.acquireReservation = vi.fn(
      async (...args: Parameters<InstallationFilesystem['acquireReservation']>) => {
        await acquire(...args);
        throw new InstallationFailure('RECORD_FAILED');
      }
    );
    expect(await h.transaction().install()).toMatchObject({
      state: 'uncertain',
      cause: 'RECORD_FAILED',
    });
    expect(h.fs.stageCandidate).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it('refuses a changed current observed after reservation before candidate acquisition', async () => {
    const h = harness();
    let reads = 0;
    h.fs.inspectExisting = vi.fn<InstallationFilesystem['inspectExisting']>(async () => ({
      ...h.inspect(),
      current: ++reads === 1 ? { state: 'absent' } : { state: 'unknown' },
    }));
    expect(await h.transaction().install()).toMatchObject({
      state: 'uncertain',
      cause: 'ROOT_CHANGED',
    });
    expect(h.fs.stageCandidate).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
  });

  it.each(['nonce', 'generation', 'installationId'] as const)(
    'rejects a fresh reply with foreign %s',
    async (field) => {
      const h = harness();
      h.changeReply((reply) => ({
        ...reply,
        binding: {
          ...reply.binding,
          [field]: field === 'generation' ? reply.binding.generation + 1 : 'foreign',
        },
      }));
      expect(await h.transaction().install()).toMatchObject({
        state: 'uncertain',
        cause: 'BINDING_MISMATCH',
      });
      expect(h.fs.publish).not.toHaveBeenCalled();
      expect(h.fs.releaseReservation).not.toHaveBeenCalled();
    }
  );

  it('rejects a digest-equal reply when executable inode changed', async () => {
    const h = harness();
    h.changeReply((reply) => ({
      ...reply,
      executableIdentity: { ...reply.executableIdentity, inode: '2' },
    }));
    expect(await h.transaction().install()).toMatchObject({ cause: 'HASH_MISMATCH' });
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it('rejects an authentic job handle with unresolved pipe/raw custody', async () => {
    const h = harness();
    h.changeJob((facts) => ({ ...facts, stdout: { ...facts.stdout, rawFlushedClosed: false } }));
    expect(await h.transaction().install()).toMatchObject({ cause: 'CUSTODY_UNCERTAIN' });
    expect(h.jobs.runVerifier).not.toHaveBeenCalled();
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it('rejects a copied handle even when all serialized facts match', async () => {
    const h = harness();
    const run = h.jobs.runInstaller;
    h.jobs.runInstaller = vi.fn(async (request) => {
      const actual = await run(request);
      return { ...actual, handle: { ...actual.handle } };
    });
    expect(await h.transaction().install()).toMatchObject({ cause: 'CUSTODY_UNCERTAIN' });
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it('rejects renewed bounds in an otherwise matching original birth', async () => {
    const h = harness();
    h.changeJob((facts) => ({
      ...facts,
      birth: facts.birth && {
        ...facts.birth,
        bounds: { ...facts.birth.bounds, workEnd: facts.birth.bounds.workEnd + 1 },
      },
    }));
    expect(await h.transaction().install()).toMatchObject({ cause: 'BINDING_MISMATCH' });
    expect(h.jobs.runVerifier).not.toHaveBeenCalled();
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it('preserves original installer failure and enters no verifier/publication', async () => {
    const h = harness();
    h.changeJob((facts) => ({
      ...facts,
      exitCode: 1,
      firstCause: 'INSTALLER_FAILED',
      cleanupCauses: ['IO_FAILED'],
      descendantDisposition: 'unknown',
    }));
    expect(await h.transaction().install()).toMatchObject({ cause: 'INSTALLER_FAILED' });
    expect(h.jobs.runVerifier).not.toHaveBeenCalled();
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it('never replaces current after the filesystem durability gate fails', async () => {
    const h = harness();
    h.fs.makeCandidateDurable = vi.fn(async () => {
      throw new InstallationFailure('IO_FAILED');
    });
    expect(await h.transaction().install()).toMatchObject({
      cause: 'IO_FAILED',
      publicationMayHaveChanged: false,
    });
    expect(h.fs.publish).not.toHaveBeenCalled();
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it('requires candidate revalidation before publication', async () => {
    const h = harness();
    h.fs.revalidateCandidate = vi.fn(async () => {
      throw new InstallationFailure('ROOT_CHANGED');
    });
    expect(await h.transaction().install()).toMatchObject({
      cause: 'ROOT_CHANGED',
      publicationMayHaveChanged: false,
    });
    expect(h.fs.makeCandidateDurable).not.toHaveBeenCalled();
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it('admits no installer when attempt creation fails its durability gate', async () => {
    const h = harness();
    h.fs.createAttempt = vi.fn(async () => {
      throw new InstallationFailure('IO_FAILED');
    });
    expect(await h.transaction().install()).toMatchObject({ cause: 'IO_FAILED' });
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it('does not publish after the fixed work deadline expires during installation', async () => {
    const h = harness();
    const install = h.jobs.runInstaller;
    h.jobs.runInstaller = vi.fn(async (request) => {
      const result = await install(request);
      h.setClock(1002);
      return result;
    });
    expect(await h.transaction().install()).toMatchObject({
      cause: 'WORK_EXPIRED',
      publicationMayHaveChanged: false,
    });
    expect(h.jobs.runVerifier).not.toHaveBeenCalled();
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it('retains post-rename uncertainty instead of rollback or clean release', async () => {
    const h = harness();
    h.fs.publish = vi.fn(async () => {
      throw new InstallationFailure('PUBLICATION_UNCERTAIN', true);
    });
    expect(await h.transaction().install()).toMatchObject({
      state: 'uncertain',
      cause: 'PUBLICATION_UNCERTAIN',
      publicationMayHaveChanged: true,
    });
    expect(h.fs.publish).toHaveBeenCalledTimes(1);
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it('preserves an original filesystem cause with ambiguous publication effects', async () => {
    const h = harness();
    h.fs.publish = vi.fn(async () => {
      throw new InstallationFailure('IO_FAILED', true);
    });
    expect(await h.transaction().install()).toMatchObject({
      state: 'uncertain',
      cause: 'IO_FAILED',
      publicationMayHaveChanged: true,
    });
    expect(h.fs.publish).toHaveBeenCalledTimes(1);
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it('keeps durable publication uncertainty when reservation release fails', async () => {
    const h = harness();
    h.fs.releaseReservation = vi.fn(async () => {
      throw new InstallationFailure('OWNERSHIP_UNCERTAIN');
    });
    expect(await h.transaction().install()).toMatchObject({
      state: 'uncertain',
      cause: 'OWNERSHIP_UNCERTAIN',
      publicationMayHaveChanged: true,
    });
    expect(h.fs.publish).toHaveBeenCalledTimes(1);
  });

  it('refuses a forged reuse-journal digest and never rewrites current', async () => {
    const h = harness(oldInstallation());
    h.fs.writeReuseJournal = vi.fn(async (_reservation, attempt) =>
      file(join(attempt.attemptRoot, 'reuse.json'))
    );
    expect(await h.transaction().install()).toMatchObject({ cause: 'OWNERSHIP_UNCERTAIN' });
    expect(h.fs.publish).not.toHaveBeenCalled();
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it('does not turn clock regression into a renewed admission window', async () => {
    const h = harness();
    const validate = h.fs.validateLibrary;
    h.fs.validateLibrary = vi.fn(async () => {
      const library = await validate();
      h.setClock(0);
      return library;
    });
    expect(await h.transaction().install()).toMatchObject({ cause: 'CLOCK_UNAVAILABLE' });
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
  });

  it('refuses abort before any reservation/native effect', async () => {
    const h = harness();
    const abort = new AbortController();
    abort.abort();
    expect(await h.transaction().install({ signal: abort.signal })).toMatchObject({
      state: 'refused',
      cause: 'ABORTED',
    });
    expect(h.fs.acquireReservation).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
  });
});

describe('existing-only startup verification prerequisite (semantic controls, physical acceptance UNRUN)', () => {
  it('refuses a missing runtime before reservation, stage, installer or verifier', async () => {
    const h = harness();
    const result = await h.transaction().install({ existingOnly: true });
    expect(result).toMatchObject({
      state: 'refused',
      cause: 'VERIFICATION_UNAVAILABLE',
      publicationMayHaveChanged: false,
    });
    expect(h.fs.acquireReservation).not.toHaveBeenCalled();
    expect(h.fs.stageCandidate).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.jobs.runVerifier).not.toHaveBeenCalled();
  });
  it('joins a held original verifier before releasing an aborted existing-only reuse', async () => {
    const h = harness(oldInstallation()),
      abort = new AbortController();
    const original = h.jobs.runVerifier;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.jobs.runVerifier = vi.fn(async (request) => {
      entered();
      await held;
      return original(request);
    });
    const result = h.transaction().install({ existingOnly: true, signal: abort.signal });
    await started;
    abort.abort();
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
    release();
    expect(await result).toMatchObject({ state: 'refused', cause: 'ABORTED' });
    expect(h.fs.releaseReservation).toHaveBeenCalledTimes(1);
    expect(h.fs.writeReuseJournal).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.events.indexOf('returned:fresh-verifier')).toBeLessThan(h.events.indexOf('release'));
  });

  it('waits for the original held reuse publication before cancellation release', async () => {
    const h = harness(oldInstallation()),
      abort = new AbortController();
    const original = h.fs.writeReuseJournal;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fs.writeReuseJournal = vi.fn(async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      entered();
      await held;
      return result;
    });
    const result = h.transaction().install({ existingOnly: true, signal: abort.signal });
    await started;
    abort.abort();
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
    release();
    expect(await result).toMatchObject({ state: 'refused', cause: 'ABORTED' });
    expect(h.reuse).not.toBeNull();
    expect(h.fs.releaseReservation).toHaveBeenCalledTimes(1);
    expect(h.fs.publish).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    'preserves ABORTED when original release fails with %s',
    async (failure) => {
      const h = harness(oldInstallation()),
        abort = new AbortController();
      const original = h.jobs.runVerifier;
      h.jobs.runVerifier = vi.fn(async (request) => {
        const run = await original(request);
        abort.abort();
        return run;
      });
      h.fs.releaseReservation = vi.fn(async () => {
        throw failure;
      });
      expect(
        await h.transaction().install({ existingOnly: true, signal: abort.signal })
      ).toMatchObject({ state: 'uncertain', cause: 'ABORTED' });
      expect(h.fs.releaseReservation).toHaveBeenCalledTimes(1);
    }
  );

  it.each([false, undefined])(
    'keeps uncertainty when release changes custody then throws %s',
    async (failure) => {
      const h = harness(oldInstallation()),
        abort = new AbortController();
      const verifier = h.jobs.runVerifier,
        release = h.fs.releaseReservation;
      h.jobs.runVerifier = vi.fn(async (request) => {
        const run = await verifier(request);
        abort.abort();
        return run;
      });
      h.fs.releaseReservation = vi.fn(async (handle) => {
        await release(handle);
        throw failure;
      });
      expect(
        await h.transaction().install({ existingOnly: true, signal: abort.signal })
      ).toMatchObject({ state: 'uncertain', cause: 'ABORTED' });
      expect(h.fs.custody().reservation).toBe('released');
      expect(h.fs.releaseReservation).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['held', 'unreadable'] as const)(
    'requires genuine final custody after a fulfilled cancellation release: %s',
    async (condition) => {
      const h = harness(oldInstallation()),
        abort = new AbortController();
      const original = h.jobs.runVerifier;
      h.jobs.runVerifier = vi.fn(async (request) => {
        const run = await original(request);
        abort.abort();
        return run;
      });
      h.fs.releaseReservation = vi.fn(async () => {
        if (condition === 'unreadable')
          h.fs.custody = () => {
            throw undefined;
          };
        // A fulfilled DTO alone leaves the original reservation held.
      });
      expect(
        await h.transaction().install({ existingOnly: true, signal: abort.signal })
      ).toMatchObject({ state: 'uncertain', cause: 'ABORTED' });
      expect(h.fs.releaseReservation).toHaveBeenCalledTimes(1);
    }
  );

  it('does not release ordinary install reuse on cancellation', async () => {
    const h = harness(oldInstallation()),
      abort = new AbortController();
    const original = h.jobs.runVerifier;
    h.jobs.runVerifier = vi.fn(async (request) => {
      const run = await original(request);
      abort.abort();
      return run;
    });
    expect(await h.transaction().install({ signal: abort.signal })).toMatchObject({
      state: 'uncertain',
      cause: 'ABORTED',
    });
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it('does not release an aborted verifier whose original returned custody failed', async () => {
    const h = harness(oldInstallation()),
      abort = new AbortController();
    h.changeJob((facts) => ({ ...facts, stopRequested: true }));
    const original = h.jobs.runVerifier;
    h.jobs.runVerifier = vi.fn(async (request) => {
      const run = await original(request);
      abort.abort();
      return run;
    });
    expect(
      await h.transaction().install({ existingOnly: true, signal: abort.signal })
    ).toMatchObject({ state: 'uncertain', cause: 'CUSTODY_UNCERTAIN' });
    expect(h.fs.releaseReservation).not.toHaveBeenCalled();
  });

  it.each(['files-pending', 'files-failed', 'jobs-pending', 'jobs-failed', 'expired'] as const)(
    'retains canceled reuse reservation when original custody is %s',
    async (condition) => {
      const h = harness(oldInstallation()),
        abort = new AbortController();
      const original = h.jobs.runVerifier;
      h.jobs.runVerifier = vi.fn(async (request) => {
        const run = await original(request);
        abort.abort();
        if (condition === 'files-pending' || condition === 'files-failed') {
          const custody = h.fs.custody();
          h.fs.custody = () => ({
            ...custody,
            pendingOperations: condition === 'files-pending' ? 1 : 0,
            firstCause: condition === 'files-failed' ? 'IO_FAILED' : null,
          });
        }
        if (condition === 'jobs-pending' || condition === 'jobs-failed')
          h.jobs.custody = () => ({
            pending: condition === 'jobs-pending' ? 1 : 0,
            firstCause: condition === 'jobs-failed' ? 'IO_FAILED' : null,
          });
        if (condition === 'expired') h.setClock(Number.MAX_SAFE_INTEGER);
        return run;
      });
      expect(
        await h.transaction().install({ existingOnly: true, signal: abort.signal })
      ).toMatchObject({ state: 'uncertain', cause: 'ABORTED' });
      expect(h.fs.releaseReservation).not.toHaveBeenCalled();
    }
  );

  it('existing-only cannot be turned into repair/install by a conflicting option', async () => {
    const h = harness(oldInstallation());
    expect(await h.transaction().install({ existingOnly: true, repair: true })).toMatchObject({
      state: 'refused',
      cause: 'VERIFICATION_UNAVAILABLE',
    });
    expect(h.fs.acquireReservation).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
  });
  it('invalid historical files refuse before any original native job', async () => {
    const h = harness();
    h.fs.inspectExisting = vi.fn(async () => ({
      ...h.inspect(),
      status: {
        ...statusCommon,
        state: 'invalid' as const,
        cause: 'INSTALLATION_INVALID' as const,
      },
    }));
    expect(await h.transaction().install({ existingOnly: true })).toMatchObject({
      state: 'refused',
      cause: 'INSTALLATION_INVALID',
    });
    expect(h.fs.acquireReservation).not.toHaveBeenCalled();
    expect(h.jobs.runVerifier).not.toHaveBeenCalled();
  });
  it('facade fresh verification invokes the original verifier for existing files without installer or mode readiness', async () => {
    const h = harness(oldInstallation());
    composition.filesystem.mockReset().mockReturnValue(h.fs);
    composition.jobs.mockReset().mockReturnValue(h.jobs);
    const facade = createRuntimeInstallation(config);
    const result = await facade.verifyExisting();
    expect(result.state).toBe('verified-reused');
    expect(result.readiness).toEqual(READINESS_UNAVAILABLE);
    expect(h.jobs.runVerifier).toHaveBeenCalledTimes(1);
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.fs.stageCandidate).not.toHaveBeenCalled();
    expect(h.fs.publish).not.toHaveBeenCalled();
    expect(h.reuse?.binding.attemptId).not.toBe(oldBinding.attemptId);
  });
  it('concurrent existing verification joins its exact original held verifier through natural settlement', async () => {
    const h = harness(oldInstallation());
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    const originalVerifier = h.jobs.runVerifier.bind(h.jobs);
    h.jobs.runVerifier = vi.fn(async (request: Parameters<InstallationJobs['runVerifier']>[0]) => {
      await held;
      return originalVerifier(request);
    });
    composition.filesystem.mockReset().mockReturnValue(h.fs);
    composition.jobs.mockReset().mockReturnValue(h.jobs);
    const facade = createRuntimeInstallation(config),
      original = facade.verifyExisting();
    let settled = false;
    void original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await vi.waitFor(() => expect(h.jobs.runVerifier).toHaveBeenCalledTimes(1));
      expect(facade.verifyExisting()).toBe(original);
      expect(settled).toBe(false);
      expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    } finally {
      release();
      await original;
    }
    expect(settled).toBe(true);
  });
  it('active ordinary installation cannot lend a fresh existing-verification result or launch another original', async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    const originalInspection = h.fs.inspectExisting.bind(h.fs);
    h.fs.inspectExisting = vi.fn(
      async (options: Parameters<InstallationFilesystem['inspectExisting']>[0]) => {
        await held;
        return originalInspection(options);
      }
    );
    composition.filesystem.mockReset().mockReturnValue(h.fs);
    composition.jobs.mockReset().mockReturnValue(h.jobs);
    const facade = createRuntimeInstallation(config),
      original = facade.install();
    try {
      await vi.waitFor(() => expect(h.fs.inspectExisting).toHaveBeenCalledTimes(1));
      expect(await facade.verifyExisting()).toMatchObject({
        state: 'refused',
        cause: 'PUBLICATION_BUSY',
        readiness: READINESS_UNAVAILABLE,
      });
      expect(composition.jobs).toHaveBeenCalledTimes(1);
      expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    } finally {
      release();
      await original;
    }
  });
  it('unsupported platform refuses before filesystem inspection or jobs', async () => {
    const h = harness();
    composition.filesystem.mockReset().mockReturnValue(h.fs);
    composition.jobs.mockReset().mockReturnValue(h.jobs);
    const facade = createRuntimeInstallation({ ...config, platform: 'linux' });
    expect(await facade.verifyExisting()).toMatchObject({
      state: 'refused',
      cause: 'PLATFORM_UNSUPPORTED',
    });
    expect(h.fs.inspectExisting).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.jobs.runVerifier).not.toHaveBeenCalled();
  });
  it('changed current pointer under original reservation refuses instead of installing a replacement', async () => {
    const h = harness(oldInstallation());
    h.fs.inspectExisting = vi
      .fn()
      .mockResolvedValueOnce(h.inspect())
      .mockResolvedValueOnce({ ...h.inspect(), current: { state: 'absent' } });
    expect(await h.transaction().install({ existingOnly: true })).toMatchObject({
      state: 'uncertain',
      cause: 'ROOT_CHANGED',
    });
    expect(h.fs.stageCandidate).not.toHaveBeenCalled();
    expect(h.jobs.runInstaller).not.toHaveBeenCalled();
    expect(h.jobs.runVerifier).not.toHaveBeenCalled();
  });
});
