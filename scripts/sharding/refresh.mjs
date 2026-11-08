import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { balance } from './balance.ts';

/** Extract timing metadata only, never assertions, messages, stdout or local absolute paths. */
function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory()
      ? collect(file)
      : entry.name === 'vitest-shard-report.json'
        ? [file]
        : [];
  });
}

const [reports, sourceRun] = process.argv.slice(2);
if (!reports || !/^\d+$/.test(sourceRun ?? ''))
  throw new Error(
    'Usage: node scripts/sharding/refresh.mjs <downloaded-report-directory> <run-id>'
  );
const durations = {};
let measuredAt = 0;
for (const file of collect(resolve(reports))) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (report.success !== true)
    throw new Error(`Refusing non-green report: ${relative(reports, file)}`);
  for (const test of report.testResults) {
    // The artifact report location is <apps|packages>/<package>/report.json;
    // runner paths have an arbitrary prefix, so find that exact package suffix.
    const parts = file
      .replaceAll('\\', '/')
      .match(/\/(apps|packages)\/([^/]+)\/vitest-shard-report.json$/);
    if (!parts) throw new Error(`Report is not under apps/* or packages/*: ${file}`);
    const prefix = `${parts[1]}/${parts[2]}/`;
    const offset = test.name.lastIndexOf(`/${prefix}`);
    if (offset < 0) throw new Error('Report test path does not match its package');
    const key = test.name.slice(offset + 1);
    if (key.split('/').includes('..') || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(key))
      throw new Error(`Invalid test path: ${key}`);
    const ms = test.endTime - test.startTime;
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid timing: ${key}`);
    if (Object.hasOwn(durations, key)) throw new Error(`Duplicate file: ${key}`);
    durations[key] = Math.max(1, Math.round(ms));
    measuredAt = Math.max(measuredAt, test.endTime);
  }
}
if (!Object.keys(durations).length) throw new Error('No timing records found');
const data = {
  version: 1,
  sourceRun,
  measuredAt: new Date(measuredAt).toISOString(),
  durations: Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(new URL('./durations.json', import.meta.url), `${JSON.stringify(data, null, 2)}\n`);
// Turbo runs packages serially. Balance each package independently, then sum
// each runner's assigned work. This is serial test-work, NOT predicted wall time.
const totals = Array(6).fill(0);
const packages = [
  ...new Set(Object.keys(durations).map((key) => key.split('/').slice(0, 2).join('/'))),
];
for (const pkg of packages) {
  const items = Object.keys(durations)
    .filter((key) => key.startsWith(`${pkg}/`))
    .map((key) => ({ key }));
  balance(items, 6, durations).forEach((bin, i) => (totals[i] += bin.ms));
}
console.log(
  `${Object.keys(durations).length} files from run ${sourceRun}; measured ${data.measuredAt}`
);
console.log(
  `Simulated serial test-minutes per shard: ${totals.map((ms) => (ms / 60000).toFixed(2)).join(', ')}`
);
