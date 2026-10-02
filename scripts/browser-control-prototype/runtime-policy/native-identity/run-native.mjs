import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startNativeFixture } from './fixture.mjs';
import { startNativeWorker } from './owned-worker.mjs';
import { isEntrypoint } from '../../entrypoint.mjs';
import { bundleSha256 } from './pins.mjs';
import { compareNativeHeaders } from './headers.mjs';

function headersMatch(request, identity, { hintsRequired = true, ...options } = {}) {
  const result = compareNativeHeaders(request, identity, options);
  if (hintsRequired && result.status === 'unverified')
    throw Error('NATIVE_HIGH_HINT_NOT_EMITTED:' + request.path);
  return result;
}
/** Observe unchanged native identity in private cross-site fixtures; no generated dependency patch is used. */
export async function runNativeProbe({ repoRoot, privateDir, delegateHints = true }) {
  await mkdir(privateDir, { mode: 0o700 });
  const bundle = join(
    repoRoot,
    'node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/lib/coreBundle.js'
  );
  const originalHash = createHash('sha256')
    .update(await readFile(bundle))
    .digest('hex');
  if (originalHash !== bundleSha256) throw Error('UNPATCHED_BUNDLE_PIN_MISMATCH');
  const fixture = await startNativeFixture(privateDir, { delegateHints });
  const receipt = {
    status: 'unverified',
    phase: 'cross-site-initial',
    noIdentityOverride: true,
    noPatch: true,
    installedBundleSha256: originalHash,
    tls: { fixtureOnly: true, spkiHash: fixture.spkiHash, certSha256: fixture.certSha256 },
    hostMapping: fixture.hostMapping,
    hintDelegation: delegateHints,
    observations: null,
    limitations: [
      'Private persistent restart, background lifetimes, nested workers, worker restart/update and other platforms remain unverified. Native mode does not resolve the Chrome-compatible preference.',
    ],
  };
  let worker;
  try {
    worker = startNativeWorker();
    receipt.launch = await worker.request({
      type: 'configure',
      repoRoot,
      hostMapping: fixture.hostMapping,
      hintDelegation: delegateHints,
      spkiHash: fixture.spkiHash,
    });
    receipt.observations = (await worker.request({ type: 'matrix', urls: fixture.urls })).result;
    const { main, frame, workers, reload, oopifTargets } = receipt.observations;
    receipt.subjects = [
      { id: 'page-initial', identity: main },
      { id: 'cross-site-frame', identity: frame },
      { id: 'page-reload', identity: reload },
      ...Object.entries(workers).map(([type, identity]) => ({ id: type + '-worker', identity })),
    ];
    receipt.subjectCount = receipt.subjects.length;
    assert.equal(main.secure, true);
    for (const subject of [frame, reload, ...Object.values(workers)])
      assert.deepEqual(subject, main);
    assert.equal(oopifTargets.length, 1, 'actual cross-site iframe target must be observed');
    assert.equal(
      oopifTargets[0].url,
      receipt.observations.frameUrl,
      'observed target URL binds to the exact evaluated frame'
    );
    headersMatch(
      fixture.requests.find((request) => request.path === '/page'),
      main
    );
    headersMatch(
      fixture.requests.find((request) => request.path === '/frame'),
      main
    );
    for (const path of ['/page-negotiated', '/frame-negotiated'])
      headersMatch(
        fixture.requests.find((request) => request.path === path),
        main,
        { high: true }
      );
    receipt.workerHttpHints = {};
    receipt.workerEndpointPageControls = {};
    for (const type of ['dedicated', 'shared', 'service']) {
      headersMatch(
        fixture.requests.find((request) => request.path === '/worker-' + type),
        main,
        { hintsRequired: false }
      );
      const fetched = fixture.requests.find((request) => request.path === '/fetch-' + type);
      const availability = headersMatch(fetched, main, { high: true, hintsRequired: false });
      const pageControl = fixture.requests.find(
        (request) =>
          request.path === '/fetch-' + type && request.headers['sec-ch-ua-full-version-list']
      );
      headersMatch(pageControl, main, { high: true });
      receipt.workerEndpointPageControls[type] = {
        observed: true,
        path: pageControl.path,
        headers: pageControl.headers,
      };
      receipt.workerHttpHints[type] = {
        ...availability,
        limitation:
          availability.status === 'pass'
            ? null
            : 'Native worker HTTP request emitted no Client Hints despite fixture Accept-CH; JS descriptor and legacy HTTP UA were observed separately.',
      };
    }
    receipt.nativeCoherenceStatus = 'pass';
    receipt.status = Object.values(receipt.workerHttpHints).every(
      (observation) => observation.status === 'pass'
    )
      ? 'pass'
      : 'unverified';
  } catch (error) {
    receipt.status = error instanceof assert.AssertionError ? 'fail' : 'unverified';
    receipt.failure = error.message;
  } finally {
    receipt.requests = fixture.requests;
    if (worker)
      try {
        receipt.cleanup = await worker.stop();
      } catch (error) {
        receipt.cleanup = {
          status: 'unverified',
          inventoryComplete: false,
          allGone: null,
          failure: error.message,
        };
        if (receipt.status !== 'fail') receipt.status = 'unverified';
      }
    await fixture.close();
    receipt.installedSourceUnchanged =
      originalHash ===
      createHash('sha256')
        .update(await readFile(bundle))
        .digest('hex');
    if (!receipt.installedSourceUnchanged) {
      receipt.status = 'fail';
      receipt.failure = 'INSTALLED_SOURCE_CHANGED';
    }
    await writeFile(
      join(privateDir, 'native-receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { mode: 0o600 }
    );
  }
  return receipt;
}
if (isEntrypoint(import.meta.url)) {
  const root = await mkdtemp(join(tmpdir(), 'unchanged-native-'));
  const receipt = await runNativeProbe({
    repoRoot: resolve(process.argv[2] ?? '.'),
    privateDir: join(root, 'probe'),
  });
  console.log(
    JSON.stringify({
      status: receipt.status,
      failure: receipt.failure,
      artifact: join(root, 'probe/native-receipt.json'),
      cleanup: receipt.cleanup,
    })
  );
  if (receipt.status !== 'pass') process.exitCode = 1;
}
