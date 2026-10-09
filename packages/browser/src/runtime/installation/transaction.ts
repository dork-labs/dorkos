import { join } from 'node:path';
import {
  AttemptBindingSchema,
  AttemptBoundsSchema,
  DigestSchema,
  FileIdentitySchema,
  FreshVerifierReplySchema,
  FreshVerifierRequestSchema,
  IdSchema,
  InstallationConfigurationSchema,
  InstallationFailure,
  INSTALLATION_LIMITS,
  INSTALLATION_TARGET,
  ManifestSchema,
  READINESS_UNAVAILABLE,
  ReuseRecordSchema,
  VerificationRecordSchema,
  canonicalDigest,
  failureCode,
  parseRecord,
  recordBytes,
  sameBinding,
  sameFileIdentity,
  sha256,
  type AttemptBinding,
  type AttemptBounds,
  type CandidateSnapshot,
  type FailureCode,
  type InstallOptions,
  type InstallationConfiguration,
  type InstallResult,
  type JobFacts,
  type JobRole,
  type JobRun,
  type LibrarySnapshot,
  type OwnerRecord,
  type ReservationHandle,
  type TransactionDependencies,
} from './contracts.js';

function require(value: unknown, code: FailureCode): asserts value {
  if (!value) throw new InstallationFailure(code);
}

