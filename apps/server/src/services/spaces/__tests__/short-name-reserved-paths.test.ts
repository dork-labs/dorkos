import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_HOST_GRANTABLE_SHORT_NAMES,
  COMMUNITY_PATH_SHORT_NAMES,
  COMMUNITY_RESERVED_SHORT_NAMES,
  CommunityShortNameSchema,
} from '@dorkos/shared/community-admin-wire';
import { COMMUNITY_EMAIL_LINK_PAGES } from '@dorkos/shared/community-wire';
import { OWNER_CLAIM_PATH } from '../browser/owner-claim.js';
import { SPACE_WEB_SRC } from './space-paths.js';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const METHODS = 'get|post|put|patch|delete|options|head|all|use|route';

/** The first segment of every literal path a file routes on, on the root app or in the browser. */
function topLevelPaths(text: string): string[] {
  const literals = [
    // app.get('/x…'), app.post(…), app.use(…), app.route('/api/v1', …), and every other method.
    ...text.matchAll(new RegExp(String.raw`\bapp\.(?:${METHODS})\(\s*'\/([^/'*:]+)`, 'gu')),
    // app.on('GET', '/x…') and app.on(['GET', 'POST'], '/x…').
    ...text.matchAll(/\bapp\.on\(\s*(?:'[^']*'|\[[^\]]*\])\s*,\s*'\/([^/'*:]+)/gu),
    ...text.matchAll(/pathname === '\/([^/']+)/gu),
    ...text.matchAll(/\^\\\/([a-z][a-z-]*)\\\//gu),
    ...text.matchAll(/\^\\\/([a-z][a-z-]*)\$/gu),
  ].map((match) => match[1]);
  return [...new Set(literals)];
}

/** The modules `app.ts` hands the root app to, so routes they add there are scanned too. */
function rootAppRegistrars(appSource: string): string[] {
  return [...appSource.matchAll(/\b(register\w+)\(app\b/gu)].map(([, name]) => {
    const from = new RegExp(
      String.raw`import \{[^}]*\b${name}\b[^}]*\} from '\.\/([^']+)\.js'`,
      'u'
    ).exec(appSource)?.[1];
    if (!from) throw new Error(`Cannot find where ${name} is imported from`);
    return `../${from}.ts`;
  });
}

describe('reserved short names', () => {
  // Purpose: a short name shares the top-level path space with the app. Fails when someone adds
  // a page or route to the server or browser and forgets to reserve its path.
  it('reserves every literal top-level path the server serves and the browser routes on', () => {
    const appSource = source('../app.ts');
    const registrars = rootAppRegistrars(appSource);
    expect(registrars).toContain('../routes/test-control.ts');
    const paths = [
      ...topLevelPaths(appSource),
      ...registrars.flatMap((path) => topLevelPaths(source(path))),
      ...topLevelPaths(source('../main.ts')),
      ...topLevelPaths(source('../startup/space-server.ts')),
      ...topLevelPaths(source('../pages/register.ts')),
      ...topLevelPaths(readFileSync(new URL('BrowserRoot.tsx', SPACE_WEB_SRC), 'utf8')),
      OWNER_CLAIM_PATH.slice(1),
      // The pages a mailed link opens; pages/register.ts serves them from this one list.
      ...Object.values(COMMUNITY_EMAIL_LINK_PAGES).map((page) => page.slice(1)),
    ];
    // The scanner itself must find the paths each file really routes on.
    expect(paths).toEqual(
      expect.arrayContaining(['api', 'health', 'host', 'join', 'claim', 'pairing', 'c', 'assets'])
    );
    for (const path of paths) expect(COMMUNITY_RESERVED_SHORT_NAMES, path).toContain(path);
    // A host operator may give a grantable name to a space, so none may be a path.
    for (const path of paths)
      expect(COMMUNITY_HOST_GRANTABLE_SHORT_NAMES, path).not.toContain(path);
  });

  it('splits the reserved names into paths and names a host operator may give out', () => {
    // Purpose: fails if a grantable name is not reserved (so anyone could take it), or if the
    // split loses or duplicates a reserved name.
    for (const name of COMMUNITY_HOST_GRANTABLE_SHORT_NAMES)
      expect(COMMUNITY_RESERVED_SHORT_NAMES, name).toContain(name);
    expect([...COMMUNITY_PATH_SHORT_NAMES, ...COMMUNITY_HOST_GRANTABLE_SHORT_NAMES].sort()).toEqual(
      [...COMMUNITY_RESERVED_SHORT_NAMES].sort()
    );
    expect(COMMUNITY_HOST_GRANTABLE_SHORT_NAMES).toEqual(
      expect.arrayContaining(['dorkos', 'official'])
    );
  });

  it('finds routes of every method and a mounted sub-app', () => {
    // Purpose: fails if the scanner only sees GET and use, and so misses a new POST or mount.
    expect(
      topLevelPaths(`
        app.post('/alpha', h); app.delete('/beta/:id', h); app.all('/gamma/*', h);
        app.route('/delta', sub); app.on(['GET', 'POST'], '/epsilon', h); app.on('PUT', '/zeta', h);
        app.get('/:name', h);
      `).sort()
    ).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'zeta']);
  });

  it('normalizes input and refuses anything outside the ASCII grammar', () => {
    expect(CommunityShortNameSchema.parse('  Acme-Labs ')).toBe('acme-labs');
    for (const bad of ['ab', 'a--b', '-abc', 'abc-', '1abc', 'ácme', 'a'.repeat(33), 'a_b'])
      expect(CommunityShortNameSchema.safeParse(bad).success, bad).toBe(false);
    for (const reserved of COMMUNITY_RESERVED_SHORT_NAMES)
      expect(reserved, reserved).toBe(reserved.toLowerCase());
  });
});
