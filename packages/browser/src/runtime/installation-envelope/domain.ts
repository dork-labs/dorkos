/* eslint-disable max-lines -- One transaction state machine keeps owner-local references, terminal admission and result accounting together; splitting its closures would obscure their shared custody. */
import { createHash } from 'node:crypto';
import {
  type Accounting,
  type Cause,
  type RunnerResult,
  RunnerSchema,
  ReplySchema,
  pins,
} from './records.js';
import {
  JobSchema,
  PublicationSchema,
  FixtureLedger,
  metrics,
  bindingMatches,
  canonicalDigest,
  same,
  validateBudgets,
  type Publication,
} from './correlation.js';
import { EnvelopeOwner, Intake, reservations, type BytePort } from './owner.js';
import { decodeJSON, EnvelopeError, intakeFailureCause } from './scanner.js';
import { freezeData, guardedData, inspectOwnData, type PreboundedData } from './own-data.js';

import type {
  JobReference,
  ResultReference,
  WitnessReference,
  PublicationReference,
  InstallReference,
  Registered,
  Witness,
  Delivery,
  Result,
  InstallResult,
} from './references.js';
export type {
  JobReference,
  ResultReference,
  WitnessReference,
  PublicationReference,
  InstallReference,
} from './references.js';
import { composeFixture, evidenceFields } from './composition.js';
import { replySpan } from './framing.js';

