import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scanJSON } from '../inspection/scanner.js';
import {
  DISTRIBUTION,
  IdentitySchema,
  ManifestSchema,
  PointerSchema,
  relativePath,
  trustedPath,
  type Manifest,
} from '../inspection/records.js';

/** Integrity grammar is shared with inspection; its fixture owner is never instantiated. */
export { DISTRIBUTION, ManifestSchema, PointerSchema, relativePath, trustedPath };
export type { Manifest };

/** Enforced local retention limits; these are not network, extraction or OS quotas. */
export const INSTALLATION_LIMITS = Object.freeze({
  bufferBytes: 65_536,
  streamBytes: 1_048_576,
  diagnosticBytes: 8_388_608,
  replyBytes: 4_096,
  journalBytes: 65_536,
  manifestBytes: 16_384,
  pointerBytes: 1_024,
  libraryFileBytes: 8_388_608,
  libraryBytes: 33_554_432,
  libraryEntries: 256,
  payloadEntries: 16_384,
  payloadDepth: 32,
  executableBytes: 2_147_483_648,
  payloadBytes: 8_589_934_592,
});
export const INSTALLATION_TARGET = Object.freeze({
  packageName: 'playwright-core' as const,
  packageVersion: '1.63.0' as const,
  chromiumRevision: '1243' as const,
  observedVersion: '153.0.8010.12' as const,
  libraryDistributionSHA256: DISTRIBUTION,
  platform: 'darwin' as const,
  arch: 'arm64' as const,
  executablePath:
    'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
});
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AttemptBindingSchema = z.strictObject({
  transactionId: IdSchema,
  attemptId: IdSchema,
  nonce: IdSchema,
  generation,
  installationId: IdSchema,
});
export type AttemptBinding = Readonly<z.infer<typeof AttemptBindingSchema>>;
export const FileIdentitySchema = IdentitySchema.extend({
  uid: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
}).strict();
export type FileIdentity = Readonly<z.infer<typeof FileIdentitySchema>>;
export type Platform = 'darwin' | 'linux' | 'win32';
export type Architecture = 'arm64' | 'x64';

export const FailureCodeSchema = z.enum([
  'INVALID_INSTALL_CONFIGURATION',
  'PLATFORM_UNSUPPORTED',
  'PUBLICATION_BUSY',
  'INSTALLATION_INVALID',
  'VERIFICATION_UNAVAILABLE',
  'OWNERSHIP_UNCERTAIN',
  'ROOT_CHANGED',
  'PUBLICATION_UNCERTAIN',
  'INSTALLER_FAILED',
  'VERIFIER_FAILED',
  'PROBE_FAILED',
  'BINDING_MISMATCH',
  'VERSION_MISMATCH',
  'HASH_MISMATCH',
  'LIBRARY_MISMATCH',
  'SOURCE_MISMATCH',
  'RECORD_FAILED',
  'IO_FAILED',
  'CUSTODY_UNCERTAIN',
  'RETENTION_EXCEEDED',
  'WORK_EXPIRED',
  'FINAL_EXPIRED',
  'ABORTED',
  'CLOCK_UNAVAILABLE',
]);
export type FailureCode = z.infer<typeof FailureCodeSchema>;
/** Closed diagnostics; arbitrary exception messages never become public status copy. */
export class InstallationFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly publicationMayHaveChanged = false
  ) {
    super(code);
    this.name = 'InstallationFailure';
  }
}
/** Return a closed diagnostic code without exposing arbitrary exception text. */
export function failureCode(error: unknown): FailureCode {
  return error instanceof InstallationFailure ? error.code : 'IO_FAILED';
}

/** Fixed monotonic ends belong to one original attempt and cannot be renewed. */
export interface AttemptBounds {
  readonly origin: number;
  readonly workEnd: number;
  readonly finalEnd: number;
}
export const AttemptBoundsSchema = z
  .strictObject({
    origin: z.number().nonnegative(),
    workEnd: z.number().nonnegative(),
    finalEnd: z.number().nonnegative(),
  })
  .refine((v) => v.origin < v.workEnd && v.workEnd <= v.finalEnd);
