#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { securityPathPattern, touchesSecurity } from '../.github/scripts/security-gate.mjs';

/** Read-only arm preflight: a label never confirms approval on an exact SHA. */
export function checkPaths(
  pr,
  { run = (args) => execFileSync('gh', args, { encoding: 'utf8' }), out = console.log } = {}
) {
  if (!/^[1-9][0-9]*$/.test(String(pr)))
    throw new Error('Usage: node scripts/security-paths-check.mjs <pr-number>');
  const read = () =>
    JSON.parse(
      run([
        'pr',
        'view',
        String(pr),
        '--repo',
        'dork-labs/dorkos',
        '--json',
        'headRefOid,baseRefName,baseRefOid,labels,changedFiles',
      ])
    );
  const before = read();
  if (
    !/^[0-9a-f]{40}$/.test(before.headRefOid) ||
    !Array.isArray(before.labels) ||
    !/^[0-9a-f]{40}$/.test(before.baseRefOid) ||
    typeof before.baseRefName !== 'string' ||
    !Number.isSafeInteger(before.changedFiles)
  )
    throw new Error('Incomplete PR metadata');
  out(`PR #${pr} head ${before.headRefOid} labels [${before.labels.map((l) => l.name).join(',')}]`);
  const pages = JSON.parse(
    run(['api', '--paginate', '--slurp', `repos/dork-labs/dorkos/pulls/${pr}/files?per_page=100`])
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error('Incomplete PR file list');
  const files = pages.flat();
  if (files.length !== before.changedFiles || files.some((f) => typeof f.filename !== 'string'))
    throw new Error('Incomplete PR file list');
  const pattern = securityPathPattern();
  const hits = files.filter((file) => touchesSecurity([file], pattern));
  const after = read();
  if (
    after.headRefOid !== before.headRefOid ||
    after.baseRefOid !== before.baseRefOid ||
    after.baseRefName !== before.baseRefName
  )
    throw new Error('PR head or base moved during preflight');
  if (!hits.length) {
    out('CLEAR: no security paths');
    return 0;
  }
  out('SECURITY PATHS:');
  for (const file of hits)
    out(`  ${file.previous_filename ? `${file.previous_filename} -> ` : ''}${file.filename}`);
  out(
    before.labels.some((l) => l.name === 'security-reviewed')
      ? `Has security-reviewed: confirm Security named head ${before.headRefOid} before arming`
      : 'NO LABEL: do not arm'
  );
  return 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one PR number');
    process.exitCode = checkPaths(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
