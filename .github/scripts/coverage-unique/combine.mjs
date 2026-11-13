// Combine the Coverage Unique pilot's chunks into one report.
//
// Usage: node combine.mjs <dir of chunk *.jsonl> <package> <out dir>
//
// A test file's UNIQUE lines are the source lines no other passing test file in
// the package reaches. The report lists every passing test file with zero
// unique lines, largest first, with its own length in lines. Files that failed
// or timed out are left out of the counting on both sides and listed apart:
// their coverage is partial, and counting it could make a passing file look
// redundant when it is not.
//
// Zero unique lines is a lead, not a verdict: two files can reach the same
// lines and assert different things. Mutation results and a reading of the
// file decide; this only says where to look.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [inDir, pkg, outDir] = process.argv.slice(2);
if (!inDir || !pkg || !outDir) {
  console.error('usage: combine.mjs <dir of chunk *.jsonl> <package> <out dir>');
  process.exit(2);
}

const rows = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl'))
      for (const line of readFileSync(p, 'utf8').split('\n')) if (line) rows.push(JSON.parse(line));
  }
};
walk(inDir);

const passed = rows.filter((r) => r.status === 'passed');
const notPassed = rows.filter((r) => r.status !== 'passed');

// Every covered line gets a small integer id; `reach[id]` counts the passing
// files that reach it.
const ids = new Map();
const reach = [];
const linesOf = passed.map((r) => {
  const own = [];
  for (const [src, lines] of Object.entries(r.covered)) {
    for (const line of lines) {
      const key = `${src}:${line}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = reach.length;
        ids.set(key, id);
        reach.push(0);
      }
      reach[id] += 1;
      own.push(id);
    }
  }
  return own;
});

const perFile = passed.map((r, i) => ({
  file: r.file,
  testLines: r.testLines,
  coveredLines: linesOf[i].length,
  uniqueLines: linesOf[i].filter((id) => reach[id] === 1).length,
}));
const noUnique = perFile
  .filter((f) => f.uniqueLines === 0)
  .sort((a, b) => b.testLines - a.testLines);

const report = {
  package: pkg,
  generated: new Date().toISOString(),
  testFiles: rows.length,
  passed: passed.length,
  notPassed: notPassed.map(({ file, status }) => ({ file, status })),
  coveredSourceLines: reach.length,
  noUniqueCoverage: noUnique,
  noUniqueTestLines: noUnique.reduce((a, f) => a + f.testLines, 0),
  perFile: perFile.sort((a, b) => a.file.localeCompare(b.file)),
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'coverage-unique.json'), `${JSON.stringify(report, null, 2)}\n`);

const md = [
  `## Coverage Unique pilot: ${pkg}`,
  '',
  `- Test files: ${rows.length} (${passed.length} passed; ${notPassed.length} failed or timed out, left out)`,
  `- Source lines reached by at least one passing file: ${reach.length}`,
  `- **Files that reach no line another file does not: ${noUnique.length}**, ${report.noUniqueTestLines} test lines in all`,
  '',
  'A lead, not a verdict: overlapping coverage can still assert different things.',
  '',
  '| Test file | Its lines | Source lines it reaches |',
  '| --- | --- | --- |',
  ...noUnique.slice(0, 50).map((f) => `| \`${f.file}\` | ${f.testLines} | ${f.coveredLines} |`),
  noUnique.length > 50 ? `\n${noUnique.length - 50} more in coverage-unique.json.` : '',
];
writeFileSync(join(outDir, 'coverage-unique.md'), `${md.join('\n')}\n`);
console.log(md.join('\n'));