export const SourceVintageSchema = z.strictObject({
  sourceManifestSHA256: DigestSchema,
  controllerSHA256: DigestSchema,
  verifierSHA256: DigestSchema,
});
/** Generated same-vintage asset data; its own exact byte digest stays outside this document. */
export const SourceManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  controllerSHA256: DigestSchema,
  verifierSHA256: DigestSchema,
});
export interface SourceVintage {
  readonly sourceManifestSHA256: string;
  readonly controllerSHA256: string;
  readonly verifierSHA256: string;
}
/** Trusted local composition only; CLI resolves these from its real installed package. */
export interface InstallationConfiguration {
  readonly cacheRoot: string;
  readonly libraryRoot: string;
  readonly nodeExecutable: string;
  readonly nodeExecutableSHA256: string;
  readonly verifierEntry: string;
  readonly controllerEntry: string;
  readonly sourceManifestPath: string;
  readonly sourceVintage: SourceVintage;
  readonly platform: Platform;
  readonly arch: Architecture;
  readonly workMilliseconds: number;
  readonly finalMilliseconds: number;
}
export const InstallationConfigurationSchema = z
  .strictObject({
    cacheRoot: trustedPath,
    libraryRoot: trustedPath,
    nodeExecutable: trustedPath,
    nodeExecutableSHA256: DigestSchema,
    verifierEntry: trustedPath,
    controllerEntry: trustedPath,
    sourceManifestPath: trustedPath,
    sourceVintage: SourceVintageSchema,
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.enum(['arm64', 'x64']),
    workMilliseconds: z.number().int().positive().max(900_000),
    finalMilliseconds: z.number().int().positive().max(960_000),
  })
  .refine((v) => v.workMilliseconds <= v.finalMilliseconds);
export interface InstallOptions {
  readonly repair?: boolean;
  readonly signal?: AbortSignal;
}
export interface InspectOptions {
  readonly signal?: AbortSignal;
}
export const READINESS_UNAVAILABLE = Object.freeze({
  state: 'unavailable' as const,
  cause: 'VERIFICATION_UNAVAILABLE' as const,
});
interface StatusCommon {
  readonly schemaVersion: 1;
  readonly pinnedPackageVersion: '1.63.0';
  readonly chromiumRevision: '1243';
  readonly platform: Platform;
  readonly arch: Architecture;
  readonly observation: 'files-only';
  readonly readiness: typeof READINESS_UNAVAILABLE;
}
export type RuntimeInstallationStatus = StatusCommon &
  (
    | Readonly<{ state: 'missing'; cause: null }>
    | Readonly<{
        state: 'installed-files';
        cause: null;
        installationId: string;
        executableSHA256: string;
        currentManifestDigest: string;
        lastFreshVerifiedVersion: string;
        historicalAttemptId: string;
        historicalGeneration: number;
        verificationDigest: string;
      }>
    | Readonly<{ state: 'unsupported'; cause: 'PLATFORM_UNSUPPORTED' }>
    | Readonly<{ state: 'invalid'; cause: 'INSTALLATION_INVALID' }>
    | Readonly<{ state: 'unverified'; cause: 'VERIFICATION_UNAVAILABLE' }>
  );
export type InstallResult =
  | Readonly<{
      state: 'verified-installed' | 'verified-reused';
      cause: null;
      installationId: string;
      attemptId: string;
      generation: number;
      observedVersion: string;
      executableSHA256: string;
      platform: Platform;
      arch: Architecture;
      currentManifestDigest: string;
      journalDigest: string;
      readiness: typeof READINESS_UNAVAILABLE;
    }>
  | Readonly<{
      state: 'refused' | 'uncertain';
      cause: FailureCode;
      attemptId?: string;
      publicationMayHaveChanged: boolean;
      readiness: typeof READINESS_UNAVAILABLE;
    }>;
