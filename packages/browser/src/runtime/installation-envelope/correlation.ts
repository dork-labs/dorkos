import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccountingSchema,
  BindingSchema,
  digest,
  LocalEvidenceSchema,
  ReplySchema,
  roles,
  type Accounting,
  type Identity,
  type JobBinding,
  type RunnerResult,
} from './records.js';
import { EnvelopeError } from './scanner.js';

/** Closed local projection; each digest identifies one independently supplied fixture source. */
export const JobSchema = z.strictObject({
  kind: z.enum(['official-install', 'fresh-verifier']),
  binding: BindingSchema,
  packageDigest: digest,
  sourceDigest: digest,
  entryDigest: digest,
  environmentDigest: digest,
  backendDigest: digest,
  candidateDigest: digest,
  expectedReply: ReplySchema,
});
export type JobDescriptor = z.infer<typeof JobSchema>;
export const WitnessSchema = z.strictObject({
  runner: z.unknown(),
  jobDigest: digest,
  noLateAcquisitions: z.boolean(),
  noAcquisition: z.boolean(),
});
export const PublicationSchema = z.strictObject({
  kind: z.enum(['installed', 'reused']),
  state: z.enum(['complete', 'unknown']),
  reservation: z.enum(['released', 'unknown']),
  currentBeforeDigest: digest,
  currentAfterDigest: digest,
  candidateDigest: digest,
  manifestDigest: digest,
  evidence: LocalEvidenceSchema,
});
export type Publication = z.infer<typeof PublicationSchema>;
/** Stream type-tagged scalar encodings in sorted fixed record order; never serialize a full receipt. */
export function canonicalDigest(value: unknown, check: () => void): string {
  const hash = createHash('sha256');
  const visit = (v: unknown): void => {
    check();
    if (v === null) {
      hash.update('null;');
      return;
    }
    if (typeof v === 'string') {
      hash.update(`s${v.length}:`);
      hash.update(v);
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      hash.update(`${typeof v}:${String(v)};`);
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
    throw new EnvelopeError('INVALID_ENVELOPE');
  };
  visit(value);
  check();
  return hash.digest('hex');
}
/** All observed metric values, including roles; unknown stays absent. */
export function metrics(accounting: Accounting): Map<string, number> {
  const result = new Map<string, number>([
    ['cumulativeAcquisitionIntents', accounting.cumulativeAcquisitionIntents],
  ]);
  for (const [key, value] of Object.entries(accounting)) {
    if (key === 'roleCounts') {
      for (const role of roles) {
        const metric = accounting.roleCounts[role];
        if (metric.state === 'observed') result.set(`role:${role}`, metric.value);
      }
    } else if (typeof value === 'object' && 'state' in value && value.state === 'observed')
      result.set(key, value.value);
  }
  return result;
}
/** Retained transaction prefixes; immutable acquisition identities survive job changes. */
export class FixtureLedger {
  private readonly values = new Map<string, number>();
  private readonly lifetimes = new Map<string, Identity>();
  private readonly pidBirth = new Map<string, string>();
  private unknown = false;
  constructor(private readonly budgets: Readonly<Record<string, number>>) {}
  accept(runner: RunnerResult): void {
    const next = metrics(runner.accounting);
    if (this.unknown && runner.primaryCause === null && runner.state === 'settled')
      throw new EnvelopeError('CUSTODY_UNCERTAIN');
    for (const [key, value] of next) {
      if (value < (this.values.get(key) ?? 0)) throw new EnvelopeError('INSTALLATION_INVALID');
      const cap = this.budgets[key];
      if (cap === undefined || value > cap) throw new EnvelopeError('BUDGET_EXCEEDED');
    }
    if (next.size !== 18) this.unknown = true;
    for (const identity of runner.inventory.identities) {
      const old = this.lifetimes.get(identity.acquisitionId);
      if (
        old &&
        (old.pid !== identity.pid ||
          old.birth !== identity.birth ||
          old.role !== identity.role ||
          old.parentAcquisitionId !== identity.parentAcquisitionId ||
          old.attributionEvidenceDigest !== identity.attributionEvidenceDigest ||
          (old.lifetimeState === 'observed-closed' && identity.lifetimeState !== 'observed-closed'))
      )
        throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
      const key = `${identity.pid}:${identity.birth}`;
      const previous = this.pidBirth.get(key);
      if (previous && previous !== identity.acquisitionId)
        throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
      if (!old && this.lifetimes.size >= 64) throw new EnvelopeError('BUDGET_EXCEEDED');
    }
    const actual = runner.accounting.actualAcquisitions;
    const materialized = new Set(
      [...this.lifetimes.values(), ...runner.inventory.identities]
        .filter((i) => i.lifetimeState !== 'preregistered')
        .map((i) => i.acquisitionId)
    );
    if (actual.state === 'observed' && materialized.size !== actual.value)
      throw new EnvelopeError('INSTALLATION_INVALID');
    for (const [key, value] of next) this.values.set(key, value);
    for (const identity of runner.inventory.identities) {
      this.lifetimes.set(identity.acquisitionId, identity);
      this.pidBirth.set(`${identity.pid}:${identity.birth}`, identity.acquisitionId);
    }
  }
  allObserved(accounting: Accounting): boolean {
    return !this.unknown && metrics(accounting).size === 18;
  }
}
/** Structural equality checks fixed bounded records; no equality result authenticates an issuer. */
export function same(a: unknown, b: unknown, check: () => void): boolean {
  return canonicalDigest(a, check) === canonicalDigest(b, check);
}
/** Binding correlation includes every opaque field, not only installation ID. */
export function bindingMatches(actual: JobBinding, expected: JobBinding): boolean {
  return (
    actual.transactionId === expected.transactionId &&
    actual.attemptId === expected.attemptId &&
    actual.nonce === expected.nonce &&
    actual.generation === expected.generation &&
    actual.installationId === expected.installationId
  );
}
/** Explicit mock budgets have no production defaults and must name every metric. */
export function validateBudgets(value: unknown): Readonly<Record<string, number>> {
  const names = [
    'cumulativeAcquisitionIntents',
    ...Object.keys(AccountingSchema.shape).filter(
      (key) => key !== 'cumulativeAcquisitionIntents' && key !== 'roleCounts'
    ),
    ...roles.map((role) => `role:${role}`),
  ];
  const schema = z.strictObject(
    Object.fromEntries(
      names.map((name) => [name, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
    )
  );
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EnvelopeError('INVALID_INSTALL_CONFIGURATION');
  return Object.freeze(parsed.data as Record<string, number>);
}
