import assert from 'node:assert/strict';
function brands(header) {
  assert.equal(typeof header, 'string');
  return [...header.matchAll(/"([^"]+)";v="([^"]+)"/g)]
    .map((match) => ({ brand: match[1], version: match[2] }))
    .sort((a, b) => a.brand.localeCompare(b.brand));
}
/** Check every emitted field independently; missing required hints remain unavailable, never fabricated. */
export function compareNativeHeaders(request, identity, { high = false } = {}) {
  assert.ok(request, 'actual fixture request required');
  assert.equal(request.headers['user-agent'], identity.ua);
  const metadata = identity.metadata;
  const expected = {
    'sec-ch-ua': metadata.brands,
    'sec-ch-ua-platform': JSON.stringify(metadata.platform),
    'sec-ch-ua-mobile': metadata.mobile ? '?1' : '?0',
    'sec-ch-ua-full-version-list': metadata.fullVersionList,
    'sec-ch-ua-full-version': JSON.stringify(metadata.uaFullVersion),
    'sec-ch-ua-arch': JSON.stringify(metadata.architecture),
    'sec-ch-ua-bitness': JSON.stringify(metadata.bitness),
    'sec-ch-ua-platform-version': JSON.stringify(metadata.platformVersion),
    'sec-ch-ua-model': JSON.stringify(metadata.model),
    'sec-ch-ua-wow64': metadata.wow64 === undefined ? undefined : metadata.wow64 ? '?1' : '?0',
    'sec-ch-ua-form-factors': metadata.formFactors
      ?.map((value) => JSON.stringify(value))
      .join(', '),
  };
  const emitted = Object.keys(request.headers).filter((name) => name.startsWith('sec-ch-ua'));
  const unsupported = [];
  for (const name of emitted) {
    if (expected[name] === undefined) {
      unsupported.push(name);
      continue;
    }
    if (name === 'sec-ch-ua' || name === 'sec-ch-ua-full-version-list')
      assert.deepEqual(
        brands(request.headers[name]),
        [...expected[name]].sort((a, b) => a.brand.localeCompare(b.brand)),
        name
      );
    else assert.equal(request.headers[name], expected[name], name);
  }
  const required = ['sec-ch-ua', 'sec-ch-ua-platform', 'sec-ch-ua-mobile'];
  if (high)
    required.push(
      ...Object.keys(expected).filter(
        (name) =>
          !required.includes(name) &&
          name !== 'sec-ch-ua-full-version' &&
          expected[name] !== undefined
      )
    );
  const missing = required.filter((name) => request.headers[name] === undefined);
  return {
    status: missing.length || unsupported.length ? 'unverified' : 'pass',
    missingFields: missing,
    unsupportedFields: unsupported,
    emittedHintNames: emitted,
  };
}