export interface RuntimeInstallation {
  install(options?: InstallOptions): Promise<InstallResult>;
  inspectExisting(options?: InspectOptions): Promise<RuntimeInstallationStatus>;
}

export interface FileSnapshot {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly sha256: string;
  readonly bytes: number;
}
export interface LibrarySnapshot {
  readonly distributionSHA256: string;
  readonly files: readonly FileSnapshot[];
  readonly cli: FileSnapshot;
  readonly browsersManifest: FileSnapshot;
}
export interface CandidateSnapshot {
  readonly installationId: string;
  readonly candidateRoot: string;
  readonly payloadRoot: string;
  readonly executable: FileSnapshot;
  readonly machOCPU: 16777228;
  readonly inventoryDigest: string;
  readonly entries: number;
  readonly bytes: number;
}
export type CurrentObservation =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'present'; file: FileSnapshot; pointer: z.infer<typeof PointerSchema> }>
  | Readonly<{ state: 'invalid'; file: FileSnapshot }>
  | Readonly<{ state: 'unknown' }>;
export interface ExistingInstallation {
  readonly current: Extract<CurrentObservation, { state: 'present' }>;
  readonly manifest: Manifest;
  readonly manifestFile: FileSnapshot;
  readonly verification: VerificationRecord;
  readonly verificationFile: FileSnapshot;
  readonly candidate: CandidateSnapshot;
}
export interface ExistingInspection {
  readonly status: RuntimeInstallationStatus;
  readonly current: CurrentObservation;
  readonly installation: ExistingInstallation | null;
}

/** These handles are meaningful ONLY in the actual issuing producer's local membership map. */
export interface ReservationHandle {
  readonly kind: 'installation-reservation';
  readonly binding: AttemptBinding;
}
export interface AttemptHandle {
  readonly kind: 'installation-attempt';
  readonly binding: AttemptBinding;
  readonly attemptRoot: string;
  readonly homeRoot: string;
  readonly temporaryRoot: string;
  readonly identity: FileIdentity;
}
export interface CandidateHandle {
  readonly kind: 'installation-candidate';
  readonly binding: AttemptBinding;
  readonly candidateRoot: string;
  readonly payloadRoot: string;
  readonly reuse: boolean;
}
export interface FilesystemCustody {
  readonly pendingOperations: number;
  readonly unresolvedHandles: number;
  readonly firstCause: FailureCode | null;
  readonly reservation: 'held' | 'released' | 'uncertain';
}
export interface PublicationFacts {
  readonly state: 'durable' | 'uncertain';
  readonly pointerReplaced: boolean;
  readonly currentBefore: CurrentObservation;
  readonly currentAfter: CurrentObservation;
  readonly manifestDigest: string;
  readonly verificationDigest: string;
  readonly firstCause: FailureCode | null;
}
export interface OwnerRecord {
  readonly schemaVersion: 1;
  readonly binding: AttemptBinding;
  readonly bounds: AttemptBounds;
  readonly phase: 'reserved' | 'installing' | 'verifying' | 'publishing' | 'reusing' | 'uncertain';
  readonly sourceVintage: SourceVintage;
  readonly births?: readonly JobBirth[];
}
export const OwnerRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: AttemptBindingSchema,
  bounds: AttemptBoundsSchema,
  phase: z.enum(['reserved', 'installing', 'verifying', 'publishing', 'reusing', 'uncertain']),
  sourceVintage: SourceVintageSchema,
  births: z
    .array(z.lazy(() => JobBirthSchema))
    .max(2)
    .optional(),
});
/** F implements real fs mutations; I owns their ordering and never duplicates them. */
export interface InstallationFilesystem {
  inspectExisting(options?: InspectOptions): Promise<ExistingInspection>;
  validateLibrary(): Promise<LibrarySnapshot>;
  acquireReservation(binding: AttemptBinding, bounds: AttemptBounds): Promise<ReservationHandle>;
  createAttempt(reservation: ReservationHandle): Promise<AttemptHandle>;
  writeOwner(
    reservation: ReservationHandle,
    attempt: AttemptHandle,
    record: OwnerRecord
  ): Promise<void>;
  stageCandidate(reservation: ReservationHandle, attempt: AttemptHandle): Promise<CandidateHandle>;
  bindExistingCandidate(
    reservation: ReservationHandle,
    attempt: AttemptHandle,
    existing: ExistingInstallation
  ): Promise<CandidateHandle>;
  observeCandidate(candidate: CandidateHandle): Promise<CandidateSnapshot>;
  revalidateCandidate(candidate: CandidateHandle, expected: CandidateSnapshot): Promise<void>;
  createJobSink(reservation: ReservationHandle, attempt: AttemptHandle): InstallationJobSink;
  /** Fresh child independently acquires read originals; request fields are correspondence, not handles. */
  inspectFreshRequest(request: FreshVerifierRequest): Promise<
    Readonly<{
      candidate: CandidateSnapshot;
      library: LibrarySnapshot;
    }>
  >;
  /** Confined probe diagnostics only, after exact owned attempt/nonce/identity re-observation. */
  createProbeSink(request: FreshVerifierRequest): InstallationJobSink;
  /** Flush every actual payload file and child/parent entry; not a recursive-directory-sync fiction. */
  makeCandidateDurable(candidate: CandidateHandle, expected: CandidateSnapshot): Promise<void>;
  publish(
    reservation: ReservationHandle,
    candidate: CandidateHandle,
    manifest: Manifest,
    verification: VerificationRecord,
    before: CurrentObservation
  ): Promise<PublicationFacts>;
  /** Writes only this new attempt's journal; existing candidate/current bytes stay immutable. */
  writeReuseJournal(
    reservation: ReservationHandle,
    attempt: AttemptHandle,
    record: ReuseRecord
  ): Promise<FileSnapshot>;
  /** Transaction enters only after jobs.requireReturned and its own fixed-end checks. */
  releaseReservation(reservation: ReservationHandle): Promise<void>;
  custody(reservation?: ReservationHandle): FilesystemCustody;
}

