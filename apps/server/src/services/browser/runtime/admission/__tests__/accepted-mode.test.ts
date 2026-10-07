import { afterEach, expect, it, vi } from 'vitest';
import {
  BrowserModeSubjectSchema,
  acquireBrowserModeAdmission,
  browserModeAdmissionCurrent,
  browserModeAdmissionScope,
  createPrivateBrowserQualification,
  isBrowserModeAdmissionRefusal,
  type AcceptedBrowserMode,
  type BrowserModeSubject,
  requiredBrowserModeGates,
  readQualificationProductionSubject,
} from '../accepted-mode.js';
// These mock records test the production consumer; they are not native acceptance receipts.
const { records } = vi.hoisted(() => ({ records: [] as AcceptedBrowserMode[] }));
vi.mock('../accepted-catalogue.js', () => ({ acceptedBrowserModes: records }));
afterEach(() => {
  records.length = 0;
});
const subject = Object.freeze<BrowserModeSubject>({
  executableSHA256: '1'.repeat(64),
  version: '153.0.8000.0',
  revision: '1243',
  libraryVersion: '1.63.0',
  platform: 'darwin',
  arch: 'arm64',
  channel: 'cli',
  sourceManifestSHA256: '2'.repeat(64),
  controllerSHA256: '3'.repeat(64),
  verifierSHA256: '4'.repeat(64),
  nativeJournalSHA256: '5'.repeat(64),
  productionSubjectSHA256: '6'.repeat(64),
  runtimeClass: {
    kind: 'node',
    nodeVersion: '24.14.1',
    modulesABI: '137',
    v8Version: '13.6.233.17-node.39',
    opensslVersion: '3.5.4',
    uvVersion: '1.51.0',
    electronVersion: null,
    platform: 'darwin',
    arch: 'arm64',
    featureContract: 'browser-owner-runtime-v1',
    surface: {
      abortSignalAny: true,
      abortSignalTimeout: true,
      workerThreads: true,
      callbackDnsCancel: true,
      bigint: true,
    },
  },
  mode: 'native',
  identityPolicyRevision: 1,
  networkPolicyRevision: 1,
});
const entry = (): AcceptedBrowserMode => ({
  subject,
  // Synthetic controlled catalogue limits; these are not a reviewed release envelope.
  resourceEnvelope: {
    profiles: 2,
    browsers: 2,
    captureMinimumIntervalMilliseconds: 100,
    maximumCPUPercent: 50,
    minimumAvailableMemoryBytes: 1000,
    maximumBrowserRSSBytes: 10000,
    maximumObservationAgeMilliseconds: 500,
    samplingIntervalMilliseconds: 100,
  },
  gates: requiredBrowserModeGates.map((gate) => ({
    gate,
    outcome: 'accepted',
    subjects: 1,
    samples: 1,
    receiptSHA256: '7'.repeat(64),
    negativeReceiptSHA256: '8'.repeat(64),
  })),
});
it('fails closed with no reviewed record; installation facts alone do not mint admission', () => {
  let reason: unknown;
  try {
    acquireBrowserModeAdmission(subject, () => true);
  } catch (value) {
    reason = value;
  }
  expect(isBrowserModeAdmissionRefusal(reason)).toBe(true);
  expect(isBrowserModeAdmissionRefusal(new Error('BROWSER_MODE_VERIFICATION_UNAVAILABLE'))).toBe(
    false
  );
});
it.each([
  'executableSHA256',
  'controllerSHA256',
  'verifierSHA256',
  'sourceManifestSHA256',
  'productionSubjectSHA256',
  'nativeJournalSHA256',
] as const)('rejects a stale exact %s', (field) => {
  records.push(entry());
  expect(() =>
    acquireBrowserModeAdmission({ ...subject, [field]: '9'.repeat(64) }, () => true)
  ).toThrow();
});
it('keeps native separate from unavailable Chrome and denies duplicate or incomplete gates', () => {
  records.push(entry());
  const original = acquireBrowserModeAdmission(subject, () => true);
  expect(browserModeAdmissionScope(original)).toBe('accepted');
  expect(() =>
    acquireBrowserModeAdmission({ ...subject, mode: 'chrome-compatible' }, () => true)
  ).toThrow();
  records[0] = { ...entry(), gates: entry().gates.map(() => entry().gates[0]!) };
  expect(() => acquireBrowserModeAdmission(subject, () => true)).toThrow();
});
it('revokes the exact retained lease when the captured configuration epoch changes', () => {
  records.push(entry());
  let epoch = 1;
  const original = acquireBrowserModeAdmission(subject, () => epoch === 1);
  expect(browserModeAdmissionCurrent(original, subject)).toBe(true);
  expect(browserModeAdmissionCurrent({ ...original }, subject)).toBe(false);
  epoch++;
  expect(browserModeAdmissionCurrent(original, subject)).toBe(false);
});
it('qualification is explicitly unaccepted, exact-subject scoped, original and revocable', () => {
  let alive = true;
  const originalSubject = JSON.stringify(BrowserModeSubjectSchema.parse(subject));
  const qualifier = createPrivateBrowserQualification({
    current: () => alive,
    check: (value) => JSON.stringify(value) === originalSubject,
  });
  const original = acquireBrowserModeAdmission(subject, () => true, qualifier);
  expect(browserModeAdmissionScope(original)).toBe('qualification');
  expect(() => acquireBrowserModeAdmission(subject, () => true, { ...qualifier })).toThrow();
  expect(() =>
    acquireBrowserModeAdmission({ ...subject, mode: 'chrome-compatible' }, () => true, qualifier)
  ).toThrow();
  alive = false;
  expect(browserModeAdmissionCurrent(original, subject)).toBe(false);
});
it.each([false, undefined])('preserves a genuine qualification producer fault %s', (reason) => {
  const qualifier = createPrivateBrowserQualification({
    current: () => true,
    check: () => {
      throw reason;
    },
  });
  let observed: unknown = new Error('not entered');
  try {
    acquireBrowserModeAdmission(subject, () => true, qualifier);
  } catch (value) {
    observed = value;
  }
  expect(observed).toBe(reason);
});

