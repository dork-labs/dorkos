/**
 * Contract suite for the adapter conformance harness
 * (`.agents/flow/scripts/validate-adapter.mjs`, task 3.2). The harness is a
 * hand-rolled, dependency-free ESM script (not a built oracle), so this suite
 * spawns it as a real subprocess and asserts its JSON verdict + exit code
 * against the committed reference fixtures.
 *
 * The two keystone cases are the **good** fixture (every invariant passes;
 * `ok:true`, exit 0) and the **bad** fixture (exactly one invariant -- INV-3,
 * a native-id leak in `relations.blockedBy` -- fails; `ok:false`, exit nonzero).
 * Together they prove the harness both passes a conforming adapter and bites a
 * non-conforming one. The interface mirrored here (`--fixture <path>`, the
 * `{ ok, failures: [{ invariant, detail }] }` verdict, the exit-code contract)
 * is the one the building-adapters skill documents; keep them in lockstep.
 *
 * @see .agents/flow/adapters/SPEC.md section 4 (the normative invariants)
 * @see .agents/flow/skills/building-adapters/references/conformance-harness.md
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/__tests__ -> src -> engine
const ENGINE_DIR = path.resolve(here, '..', '..');
// engine -> flow -> scripts/validate-adapter.mjs
const SCRIPT = path.resolve(ENGINE_DIR, '..', 'scripts', 'validate-adapter.mjs');
// engine -> flow -> adapters/reference/fixtures
const FIXTURES_DIR = path.resolve(ENGINE_DIR, '..', 'adapters', 'reference', 'fixtures');
const GOOD_FIXTURE = path.join(FIXTURES_DIR, 'work-items.good.json');
const BAD_FIXTURE = path.join(FIXTURES_DIR, 'work-items.bad.json');

interface Verdict {
  ok: boolean;
  failures: Array<{ invariant: string; detail: string }>;
}

/** Spawn the harness, returning its exit code + captured streams. */
function runHarness(opts: { stdin?: string; args?: readonly string[] } = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(process.execPath, [SCRIPT, ...(opts.args ?? [])], {
    input: opts.stdin ?? '',
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('validate-adapter.mjs', () => {
  describe('good fixture', () => {
    it('passes every invariant (ok:true, exit 0)', () => {
      const { status, stdout } = runHarness({ args: ['--fixture', GOOD_FIXTURE] });
      expect(status).toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.ok).toBe(true);
      expect(verdict.failures).toEqual([]);
    });

    it('reads the same fixture on stdin (ok:true, exit 0)', () => {
      const { status, stdout } = runHarness({ stdin: readFileSync(GOOD_FIXTURE, 'utf8') });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });
  });

  describe('bad fixture', () => {
    it('fails exactly INV-3 (native-id leak in blockedBy) with ok:false, exit nonzero', () => {
      const { status, stdout } = runHarness({ args: ['--fixture', BAD_FIXTURE] });
      expect(status).not.toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.ok).toBe(false);
      const invariants = verdict.failures.map((f) => f.invariant);
      expect(invariants).toContain('INV-3');
      // The bad fixture is crafted to breach exactly one invariant.
      expect(invariants).toEqual(['INV-3']);
      // The detail names the offending item and the native-id reference.
      const inv3 = verdict.failures.find((f) => f.invariant === 'INV-3');
      expect(inv3?.detail).toContain('DOR-2');
      expect(inv3?.detail).toContain('node_DOR-1');
    });
  });

  describe('--help', () => {
    it('prints the contract and exits 0', () => {
      const { status, stdout } = runHarness({ args: ['--help'] });
      expect(status).toBe(0);
      expect(stdout).toContain('INV-1');
      expect(stdout).toContain('INV-5');
      expect(stdout).toContain('--fixture');
    });
  });

  describe('invalid input', () => {
    it('exits 2 on non-JSON input and still emits a JSON verdict', () => {
      const { status, stdout, stderr } = runHarness({ stdin: 'not json at all' });
      expect(status).toBe(2);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(false);
      expect(stderr).toContain('invalid input');
    });
  });
});
