import { it, expect, vi, onTestFinished } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import { NativeIdentitySchema } from '../native-observation.js';
import {
  matrixSubjects,
  qualifyFixtureOriginalMatrix,
  sampleFixtureOriginalMatrix,
  type MatrixRequest,
} from './fixture-original-matrix.js';
const original = () =>
  NativeIdentitySchema.parse({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/153.0.0.0 Safari/537.36',
    appVersion: '5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/153.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    secureContext: true,
    metadata: {
      brands: [
        { brand: 'Chromium', version: '153' },
        { brand: 'Not A Brand', version: '99' },
      ],
      fullVersionList: [
        { brand: 'Chromium', version: '153.0.8010.12' },
        { brand: 'Not A Brand', version: '99.0.0.0' },
      ],
      mobile: false,
      platform: 'macOS',
      platformVersion: '15.7.0',
      architecture: 'arm',
      bitness: '64',
      model: '',
      uaFullVersion: '153.0.8010.12',
      wow64: false,
      formFactors: ['Desktop'],
    },
  });
function observations() {
  const native = original();
  const identity = {
    ...native,
    userAgent: native.userAgent.replace('HeadlessChrome/', 'Chrome/'),
    appVersion: native.appVersion.replace('HeadlessChrome/', 'Chrome/'),
  };
  return matrixSubjects.flatMap((subject) =>
    ['initial', 'negotiated'].map((stage) => ({ subject, stage, identity }))
  );
}
function requests(): MatrixRequest[] {
  const identity = observations()[0]!.identity,
    m = identity.metadata!;
  const brands = (rows: typeof m.brands) =>
    rows.map((row) => JSON.stringify(row.brand) + ';v=' + JSON.stringify(row.version)).join(', ');
  const headers = {
    'user-agent': identity.userAgent,
    'sec-ch-ua': brands(m.brands),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-ch-ua-full-version-list': brands(m.fullVersionList!),
    'sec-ch-ua-full-version': '"153.0.8010.12"',
    'sec-ch-ua-arch': '"arm"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-platform-version': '"15.7.0"',
    'sec-ch-ua-wow64': '?0',
    'sec-ch-ua-form-factors': '"Desktop"',
  };
  return matrixSubjects.flatMap((subject) =>
    (['first', 'initial', 'negotiated'] as const).map((stage) => ({
      subject,
      stage,
      headers: { ...headers },
    }))
  );
}
it('private comparison retains all native brands/reduced legacy fields across every fixed cohort', () => {
  const baseline = original();
  expect(qualifyFixtureOriginalMatrix(baseline, observations(), requests())).toEqual({
    javascriptObservations: 14,
    httpsSubjects: 7,
    status: 'qualified',
  });
  expect(baseline.metadata!.brands.some((row) => row.brand === 'Google Chrome')).toBe(false);
});
it.each(['service', 'shared', 'popup'] as const)(
  'missing original %s first request cannot qualify',
  (subject) => {
    expect(() =>
      qualifyFixtureOriginalMatrix(
        original(),
        observations(),
        requests().filter((row) => row.subject !== subject || row.stage !== 'first')
      )
    ).toThrow('CHROME_MATRIX_HTTPS_IDENTITY_NOT_QUALIFIED');
  }
);
it('a service main-script native token cannot hide behind later negotiated Chrome requests', () => {
  const rows = requests().map((row) =>
    row.subject === 'service' && row.stage === 'first'
      ? { ...row, headers: { ...row.headers, 'user-agent': original().userAgent } }
      : row
  );
  expect(() => qualifyFixtureOriginalMatrix(original(), observations(), rows)).toThrow(
    'CHROME_MATRIX_HTTPS_IDENTITY_NOT_QUALIFIED'
  );
});
it('missing shared-worker UAData is unverified rather than an absence exception', () => {
  const rows = observations().map((row) =>
    row.subject === 'shared' ? { ...row, identity: { ...row.identity, metadata: null } } : row
  );
  expect(() => qualifyFixtureOriginalMatrix(original(), rows, requests())).toThrow(
    'CHROME_MATRIX_JS_IDENTITY_NOT_QUALIFIED'
  );
});
it('fabricated Google Chrome brands cannot replace the actual native brands', () => {
  const rows = observations().map((row) => ({
    ...row,
    identity: {
      ...row.identity,
      metadata: { ...row.identity.metadata!, brands: [{ brand: 'Google Chrome', version: '153' }] },
    },
  }));
  expect(() => qualifyFixtureOriginalMatrix(original(), rows, requests())).toThrow(
    'CHROME_MATRIX_JS_IDENTITY_NOT_QUALIFIED'
  );
});
it('late original goto after retirement never enters the fixed JS read', async () => {
  const closed = new Error('closed');
  let retired = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const page = {
    context: () => context,
    goto: vi.fn(() => held),
    reload: vi.fn(),
    evaluate: vi.fn(),
    waitForEvent: vi.fn(),
  };
  const context = { pages: () => [page] } as unknown as BrowserContext;
  const bank: { operation?: Promise<unknown> } = {};
  const originals = new Set<Promise<unknown>>();
  const track = <T>(_label: string, producer: () => Promise<T> | T): Promise<T> => {
    const work = Promise.resolve().then(producer);
    originals.add(work);
    void work.then(
      () => originals.delete(work),
      () => originals.delete(work)
    );
    return work;
  };
  onTestFinished(async () => {
    retired = true;
    release();
    const results = await Promise.allSettled([
      ...(bank.operation ? [bank.operation] : []),
      ...originals,
    ]);
    for (const result of results)
      if (result.status === 'rejected' && result.reason !== closed) throw result.reason;
  });
  bank.operation = sampleFixtureOriginalMatrix(
    context,
    'https://identity-alpha.test:4443/baseline',
    () => {
      if (retired) throw closed;
    },
    track
  );
  void bank.operation.catch(() => {});
  await Promise.resolve();
  expect(page.goto).toHaveBeenCalledTimes(1);
  retired = true;
  release();
  await expect(bank.operation).rejects.toBe(closed);
  expect(page.evaluate).not.toHaveBeenCalled();
  expect(page.reload).not.toHaveBeenCalled();
});
