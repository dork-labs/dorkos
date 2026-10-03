import {
  AccountingSchema,
  pins,
  roles,
  type Accounting,
  type RunnerResult,
  type VerifierReply,
} from '../records.js';
import { createFixtureEnvelopeDomain } from '../domain.js';
import type { JobDescriptor } from '../correlation.js';
import type { BytePort } from '../owner.js';
import type { PreboundedData } from '../own-data.js';

export const sha = (character: string) => character.repeat(64);
export const bounded = (value: unknown): PreboundedData => ({
  producer: 'fixture-prebounded-own-data',
  value,
});
export const binding = (nonce = 'nonce') => ({
  transactionId: 'transaction',
  attemptId: 'attempt',
  nonce,
  generation: 1,
  installationId: 'candidate',
});
export function accounting(installer = 0, verifier = 1): Accounting {
  const metric = (value: number) => ({ state: 'observed' as const, value, cause: null });
  const count = installer + verifier;
  return AccountingSchema.parse({
    cumulativeAcquisitionIntents: count,
    actualAcquisitions: metric(count),
    distinctLifetimes: metric(count),
    peakActive: metric(count === 0 ? 0 : 1),
    roleCounts: Object.fromEntries(
      roles.map((role) => [
        role,
        metric(role === 'installer-root' ? installer : role === 'verifier-root' ? verifier : 0),
      ])
    ),
    networkBytes: metric(0),
    extractedBytes: metric(0),
    retainedDiagnosticBytes: metric(0),
    archiveEntries: metric(0),
    redirects: metric(0),
    officialArtifactAttempts: metric(0),
    registryWaits: metric(0),
  });
}
export function reply(nonce = 'nonce'): VerifierReply {
  return {
    schemaVersion: 1,
    jobBinding: binding(nonce),
    installationId: 'candidate',
    ...pins,
    platform: 'darwin',
    arch: 'arm64',
    candidateRelativeExecutablePath: 'chromium/Chromium.app/Contents/MacOS/Chromium',
    executableSHA256: sha('a'),
  };
}
export function descriptor(
  kind: JobDescriptor['kind'] = 'fresh-verifier',
  nonce = 'nonce'
): JobDescriptor {
  return {
    kind,
    binding: binding(nonce),
    packageDigest: sha('1'),
    sourceDigest: sha('2'),
    entryDigest: sha('3'),
    environmentDigest: sha('4'),
    backendDigest: sha('5'),
    candidateDigest: sha('6'),
    expectedReply: reply(nonce),
  };
}
export function runner(
  kind: RunnerResult['jobKind'] = 'fresh-verifier',
  nonce = 'nonce',
  installer = 0
): RunnerResult {
  return {
    jobKind: kind,
    jobBinding: binding(nonce),
    state: 'settled',
    inventory: {
      state: 'complete',
      cause: null,
      identities: [
        {
          pid: kind === 'official-install' ? 10 : 20,
          birth: 'birth',
          acquisitionId: kind === 'official-install' ? 'install-root' : 'verifier-root',
          role: kind === 'official-install' ? 'installer-root' : 'verifier-root',
          parentAcquisitionId: null,
          attributionEvidenceDigest: sha('7'),
          lifetimeState: 'observed-closed',
        },
      ],
    },
    rootWait: { state: 'observed', exitCode: 0 },
    stdio: { state: 'closed' },
    cancellation: { requested: false, cleanup: 'observed-closed' },
    accounting: accounting(
      kind === 'official-install' ? 1 : installer,
      kind === 'fresh-verifier' ? 1 : 0
    ),
    primaryCause: null,
    cleanupCauses: [],
    ...(kind === 'fresh-verifier' ? { verifierReply: reply(nonce) } : {}),
  };
}
export function fixture(clock = () => 1) {
  const abort = new AbortController();
  const a = accounting();
  const budgets: Record<string, number> = {};
  for (const [key, value] of Object.entries(a)) {
    if (key === 'roleCounts') for (const role of roles) budgets[`role:${role}`] = 64;
    else if (typeof value === 'number' || typeof value === 'object') budgets[key] = 100000;
  }
  return {
    ...createFixtureEnvelopeDomain({
      transactionId: 'transaction',
      attemptId: 'attempt',
      generation: 1,
      installationId: 'candidate',
      clock,
      verifierDuration: 90,
      workEnd: 100,
      finalEnd: 120,
      signal: abort.signal,
      budgets: bounded(budgets),
    }),
    abort,
  };
}
export function bytesPort(
  data: Uint8Array,
  maximumChunk = 4096
): BytePort & { reads: number; closes: number; requests: number[] } {
  let offset = 0;
  return {
    reads: 0,
    closes: 0,
    requests: [],
    async read(target, delivery) {
      this.reads++;
      this.requests.push(target.length);
      const count = Math.min(target.length, data.length - offset, maximumChunk);
      target.set(data.subarray(offset, offset + count));
      offset += count;
      return { count, eof: offset === data.length, delivery };
    },
    async close(delivery) {
      this.closes++;
      return { delivery, state: 'closed' };
    },
  };
}
export const wire = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export async function deliver(
  f: ReturnType<typeof fixture>,
  value = runner(),
  jobDescriptor = descriptor()
) {
  const job = f.issuer.registerJob(bounded(jobDescriptor));
  const witness = f.issuer.observe(job, bounded(value), {
    noLateAcquisitions: true,
    noAcquisition: value.state === 'not-started',
  });
  const port = bytesPort(wire(value));
  const reference = await f.domain.intake(job, {}, port, witness);
  return { job, witness, port, reference, value };
}
export function publication(
  f: ReturnType<typeof fixture>,
  verifier: Awaited<ReturnType<typeof deliver>>,
  kind: 'installed' | 'reused' = 'reused'
) {
  return f.issuer.publication(
    bounded({
      kind,
      state: 'complete',
      reservation: 'released',
      currentBeforeDigest: sha('8'),
      currentAfterDigest: sha('8'),
      candidateDigest: sha('6'),
      manifestDigest: sha('9'),
      evidence: {
        installationId: 'candidate',
        manifestDigest: sha('9'),
        libraryRoot: '/fixture/library',
        executablePath: '/fixture/cache/chromium',
        ...pins,
        executableSHA256: sha('a'),
        platform: 'darwin',
        arch: 'arm64',
        verifierJobBinding: verifier.value.jobBinding,
        verifierEvidenceDigest: f.domain.fixtureEvidenceDigest(verifier.reference) ?? sha('0'),
      },
    })
  );
}
