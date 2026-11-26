/**
 * Every gate answers `--help` with its document of record (DOR-4950): what it
 * is for, where it runs, how to fix a failure, and how to call it, read from
 * its own header and printed before it does any work.
 *
 * A gate is found by name, so a new one is held here the day it lands:
 * `check-*`, `assert-*`, `pre-push-*` and `*-check` scripts in `scripts/`, and
 * `check-*.ts` one folder down. `heavy-run-lock.sh` is the load gate, not a
 * check, and keeps its own `--help` (the queue usage).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readGateHelp } from '../lib/gate-help.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOP = /^(?!test-)(?:(?:check|assert|pre-push)-.+|.+-check)\.(?:sh|ts|mjs)$/;
const NESTED = /^check-.+\.ts$/;

/** Every gate script, as a path relative to `scripts/`. */
function gates(): string[] {
  const found: string[] = [];
  for (const name of readdirSync(SCRIPTS)) {
    const path = join(SCRIPTS, name);
    if (statSync(path).isFile()) {
      if (TOP.test(name)) found.push(name);
    } else if (name !== '__tests__' && name !== 'node_modules') {
      for (const inner of readdirSync(path)) {
        if (NESTED.test(inner)) found.push(relative(SCRIPTS, join(path, inner)));
      }
    }
  }
  return found.sort();
}

/** How CI and the hooks start a gate of this kind. */
function command(gate: string): [string, string[]] {
  const path = join(SCRIPTS, gate);
  if (gate.endsWith('.sh')) return ['bash', [path]];
  if (gate.endsWith('.ts')) return [process.execPath, ['--import', 'tsx', path]];
  return [process.execPath, [path]];
}

describe('gate --help', () => {
  it('finds the gates by name', () => {
    expect(gates()).toEqual(
      expect.arrayContaining([
        'check-max-lines.ts',
        'pre-push-format-check.sh',
        'not-held-check.sh',
      ])
    );
  });

  it.each(gates())(
    '%s prints its purpose, where it runs and how to fix it, and exits 0',
    (gate) => {
      const [bin, args] = command(gate);
      const started = Date.now();
      const run = spawnSync(bin, [...args, '--help'], { encoding: 'utf8', timeout: 10_000 });
      const elapsed = Date.now() - started;

      expect(run.status, run.stderr).toBe(0);
      for (const part of ['Purpose:', 'Runs in:', 'To fix:', 'Usage:']) {
        expect(run.stdout).toMatch(new RegExp(`^${part} `, 'm'));
      }
      // Only the header's block, so the gate printed nothing of its own work.
      expect(run.stdout).toBe(readGateHelp(readFileSync(join(SCRIPTS, gate), 'utf8')));
      expect(elapsed).toBeLessThan(3_000);
    },
    15_000
  );
});
