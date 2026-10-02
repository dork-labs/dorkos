import assert from 'node:assert/strict';
import test from 'node:test';
import { compareNativeHeaders } from './headers.mjs';
const identity = {
  ua: 'native-fixture-UA',
  metadata: {
    brands: [{ brand: 'Chromium', version: '153' }],
    fullVersionList: [{ brand: 'Chromium', version: '153.0.8010.12' }],
    platform: 'macOS',
    mobile: false,
    architecture: 'arm',
    bitness: '64',
    platformVersion: '26.6.2',
    model: '',
    wow64: false,
    formFactors: ['Desktop'],
  },
};
const request = (headers) => ({
  path: '/owned-partial-hints',
  headers: { 'user-agent': identity.ua, ...headers },
});

test('a partial emitted hint cannot hide behind an absent brand header', () => {
  for (const headers of [
    { 'sec-ch-ua-arch': '"wrong"' },
    { 'sec-ch-ua-full-version-list': '"Chromium";v="1.0.0.0"' },
    { 'sec-ch-ua-platform': '"wrong"' },
    { 'sec-ch-ua-bitness': '"32"' },
    { 'sec-ch-ua-wow64': '?1' },
    { 'sec-ch-ua-form-factors': '"Mobile"' },
  ])
    assert.throws(
      () => compareNativeHeaders(request(headers), identity, { hintsRequired: false }),
      assert.AssertionError
    );
});

test('matching partial hints retain missing-field UNVERIFIED without inventing values', () => {
  const result = compareNativeHeaders(request({ 'sec-ch-ua-arch': '"arm"' }), identity, {
    high: true,
  });
  assert.equal(result.status, 'unverified');
  assert.ok(result.missingFields.includes('sec-ch-ua'));
  assert.ok(result.missingFields.includes('sec-ch-ua-full-version-list'));
  assert.deepEqual(result.emittedHintNames, ['sec-ch-ua-arch']);
  const absent = compareNativeHeaders(request({}), identity);
  assert.equal(absent.status, 'unverified');
  assert.deepEqual(absent.missingFields, ['sec-ch-ua', 'sec-ch-ua-platform', 'sec-ch-ua-mobile']);
});
