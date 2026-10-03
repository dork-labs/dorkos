import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isEntrypoint } from '../../entrypoint.mjs';
import { verifyCustody } from './custody.mjs';
import { CohortRunner } from './cohort-runner.mjs';
import { NativeGuardianPort } from './native-port.mjs';
import { guardianObservations } from './guardian-observations.mjs';

/** Execute only the explicit private research CLI; this partial native slice cannot certify task4.3. */
export async function runNative({
  manifestPath,
  receiptRoot,
  scenario,
  platform = process.platform,
}) {
  if (platform !== 'darwin') throw Error('DARWIN_UNAVAILABLE');
  if (
    scenario !== 'owned-v2-once' ||
    resolve(manifestPath) !== manifestPath ||
    resolve(receiptRoot) !== receiptRoot
  )
    throw Error('NATIVE_ARGUMENTS');
  const stat = await lstat(receiptRoot);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(receiptRoot)) !== receiptRoot
  )
    throw Error('RECEIPT_ROOT');
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 16_384) throw Error('CUSTODY_MANIFEST');
  const custody = await verifyCustody(JSON.parse(manifestBytes.toString('utf8')));
  const guardians = [];
  let cleanup;
  const runner = new CohortRunner({
    now: () => performance.now(),
    registerCleanup: (fn) => {
      cleanup = fn;
      return true;
    },
    guardianFactory: async (allocation, record) => {
      const guardian = new NativeGuardianPort(custody, allocation);
      guardians.push(guardian);
      await record(guardian);
      await guardian.start();
    },
  });
  // Cooperative EOF only. No signal, process search, imported PID or cleanup fallback exists here.
  const interrupt = () => {
    void cleanup();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let portable;
  try {
    portable = await runner.run();
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  const receipt = {
    kind: 'native-research-partial',
    status: 'UNVERIFIED',
    fullTask4_3: 'OPEN',
    completeness: 'UNVERIFIED',
    reason: portable.reason,
    pins: portable.pins,
    library: 'installed private libproc; each counted G resolves before fixtures/query/candidate',
    kernelCorrespondence: 'UNVERIFIED',
    ...guardianObservations(guardians),
    cohorts: portable.results,
    remainingCohorts: 6 - portable.results.length,
    cleanup: portable.cleanup,
    controlledDirectSlotsClosed: portable.cleanup.every(
      (c) => c.closure && Object.values(c.closure).every((value) => value === true)
    ),
    guardians: guardians.map((g) => ({
      cohort: g.allocation.id,
      spawnObserved: g.spawnObserved,
      exitObserved: g.exitObserved,
      exitCode: g.exitCode ?? null,
      failure: g.failure,
      attempts: g.events,
    })),
    limitations: [
      'Native gap cohorts stop without an attributable non-direct exit oracle; no gap-success stub',
      'Known direct fixture slots are not complete arbitrary descendant inventory',
      'Unknown startup/late acquisition counts stay incomplete; no general Chromium containment',
      'Private API runtime/platform coverage and native invocation are separately gated',
    ],
  };
  await writeFile(
    join(receiptRoot, 'owned-v2-once.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }
  );
  return receipt;
}

if (isEntrypoint(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length !== 6 ||
    arguments_[0] !== '--custody-manifest' ||
    arguments_[2] !== '--receipt-root' ||
    arguments_[4] !== '--scenario'
  ) {
    process.stderr.write('NATIVE_ARGUMENTS\n');
    process.exitCode = 1;
  } else {
    try {
      const receipt = await runNative({
        manifestPath: arguments_[1],
        receiptRoot: arguments_[3],
        scenario: arguments_[5],
      });
      process.stdout.write(
        JSON.stringify({
          status: receipt.status,
          fullTask4_3: receipt.fullTask4_3,
          counts: receipt.counts,
        }) + '\n'
      );
      process.exitCode = 2;
    } catch (error) {
      process.stderr.write(
        /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
          ? error.message + '\n'
          : 'NATIVE_SETUP_UNVERIFIED\n'
      );
      process.exitCode = 1;
    }
  }
}
