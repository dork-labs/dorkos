/**
 * Vendor flow's fleet conformance fixture into this repo.
 *
 * The folder `plugins/flow/conformance/fleet/` in `dork-labs/marketplace` is the
 * shared contract for Claude, Codex and OpenCode accounts and their usage
 * ledgers (marketplace `specs/flow-cli-core` §1.4). DorkOS runs its own code
 * against a pinned copy in `packages/shared/src/__fixtures__/flow-fleet-conformance/`.
 * This script replaces that copy with the folder at one marketplace commit,
 * byte for byte (`git archive`), and records where it came from in
 * `SOURCE.json`. A re-sync is a contract change: review it in both repos.
 *
 * Run with: `tsx scripts/sync-flow-conformance.ts --from <marketplace checkout> --commit <sha>`
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_PATH = 'plugins/flow/conformance/fleet';
const TARGET = path.resolve(
  import.meta.dirname,
  '..',
  'packages/shared/src/__fixtures__/flow-fleet-conformance'
);
/** Files this repo owns inside the vendored folder; a re-sync keeps them. */
const LOCAL_FILES = new Set(['SOURCE.json', 'VENDORED.md']);

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) {
    console.error(
      'Usage: tsx scripts/sync-flow-conformance.ts --from <marketplace checkout> --commit <sha>'
    );
    process.exit(2);
  }
  return value;
}

const from = path.resolve(arg('--from'));
const commit = execFileSync(
  'git',
  ['-C', from, 'rev-parse', '--verify', `${arg('--commit')}^{commit}`],
  {
    encoding: 'utf8',
  }
).trim();

const staging = path.join(TARGET, '..', `.flow-fleet-conformance-${process.pid}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
try {
  const archive = execFileSync(
    'git',
    ['-C', from, 'archive', '--format=tar', commit, FIXTURE_PATH],
    {
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  execFileSync('tar', ['-x', '-C', staging], { input: archive });
  const source = path.join(staging, FIXTURE_PATH);
  const files = readdirSync(source);
  if (!files.includes('CONTRACT_VERSION')) {
    throw new Error(`${FIXTURE_PATH} at ${commit} has no CONTRACT_VERSION.`);
  }

  mkdirSync(TARGET, { recursive: true });
  for (const name of readdirSync(TARGET)) {
    if (!LOCAL_FILES.has(name)) rmSync(path.join(TARGET, name), { recursive: true, force: true });
  }
  for (const name of files) {
    writeFileSync(path.join(TARGET, name), readFileSync(path.join(source, name)));
  }
  const contractVersion = readFileSync(path.join(source, 'CONTRACT_VERSION'), 'utf8').trim();
  writeFileSync(
    path.join(TARGET, 'SOURCE.json'),
    `${JSON.stringify({ repo: 'dork-labs/marketplace', commit, contractVersion }, null, 2)}\n`
  );
  console.log(`Vendored ${files.length} files at ${commit} (contract ${contractVersion}).`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
