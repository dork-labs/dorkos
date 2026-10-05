import type { Accounting, Cause, LocalEvidence, RunnerResult } from './records.js';
import type { JobDescriptor } from './correlation.js';
import type { Intake } from './owner.js';

/** Nominal references have no bearer fields and are meaningful only to their issuing domain. */
export interface JobReference {
  readonly fixtureJob: true;
}
export interface ResultReference {
  readonly fixtureResult: true;
}
export interface WitnessReference {
  readonly fixtureWitness: true;
}
export interface PublicationReference {
  readonly fixturePublication: true;
}
export interface InstallReference {
  readonly fixtureInstall: true;
}
export interface Registered {
  descriptor: JobDescriptor;
  digest: string;
  sequence: number;
  end: number;
  consumed: boolean;
  result?: RunnerResult;
  reference?: ResultReference;
  phase?: object;
}
export interface Witness {
  job: Registered;
  digest: string;
  noLateAcquisitions: boolean;
  noAcquisition: boolean;
}
export interface Delivery {
  job: Registered;
  key: object;
  intake: Intake;
  promise: Promise<ResultReference>;
  witness: Witness;
}
export interface Result {
  job: Registered;
  runner: RunnerResult;
  replyDigest: string | null;
  evidenceDigest: string | null;
  consumed: boolean;
}
/** Private results retain local paths; the projector below deliberately omits them. */
export interface InstallResult {
  readonly kind: 'verified-installed' | 'verified-reused' | 'refused' | 'uncertain';
  readonly cause: Cause | null;
  readonly cleanupCauses: readonly Cause[];
  readonly accounting: Accounting;
  readonly provenance: 'fixture-only';
  readonly localEvidence?: LocalEvidence;
}
