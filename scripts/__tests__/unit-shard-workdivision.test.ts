/** Execute the actual workflow fan-in against complete and damaged shard evidence. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
const shardIds = JSON.parse(workflow.match(/^ {8}shard: (\[[^\n]+\])/m)![1]!) as number[];

/** Extract the real shell body; no copy of the lane intersection algorithm. */
function step(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const run = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  expect(run).toBeGreaterThan(start);
  const indent = lines[run]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

type Copy = { id: number; total?: number; missingLane?: boolean };
/** Run the actual identity writer and fan-in over finite artifact fixtures. */
function lane(copies: Copy[]) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dorkos-six-shards-'));
  try {
    const summary = path.join(cwd, 'summary.md');
    writeFileSync(summary, '');
    const writer = step('Read the quarantine lane')
      .split('\n')
      .find((line) => line.includes('> "$RUNNER_TEMP/shard.txt"'))!;
    expect(writer).toBeTruthy();
    for (const [index, copy] of copies.entries()) {
      const dir = path.join(cwd, 'lane', `copy-${index}`);
      mkdirSync(dir, { recursive: true });
      const command = writer.replaceAll('${{ matrix.shard }}', String(copy.id));
      const written = spawnSync('bash', ['-e', '-c', command], {
        cwd,
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- real bash step reads runner paths.
        env: { ...process.env, RUNNER_TEMP: dir },
      });
      expect(written.status, written.stderr).toBe(0);
      if (copy.total !== undefined)
        writeFileSync(path.join(dir, 'shard.txt'), `${copy.id}/${copy.total}\n`);
      if (!copy.missingLane)
        writeFileSync(
          path.join(dir, 'quarantine.txt'),
          `apps/client/shared.test.ts > same\napps/client/only-${index}.test.ts > distinct\n`
        );
    }
    const result = spawnSync(
      'bash',
      ['-e', '-o', 'pipefail', '-c', step('Agree on the lane this build ran under')],
      {
        cwd,
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- real bash step reads runner paths.
        env: { ...process.env, RUNNER_TEMP: cwd, GITHUB_STEP_SUMMARY: summary },
      }
    );
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      intersection: (() => {
        try {
          return readFileSync(path.join(cwd, 'quarantine.txt'), 'utf8');
        } catch {
          return '';
        }
      })(),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const complete = () => shardIds.map((id) => ({ id }));
describe('six-way unit file work division', () => {
  it('uses every matrix identity once and both sweeps partition the same total', () => {
    expect(shardIds).toEqual([1, 2, 3, 4, 5, 6]);
    const denominators = [...workflow.matchAll(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/g)].map(
      (match) => Number(match[1])
    );
    expect(denominators).toEqual([shardIds.length, shardIds.length]);
    const result = lane(complete());
    expect(result.status, result.output).toBe(0);
    expect(result.intersection).toBe('apps/client/shared.test.ts > same\n');
  });
  it('refuses a missing matrix copy instead of widening the intersection', () => {
    const result = lane(complete().slice(0, -1));
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('only 5 handed over');
  });
  it('refuses duplicate identities even with six artifact directories', () => {
    const result = lane([...complete().slice(0, -1), { id: 5 }]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('not shards 1..6 exactly');
  });
  it('refuses a stale denominator rather than mixing runs', () => {
    const result = lane([...complete().slice(0, -1), { id: 6, total: 4 }]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('disagree about how many');
  });
  it('refuses a missing lane body even when every identity arrived', () => {
    const result = lane([...complete().slice(0, -1), { id: 6, missingLane: true }]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('not every shard handed over');
  });
});
