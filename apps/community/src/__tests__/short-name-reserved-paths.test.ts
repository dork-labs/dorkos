import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_RESERVED_SHORT_NAMES,
  CommunityShortNameSchema,
} from '@dorkos/shared/community-admin-wire';
import { OWNER_CLAIM_PATH } from '../browser/owner-claim.js';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The first segment of every literal path a file routes on. */
function topLevelPaths(text: string): string[] {
  const literals = [
    ...text.matchAll(/app\.(?:get|use)\(\s*'\/([^/'*:]+)/gu),
    ...text.matchAll(/pathname === '\/([^/']+)/gu),
    ...text.matchAll(/\^\\\/([a-z][a-z-]*)\\\//gu),
    ...text.matchAll(/\^\\\/([a-z][a-z-]*)\$/gu),
  ].map((match) => match[1]);
  return [...new Set(literals)];
}

describe('reserved short names', () => {
  // Purpose: a short name shares the top-level path space with the app. Fails when someone adds
  // a page to the server or browser and forgets to reserve its path.
  it('reserves every literal top-level path the server serves and the browser routes on', () => {
    const paths = [
      ...topLevelPaths(source('../main.ts')),
      ...topLevelPaths(source('../browser/BrowserRoot.tsx')),
      OWNER_CLAIM_PATH.slice(1),
      'api',
      'health',
    ];
    expect(paths).toEqual(expect.arrayContaining(['host', 'join', 'claim', 'pairing', 'c']));
    for (const path of paths) expect(COMMUNITY_RESERVED_SHORT_NAMES, path).toContain(path);
  });

  it('normalizes input and refuses anything outside the ASCII grammar', () => {
    expect(CommunityShortNameSchema.parse('  Acme-Labs ')).toBe('acme-labs');
    for (const bad of ['ab', 'a--b', '-abc', 'abc-', '1abc', 'ácme', 'a'.repeat(33), 'a_b'])
      expect(CommunityShortNameSchema.safeParse(bad).success, bad).toBe(false);
    for (const reserved of COMMUNITY_RESERVED_SHORT_NAMES)
      expect(reserved, reserved).toBe(reserved.toLowerCase());
  });
});
