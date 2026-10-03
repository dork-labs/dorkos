import type { Cause, LocalEvidence } from './records.js';
import type { Publication, FixtureLedger } from './correlation.js';
import { bindingMatches, same } from './correlation.js';
import { freezeData } from './own-data.js';
import { EnvelopeError } from './scanner.js';
import type { EnvelopeOwner } from './owner.js';
import type {
  ResultReference,
  PublicationReference,
  InstallReference,
  Result,
  InstallResult,
} from './references.js';
interface CompositionContext {
  owner: EnvelopeOwner;
  active: () => boolean;
  finalPrefix: () => boolean;
  terminal: () => boolean;
  installJob: boolean;
  results: WeakMap<ResultReference, Result>;
  publications: WeakMap<PublicationReference, Publication>;
  installs: WeakMap<InstallReference, InstallResult>;
  ledger: FixtureLedger;
  current: () => string | undefined;
  check: () => void;
}
/** Compose exact fixture-issued references; no structural record creates this authority. */
export function composeFixture(
  context: CompositionContext,
  verifierRef: ResultReference,
  publicationRef: PublicationReference,
  installerRef?: ResultReference
): InstallReference {
  const {
    owner,
    active,
    finalPrefix,
    terminal,
    installJob,
    results,
    publications,
    installs,
    ledger,
    current,
    check: observe,
  } = context;
  const check = () => {
    observe();
    if (active() || terminal()) throw new EnvelopeError('PUBLICATION_BUSY');
  };
  check();
  const verifier = results.get(verifierRef);
  const publication = publications.get(publicationRef);
  const installer = installerRef && results.get(installerRef);
  if (
    !verifier ||
    !publication ||
    verifier.consumed ||
    (verifier.job.descriptor.kind !== 'fresh-verifier' && verifier.runner.primaryCause === null) ||
    (installerRef &&
      (!installer || installer.consumed || installer.job.descriptor.kind !== 'official-install'))
  )
    throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
  const v = verifier.runner;
  const i = installer && installer.runner;
  const failure = i?.primaryCause ?? v.primaryCause;
  let kind: InstallResult['kind'] = 'refused';
  let cause: Cause | null = failure;
  const cleanupCauses = [
    ...new Set([...(i?.cleanupCauses ?? []), ...v.cleanupCauses, ...owner.cleanupCauses]),
  ];
  if (publication.state === 'unknown' || publication.reservation === 'unknown') {
    kind = 'uncertain';
    cause ??= 'PUBLICATION_UNCERTAIN';
  } else if (v.state === 'unknown' || i?.state === 'unknown') {
    kind = 'uncertain';
    cause ??= 'CUSTODY_UNCERTAIN';
    if (!cleanupCauses.includes('CUSTODY_UNCERTAIN')) cleanupCauses.push('CUSTODY_UNCERTAIN');
  } else if (
    (v.state !== 'settled' && v.state !== 'not-started') ||
    (i && i.state !== 'settled' && i.state !== 'not-started')
  )
    throw new EnvelopeError('CUSTODY_UNCERTAIN');
  else if (!failure) {
    const expected = verifier.job.descriptor.expectedReply;
    const evidence = publication.evidence;
    if (
      !ledger.allObserved(v.accounting) ||
      !verifier.evidenceDigest ||
      !v.verifierReply ||
      cleanupCauses.length ||
      publication.currentAfterDigest !== current() ||
      publication.candidateDigest !== verifier.job.descriptor.candidateDigest ||
      evidence.manifestDigest !== publication.manifestDigest ||
      evidence.verifierEvidenceDigest !== verifier.evidenceDigest ||
      !bindingMatches(evidence.verifierJobBinding, v.jobBinding) ||
      !same(evidenceFields(evidence), expectedFields(expected), check)
    )
      throw new EnvelopeError('INSTALLATION_INVALID');
    if (publication.kind === 'installed') {
      if (
        !i ||
        i.primaryCause ||
        installer!.job.descriptor.candidateDigest !== publication.candidateDigest
      )
        throw new EnvelopeError('INSTALLATION_INVALID');
      kind = 'verified-installed';
    } else {
      if (
        i ||
        installJob ||
        publication.currentBeforeDigest !== publication.currentAfterDigest ||
        !reuseAccounting(v.accounting)
      )
        throw new EnvelopeError('INSTALLATION_INVALID');
      kind = 'verified-reused';
    }
    if (!finalPrefix()) throw new EnvelopeError('INSTALLATION_INVALID');
    cause = null;
  }
  cause ??= 'INSTALLATION_INVALID';
  if (kind === 'verified-installed' || kind === 'verified-reused') cause = null;
  const result: InstallResult = freezeData({
    kind,
    cause,
    cleanupCauses,
    accounting: v.accounting,
    provenance: 'fixture-only',
    ...(kind === 'verified-installed' || kind === 'verified-reused'
      ? { localEvidence: publication.evidence }
      : {}),
  });
  check();
  if ((kind === 'verified-installed' || kind === 'verified-reused') && !finalPrefix())
    throw new EnvelopeError('INSTALLATION_INVALID');
  verifier.consumed = true;
  if (installer) installer.consumed = true;
  const reference = Object.freeze({ fixtureInstall: true as const });
  installs.set(reference, result);
  return reference;
}
/** Pick only bounded safe identity fields; canonical local paths remain private. */
export function evidenceFields(e: LocalEvidence) {
  return {
    installationId: e.installationId,
    libraryDistributionSHA256: e.libraryDistributionSHA256,
    executableSHA256: e.executableSHA256,
    chromiumRevision: e.chromiumRevision,
    observedVersion: e.observedVersion,
    platform: e.platform,
    arch: e.arch,
  };
}
function expectedFields(e: import('./records.js').VerifierReply) {
  return {
    installationId: e.installationId,
    libraryDistributionSHA256: e.libraryDistributionSHA256,
    executableSHA256: e.executableSHA256,
    chromiumRevision: e.chromiumRevision,
    observedVersion: e.observedVersion,
    platform: e.platform,
    arch: e.arch,
  };
}
function reuseAccounting(a: import('./records.js').Accounting): boolean {
  return (
    ['installer-root', 'downloader', 'shell', 'tool'].every((role) => {
      const m = a.roleCounts[role as keyof typeof a.roleCounts];
      return m.state === 'observed' && m.value === 0;
    }) &&
    [a.networkBytes, a.extractedBytes, a.officialArtifactAttempts].every(
      (m) => m.state === 'observed' && m.value === 0
    )
  );
}