/** Fixed-end, single-use local transaction; only the real producers can return local handles. */
export function createInstallationTransaction(
  configuration: InstallationConfiguration,
  dependencies: TransactionDependencies,
  generation: number
): Readonly<{ install(options?: InstallOptions): Promise<InstallResult> }> {
  const parsed = InstallationConfigurationSchema.safeParse(configuration);
  if (!parsed.success) throw new InstallationFailure('INVALID_INSTALL_CONFIGURATION');
  const config = Object.freeze({
    ...parsed.data,
    sourceVintage: Object.freeze(parsed.data.sourceVintage),
    electronFramework: parsed.data.electronFramework
      ? Object.freeze(parsed.data.electronFramework)
      : undefined,
  });
  const { filesystem: fs, jobs } = dependencies;
  // Capture trusted producer receivers once; no public arbitrary-port constructor uses this seam.
  const now = dependencies.now;
  const createId = dependencies.createId;
  let active: Promise<InstallResult> | null = null;
  let lastTime = -Infinity;
  let firstCause: FailureCode | null = null;
  let publicationMayHaveChanged = false;
  let reservation: ReservationHandle | undefined;
  let binding: AttemptBinding | undefined;
  const returned: JobRun[] = [];
  let cancellableReuse: AttemptBounds | undefined;
  const fail = (error: unknown): void => {
    firstCause ??= failureCode(error);
    if (error instanceof InstallationFailure && error.publicationMayHaveChanged)
      publicationMayHaveChanged = true;
  };
  const time = (): number => {
    let current: number;
    try {
      current = Reflect.apply(now, dependencies, []);
    } catch {
      throw new InstallationFailure('CLOCK_UNAVAILABLE');
    }
    require(Number.isFinite(current) && current >= 0 && current >= lastTime, 'CLOCK_UNAVAILABLE');
    lastTime = current;
    return current;
  };
  const check = (bounds: AttemptBounds, signal: AbortSignal | undefined, final = false): void => {
    require(firstCause === null, firstCause ?? 'CUSTODY_UNCERTAIN');
    require(!signal?.aborted, 'ABORTED');
    require(time() < (final ? bounds.finalEnd : bounds.workEnd), final
      ? 'FINAL_EXPIRED'
      : 'WORK_EXPIRED');
  };
  const id = (): string => IdSchema.parse(Reflect.apply(createId, dependencies, []));
  const fsReturned = (): void => {
    const custody = fs.custody(reservation);
    require(custody.pendingOperations === 0 &&
      custody.unresolvedHandles === 0, 'CUSTODY_UNCERTAIN');
    require(custody.firstCause === null, custody.firstCause ?? 'CUSTODY_UNCERTAIN');
    require(custody.reservation === 'held', 'OWNERSHIP_UNCERTAIN');
  };
  const allJobsReturned = (): void => {
    for (const job of returned) jobs.requireReturned(job.handle);
    const custody = jobs.custody();
    require(custody.pending === 0, 'CUSTODY_UNCERTAIN');
    require(custody.firstCause === null, custody.firstCause ?? 'CUSTODY_UNCERTAIN');
  };
  const jobReturned = (
    run: JobRun,
    role: JobRole,
    expected: AttemptBinding,
    bounds: AttemptBounds,
    argv: readonly string[]
  ): JobFacts => {
    // This authentic local lookup precedes any use of serializable receipt/reply fields.
    const facts = jobs.requireReturned(run.handle);
    returned.push(run);
    require(canonicalDigest(facts) === canonicalDigest(run.facts), 'BINDING_MISMATCH');
    require(facts.role === role &&
      run.handle.role === role &&
      facts.jobId === run.handle.jobId &&
      sameBinding(facts.binding, expected), 'BINDING_MISMATCH');
    require(facts.firstCause === null, facts.firstCause ?? 'CUSTODY_UNCERTAIN');
    require(facts.cleanupCauses.length === 0 &&
      !facts.stopRequested &&
      facts.exitObserved &&
      facts.closeObserved, 'CUSTODY_UNCERTAIN');
    require(facts.exitCode === 0 && facts.signal === null, role === 'official-install'
      ? 'INSTALLER_FAILED'
      : 'VERIFIER_FAILED');
    const birth = facts.birth;
    require(birth &&
      sameBinding(birth.binding, expected) &&
      birth.role === role &&
      birth.jobId === facts.jobId &&
      birth.executable === config.nodeExecutable &&
      canonicalDigest(birth.bounds) === canonicalDigest(bounds) &&
      birth.cwd === join(config.cacheRoot, 'attempts', expected.attemptId) &&
      Number.isSafeInteger(birth.pid) &&
      birth.pid > 0 &&
      canonicalDigest(birth.argv) === canonicalDigest(argv), 'BINDING_MISMATCH');
    for (const [stream, bytes] of [
      [facts.stdout, run.stdout],
      [facts.stderr, run.stderr],
    ] as const) {
      require(stream.eof &&
        stream.closed &&
        stream.rawFlushedClosed &&
        !stream.overflow, 'CUSTODY_UNCERTAIN');
      require(Number.isSafeInteger(stream.observedBytes) &&
        Number.isSafeInteger(stream.retainedBytes) &&
        stream.observedBytes === stream.retainedBytes &&
        stream.retainedBytes === bytes.byteLength &&
        bytes.byteLength <= INSTALLATION_LIMITS.streamBytes, 'RETENTION_EXCEEDED');
    }
    require(facts.descendantDisposition ===
      (role === 'official-install'
        ? 'trusted-installer-return'
        : 'not-applicable'), 'CUSTODY_UNCERTAIN');
    return facts;
  };
  const validateLibrary = (library: LibrarySnapshot): void => {
    require(library.distributionSHA256 ===
      INSTALLATION_TARGET.libraryDistributionSHA256, 'LIBRARY_MISMATCH');
    require(library.cli.path === join(config.libraryRoot, 'cli.js') &&
      library.browsersManifest.path ===
        join(config.libraryRoot, 'browsers.json'), 'LIBRARY_MISMATCH');
    require(library.files.length > 0 &&
      library.files.length <= INSTALLATION_LIMITS.libraryEntries, 'LIBRARY_MISMATCH');
  };
  const validateCandidate = (candidate: CandidateSnapshot, expected: AttemptBinding): void => {
    require(candidate.installationId === expected.installationId &&
      candidate.candidateRoot === join(config.cacheRoot, 'candidates', expected.installationId) &&
      candidate.payloadRoot === join(candidate.candidateRoot, 'payload') &&
      candidate.executable.path ===
        join(candidate.candidateRoot, INSTALLATION_TARGET.executablePath), 'OWNERSHIP_UNCERTAIN');
    FileIdentitySchema.parse(candidate.executable.identity);
    DigestSchema.parse(candidate.executable.sha256);
    DigestSchema.parse(candidate.inventoryDigest);
    require(candidate.executable.identity.type === 'file' &&
      candidate.machOCPU === 16777228, 'INSTALLATION_INVALID');
    require(Number.isSafeInteger(candidate.entries) &&
      candidate.entries > 0 &&
      candidate.entries <= INSTALLATION_LIMITS.payloadEntries &&
      Number.isSafeInteger(candidate.bytes) &&
      candidate.bytes > 0 &&
      candidate.bytes <= INSTALLATION_LIMITS.payloadBytes, 'RETENTION_EXCEEDED');
  };
  const perform = async (options: InstallOptions): Promise<InstallResult> => {
    try {
      require(config.platform === 'darwin' && config.arch === 'arm64', 'PLATFORM_UNSUPPORTED');
      require(!options.signal?.aborted, 'ABORTED');
      const origin = time();
      const bounds = Object.freeze(
        AttemptBoundsSchema.parse({
          origin,
          workEnd: origin + config.workMilliseconds,
          finalEnd: origin + config.finalMilliseconds,
        })
      );
      // Read-only preflight chooses the candidate ID. Re-read after exclusive reservation.
      const before = await fs.inspectExisting({ signal: options.signal });
      check(bounds, options.signal);
      require(before.current.state !== 'unknown' &&
        before.status.state !== 'unverified', 'OWNERSHIP_UNCERTAIN');
      const existing = before.installation;
      const reuse =
        existing !== null && before.status.state === 'installed-files' && !options.repair;
      require(before.status.state !== 'invalid' || options.repair === true, 'INSTALLATION_INVALID');
      // Startup verification cannot stage/install/repair a missing or uncertain current runtime.
      require(options.existingOnly !== true || reuse, 'VERIFICATION_UNAVAILABLE');
      binding = Object.freeze(
        AttemptBindingSchema.parse({
          transactionId: id(),
          attemptId: id(),
          nonce: id(),
          generation,
          installationId: reuse ? existing!.manifest.installationId : id(),
        })
      );
      require(new Set([
        binding.transactionId,
        binding.attemptId,
        binding.nonce,
        ...(reuse ? [] : [binding.installationId]),
      ]).size === (reuse ? 3 : 4), 'BINDING_MISMATCH');
      reservation = await fs.acquireReservation(binding, bounds);
      check(bounds, options.signal);
      const reserved = await fs.inspectExisting({ signal: options.signal });
      require(canonicalDigest(reserved.current) ===
        canonicalDigest(before.current), 'ROOT_CHANGED');
      require(reserved.status.state !== 'unverified', 'OWNERSHIP_UNCERTAIN');
      if (reuse)
        require(reserved.installation &&
          canonicalDigest(reserved.installation) === canonicalDigest(existing), 'ROOT_CHANGED');
      check(bounds, options.signal);
      const attempt = await fs.createAttempt(reservation);
      require(sameBinding(attempt.binding, binding), 'BINDING_MISMATCH');
      const owner = async (phase: OwnerRecord['phase']): Promise<void> => {
        await fs.writeOwner(
          reservation!,
          attempt,
          Object.freeze({
            schemaVersion: 1,
            binding: binding!,
            bounds,
            phase,
            sourceVintage: config.sourceVintage,
            births: returned.flatMap((run) => (run.facts.birth ? [run.facts.birth] : [])),
          })
        );
      };
      await owner('reserved');
      check(bounds, options.signal);
      const library = await fs.validateLibrary();
      validateLibrary(library);
      check(bounds, options.signal);
      const candidate = reuse
        ? await fs.bindExistingCandidate(reservation, attempt, reserved.installation!)
        : await fs.stageCandidate(reservation, attempt);
      require(sameBinding(candidate.binding, binding) &&
        candidate.reuse === reuse, 'BINDING_MISMATCH');
      const sink = fs.createJobSink(reservation, attempt);
      let installer:
        { kind: 'not-invoked' } | { kind: 'invoked'; jobId: string; receiptDigest: string } = {
        kind: 'not-invoked',
      };
      if (!reuse) {
        await owner('installing');
        check(bounds, options.signal);
        const run = await jobs.runInstaller({
          binding,
          bounds,
          attempt,
          candidate,
          library,
          sink,
          signal: options.signal,
        });
        const facts = jobReturned(run, 'official-install', binding, bounds, [
          library.cli.path,
          'install',
          'chromium',
          '--no-shell',
          '--no-remove',
        ]);
        installer = {
          kind: 'invoked',
          jobId: facts.jobId,
          receiptDigest: canonicalDigest(facts),
        };
        check(bounds, options.signal);
      }
      const snapshot = await fs.observeCandidate(candidate);
      validateCandidate(snapshot, binding);
      check(bounds, options.signal);
      // F independently requires this phase for both fresh-install and reuse children.
      await owner('verifying');
      const request = FreshVerifierRequestSchema.parse({
        schemaVersion: 1,
        binding,
        bounds,
        cacheRoot: config.cacheRoot,
        candidateRoot: snapshot.candidateRoot,
        libraryRoot: config.libraryRoot,
        attemptRoot: attempt.attemptRoot,
        attemptIdentity: attempt.identity,
        nodeExecutable: config.nodeExecutable,
        nodeExecutableSHA256: config.nodeExecutableSHA256,
        nodeRuntime: config.nodeRuntime ?? 'node',
        electronFramework: config.electronFramework,
        controllerEntry: config.controllerEntry,
        verifierEntry: config.verifierEntry,
        sourceManifestPath: config.sourceManifestPath,
        sourceVintage: config.sourceVintage,
        executablePath: INSTALLATION_TARGET.executablePath,
        executableSHA256: snapshot.executable.sha256,
        executableIdentity: snapshot.executable.identity,
        libraryDistributionSHA256: library.distributionSHA256,
        expectedVersion: INSTALLATION_TARGET.observedVersion,
        chromiumRevision: INSTALLATION_TARGET.chromiumRevision,
        platform: INSTALLATION_TARGET.platform,
        arch: INSTALLATION_TARGET.arch,
      });
      recordBytes(request, INSTALLATION_LIMITS.replyBytes);
      check(bounds, options.signal);
      const verifier = await jobs.runVerifier({
        binding,
        bounds,
        attempt,
        candidate,
        library,
        sink,
        request,
        signal: options.signal,
      });
      const verifierFacts = jobReturned(verifier, 'fresh-verifier', binding, bounds, [
        config.verifierEntry,
      ]);
      // Only the original existing-only verifier return can authorize cancellation cleanup.
      if (reuse && options.existingOnly === true) cancellableReuse = bounds;
      check(bounds, options.signal);
      const reply = parseRecord(
        verifier.stdout,
        FreshVerifierReplySchema,
        INSTALLATION_LIMITS.replyBytes
      );
      require(sameBinding(reply.binding, binding), 'BINDING_MISMATCH');
      require(reply.executableSHA256 === snapshot.executable.sha256 &&
        sameFileIdentity(reply.executableIdentity, snapshot.executable.identity), 'HASH_MISMATCH');
      require(reply.libraryDistributionSHA256 === library.distributionSHA256, 'LIBRARY_MISMATCH');
      require(reply.sourceManifestSHA256 ===
        config.sourceVintage.sourceManifestSHA256, 'SOURCE_MISMATCH');
      require(reply.machOCPU === snapshot.machOCPU, 'INSTALLATION_INVALID');
      await fs.revalidateCandidate(candidate, snapshot);
      check(bounds, options.signal);
      allJobsReturned();
      fsReturned();
      const verification = VerificationRecordSchema.parse({
        schemaVersion: 1,
        canonicalFormat: 'installation-canonical-v1',
        binding,
        installer,
        verifier: {
          jobId: verifierFacts.jobId,
          receiptDigest: canonicalDigest(verifierFacts),
          replyDigest: sha256(verifier.stdout),
        },
        reply,
        candidateInventoryDigest: snapshot.inventoryDigest,
        libraryDistributionSHA256: library.distributionSHA256,
        sourceManifestSHA256: config.sourceVintage.sourceManifestSHA256,
      });
      let currentManifestDigest: string;
      let journalDigest: string;
      if (reuse) {
        // No candidate/current/manifest/verification mutation in this branch.
        await owner('reusing');
        const journal = ReuseRecordSchema.parse({
          schemaVersion: 1,
          kind: 'verified-reuse',
          binding,
          installer: { kind: 'not-invoked' },
          currentManifestDigest: reserved.installation!.current.pointer.manifestDigest,
          historicalVerificationDigest: reserved.installation!.verificationFile.sha256,
          freshVerification: verification,
        });
        recordBytes(journal, INSTALLATION_LIMITS.journalBytes);
        check(bounds, options.signal);
        const written = await fs.writeReuseJournal(reservation, attempt, journal);
        require(written.path === join(attempt.attemptRoot, 'reuse.json') &&
          written.sha256 ===
            sha256(recordBytes(journal, INSTALLATION_LIMITS.journalBytes)), 'OWNERSHIP_UNCERTAIN');
        const unchanged = await fs.inspectExisting({ signal: options.signal });
        require(canonicalDigest(unchanged.current) === canonicalDigest(reserved.current) &&
          canonicalDigest(unchanged.installation) ===
            canonicalDigest(reserved.installation), 'ROOT_CHANGED');
        journalDigest = written.sha256;
        currentManifestDigest = reserved.installation!.current.pointer.manifestDigest;
      } else {
        await owner('publishing');
        check(bounds, options.signal);
        await fs.makeCandidateDurable(candidate, snapshot);
        await fs.revalidateCandidate(candidate, snapshot);
        check(bounds, options.signal);
        allJobsReturned();
        fsReturned();
        const manifest = ManifestSchema.parse({
          schemaVersion: 1,
          installationId: binding.installationId,
          packageName: INSTALLATION_TARGET.packageName,
          packageVersion: INSTALLATION_TARGET.packageVersion,
          libraryDistributionSHA256: library.distributionSHA256,
          chromiumRevision: INSTALLATION_TARGET.chromiumRevision,
          observedVersion: reply.observedVersion,
          platform: reply.platform,
          arch: reply.arch,
          executablePath: INSTALLATION_TARGET.executablePath,
          executableSHA256: snapshot.executable.sha256,
          verifierEvidence: {
            attemptId: binding.attemptId,
            generation: binding.generation,
            evidenceDigest: canonicalDigest(verification),
          },
        });
        recordBytes(manifest, INSTALLATION_LIMITS.manifestBytes);
        const published = await fs.publish(
          reservation,
          candidate,
          manifest,
          verification,
          reserved.current
        );
        publicationMayHaveChanged ||= published.pointerReplaced;
        require(published.state === 'durable' &&
          published.pointerReplaced &&
          published.firstCause === null, published.firstCause ?? 'PUBLICATION_UNCERTAIN');
        require(published.currentAfter.state === 'present' &&
          published.currentAfter.pointer.installationId === binding.installationId &&
          published.currentAfter.pointer.manifestDigest ===
            published.manifestDigest, 'PUBLICATION_UNCERTAIN');
        require(published.manifestDigest ===
          sha256(recordBytes(manifest, INSTALLATION_LIMITS.manifestBytes)) &&
          canonicalDigest(published.currentBefore) ===
            canonicalDigest(reserved.current), 'PUBLICATION_UNCERTAIN');
        require(published.verificationDigest ===
          sha256(
            recordBytes(verification, INSTALLATION_LIMITS.journalBytes)
          ), 'PUBLICATION_UNCERTAIN');
        currentManifestDigest = published.manifestDigest;
        journalDigest = published.verificationDigest;
      }
      // Publication/journal completion cannot hide late original, close or end uncertainty.
      check(bounds, options.signal, true);
      allJobsReturned();
      fsReturned();
      await fs.releaseReservation(reservation);
      check(bounds, options.signal, true);
      const final = fs.custody(reservation);
      require(final.reservation === 'released' &&
        final.pendingOperations === 0 &&
        final.unresolvedHandles === 0 &&
        final.firstCause === null, 'CUSTODY_UNCERTAIN');
      return Object.freeze({
        state: reuse ? 'verified-reused' : 'verified-installed',
        cause: null,
        installationId: binding.installationId,
        attemptId: binding.attemptId,
        generation: binding.generation,
        observedVersion: reply.observedVersion,
        executableSHA256: reply.executableSHA256,
        platform: reply.platform,
        arch: reply.arch,
        currentManifestDigest,
        journalDigest,
        readiness: READINESS_UNAVAILABLE,
      });
    } catch (error) {
      fail(error);
      // Cancellation cannot accept verification, but clean live originals may release their lease.
      // Serialized reservations, failed producers and expired final windows never enter this path.
      let cancellationReleased = false;
      if (
        firstCause === 'ABORTED' &&
        cancellableReuse &&
        reservation &&
        !publicationMayHaveChanged
      ) {
        try {
          allJobsReturned();
          fsReturned();
          require(time() < cancellableReuse.finalEnd, 'FINAL_EXPIRED');
          await fs.releaseReservation(reservation);
          cancellationReleased = true;
        } catch (cleanupError) {
          fail(cleanupError);
        }
      }
      // Acquisition can reject after F registered originals but before returning a handle.
      // Assignment alone is therefore never evidence of zero acquisition or returned custody.
      let uncertain = (!!reservation && !cancellationReleased) || publicationMayHaveChanged;
      try {
        const files = fs.custody(reservation);
        const processes = jobs.custody();
        uncertain ||=
          files.reservation !== 'released' ||
          files.pendingOperations !== 0 ||
          files.unresolvedHandles !== 0 ||
          files.firstCause !== null ||
          processes.pending !== 0 ||
          processes.firstCause !== null;
      } catch {
        uncertain = true;
      }
      // Retain failed candidate/reservation/original evidence. No retry, guessed close or rollback.
      return Object.freeze({
        state: uncertain ? 'uncertain' : 'refused',
        cause: firstCause!,
        ...(binding ? { attemptId: binding.attemptId } : {}),
        publicationMayHaveChanged,
        readiness: READINESS_UNAVAILABLE,
      });
    }
  };
  return Object.freeze({
    install(options: InstallOptions = {}): Promise<InstallResult> {
      // Promise is owned before any user/producer callback can acquire effects.
      active ??= Promise.resolve().then(() => perform(Object.freeze({ ...options })));
      return active;
    },
  });
}
