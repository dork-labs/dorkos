import {
  ReviewedBrowserResourceEnvelopeSchema,
  type ReviewedBrowserResourceEnvelope,
} from './resource-envelope.js';
import { z } from 'zod';
import { BrowserRuntimeClassSchema } from './runtime-class.js';
import { acceptedBrowserModes } from './accepted-catalogue.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const BrowserModeSubjectSchema = z
  .strictObject({
    executableSHA256: digest,
    version: z.string().min(1).max(128),
    revision: z.literal('1243'),
    libraryVersion: z.literal('1.63.0'),
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.enum(['arm64', 'x64']),
    channel: z.enum(['cli', 'desktop']),
    sourceManifestSHA256: digest,
    controllerSHA256: digest,
    verifierSHA256: digest,
    nativeJournalSHA256: digest,
    runtimeClass: BrowserRuntimeClassSchema,
    productionSubjectSHA256: digest,
    mode: z.enum(['native', 'chrome-compatible']),
    identityPolicyRevision: z.literal(1),
    networkPolicyRevision: z.literal(1),
  })
  .refine(
    (value) =>
      value.runtimeClass.platform === value.platform &&
      value.runtimeClass.arch === value.arch &&
      (value.runtimeClass.kind === 'electron') === (value.channel === 'desktop')
  );
export type BrowserModeSubject = Readonly<z.infer<typeof BrowserModeSubjectSchema>>;
export const requiredBrowserModeGates = Object.freeze([
  'identity-targets',
  'network',
  'distribution',
  'native-platform',
  'semantic-input',
  'performance',
  'resources',
  'assistive-technology',
  'artifact-privacy',
  'api-grant-negatives',
] as const);
export const AcceptedBrowserModeSchema = z.strictObject({
  subject: BrowserModeSubjectSchema,
  resourceEnvelope: ReviewedBrowserResourceEnvelopeSchema.optional(),
  gates: z
    .array(
      z.strictObject({
        gate: z.enum(requiredBrowserModeGates),
        outcome: z.literal('accepted'),
        subjects: z.number().int().positive().safe(),
        samples: z.number().int().positive().safe(),
        receiptSHA256: digest,
        negativeReceiptSHA256: digest,
      })
    )
    .length(requiredBrowserModeGates.length),
});
export type AcceptedBrowserMode = Readonly<z.infer<typeof AcceptedBrowserModeSchema>>;
const refusals = new WeakSet<object>();
function unavailable(): Error {
  const reason = new Error('BROWSER_MODE_VERIFICATION_UNAVAILABLE');
  refusals.add(reason);
  return reason;
}
/** Recognize only an original private admission refusal, including through caller catch paths. */
export function isBrowserModeAdmissionRefusal(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && refusals.has(reason);
}
const key = (subject: BrowserModeSubject) =>
  JSON.stringify(BrowserModeSubjectSchema.parse(subject));
const originals = new WeakMap<
  object,
  {
    subject: string;
    current(): boolean;
    scope: 'accepted' | 'qualification';
    resourceEnvelope?: ReviewedBrowserResourceEnvelope;
  }
>();
export interface BrowserModeAdmission {
  readonly kind: 'original-browser-mode-admission';
}
export interface PrivateBrowserQualification {
  readonly kind: 'private-browser-qualification';
}
const qualifications = new WeakMap<
  PrivateBrowserQualification,
  {
    check(subject: BrowserModeSubject): boolean;
    current(): boolean;
    productionSubject?(): Promise<string>;
  }
>();
/** Private fixture constructor only; copied JSON, HTTP, config and observation receivers cannot mint this. */
export function createPrivateBrowserQualification(options: {
  check(subject: BrowserModeSubject): boolean;
  current(): boolean;
  productionSubject?(): Promise<string>;
}): PrivateBrowserQualification {
  const original = Object.freeze({ kind: 'private-browser-qualification' as const });
  const productionSubject = options.productionSubject?.bind(options);
  qualifications.set(original, {
    check: options.check.bind(options),
    current: options.current.bind(options),
    ...(productionSubject ? { productionSubject } : {}),
  });
  return original;
}
/** Source-only private fixture bootstrap; never supplies an accepted catalogue subject. */
export async function readQualificationProductionSubject(
  qualification: PrivateBrowserQualification
): Promise<string | undefined> {
  const original = qualifications.get(qualification);
  if (!original || !original.current()) throw unavailable();
  const value = await original.productionSubject?.();
  if (!original.current()) throw unavailable();
  if (value !== undefined && !/^[a-f0-9]{64}$/u.test(value)) throw unavailable();
  return value;
}
/** Issue an exact-subject lease from the reviewed catalogue or original private qualification. */
export function acquireBrowserModeAdmission(
  subject: BrowserModeSubject,
  current: () => boolean,
  qualification?: PrivateBrowserQualification
): BrowserModeAdmission {
  const captured = BrowserModeSubjectSchema.parse(subject),
    fingerprint = key(captured);
  if (!current()) throw unavailable();
  const privateOriginal = qualification && qualifications.get(qualification);
  let scope: 'accepted' | 'qualification';
  let resourceEnvelope: ReviewedBrowserResourceEnvelope | undefined;
  if (privateOriginal) {
    if (
      !privateOriginal.current() ||
      !privateOriginal.check(captured) ||
      !current() ||
      !privateOriginal.current()
    )
      throw unavailable();
    scope = 'qualification';
  } else {
    if (qualification) throw unavailable();
    const matches = acceptedBrowserModes
      .map((value) => AcceptedBrowserModeSchema.parse(value))
      .filter((entry) => {
        return (
          key(entry.subject) === fingerprint &&
          new Set(entry.gates.map((gate) => gate.gate)).size === requiredBrowserModeGates.length
        );
      });
    if (matches.length !== 1 || !current()) throw unavailable();
    if (!matches[0]!.resourceEnvelope) throw unavailable();
    resourceEnvelope = Object.freeze({ ...matches[0]!.resourceEnvelope });
    scope = 'accepted';
  }
  const admission = Object.freeze({ kind: 'original-browser-mode-admission' as const });
  originals.set(admission, {
    subject: fingerprint,
    scope,
    ...(resourceEnvelope ? { resourceEnvelope } : {}),
    current: () => current() && (!privateOriginal || privateOriginal.current()),
  });
  return admission;
}
/** Recheck the original lease, exact parsed subject and retained configuration lifetime. */
export function browserModeAdmissionCurrent(
  admission: BrowserModeAdmission,
  subject: BrowserModeSubject
): boolean {
  const original = originals.get(admission);
  return !!original && original.subject === key(subject) && original.current();
}
/** Read the original current scope without upgrading qualification to accepted. */
export function browserModeAdmissionScope(
  admission: BrowserModeAdmission
): 'accepted' | 'qualification' {
  const original = originals.get(admission);
  if (!original || !original.current()) throw unavailable();
  return original.scope;
}

/** Exact original accepted subject only. Private qualification remains an unaccepted measurement path. */
export function browserModeResourceEnvelope(
  admission: BrowserModeAdmission
): ReviewedBrowserResourceEnvelope | undefined {
  const original = originals.get(admission);
  if (!original || !original.current()) throw unavailable();
  if (original.scope === 'qualification') return;
  if (!original.resourceEnvelope) throw unavailable();
  return original.resourceEnvelope;
}
