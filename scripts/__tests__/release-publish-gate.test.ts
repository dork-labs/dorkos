/**
 * Release Publish keeps its npm gate (DOR-5123, ADR 261118-135124 clause 6):
 * right before npm, main's `scripts/release-gate.sh` must answer exactly `SHIP`
 * for P. This pins the job graph that makes that true, so an edit that drops
 * the gate from `publish`'s needs, or points the gate at anything but main's
 * copy of the script, fails here instead of shipping.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const text = readFileSync(join(root, '.github/workflows/release-publish.yml'), 'utf8');

/** Each job's block under `jobs:`, comment lines dropped, by job id. */
const jobs: Record<string, string> = {};
for (const block of text.split(/\njobs:\n/)[1]?.split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/) ?? []) {
  const id = /^ {2}([a-z][a-z0-9-]*):\n/.exec(block)?.[1];
  if (id)
    jobs[id] = block
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
}
const gate = jobs.gate ?? '';
const publish = jobs.publish ?? '';

describe('release-publish.yml gates npm on release-gate.sh', () => {
  it('reads the job graph (a silent no-op would pass everything)', () => {
    expect(Object.keys(jobs)).toEqual(['prove', 'prepare', 'gate', 'smoke', 'publish']);
  });

  it('runs gate after prove and prepare, on main only, and publish only after gate', () => {
    expect(gate).toMatch(/^ {4}needs: \[prove, prepare\]$/m);
    expect(gate).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    expect(publish).toMatch(/^ {4}needs: \[prepare, gate, smoke\]$/m);
    // A condition that runs publish after a failed or skipped gate would undo it.
    expect(publish).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|continue-on-error/);
    expect(gate).not.toMatch(/continue-on-error/);
  });

  it("checks out only main's copy of the script, without credentials", () => {
    expect(gate.match(/uses: actions\/checkout@/g)).toHaveLength(1);
    expect(gate).toMatch(
      / {10}ref: \$\{\{ github\.sha \}\}\n {10}persist-credentials: false\n {10}sparse-checkout: scripts\/release-gate\.sh\n {10}sparse-checkout-cone-mode: false\n/
    );
    expect(gate).not.toMatch(/RELEASE_EXPECTED_SHA \}\}|release\/v/);
  });

  it('is read-only, with no secret and no environment', () => {
    expect(gate).toContain(
      '    permissions:\n      contents: read\n      actions: read\n      checks: read\n      pull-requests: read\n    env:'
    );
    expect(gate).not.toMatch(/secrets\.|environment:|id-token/);
  });

  it("takes P from prove's proven output and ships only on the exact line SHIP", () => {
    expect(gate).toContain('      P: ${{ needs.prove.outputs.p }}\n');
    expect(jobs.prove).toContain('      p: ${{ steps.proven.outputs.p }}\n');
    expect(gate).toContain('      FULL_RUN_WORKFLOWS: browser-test.yml\n');
    expect(gate).toContain('bash scripts/release-gate.sh facts "$RELEASE_VERSION" "$P" >"$facts"');
    expect(gate).toContain('decision=$(bash scripts/release-gate.sh decide "$facts")');
    expect(gate).toMatch(/if \[\[ "\$decision" != SHIP \]\]; then\n.*\n\s+exit 1\n/);
  });
});