export type JobRole = 'official-install' | 'fresh-verifier' | 'version-probe';
export interface JobIntent {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly role: JobRole;
  readonly binding: AttemptBinding;
  readonly bounds: AttemptBounds;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environmentDigest: string;
}
export interface JobBirth extends JobIntent {
  readonly pid: number;
}
export const JobIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: IdSchema,
  role: z.enum(['official-install', 'fresh-verifier', 'version-probe']),
  binding: AttemptBindingSchema,
  bounds: AttemptBoundsSchema,
  executable: trustedPath,
  argv: z.array(z.string().max(16_384)).max(16),
  cwd: trustedPath,
  environmentDigest: DigestSchema,
});
export const JobBirthSchema = JobIntentSchema.extend({ pid: z.number().int().positive() }).strict();
export interface RawWriter {
  /** F validates its local handle and writes retained chunks under a fixed per-stream cap. */
  write(bytes: Uint8Array): Promise<void>;
  /** One original flush/fsync/close; ambiguous close is retained and never retried numerically. */
  finish(): Promise<void>;
}
export interface JobOutput {
  readonly stdout: RawWriter;
  readonly stderr: RawWriter;
}
/** Sink methods are acquired under J's preregistered original duty, before first spawn. */
export interface InstallationJobSink {
  prepare(intent: JobIntent): Promise<JobOutput>;
  birth(facts: JobBirth): Promise<void>;
  receipt(facts: JobFacts): Promise<void>;
}
export interface JobHandle {
  readonly kind: 'installation-job';
  readonly jobId: string;
  readonly role: JobRole;
}
export interface StreamFacts {
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly overflow: boolean;
  readonly eof: boolean;
  readonly closed: boolean;
  readonly rawFlushedClosed: boolean;
}
export interface JobFacts {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly role: JobRole;
  readonly binding: AttemptBinding;
  readonly birth: JobBirth | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly exitObserved: boolean;
  readonly closeObserved: boolean;
  readonly stdout: StreamFacts;
  readonly stderr: StreamFacts;
  readonly stopRequested: boolean;
  readonly firstCause: FailureCode | null;
  readonly cleanupCauses: readonly FailureCode[];
  /** Normal trusted installer return is not a claim that all descendants were independently observed. */
  readonly descendantDisposition: 'trusted-installer-return' | 'not-applicable' | 'unknown';
}
export interface JobRun {
  readonly handle: JobHandle;
  readonly facts: JobFacts;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}