/** No production or supported-runner constructor exists in this leaf. */
export interface FixtureDomainConfig {
  readonly transactionId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly installationId: string;
  readonly clock: () => number;
  readonly verifierDuration: number;
  readonly workEnd: number;
  readonly finalEnd: number;
  readonly signal: AbortSignal;
  readonly budgets: PreboundedData;
}
/** Fixture authority and consumer interfaces are returned separately, not encoded in wire records. */
export function createFixtureEnvelopeDomain(input: FixtureDomainConfig) {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const fields = [
    'transactionId',
    'attemptId',
    'generation',
    'installationId',
    'clock',
    'verifierDuration',
    'workEnd',
    'finalEnd',
    'signal',
    'budgets',
  ];
  if (
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== fields.length ||
    fields.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
  )
    throw new EnvelopeError('INVALID_INSTALL_CONFIGURATION');
  const config = Object.freeze(
    Object.fromEntries(fields.map((key) => [key, descriptors[key]!.value]))
  ) as unknown as FixtureDomainConfig;
  if (
    !Number.isFinite(config.verifierDuration) ||
    config.verifierDuration <= 0 ||
    typeof config.clock !== 'function' ||
    !(config.signal instanceof AbortSignal)
  )
    throw new EnvelopeError('INVALID_INSTALL_CONFIGURATION');
  const owner = new EnvelopeOwner(config.clock, config.workEnd, config.finalEnd, config.signal);
  const check = () => owner.check();
  const readPrebounded = (source: PreboundedData, memberCap = 256, guard = check): unknown => {
    try {
      guard();
      const descriptors = Object.getOwnPropertyDescriptors(source);
      guard();
      const keys = Reflect.ownKeys(source);
      guard();
      if (
        keys.length !== 2 ||
        descriptors.producer?.value !== 'fixture-prebounded-own-data' ||
        !descriptors.value ||
        !('value' in descriptors.value)
      )
        throw new EnvelopeError('RESOURCE_ENFORCEMENT_UNAVAILABLE');
      const data: unknown = descriptors.value.value;
      inspectOwnData(data, guard, memberCap);
      return guardedData(data, guard);
    } catch (error) {
      if (error instanceof EnvelopeError) throw error;
      throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
    }
  };
  const budgets = validateBudgets(readPrebounded(config.budgets));
  check();
  const ledger = new FixtureLedger(budgets);
  const jobs = new WeakMap<JobReference, Registered>();
  const witnesses = new WeakMap<WitnessReference, Witness>();
  const publications = new WeakMap<PublicationReference, Publication>();
  const results = new WeakMap<ResultReference, Result>();
  const installs = new WeakMap<InstallReference, InstallResult>();
  const projections = new WeakMap<InstallReference, object>();
  let sequence = 0;
  let installJob = false;
  let verifierJob = false;
  let active: Delivery | undefined;
  let terminal: InstallReference | undefined;
  let lastPrimary: Cause | null = null;
  let observedPrimary: Cause | null = null;
  let observedIntents = 0;
  // Independent observations retain a bounded fixed-key prefix even if later closure fails.
  // Wire-ledger acceptance cannot restore work or coverage lost before intake.
  const observedMetrics = new Map<string, number>();
  let observedUnknown = false;
  const retainObservedAccounting = (accounting: Accounting) => {
    const next = metrics(accounting);
    let regressed = false;
    for (const [key, value] of next) {
      const previous = observedMetrics.get(key) ?? 0;
      if (value < previous) regressed = true;
      observedMetrics.set(key, Math.max(previous, value));
    }
    observedIntents = Math.max(observedIntents, accounting.cumulativeAcquisitionIntents);
    if (next.size !== 18) observedUnknown = true;
    if (regressed) throw new EnvelopeError('INSTALLATION_INVALID');
  };
  const matchesObservedAccounting = (accounting: Accounting) => {
    const next = metrics(accounting);
    return (
      !observedUnknown &&
      next.size === 18 &&
      observedMetrics.size === 18 &&
      [...next].every(([key, value]) => observedMetrics.get(key) === value)
    );
  };
  let witnessesIssued = 0;
  let publicationIssued = false;
  let publicationLease: object | undefined;
  let currentDigest: string | undefined;
  let officialCompleted: ResultReference | undefined;
  let latestCompleted: ResultReference | undefined;
  let verifierObserved = false;
  let observedAccountingDigest: string | undefined;
  let observationRevision = {};
  const checkOpen = () => {
    if (terminal) throw new EnvelopeError('PUBLICATION_BUSY');
    check();
    if (terminal) throw new EnvelopeError('PUBLICATION_BUSY');
  };
  const checkRegistration = () => {
    checkOpen();
    if (active || owner.cause || lastPrimary || observedPrimary)
      throw new EnvelopeError('PUBLICATION_BUSY');
  };
  const trustedRunner = (data: unknown, guard = check): RunnerResult => {
    guard();
    const parsed = RunnerSchema.safeParse(data);
    guard();
    if (!parsed.success) throw new EnvelopeError('INVALID_ENVELOPE');
    return freezeData(parsed.data);
  };
  const bound = (job: Registered, runner: RunnerResult) => {
    check();
    if (
      runner.jobKind !== job.descriptor.kind ||
      !bindingMatches(runner.jobBinding, job.descriptor.binding)
    )
      throw new EnvelopeError('INSTALLATION_INVALID');
    if (
      runner.verifierReply &&
      (!bindingMatches(runner.verifierReply.jobBinding, job.descriptor.binding) ||
        !same(runner.verifierReply, job.descriptor.expectedReply, check))
    )
      throw new EnvelopeError('VERIFIER_REPLY_INVALID');
  };
  const issuer = Object.freeze({
    /** Trusted mock producer prerequisite: caller guarantees bounded own data before entry. */
    registerJob(source: PreboundedData): JobReference {
      checkRegistration();
      const parsed = JobSchema.safeParse(readPrebounded(source, 256, checkRegistration));
      checkRegistration();
      if (!parsed.success) throw new EnvelopeError('INVALID_INSTALL_CONFIGURATION');
      const descriptor = freezeData(parsed.data);
      const b = descriptor.binding;
      if (
        b.transactionId !== config.transactionId ||
        b.attemptId !== config.attemptId ||
        b.generation !== config.generation ||
        b.installationId !== config.installationId ||
        !bindingMatches(descriptor.expectedReply.jobBinding, b) ||
        descriptor.expectedReply.installationId !== b.installationId ||
        Object.entries(pins).some(
          ([key, value]) => descriptor.expectedReply[key as keyof typeof pins] !== value
        )
      )
        throw new EnvelopeError('INSTALLATION_INVALID');
      if (
        (descriptor.kind === 'official-install' && (installJob || verifierObserved)) ||
        (descriptor.kind === 'fresh-verifier' && verifierJob) ||
        sequence === Number.MAX_SAFE_INTEGER
      )
        throw new EnvelopeError('PUBLICATION_BUSY');
      if (descriptor.kind === 'official-install') installJob = true;
      else verifierJob = true;
      const job = Object.freeze({ fixtureJob: true as const });
      const end =
        descriptor.kind === 'fresh-verifier'
          ? Math.min(owner.workEnd, owner.currentTime + config.verifierDuration)
          : owner.workEnd;
      if (!Number.isFinite(end)) throw new EnvelopeError('INVALID_INSTALL_CONFIGURATION');
      const digest = canonicalDigest(
        {
          descriptor,
          origin: owner.origin,
          workEnd: owner.workEnd,
          finalEnd: owner.finalEnd,
          end,
        },
        checkRegistration
      );
      checkRegistration();
      jobs.set(job, {
        descriptor,
        digest,
        sequence: ++sequence,
        end,
        consumed: false,
      });
      return job;
    },
    /** Independent fixture observation; wire results alone cannot issue this reference. */
    observe(
      jobRef: JobReference,
      source: PreboundedData,
      closure: Readonly<{
        noLateAcquisitions: boolean;
        noAcquisition: boolean;
      }>
    ): WitnessReference {
      const revision = observationRevision;
      checkOpen();
      const job = jobs.get(jobRef);
      if (!job) throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
      const checkObservation = () => {
        checkOpen();
        if (
          job.descriptor.kind === 'fresh-verifier' &&
          installJob &&
          (!officialCompleted || results.get(officialCompleted)?.runner.state !== 'settled')
        )
          throw new EnvelopeError('INSTALLATION_INVALID');
      };
      checkObservation();
      const phase = {};
      owner.reserve(phase, reservations.runner);
      try {
        const data = readPrebounded(source, 4096, checkObservation);
        const runner = trustedRunner(data, checkObservation);
        bound(job, runner);
        checkObservation();
        // Authenticated exact-job failures survive closure/digest failure and later healthy bytes.
        // Retaining these facts is not a custody acknowledgement or owner deadline renewal.
        observedPrimary ??= runner.primaryCause;
        for (const cause of runner.cleanupCauses) owner.cleanup(cause);
        retainObservedAccounting(runner.accounting);
        inspectOwnData(closure, checkObservation);
        const closed = guardedData(closure, checkObservation) as typeof closure;
        if (
          Reflect.ownKeys(closed).length !== 2 ||
          typeof closed.noLateAcquisitions !== 'boolean' ||
          typeof closed.noAcquisition !== 'boolean'
        )
          throw new EnvelopeError('INVALID_ENVELOPE');
        const digest = canonicalDigest(runner, checkObservation);
        const accountingDigest = canonicalDigest(runner.accounting, checkObservation);
        const noLateAcquisitions = closed.noLateAcquisitions;
        const noAcquisition = closed.noAcquisition;
        checkObservation();
        if (witnessesIssued >= 64) throw new EnvelopeError('BUDGET_EXCEEDED');
        const token = Object.freeze({ fixtureWitness: true as const });
        witnesses.set(token, {
          job,
          digest,
          noLateAcquisitions,
          noAcquisition,
        });
        if (job.descriptor.kind === 'fresh-verifier') verifierObserved = true;
        // A completed nested observation owns the newer prefix, including same-intent metrics.
        if (observationRevision === revision) {
          observedAccountingDigest = accountingDigest;
          observedIntents = Math.max(
            observedIntents,
            runner.accounting.cumulativeAcquisitionIntents
          );
          observationRevision = {};
        }
        witnessesIssued++;
        // This independent fixture record aliases the later retained snapshot after exact comparison.
        owner.release(phase);
        return token;
      } catch (e) {
        owner.release(phase);
        throw e;
      }
    },
    /** Prebounded local publication observations, including both canonical paths, are fixture authority only. */
    publication(source: PreboundedData): PublicationReference {
      if (terminal || publicationIssued || publicationLease)
        throw new EnvelopeError('PUBLICATION_BUSY');
      const phase = {};
      // Reserve same-owner admission before even the external reserve clock can reenter.
      publicationLease = phase;
      const guard = () => {
        checkOpen();
        if (publicationLease !== phase || publicationIssued)
          throw new EnvelopeError('PUBLICATION_BUSY');
      };
      try {
        owner.reserve(phase, reservations.local);
        guard();
        const parsed = PublicationSchema.safeParse(readPrebounded(source, 256, guard));
        guard();
        if (!parsed.success) throw new EnvelopeError('INSTALLATION_INVALID');
        const publication = freezeData(parsed.data);
        guard();
        const token = Object.freeze({ fixturePublication: true as const });
        publications.set(token, publication);
        publicationIssued = true;
        currentDigest = publication.currentAfterDigest;
        return token;
      } catch (e) {
        if (!owner.cause) owner.release(phase);
        throw e;
      } finally {
        if (publicationLease === phase) publicationLease = undefined;
      }
    },
    /** Simulate a changed pointer independently of its previously issued observation. */
    replaceCurrent(value: string): void {
      check();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new EnvelopeError('INVALID_ENVELOPE');
      currentDigest = value;
    },
  });
  const domain = Object.freeze({
    /** Same job/key joins the exact active promise. No caller listener or new delivery is allocated. */
    intake(
      jobRef: JobReference,
      key: object,
      port: BytePort | undefined,
      witnessRef: WitnessReference
    ): Promise<ResultReference> {
      if (terminal) return Promise.reject(new EnvelopeError('PUBLICATION_BUSY'));
      const job = jobs.get(jobRef);
      const witness = witnesses.get(witnessRef);
      if (active) {
        if (active.job === job && active.key === key) return active.promise;
        return Promise.reject(new EnvelopeError('PUBLICATION_BUSY'));
      }
      if (
        !job ||
        !witness ||
        witness.job !== job ||
        job.consumed ||
        (lastPrimary !== null && job.result?.state !== 'started') ||
        !port
      )
        return Promise.reject(
          new EnvelopeError(!port ? 'INSTALL_RUNNER_UNAVAILABLE' : 'OWNERSHIP_UNCERTAIN')
        );
      let resolve!: (value: ResultReference) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<ResultReference>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const intake = new Intake(owner, port, job.end);
      const delivery: Delivery = { job, key, intake, promise, witness };
      active = delivery;
      const guard = () => {
        if (terminal) throw new EnvelopeError('PUBLICATION_BUSY');
        owner.check(false, job.end);
        if (terminal) throw new EnvelopeError('PUBLICATION_BUSY');
        if (active !== delivery || delivery.job.sequence !== job.sequence || job.consumed)
          throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
      };
      void (async () => {
        try {
          guard();
          if (job.phase) {
            owner.release(job.phase);
            if (job.reference) results.delete(job.reference);
            job.result = undefined;
          }
          const bytes = await intake.read(65536);
          guard();
          const runner = trustedRunner(decodeJSON(bytes, 4096, guard), guard);
          bound(job, runner);
          guard();
          if (canonicalDigest(runner, guard) !== witness.digest)
            throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
          if (
            (runner.state === 'settled' && !witness.noLateAcquisitions) ||
            (runner.state === 'not-started' && !witness.noAcquisition)
          )
            throw new EnvelopeError('CUSTODY_UNCERTAIN');
          if (lastPrimary && runner.primaryCause !== lastPrimary)
            throw new EnvelopeError('INSTALLATION_INVALID');
          if (runner.primaryCause || observedPrimary)
            lastPrimary ??= observedPrimary ?? runner.primaryCause;
          ledger.accept(runner);
          // Preserve observed failure history before a later progress snapshot can replace it.
          for (const cause of runner.cleanupCauses) owner.cleanup(cause);
          guard();
          let replyDigest: string | null = null;
          let evidenceDigest: string | null = null;
          if (runner.verifierReply) {
            const phase = {};
            owner.reserve(phase, reservations.reply, job.end);
            // Reply framing is a separate bounded intake requirement; enforce exact wire span below.
            const span = replySpan(bytes, guard);
            if (span.length > 4096) throw new EnvelopeError('VERIFIER_REPLY_INVALID');
            const parsed = ReplySchema.safeParse(decodeJSON(span, 256, guard));
            guard();
            if (!parsed.success || !same(parsed.data, runner.verifierReply, guard))
              throw new EnvelopeError('VERIFIER_REPLY_INVALID');
            replyDigest = createHash('sha256').update(span).digest('hex');
            guard();
            evidenceDigest = canonicalDigest(
              {
                reply: runner.verifierReply,
                replyDigest,
                runner,
                job: job.digest,
              },
              guard
            );
            owner.retain(phase, reservations.replyRetained, job.end);
          }
          await intake.close();
          guard();
          if (!intake.isClosed) throw new EnvelopeError('CUSTODY_UNCERTAIN');
          owner.retain(intake.phase, reservations.runnerRetained, job.end);
          const token = Object.freeze({ fixtureResult: true as const });
          const retainedRunner = freezeData({
            ...runner,
            primaryCause: observedPrimary ?? runner.primaryCause,
            cleanupCauses: [...owner.cleanupCauses],
          });
          results.set(token, {
            job,
            runner: retainedRunner,
            replyDigest,
            evidenceDigest,
            consumed: false,
          });
          job.result = retainedRunner;
          job.phase = intake.phase;
          job.reference = token;
          job.consumed = runner.state !== 'started';
          active = undefined;
          // Final synchronous owner observation after every awaited effect precedes publication.
          checkOpen();
          latestCompleted = token;
          if (job.descriptor.kind === 'official-install') officialCompleted = token;
          resolve(token);
        } catch (e) {
          owner.retire(intakeFailureCause(e) ?? 'CUSTODY_UNCERTAIN');
          await intake.close();
          reject(new EnvelopeError(owner.cause!));
        }
      })();
      return promise;
    },
    /** Consume authentic exact envelopes and independently issued publication observations once. */
    compose(
      verifierRef: ResultReference,
      publicationRef: PublicationReference,
      installerRef?: ResultReference
    ): InstallReference {
      // Merging a known primary cannot erase earlier work or unavailable accounting.
      const retained = results.get(verifierRef);
      if (
        !owner.cause &&
        retained &&
        metrics(retained.runner.accounting).size === 18 &&
        !matchesObservedAccounting(retained.runner.accounting)
      )
        throw new EnvelopeError('INSTALLATION_INVALID');
      const reference = composeFixture(
        {
          owner,
          active: () => active !== undefined,
          finalPrefix: () =>
            observedPrimary === null &&
            latestCompleted === verifierRef &&
            (!installerRef || officialCompleted === installerRef) &&
            matchesObservedAccounting(results.get(verifierRef)!.runner.accounting) &&
            results.get(verifierRef)?.runner.accounting.cumulativeAcquisitionIntents ===
              observedIntents &&
            canonicalDigest(results.get(verifierRef)!.runner.accounting, () => {}) ===
              observedAccountingDigest,
          terminal: () => terminal !== undefined,
          installJob,
          results,
          publications,
          installs,
          ledger,
          current: () => currentDigest,
          check,
        },
        verifierRef,
        publicationRef,
        installerRef
      );
      terminal = reference;
      return reference;
    },
    /** Safe field projection only from this owner's authentic result reference. Never a CLI success. */
    project(reference: InstallReference) {
      const result = installs.get(reference);
      if (!result) throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
      owner.retainMetadata();
      const e = result.localEvidence;
      const prior = projections.get(reference);
      const build = () =>
        freezeData({
          schemaVersion: 1 as const,
          kind: result.kind,
          cause: result.cause,
          cleanupCauses: result.cleanupCauses,
          provenance: result.provenance,
          accounting: result.accounting,
          observation: e ? ('fresh-verifier' as const) : ('unverified' as const),
          readiness: {
            state: 'unavailable' as const,
            cause: 'VERIFICATION_UNAVAILABLE' as const,
          },
          ...(e ? evidenceFields(e) : {}),
        });
      if (prior) return prior as ReturnType<typeof build>;
      const dto = build();
      projections.set(reference, dto);
      return dto;
    },
    /** Retired delivery remains uncertain. This reports charged unknowns, never installed evidence. */
    failure(): InstallReference {
      if (terminal) return terminal;
      const cause = observedPrimary ?? owner.cause ?? lastPrimary;
      if (!cause) throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
      owner.retainMetadata();
      // Preserve subsequent owner retirement as unknown accounting, without healing first failure.
      const unknown = Object.freeze({ state: 'unknown' as const, cause: owner.cause ?? cause });
      const accounting: Accounting = freezeData({
        cumulativeAcquisitionIntents: observedIntents,
        actualAcquisitions: unknown,
        distinctLifetimes: unknown,
        peakActive: unknown,
        roleCounts: Object.fromEntries(
          [
            'installer-root',
            'downloader',
            'shell',
            'tool',
            'verifier-root',
            'version-probe',
            'other-owned',
          ].map((role) => [role, unknown])
        ) as Accounting['roleCounts'],
        networkBytes: unknown,
        extractedBytes: unknown,
        retainedDiagnosticBytes: unknown,
        archiveEntries: unknown,
        redirects: unknown,
        officialArtifactAttempts: unknown,
        registryWaits: unknown,
      });
      const reference = Object.freeze({ fixtureInstall: true as const });
      installs.set(
        reference,
        freezeData({
          kind: 'uncertain',
          cause,
          cleanupCauses: owner.cleanupCauses.length
            ? [...owner.cleanupCauses]
            : ['CUSTODY_UNCERTAIN'],
          accounting,
          provenance: 'fixture-only',
        })
      );
      terminal = reference;
      return reference;
    },
    /** Fixture assertions may inspect charges, never physical capacity or installation readiness. */
    inspect() {
      return Object.freeze({
        logicalUnits: owner.units,
        rawBytes: 131072,
        cause: owner.cause,
        cleanupCauses: [...owner.cleanupCauses],
        lostCleanupCauses: owner.lostCleanupCauses,
        active: active !== undefined,
      });
    },
    /** Evidence digest is private fixture data; the returned string cannot authorize a composer. */
    fixtureEvidenceDigest(reference: ResultReference): string | null {
      const result = results.get(reference);
      if (!result) throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
      return result.evidenceDigest;
    },
  });
  return Object.freeze({ issuer, domain });
}
