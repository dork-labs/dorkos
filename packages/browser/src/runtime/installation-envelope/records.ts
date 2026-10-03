import { z } from 'zod';

/** Closed private failure codes; none accepts diagnostic text. */
export const causes = [
  'INVALID_INSTALL_CONFIGURATION',
  'LIBRARY_UNAVAILABLE',
  'PLATFORM_UNSUPPORTED',
  'INSTALL_RUNNER_UNAVAILABLE',
  'VERIFIER_RUNNER_UNAVAILABLE',
  'DOWNLOAD_POLICY_UNSUPPORTED',
  'RESOURCE_ENFORCEMENT_UNAVAILABLE',
  'PUBLICATION_BUSY',
  'OWNERSHIP_UNCERTAIN',
  'ROOT_CHANGED',
  'CURRENT_CHANGED',
  'INSTALLATION_INVALID',
  'VERIFICATION_UNAVAILABLE',
  'ATTEMPT_INTERRUPTED',
  'CUSTODY_UNCERTAIN',
  'BUDGET_EXCEEDED',
  'VERIFIER_REPLY_INVALID',
  'PUBLICATION_UNCERTAIN',
  'INSTALL_JOB_FAILED',
  'VERIFIER_JOB_FAILED',
] as const;
export type Cause = (typeof causes)[number];
export const CauseSchema = z.enum(causes);
const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z
  .string()
  .max(64)
  .regex(/^\d+(?:\.\d+)*$/);
const hasControl = (s: string) => {
  for (let i = 0; i < s.length; i++)
    if (s.charCodeAt(i) <= 31 || s.charCodeAt(i) === 127) return true;
  return false;
};
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const relative = z
  .string()
  .refine(
    (s) =>
      utf8(s) <= 1024 &&
      !/[\\:\0]/.test(s) &&
      s.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (s) =>
      s.startsWith('/') &&
      !s.includes('\\') &&
      !hasControl(s) &&
      (s === '/' ||
        s
          .slice(1)
          .split('/')
          .every((part) => part !== '' && part !== '.' && part !== '..')) &&
      utf8(s) <= 16384
  );
