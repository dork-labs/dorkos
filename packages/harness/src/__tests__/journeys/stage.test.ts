/**
 * Cross-fixture snapshot identity for links and Windows junctions.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubbedSnapshot } from './stage.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Make one fixture whose projected link uses an absolute directory target. */
function linkedFixture(targetName: string): string {
  const root = mkdtempSync(join(tmpdir(), 'scrubbed-link-'));
  temps.push(root);
  mkdirSync(join(root, targetName), { recursive: true });
  symlinkSync(join(root, targetName), join(root, 'projected'), 'junction');
  return root;
}

describe('scrubbedSnapshot link identity', () => {
  it('compares equivalent fixture-local absolute junction targets by relative path', () => {
    const first = linkedFixture('source');
    const second = linkedFixture('source');

    expect(scrubbedSnapshot(first)).toEqual(scrubbedSnapshot(second));
    expect(scrubbedSnapshot(first).projected).toBe('link:<ROOT>/source');
  });

  it('still distinguishes a junction that names the wrong fixture-local target', () => {
    const expected = linkedFixture('source');
    const wrong = linkedFixture('other-source');

    expect(scrubbedSnapshot(wrong).projected).toBe('link:<ROOT>/other-source');
    expect(scrubbedSnapshot(wrong)).not.toEqual(scrubbedSnapshot(expected));
  });
});
