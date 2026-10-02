import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPlaywright } from '../runtime.mjs';
import { isEntrypoint } from '../entrypoint.mjs';
import { stagePatchedPackage } from './package-copy.mjs';
import { startIdentityFixture } from './fixture.mjs';
import { startOwnedWorker } from './owned-worker.mjs';

function brands(header) {
  return [...header.matchAll(/"([^"]+)";v="([^"]+)"/g)]
    .map((match) => ({ brand: match[1], version: match[2] }))
    .sort((a, b) => a.brand.localeCompare(b.brand));
}
function compareHeaders(request, ua, metadata, highEntropy = false) {
  assert.ok(request, 'required actual request absent');
  const headers = request.headers;
  assert.equal(headers['user-agent'], ua);
  assert.equal(headers['sec-ch-ua-platform'], JSON.stringify(metadata.platform));
  assert.equal(headers['sec-ch-ua-mobile'], metadata.mobile ? '?1' : '?0');
  assert.deepEqual(
    brands(headers['sec-ch-ua']),
    [...metadata.brands].sort((a, b) => a.brand.localeCompare(b.brand))
  );
  if (!highEntropy) return;
  assert.deepEqual(
    brands(headers['sec-ch-ua-full-version-list']),
    [...metadata.fullVersionList].sort((a, b) => a.brand.localeCompare(b.brand))
  );
  for (const [header, key] of [
    ['arch', 'architecture'],
    ['bitness', 'bitness'],
    ['platform-version', 'platformVersion'],
    ['model', 'model'],
  ])
    assert.equal(headers['sec-ch-ua-' + header], JSON.stringify(metadata[key]));
  assert.equal(headers['sec-ch-ua-wow64'], metadata.wow64 ? '?1' : '?0');
  if (metadata.formFactors)
    assert.equal(
      headers['sec-ch-ua-form-factors'],
      metadata.formFactors.map((value) => JSON.stringify(value)).join(', ')
    );
}

