/**
 * Production knip ratchet. Existing findings are debt, never permission for new ones.
 * Build workspace package outputs first. CI activation is staged during the workflow freeze.
 *
 * node scripts/check-knip.ts [--base <commit>]
 * node scripts/check-knip.ts --update [--base <commit>]  lower allowances only
 * node scripts/check-knip.ts --init                      first baseline only
 * --report <path> reuses a production JSON report locally; CI always runs knip.
 * Exit 1: findings or a raised/stale baseline. Exit 2: could not measure or bad input.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  compare,
  lower,
  normalizeReport,
  parseBaseline,
  readKnip,
  type IssueCounts,
} from './knip/ratchet.ts';

const BASELINE = 'scripts/knip/baseline.json';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function baselineAt(root: string, ref: string): IssueCounts | null {
  git(root, ['cat-file', '-e', `${ref}^{commit}`]);
  if (!git(root, ['ls-tree', '--name-only', ref, '--', BASELINE]).trim()) return null;
  return parseBaseline(git(root, ['show', `${ref}:${BASELINE}`])).issues;
}

function writeBaseline(root: string, issues: IssueCounts): void {
  const file = join(root, BASELINE);
  mkdirSync(dirname(file), { recursive: true });
  const tool = JSON.parse(
    readFileSync(new URL('../node_modules/knip/package.json', import.meta.url), 'utf8')
  ) as { version: string };
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        $comment:
          'Production knip debt (DOR-4186). Keys identify issue type, file and symbol; values count occurrences. Run node scripts/check-knip.ts --update after reducing findings. Never add or raise allowances.',
        version: 1,
        knipVersion: tool.version,
        sourceCommit: git(root, ['rev-parse', 'HEAD']).trim(),
        measuredAt: new Date().toISOString(),
        issues: Object.fromEntries(Object.entries(issues).sort(([a], [b]) => a.localeCompare(b))),
      },
      null,
      2
    )}\n`
  );
}

function main(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      base: { type: 'string' },
      report: { type: 'string' },
      init: { type: 'boolean' },
      update: { type: 'boolean' },
    },
  });
  if (values.init && values.update) throw new Error('Choose --init or --update');
  const root = resolve(values.root ?? process.cwd());
  // eslint-disable-next-line no-restricted-syntax -- Root CLI uses the runner flag; no app env.ts applies.
  if (process.env.CI && values.report)
    throw new Error('CI must run knip; --report is for local evidence only');
  const current = values.report
    ? normalizeReport(JSON.parse(readFileSync(resolve(values.report), 'utf8')))
    : readKnip(root);
  const file = join(root, BASELINE);
  if (values.init) {
    if (existsSync(file)) throw new Error('Baseline exists; --init cannot reset the ratchet');
    writeBaseline(root, current);
    console.log(
      `knip: recorded ${Object.values(current).reduce((a, b) => a + b, 0)} production findings`
    );
    return 0;
  }
  let held = parseBaseline(readFileSync(file, 'utf8')).issues;
  const before = values.base ? baselineAt(root, values.base) : null;
  // Check before --update: lowering measurements must never launder hand-added allowances.
  const raised = before ? compare(held, before).filter((f) => f.kind !== 'stale') : [];
  if (raised.length) {
    console.error(`knip: baseline increased against ${values.base}:`);
    for (const f of raised.slice(0, 20)) console.error(`  ${f.kind}: ${f.key}`);
    return 1;
  }
  if (values.update) {
    held = lower(current, held);
    writeBaseline(root, held);
  }
  const findings = compare(current, held);
  if (findings.length) {
    console.error(`knip: ${findings.length} ratchet violation(s):`);
    for (const f of findings.slice(0, 20)) console.error(`  ${f.kind}: ${f.key}`);
    if (findings.some((f) => f.kind === 'stale'))
      console.error('Run node scripts/check-knip.ts --update to lock in reductions.');
    return 1;
  }
  console.log(
    `knip: ${Object.values(current).reduce((a, b) => a + b, 0)} production findings; no new or increased debt`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `knip: cannot measure: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
}