export interface InstallerRequest {
  readonly binding: AttemptBinding;
  readonly bounds: AttemptBounds;
  readonly attempt: AttemptHandle;
  readonly candidate: CandidateHandle;
  readonly library: LibrarySnapshot;
  readonly sink: InstallationJobSink;
  readonly signal?: AbortSignal;
}
export interface VerifierRequest extends InstallerRequest {
  readonly request: FreshVerifierRequest;
}
export interface VersionProbeRequest {
  readonly binding: AttemptBinding;
  readonly bounds: AttemptBounds;
  readonly executable: FileSnapshot;
  readonly cwd: string;
  readonly sink: InstallationJobSink;
  readonly signal?: AbortSignal;
}
/** J authenticates retained child objects; JSON or a matching PID cannot enter this registry. */
export interface InstallationJobs {
  runInstaller(request: InstallerRequest): Promise<JobRun>;
  runVerifier(request: VerifierRequest): Promise<JobRun>;
  /** Verifier-owned supervisor only; one probe subwork slot, no third controller role. */
  runVersionProbe(request: VersionProbeRequest): Promise<JobRun>;
  requireReturned(handle: JobHandle): JobFacts;
  custody(): Readonly<{ pending: number; firstCause: FailureCode | null }>;
}
export interface JobsOptions {
  readonly ownerKind: 'controller' | 'fresh-verifier';
  readonly now?: () => number;
}

export const FreshVerifierRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: AttemptBindingSchema,
  bounds: AttemptBoundsSchema,
  cacheRoot: trustedPath,
  candidateRoot: trustedPath,
  libraryRoot: trustedPath,
  attemptRoot: trustedPath,
  attemptIdentity: FileIdentitySchema,
  nodeExecutable: trustedPath,
  nodeExecutableSHA256: DigestSchema,
  controllerEntry: trustedPath,
  verifierEntry: trustedPath,
  sourceManifestPath: trustedPath,
  executablePath: relativePath,
  executableSHA256: DigestSchema,
  executableIdentity: FileIdentitySchema,
  libraryDistributionSHA256: DigestSchema,
  sourceVintage: SourceVintageSchema,
  expectedVersion: z.literal('153.0.8010.12'),
  chromiumRevision: z.literal('1243'),
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
});
export type FreshVerifierRequest = Readonly<z.infer<typeof FreshVerifierRequestSchema>>;
export const FreshVerifierReplySchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: AttemptBindingSchema,
  executableSHA256: DigestSchema,
  executableIdentity: FileIdentitySchema,
  libraryDistributionSHA256: DigestSchema,
  sourceManifestSHA256: DigestSchema,
  observedVersion: z.literal('153.0.8010.12'),
  chromiumRevision: z.literal('1243'),
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
  machOCPU: z.literal(16777228),
  probeReceiptDigest: DigestSchema,
});
export type FreshVerifierReply = Readonly<z.infer<typeof FreshVerifierReplySchema>>;
const invokedInstaller = z.strictObject({
  kind: z.literal('invoked'),
  jobId: IdSchema,
  receiptDigest: DigestSchema,
});
export const InstallerProvenanceSchema = z.discriminatedUnion('kind', [
  invokedInstaller,
  z.strictObject({ kind: z.literal('not-invoked') }),
]);
export const VerificationRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  canonicalFormat: z.literal('installation-canonical-v1'),
  binding: AttemptBindingSchema,
  installer: InstallerProvenanceSchema,
  verifier: z.strictObject({
    jobId: IdSchema,
    receiptDigest: DigestSchema,
    replyDigest: DigestSchema,
  }),
  reply: FreshVerifierReplySchema,
  candidateInventoryDigest: DigestSchema,
  libraryDistributionSHA256: DigestSchema,
  sourceManifestSHA256: DigestSchema,
});
export type VerificationRecord = Readonly<z.infer<typeof VerificationRecordSchema>>;
export const ReuseRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('verified-reuse'),
  binding: AttemptBindingSchema,
  installer: z.strictObject({ kind: z.literal('not-invoked') }),
  currentManifestDigest: DigestSchema,
  historicalVerificationDigest: DigestSchema,
  freshVerification: VerificationRecordSchema,
});
export type ReuseRecord = Readonly<z.infer<typeof ReuseRecordSchema>>;