export const BindingSchema = z.strictObject({
  transactionId: opaque,
  attemptId: opaque,
  nonce: opaque,
  generation: safe,
  installationId: opaque,
});
export type JobBinding = z.infer<typeof BindingSchema>;
export const roles = [
  'installer-root',
  'downloader',
  'shell',
  'tool',
  'verifier-root',
  'version-probe',
  'other-owned',
] as const;
const MetricSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('observed'), value: safe, cause: z.null() }),
  z.strictObject({ state: z.literal('unknown'), cause: CauseSchema }),
]);
const RoleCountsSchema = z.strictObject(
  Object.fromEntries(roles.map((role) => [role, MetricSchema])) as Record<
    (typeof roles)[number],
    typeof MetricSchema
  >
);
export const AccountingSchema = z
  .strictObject({
    cumulativeAcquisitionIntents: safe,
    actualAcquisitions: MetricSchema,
    distinctLifetimes: MetricSchema,
    peakActive: MetricSchema,
    roleCounts: RoleCountsSchema,
    networkBytes: MetricSchema,
    extractedBytes: MetricSchema,
    retainedDiagnosticBytes: MetricSchema,
    archiveEntries: MetricSchema,
    redirects: MetricSchema,
    officialArtifactAttempts: MetricSchema,
    registryWaits: MetricSchema,
  })
  .superRefine((a, ctx) => {
    const actual = a.actualAcquisitions;
    const distinct = a.distinctLifetimes;
    const peak = a.peakActive;
    if (actual.state === 'observed' && actual.value > a.cumulativeAcquisitionIntents)
      ctx.addIssue({ code: 'custom', message: 'Invalid acquisition accounting' });
    if (
      actual.state === 'observed' &&
      distinct.state === 'observed' &&
      distinct.value > actual.value
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid lifetime accounting' });
    if (distinct.state === 'observed' && peak.state === 'observed' && peak.value > distinct.value)
      ctx.addIssue({ code: 'custom', message: 'Invalid peak accounting' });
    const entries = roles.map((r) => a.roleCounts[r]);
    if (actual.state === 'observed' && entries.every((m) => m.state === 'observed')) {
      let total = 0;
      for (const m of entries) {
        if (m.state === 'observed') {
          if (total > Number.MAX_SAFE_INTEGER - m.value) {
            ctx.addIssue({ code: 'custom', message: 'Accounting overflow' });
            return;
          }
          total += m.value;
        }
      }
      if (total !== actual.value)
        ctx.addIssue({ code: 'custom', message: 'Role accounting mismatch' });
    }
  });
export type Accounting = z.infer<typeof AccountingSchema>;
export const IdentitySchema = z.strictObject({
  pid: safe.min(1),
  birth: z
    .string()
    .min(1)
    .max(128)
    .refine((s) => s.trim() === s && !hasControl(s) && utf8(s) <= 512),
  acquisitionId: opaque,
  role: z.enum(roles),
  parentAcquisitionId: opaque.nullable(),
  attributionEvidenceDigest: digest,
  lifetimeState: z.enum(['preregistered', 'running', 'observed-closed', 'unknown']),
});
export type Identity = z.infer<typeof IdentitySchema>;
const InventorySchema = z.strictObject({
  state: z.enum(['complete', 'unknown']),
  identities: z.array(IdentitySchema).max(64),
  cause: z.enum(['CUSTODY_UNCERTAIN', 'OWNERSHIP_UNCERTAIN', 'ROOT_CHANGED']).nullable(),
});
export const cleanup = z
  .array(CauseSchema)
  .max(32)
  .refine((a) => new Set(a).size === a.length);
export const ReplySchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobBinding: BindingSchema,
  installationId: opaque,
  libraryDistributionSHA256: digest,
  chromiumRevision: z.string().regex(/^\d{1,16}$/),
  observedVersion: version,
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
  candidateRelativeExecutablePath: relative,
  executableSHA256: digest,
});
export type VerifierReply = z.infer<typeof ReplySchema>;
export const RunnerSchema = z
  .strictObject({
    jobKind: z.enum(['official-install', 'fresh-verifier']),
    jobBinding: BindingSchema,
    state: z.enum(['not-started', 'started', 'unknown', 'settled']),
    inventory: InventorySchema,
    rootWait: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('not-started') }),
      z.strictObject({ state: z.literal('unknown') }),
      z.strictObject({ state: z.literal('observed'), exitCode: safe }),
    ]),
    stdio: z.strictObject({ state: z.enum(['closed', 'open', 'unknown']) }),
    cancellation: z.strictObject({
      requested: z.boolean(),
      cleanup: z.enum(['not-required', 'observed-closed', 'unknown']),
    }),
    accounting: AccountingSchema,
    primaryCause: CauseSchema.nullable(),
    cleanupCauses: cleanup,
    verifierReply: ReplySchema.optional(),
  })
  .superRefine((r, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'Invalid runner state' });
    const ids = r.inventory.identities;
    const byId = new Map(ids.map((i) => [i.acquisitionId, i]));
    if (
      byId.size !== ids.length ||
      new Set(ids.map((i) => `${i.pid}:${i.birth}`)).size !== ids.length
    )
      fail();
    if ((r.inventory.state === 'complete') !== (r.inventory.cause === null)) fail();
    for (const i of ids) {
      const visited = new Set<string>();
      let next: Identity | undefined = i;
      while (next?.parentAcquisitionId !== null && next) {
        if (visited.has(next.acquisitionId)) {
          fail();
          break;
        }
        visited.add(next.acquisitionId);
        next = byId.get(next.parentAcquisitionId);
        if (!next) {
          fail();
          break;
        }
      }
    }
    if (ids.length > 0) {
      const roots = ids.filter((i) => i.parentAcquisitionId === null);
      if (
        (r.inventory.state === 'complete' ? roots.length !== 1 : roots.length > 1) ||
        (roots.length > 0 &&
          roots[0]?.role !==
            (r.jobKind === 'official-install' ? 'installer-root' : 'verifier-root'))
      )
        fail();
    }
    const exitFailure =
      r.jobKind === 'official-install' ? 'INSTALL_JOB_FAILED' : 'VERIFIER_JOB_FAILED';
    if (
      (r.primaryCause === 'INSTALL_JOB_FAILED' || r.primaryCause === 'VERIFIER_JOB_FAILED') &&
      (r.primaryCause !== exitFailure ||
        r.rootWait.state !== 'observed' ||
        r.rootWait.exitCode === 0 ||
        ids.length === 0)
    )
      fail();
    if (r.state === 'not-started') {
      if (
        ids.length ||
        r.inventory.state !== 'complete' ||
        r.rootWait.state !== 'not-started' ||
        r.stdio.state !== 'closed' ||
        r.cancellation.cleanup !== 'not-required' ||
        !r.primaryCause ||
        r.cleanupCauses.length ||
        r.verifierReply
      )
        fail();
    }
    if (
      r.state === 'started' &&
      (r.verifierReply ||
        (r.primaryCause === null && (r.cancellation.requested || r.cleanupCauses.length > 0)))
    )
      fail();
    const unknownAccounting =
      Object.values(r.accounting).some(
        (m) => typeof m === 'object' && 'state' in m && m.state === 'unknown'
      ) || roles.some((role) => r.accounting.roleCounts[role].state === 'unknown');
    if (
      r.state === 'started' &&
      (unknownAccounting ||
        r.inventory.state === 'unknown' ||
        ids.some((i) => i.lifetimeState === 'unknown') ||
        r.stdio.state === 'unknown')
    )
      fail();
    if (
      r.state === 'unknown' &&
      (!r.primaryCause ||
        r.verifierReply ||
        (!unknownAccounting &&
          r.inventory.state !== 'unknown' &&
          !ids.some((i) => i.lifetimeState === 'unknown') &&
          r.rootWait.state !== 'unknown' &&
          r.stdio.state !== 'unknown' &&
          r.cancellation.cleanup !== 'unknown') ||
        !r.cleanupCauses.length)
    )
      fail();
    if (r.state === 'settled') {
      if (
        r.inventory.state !== 'complete' ||
        !ids.length ||
        ids.some((i) => i.lifetimeState !== 'observed-closed') ||
        r.rootWait.state !== 'observed' ||
        r.stdio.state !== 'closed' ||
        r.cancellation.cleanup !== 'observed-closed'
      )
        fail();
      if (r.rootWait.state === 'observed' && r.rootWait.exitCode !== 0 && !r.primaryCause) fail();
      if (
        r.primaryCause === null &&
        (unknownAccounting || r.cancellation.requested || r.cleanupCauses.length)
      )
        fail();
      if (r.jobKind === 'official-install' && r.verifierReply) fail();
      if (
        r.jobKind === 'fresh-verifier' &&
        (r.primaryCause === null) !== (r.verifierReply !== undefined)
      )
        fail();
    }
  });
