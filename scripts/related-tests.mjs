// Print the test files of one package that Vitest's import graph ties to a
// set of files (DOR-5110). The selection half of `vitest related`, without
// running anything, so scripts/pr-related-tests.sh can see the set before it
// runs it: an empty set for a package's own changed source is a reason to run
// that package's whole suite, not a pass.
//
// Run from the package's directory, with the config the shards use (the
// package's own config, through scripts/sharding/config.ts), so its aliases
// and setup files resolve exactly as they do in the run.
//
//   node <repo>/scripts/related-tests.mjs <config> <file>...
//
// Prints one absolute test file path per line, the real-CLI suites
// (`*.binary.test.ts`, which test-binary runs) left out. Exits non-zero when
// the graph cannot be read, and the caller treats that as "run the whole
// suite". Vitest's own logs go to stderr.
import { resolve } from 'node:path';
import { createVitest } from 'vitest/node';

const [config, ...files] = process.argv.slice(2);
if (!config || files.length === 0) {
  console.error('usage: related-tests.mjs <config> <file>...');
  process.exit(2);
}

const vitest = await createVitest(
  'test',
  {
    config: resolve(config),
    related: files.map((file) => resolve(file)),
    watch: false,
    run: true,
    passWithNoTests: true,
  },
  {},
  { stdout: process.stderr, stderr: process.stderr }
);
try {
  const specs = await vitest.getRelevantTestSpecifications();
  const unique = new Set(specs.map((spec) => spec.moduleId));
  for (const file of [...unique].sort()) {
    if (!file.endsWith('.binary.test.ts')) console.log(file);
  }
} finally {
  await vitest.close();
}
