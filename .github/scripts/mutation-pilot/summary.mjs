/* global console, process */
// Prints a Markdown summary of one Mutation Pilot run for the job summary:
// mutant counts by status, the score, elapsed time and peak memory.
// Usage: node summary.mjs <report dir>. Missing data prints as "unknown",
// never as zero.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);

const counts = {};
const report = read('mutation.json');
if (report) {
  for (const file of Object.values(JSON.parse(report).files ?? {})) {
    for (const mutant of file.mutants ?? [])
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  }
}
const detected = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
const valid = detected + (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
const score = valid ? `${((100 * detected) / valid).toFixed(1)}%` : 'unknown';

const elapsed = read('elapsed.txt')?.match(/elapsed_seconds=(\d+)/)?.[1];
const peakKb = read('resources.txt')?.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1];

console.log('## Mutation Pilot: packages/shared');
console.log('');
console.log(`- Mutation score (killed + timeout over valid mutants): **${score}**`);
console.log(`- Elapsed: ${elapsed ? `${(Number(elapsed) / 60).toFixed(1)} min` : 'unknown'}`);
console.log(`- Peak memory: ${peakKb ? `${(Number(peakKb) / 1024).toFixed(0)} MB` : 'unknown'}`);
console.log('');
console.log('| Status | Mutants |');
console.log('| --- | --- |');
if (Object.keys(counts).length === 0) console.log('| unknown (no mutation.json) | unknown |');
for (const [status, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
  console.log(`| ${status} | ${n} |`);