it('source-only qualification captures its original subject supplier without making ordinary acceptance available', async () => {
  let current = true;
  const options = {
    current: () => current,
    check: () => true,
    productionSubject: async () => 'a'.repeat(64),
  };
  const original = createPrivateBrowserQualification(options);
  options.productionSubject = async () => 'b'.repeat(64);
  expect(await readQualificationProductionSubject(original)).toBe('a'.repeat(64));
  await expect(readQualificationProductionSubject({ ...original })).rejects.toSatisfy(
    isBrowserModeAdmissionRefusal
  );
  expect(() => acquireBrowserModeAdmission(subject, () => true)).toThrow();
  current = false;
  await expect(readQualificationProductionSubject(original)).rejects.toSatisfy(
    isBrowserModeAdmissionRefusal
  );
});

it.each([
  { platform: 'linux' as const },
  { arch: 'x64' as const },
  { channel: 'desktop' as const },
  { version: '154.0.0.0' },
])(
  'rejects an otherwise qualified record for another exact platform, channel or runtime %j',
  (change) => {
    records.push(entry());
    expect(() => acquireBrowserModeAdmission({ ...subject, ...change }, () => true)).toThrow();
  }
);

it.each(['nodeVersion', 'modulesABI', 'featureContract'] as const)(
  'refuses a different exact qualified runtime %s',
  (field) => {
    records.push(entry());
    const changed =
      field === 'nodeVersion' ? '24.14.2' : field === 'modulesABI' ? '138' : 'unknown-contract';
    expect(() =>
      acquireBrowserModeAdmission(
        { ...subject, runtimeClass: { ...subject.runtimeClass, [field]: changed } },
        () => true
      )
    ).toThrow();
  }
);
it('does not qualify a missing primitive or mismatched runtime platform from a nominal version', () => {
  records.push(entry());
  expect(() =>
    acquireBrowserModeAdmission(
      BrowserModeSubjectSchema.parse({
        ...subject,
        runtimeClass: {
          ...subject.runtimeClass,
          surface: { ...subject.runtimeClass.surface, callbackDnsCancel: false },
        },
      }),
      () => true
    )
  ).toThrow();
  expect(() =>
    acquireBrowserModeAdmission(
      { ...subject, runtimeClass: { ...subject.runtimeClass, platform: 'linux' } },
      () => true
    )
  ).toThrow();
});
