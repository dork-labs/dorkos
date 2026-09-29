import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planSiteLeg, SITE_SHARD, SITE_SPEC_FILES } from '../site-leg';

const TESTS = fileURLToPath(new URL('../tests', import.meta.url));

function specs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return specs(path);
    return name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('planSiteLeg', () => {
  const sharded = { ci: true, site: '1', shardTotal: 6 };

  it('boots the leg only on the site shard of a sharded run, and collects the specs everywhere', () => {
    for (let i = 1; i <= 6; i++) {
      expect(planSiteLeg({ ...sharded, shardIndex: String(i) })).toEqual({
        specs: true,
        leg: i === SITE_SHARD,
      });
    }
  });

  it('boots the leg whenever the specs run in an unsharded run, as it always has', () => {
    expect(planSiteLeg({ ci: false, site: '1', shardTotal: 1, shardIndex: undefined })).toEqual({
      specs: true,
      leg: true,
    });
    expect(
      planSiteLeg({ ci: true, site: undefined, shardTotal: 1, shardIndex: undefined })
    ).toEqual({
      specs: true,
      leg: true,
    });
  });

  it('leaves the site out of a local run unless asked, and out of CI when forced off', () => {
    const off = { specs: false, leg: false };
    expect(
      planSiteLeg({ ci: false, site: undefined, shardTotal: 1, shardIndex: undefined })
    ).toEqual(off);
    expect(planSiteLeg({ ci: true, site: '0', shardTotal: 6, shardIndex: undefined })).toEqual(off);
  });

  it('refuses a sharded run that does not say which shard it is', () => {
    // Guessing wrong would put the site specs on a shard with nothing on the port.
    for (const shardIndex of [undefined, '', '0', '7', '1/6', 'one']) {
      expect(() => planSiteLeg({ ...sharded, shardIndex })).toThrow(/E2E_SHARD_INDEX/);
    }
  });
});

describe('SITE_SPEC_FILES', () => {
  it('names exactly the specs that point at the marketing site', () => {
    // A site spec missing from the list would be dealt to any shard, most of
    // which no longer boot the site leg; a stale entry would fail the pin.
    const pointing = specs(TESTS)
      .filter((path) => /SITE_BASE_URL|localhost:6244/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(TESTS, path).split(sep).join('/'))
      .sort();
    expect(pointing).toEqual([...SITE_SPEC_FILES].sort());
  });
});