/** Observe a narrow actual-runtime identity candidate; failures are retained and never imply production activation. */
export async function runIdentityProbe({ repoRoot, privateRoot }) {
  await mkdir(privateRoot, { mode: 0o700 });
  const runtime = await loadPlaywright({ repoRoot });
  const sourceDir = await realpath(
    join(repoRoot, 'node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core')
  );
  const packageDir = join(privateRoot, 'playwright-core');
  const patch = await stagePatchedPackage({ sourceDir, stagingDir: packageDir });
  const fixture = await startIdentityFixture(privateRoot);
  let held;
  let worker;
  const receipt = {
    status: 'unverified',
    runtime: runtime.receipt,
    patch,
    tls: { fixtureOnly: true, spkiHash: fixture.spkiHash, certSha256: fixture.certSha256 },
    sandbox: { chromiumSandbox: true, noFallback: true },
    cases: [],
    limitations: [
      'Nested workers, OOPIF, persistent/restarted contexts and other platforms are unverified. Dedicated/shared/service worker observations are limited to this initial fixture. No network-policy or production readiness claim.',
    ],
  };
  try {
    worker = startOwnedWorker((event, child) => {
      if (event.type !== 'held') return;
      held = { ...event.event, requestsBeforeRelease: [] };
      setTimeout(() => {
        held.requestsBeforeRelease = fixture.requests.filter(
          (request) => request.path === '/held-popup'
        );
        held.releasedAt = Date.now();
        if (child.connected) child.send({ type: 'release' });
      }, 300);
    });
    receipt.launch = await worker.request({
      type: 'configure',
      packageDir,
      executablePath: runtime.launchOptions.executablePath,
      spkiHash: fixture.spkiHash,
      urls: fixture.urls,
    });
    const baseline = await worker.request({ type: 'case', id: 'native' });
    receipt.cases.push(baseline);
    assert.equal(baseline.result.initial.secure, true);
    assert.equal(baseline.result.popup.secure, true);
    const native = baseline.result.initial;
    assert.deepEqual(baseline.result.popup, native);
    for (const suffix of ['initial', 'popup'])
      compareHeaders(
        fixture.requests.find((request) => request.path === '/native-' + suffix),
        native.ua,
        native.metadata
      );
    for (const suffix of ['negotiated', 'negotiated-popup'])
      compareHeaders(
        fixture.requests.find((request) => request.path === '/native-' + suffix),
        native.ua,
        native.metadata,
        true
      );
    const metadata = { ...native.metadata, fullVersion: native.metadata.uaFullVersion };
    delete metadata.uaFullVersion;
    const ua = native.ua.replace('HeadlessChrome/', 'Chrome/');
    await assert.rejects(
      worker.request({
        type: 'case',
        id: 'invalid-descriptor',
        ua,
        metadata: { ...metadata, architecture: undefined },
      }),
      /architecture.*expected string/
    );
    assert.equal(
      fixture.requests.some((request) => request.path.startsWith('/invalid-descriptor')),
      false
    );
    receipt.invalidDescriptorRefused = true;
    const normal = await worker.request({ type: 'case', id: 'normalized', ua, metadata });
    receipt.cases.push(normal);
    for (const subject of [normal.result.initial, normal.result.popup]) {
      assert.equal(subject.ua, ua);
      assert.equal(subject.appVersion, native.appVersion.replace('HeadlessChrome/', 'Chrome/'));
      assert.equal(subject.platform, native.platform);
      assert.deepEqual(subject.metadata, native.metadata);
    }
    for (const path of ['/normalized-initial', '/normalized-popup']) {
      const first = fixture.requests.find((request) => request.path === path);
      compareHeaders(first, ua, native.metadata);
    }
    for (const suffix of ['negotiated', 'negotiated-popup'])
      compareHeaders(
        fixture.requests.find((request) => request.path === '/normalized-' + suffix),
        ua,
        native.metadata,
        true
      );
    const legacy = await worker.request({ type: 'case', id: 'legacy-only', ua });
    receipt.cases.push(legacy);
    receipt.uaOnlyMismatchDetected =
      JSON.stringify(legacy.result.initial.metadata) !== JSON.stringify(native.metadata);
    assert.equal(receipt.uaOnlyMismatchDetected, true);
    const controlled = await worker.request({ type: 'case', id: 'held', ua, metadata, hold: true });
    receipt.cases.push(controlled);
    receipt.heldInstallation = held;
    assert.ok(held);
    assert.equal(
      held.requestsBeforeRelease.length,
      0,
      'first popup request escaped before metadata installation acknowledgment'
    );
    const heldRequest = fixture.requests.find((request) => request.path === '/held-popup');
    const acknowledgment = controlled.result.events.find(
      (event) => event.targetId === held.targetId && event.phase === 'acknowledged'
    );
    assert.ok(acknowledgment);
    assert.ok(heldRequest.at >= acknowledgment.at, 'request precedes actual CDP acknowledgment');
    compareHeaders(heldRequest, ua, native.metadata);
    for (const subject of [controlled.result.initial, controlled.result.popup]) {
      assert.equal(subject.ua, ua);
      assert.deepEqual(subject.metadata, native.metadata);
    }
    receipt.smallestIdentityStatus = 'pass';
    const workers = await worker.request({
      type: 'case',
      id: 'workers',
      ua,
      metadata,
      workers: true,
    });
    receipt.cases.push(workers);
    receipt.workerComparisons = Object.fromEntries(
      Object.entries(workers.result.workers).map(([type, subject]) => [
        type,
        {
          legacyMatches: subject.ua === ua,
          metadataMatches: JSON.stringify(subject.metadata) === JSON.stringify(native.metadata),
        },
      ])
    );
    for (const [type, comparison] of Object.entries(receipt.workerComparisons)) {
      assert.equal(comparison.legacyMatches, true, `${type} legacy identity mismatch`);
      assert.equal(comparison.metadataMatches, true, `${type} native metadata mismatch`);
    }
    receipt.status = 'pass';
  } catch (error) {
    receipt.status = error instanceof assert.AssertionError ? 'fail' : 'unverified';
    receipt.failure = error.message;
  } finally {
    receipt.requests = fixture.requests;
    receipt.observedTargetCount = receipt.cases.reduce(
      (sum, item) => sum + 2 + Object.keys(item.result.workers ?? {}).length,
      0
    );
    if (worker) {
      try {
        receipt.cleanup = await worker.stop();
      } catch (error) {
        receipt.cleanup = {
          allGone: null,
          inventoryComplete: false,
          status: 'unverified',
          failure: error.message,
        };
        if (receipt.status !== 'fail') receipt.status = 'unverified';
      }
    }
    await fixture.close();
    await writeFile(
      join(privateRoot, 'identity-receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { mode: 0o600 }
    );
  }
  return receipt;
}

if (isEntrypoint(import.meta.url)) {
  const repoRoot = resolve(process.argv[2] ?? '.');
  const privateRoot = await mkdtemp(join(tmpdir(), 'native-metadata-'));
  // mkdir belongs to the runner; mkdtemp already registered the private parent location.
  const receipt = await runIdentityProbe({ repoRoot, privateRoot: join(privateRoot, 'probe') });
  console.log(
    JSON.stringify({
      status: receipt.status,
      failure: receipt.failure,
      artifact: join(privateRoot, 'probe/identity-receipt.json'),
      cleanup: receipt.cleanup,
    })
  );
  if (receipt.status !== 'pass') process.exitCode = 1;
}