/** Private seams are constructor inputs for semantic tests; public composition uses actual F/J. */
export interface TransactionDependencies {
  readonly filesystem: InstallationFilesystem;
  readonly jobs: InstallationJobs;
  readonly now: () => number;
  readonly createId: () => string;
}
/** Compare every original-attempt binding field; equality alone confers no authority. */
export function sameBinding(a: AttemptBinding, b: AttemptBinding): boolean {
  return (
    a.transactionId === b.transactionId &&
    a.attemptId === b.attemptId &&
    a.nonce === b.nonce &&
    a.generation === b.generation &&
    a.installationId === b.installationId
  );
}
/** Compare the complete observed file identity, including ownership and mode. */
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.device === b.device &&
    a.inode === b.inode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.type === b.type &&
    a.uid === b.uid &&
    a.mode === b.mode
  );
}
/** Hash exact bytes for integrity correspondence, without asserting physical acceptance. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/** Same type-tagged UTF-16 string-length grammar as retained e5ec integrity data; no authority. */
export function canonicalDigest(value: unknown): string {
  const hash = createHash('sha256');
  const visit = (v: unknown): void => {
    if (v === null) {
      hash.update('null;');
      return;
    }
    if (typeof v === 'string') {
      hash.update(`s${v.length}:`);
      hash.update(v);
      return;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new InstallationFailure('INSTALLATION_INVALID');
      hash.update(`number:${String(v)};`);
      return;
    }
    if (typeof v === 'boolean') {
      hash.update(`boolean:${String(v)};`);
      return;
    }
    if (Array.isArray(v)) {
      hash.update(`a${v.length}:`);
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === 'object' && v) {
      const keys = Object.keys(v).sort();
      hash.update(`o${keys.length}:`);
      for (const key of keys) {
        visit(key);
        visit((v as Record<string, unknown>)[key]);
      }
      return;
    }
    throw new InstallationFailure('INSTALLATION_INVALID');
  };
  visit(value);
  return hash.digest('hex');
}
/** Serialization is bounded after closed-schema validation; callers retain exact durable bytes. */
export function recordBytes(value: unknown, cap: number): Uint8Array {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new InstallationFailure('INSTALLATION_INVALID');
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > cap) throw new InstallationFailure('RETENTION_EXCEEDED');
  return bytes;
}
/** Existing scanner rejects duplicate keys/invalid UTF-8 before closed-schema decoding. */
export function parseRecord<T>(bytes: Uint8Array, schema: z.ZodType<T>, cap: number): T {
  if (bytes.byteLength > cap) throw new InstallationFailure('RETENTION_EXCEEDED');
  try {
    return schema.parse(scanJSON(bytes));
  } catch {
    throw new InstallationFailure('INSTALLATION_INVALID');
  }
}
/** F/J implement these named factories; no arbitrary issuer is exposed by the public index. */
export type FilesystemFactory = (
  configuration: InstallationConfiguration
) => InstallationFilesystem;
export type JobsFactory = (
  configuration: InstallationConfiguration,
  options?: JobsOptions
) => InstallationJobs;
