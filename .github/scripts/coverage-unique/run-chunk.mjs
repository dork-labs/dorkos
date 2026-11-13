/* global console, process */
// One chunk of the Coverage Unique pilot: run each of this chunk's test files
// ON ITS OWN with v8 coverage, and record which source lines it reached.
//
// Usage: node run-chunk.mjs <package dir> <chunk 1..N> <N> <out.jsonl>
//
// The test list is the package's own (`vitest list --filesOnly`), so it honours
// the package's include and exclude. Files are sorted and dealt round-robin, so
// every chunk computes the same split from the same checkout. One JSON line per
// test file: { file, status, testLines, covered: { "src/x.ts": [lines] } }.
// A covered line is a line where a statement with a non-zero count starts.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const [pkgDir, chunkArg, totalArg, outFile] = process.argv.slice(2);
const chunk = Number(chunkArg);
const total = Number(totalArg);
if (!pkgDir || !outFile || !(chunk >= 1 && chunk <= total)) {
  console.error('usage: run-chunk.mjs <package dir> <chunk 1..N> <N> <out.jsonl>');
  process.exit(2);
}

// Real binaries (Codex, Claude, OpenCode) are not on this runner; CI runs those
// files in their own jobs. Everything else in the package's list is in scope.
const SKIP = /\.binary\.test\.tsx?$/;
// One file that hangs must not eat the job; it is recorded as a timeout.
const PER_FILE_TIMEOUT_MS = 10 * 60_000;

const listFile = join(mkdtempSync(join(tmpdir(), 'cov-list-')), 'files.json');
execFileSync('pnpm', ['exec', 'vitest', 'list', '--filesOnly', `--json=${listFile}`], {
  cwd: pkgDir,
  stdio: ['ignore', 'inherit', 'inherit'],
});
const listed = JSON.parse(readFileSync(listFile, 'utf8')).map((e) =>
  relative(pkgDir, typeof e === 'string' ? e : e.file)
);
const files = [...new Set(listed)].filter((f) => !SKIP.test(f)).sort();
const mine = files.filter((_, i) => i % total === chunk - 1);
console.log(`chunk ${chunk}/${total}: ${mine.length} of ${files.length} test files`);

writeFileSync(outFile, '');
for (const [n, file] of mine.entries()) {
  const reports = mkdtempSync(join(tmpdir(), 'cov-'));
  const started = Date.now();
  const run = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      file,
      '--retry=0',
      '--reporter=dot',
      '--coverage.enabled=true',
      '--coverage.provider=v8',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${reports}`,
      '--coverage.include=src/**',
    ],
    {
      cwd: pkgDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: PER_FILE_TIMEOUT_MS,
      encoding: 'utf8',
    }
  );
  const status = run.error ? 'timeout' : run.status === 0 ? 'passed' : 'failed';
  const covered = {};
  try {
    const cov = JSON.parse(readFileSync(join(reports, 'coverage-final.json'), 'utf8'));
    for (const [abs, data] of Object.entries(cov)) {
      const lines = new Set();
      for (const [id, count] of Object.entries(data.s)) {
        if (count > 0) lines.add(data.statementMap[id].start.line);
      }
      if (lines.size) covered[relative(pkgDir, abs)] = [...lines].sort((a, b) => a - b);
    }
  } catch {
    // No report: the file failed before coverage was written. Recorded as such.
  }
  const testLines = readFileSync(join(pkgDir, file), 'utf8').split('\n').length;
  appendFileSync(outFile, `${JSON.stringify({ file, status, testLines, covered })}\n`);
  rmSync(reports, { recursive: true, force: true });
  console.log(
    `[${n + 1}/${mine.length}] ${status} ${((Date.now() - started) / 1000).toFixed(1)}s ${file}`
  );
}
