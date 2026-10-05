import { describe, expect, it } from 'vitest';
import {
  compareNativeIdentity,
  compareNativeRequest,
  NativeIdentitySchema,
  type NativeIdentity,
} from '../native-observation.js';

// Synthetic comparator controls only, never a measured runtime baseline.
const baseline: NativeIdentity = {
  userAgent: 'fixture HeadlessChrome/153.0.0.0',
  appVersion: 'fixture 153',
  platform: 'MacIntel',
  secureContext: true,
  metadata: {
    brands: [
      { brand: 'Chromium', version: '153' },
      { brand: 'Not_A Brand', version: '8' },
    ],
    mobile: false,
    platform: 'macOS',
    fullVersionList: [
      { brand: 'Chromium', version: '153.0.8010.12' },
      { brand: 'Not_A Brand', version: '8.0.0.0' },
    ],
    uaFullVersion: '153.0.8010.12',
    architecture: 'arm',
    bitness: '64',
    model: '',
    platformVersion: '26.6.2',
    wow64: false,
    formFactors: ['Desktop'],
  },
};
const headers = {
  'user-agent': baseline.userAgent,
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="153"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-ch-ua-full-version-list': '"Chromium";v="153.0.8010.12", "Not_A Brand";v="8.0.0.0"',
  'sec-ch-ua-arch': '"arm"',
  'sec-ch-ua-bitness': '"64"',
  'sec-ch-ua-model': '""',
  'sec-ch-ua-platform-version': '"26.6.2"',
  'sec-ch-ua-wow64': '?0',
  'sec-ch-ua-form-factors': '"Desktop"',
};
describe('native identity evidence comparisons', () => {
  it('compares negotiated native conventions without replacing MacIntel with host architecture', () => {
    expect(compareNativeRequest(headers, baseline, true).status).toBe('pass');
    expect(compareNativeIdentity(baseline, structuredClone(baseline)).status).toBe('pass');
  });
  it('retains omitted worker HTTP hints as unavailable rather than deriving them from worker JS', () => {
    const result = compareNativeRequest({ 'user-agent': baseline.userAgent }, baseline, true);
    expect(result.status).toBe('unverified');
    expect(result.unavailableFields).toContain('sec-ch-ua-arch');
  });
  it('still fails a wrong emitted architecture when brand headers are absent', () => {
    expect(
      compareNativeRequest(
        { 'user-agent': baseline.userAgent, 'sec-ch-ua-arch': '"x86"' },
        baseline,
        true
      )
    ).toMatchObject({ status: 'fail', mismatchedFields: ['sec-ch-ua-arch'] });
  });
  it.each(['junk "Chromium";v="153"', '"Chromium";v="153", broken', '"Google Chrome";v="153"'])(
    'refuses malformed or invented brand identity %s',
    (value) => {
      expect(compareNativeRequest({ ...headers, 'sec-ch-ua': value }, baseline, true).status).toBe(
        'fail'
      );
    }
  );
  it.each(['userAgent', 'platform', 'appVersion'] as const)(
    'refuses changed native %s after reopen',
    (field) => {
      const changed = structuredClone(baseline);
      changed[field] = 'invented';
      expect(compareNativeIdentity(baseline, changed)).toMatchObject({
        status: 'fail',
        mismatchedFields: [field],
      });
    }
  );
  it('refuses invented full version after service-worker update', () => {
    const changed = structuredClone(baseline);
    changed.metadata!.uaFullVersion = '154.0.0.0';
    expect(compareNativeIdentity(baseline, changed)).toMatchObject({
      status: 'fail',
      mismatchedFields: ['uaFullVersion'],
    });
  });
  it('keeps unavailable native API distinct from a coherent observed descriptor', () => {
    expect(compareNativeIdentity(baseline, { ...baseline, metadata: null }).status).toBe(
      'unverified'
    );
  });
  it('observes newly emitted optional fields instead of silently ignoring them', () => {
    const unavailable = structuredClone(baseline);
    delete unavailable.metadata!.wow64;
    delete unavailable.metadata!.formFactors;
    expect(compareNativeIdentity(unavailable, baseline)).toMatchObject({
      status: 'unverified',
      unavailableFields: expect.arrayContaining(['wow64', 'formFactors']),
    });
  });
  it('keeps required high-entropy fields unavailable when absent on both observations', () => {
    const unavailable = structuredClone(baseline);
    delete unavailable.metadata!.wow64;
    expect(compareNativeIdentity(unavailable, unavailable)).toMatchObject({
      status: 'unverified',
      unavailableFields: ['wow64'],
    });
    expect(compareNativeRequest(headers, unavailable, true).status).toBe('unverified');
  });
  it.each(['architecture', 'uaFullVersion', 'fullVersionList'] as const)(
    'preserves absent actual high-entropy %s and still compares emitted fields',
    (field) => {
      const unavailable = structuredClone(baseline);
      delete unavailable.metadata![field];
      const parsed = NativeIdentitySchema.parse(unavailable);
      expect(compareNativeIdentity(parsed, parsed)).toMatchObject({
        status: 'unverified',
        unavailableFields: expect.arrayContaining([field]),
      });
      expect(compareNativeRequest(headers, parsed, true).status).toBe('unverified');
      expect(
        compareNativeRequest({ ...headers, 'sec-ch-ua-platform': '"invented"' }, parsed, true)
      ).toMatchObject({
        status: 'fail',
        mismatchedFields: expect.arrayContaining(['sec-ch-ua-platform']),
      });
    }
  );
  it('refuses empty observed native brand inventories as unavailable', () => {
    const unavailable = structuredClone(baseline);
    unavailable.metadata!.brands = [];
    unavailable.metadata!.fullVersionList = [];
    expect(compareNativeIdentity(unavailable, unavailable)).toMatchObject({
      status: 'unverified',
      unavailableFields: expect.arrayContaining(['brands', 'fullVersionList']),
    });
  });
});