export type RunnerResult = z.infer<typeof RunnerSchema>;
export const LocalEvidenceSchema = z.strictObject({
  installationId: opaque,
  manifestDigest: digest,
  libraryRoot: localPath,
  executablePath: localPath,
  libraryDistributionSHA256: digest,
  executableSHA256: digest,
  chromiumRevision: z.string().regex(/^\d{1,16}$/),
  observedVersion: version,
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
  verifierJobBinding: BindingSchema,
  verifierEvidenceDigest: digest,
});
export type LocalEvidence = z.infer<typeof LocalEvidenceSchema>;
export const pins = Object.freeze({
  libraryDistributionSHA256: '6bf8e6d392f411f43046a5688021a5ed083fea9129f2f84dbff5aee88b2de728',
  chromiumRevision: '1243',
  observedVersion: '153.0.8010.12',
});

const allObserved = (a: Accounting) =>
  Object.values(a).every(
    (m) => typeof m !== 'object' || !('state' in m) || m.state === 'observed'
  ) && roles.every((role) => a.roleCounts[role].state === 'observed');
const verifiedAccounting = AccountingSchema.refine(allObserved);
const resultBase = {
  cleanupCauses: cleanup,
  accounting: AccountingSchema,
  provenance: z.enum(['fixture-only', 'accepted-runner']),
};
/** Structural local result validation does not issue owner provenance. */
export const InstallResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...resultBase,
    kind: z.literal('verified-installed'),
    cause: z.null(),
    cleanupCauses: cleanup.max(0),
    accounting: verifiedAccounting,
    localEvidence: LocalEvidenceSchema,
  }),
  z.strictObject({
    ...resultBase,
    kind: z.literal('verified-reused'),
    cause: z.null(),
    cleanupCauses: cleanup.max(0),
    accounting: verifiedAccounting,
    localEvidence: LocalEvidenceSchema,
  }),
  z.strictObject({ ...resultBase, kind: z.literal('refused'), cause: CauseSchema }),
  z.strictObject({ ...resultBase, kind: z.literal('uncertain'), cause: CauseSchema }),
]);
const dtoBase = {
  schemaVersion: z.literal(1),
  ...resultBase,
  readiness: z.strictObject({
    state: z.literal('unavailable'),
    cause: z.literal('VERIFICATION_UNAVAILABLE'),
  }),
};
const verifiedFields = {
  installationId: opaque,
  libraryDistributionSHA256: digest,
  executableSHA256: digest,
  chromiumRevision: z.string().regex(/^\d{1,16}$/),
  observedVersion: version,
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
};
/** Closed safe projection schema; successful parsing still cannot enter the trusted composer. */
export const RuntimeInstallDTOSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...dtoBase,
    ...verifiedFields,
    kind: z.literal('verified-installed'),
    cause: z.null(),
    cleanupCauses: cleanup.max(0),
    accounting: verifiedAccounting,
    observation: z.literal('fresh-verifier'),
  }),
  z.strictObject({
    ...dtoBase,
    ...verifiedFields,
    kind: z.literal('verified-reused'),
    cause: z.null(),
    cleanupCauses: cleanup.max(0),
    accounting: verifiedAccounting,
    observation: z.literal('fresh-verifier'),
  }),
  z.strictObject({
    ...dtoBase,
    kind: z.literal('refused'),
    cause: CauseSchema,
    observation: z.literal('unverified'),
  }),
  z.strictObject({
    ...dtoBase,
    kind: z.literal('uncertain'),
    cause: CauseSchema,
    observation: z.literal('unverified'),
  }),
]);
