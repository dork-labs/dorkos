import { describe, it, expect } from 'vitest';
import {
  UserConfigSchema,
  healClaudeAccountRename,
  slugifyAccountId,
  claudeAccountId,
  settleLegacyAccountAlias,
} from '../../config-schema.js';
import type {} from '../../config-schema.js';

describe('UserConfigSchema runtimes.claudeCode (spec claude-code-accounts)', () => {
  it('heals a registry written before ids existed, rather than refusing it', () => {
    // Every config file that has ever been written is missing `accounts[].id`
    // until the `'0.65.0'` migration runs — and a dev tree runs no migrations at
    // all. Zod parses the whole MERGED config inside `applyConfigPatch`, so a
    // refusal here is every settings write in the cockpit refused.
    const parsed = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: {
          accounts: [
            { path: '/Users/me/.claude2', label: 'Acme Corp' },
            { path: '/Users/me/.claude3', label: null },
          ],
        },
      },
    });
    expect(parsed.runtimes.claudeCode.accounts).toEqual([
      { id: 'acme-corp', path: '/Users/me/.claude2', label: 'Acme Corp', color: null },
      { id: 'claude3', path: '/Users/me/.claude3', label: null, color: null },
    ]);
  });

  it('reserves ids a LATER row already owns before minting one', () => {
    // A half-migrated registry. Seeding the taken set as it walks would let the
    // first row mint `acme-corp` and collide with the row that already holds it.
    const parsed = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: {
          accounts: [
            { path: '/a/.claude', label: 'Acme Corp' },
            { id: 'acme-corp', path: '/b/.claude', label: 'Acme Corp' },
          ],
        },
      },
    });
    expect(parsed.runtimes.claudeCode.accounts.map((a) => a.id)).toEqual([
      'acme-corp-2',
      'acme-corp',
    ]);
  });

  it('never invents the same id twice while healing', () => {
    const parsed = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: {
          accounts: [
            { path: '/a/.claude', label: 'Acme Corp' },
            { path: '/b/.claude', label: 'ACME corp' },
            { path: '/c/.claude', label: null },
          ],
        },
      },
    });
    const ids = parsed.runtimes.claudeCode.accounts.map((a) => a.id);
    expect(ids).toEqual(['acme-corp', 'acme-corp-2', 'claude']);
    expect(new Set(ids).size).toBe(3);
  });

  it('reads a pre-rename default, and answers in ONE spelling', () => {
    // Two claims, and the second is a contract rather than an observable end to
    // end: a parse would strip the retired key anyway. Stating it here keeps the
    // function honest for any caller that does not go through the object schema.
    const healed = healClaudeAccountRename({
      activeAccount: '/Users/me/.claude2',
      accounts: [],
    }) as Record<string, unknown>;

    expect(healed.defaultAccount).toBe('/Users/me/.claude2');
    expect(healed).not.toHaveProperty('activeAccount');
  });

  it('lets a real value under the new name outrank the retired one', () => {
    const healed = healClaudeAccountRename({
      activeAccount: '/Users/me/.claude2',
      defaultAccount: '/Users/me/.claude3',
    }) as Record<string, unknown>;

    expect(healed.defaultAccount).toBe('/Users/me/.claude3');
    expect(healed).not.toHaveProperty('activeAccount');
  });

  it('settles the retired key only when the patch NAMES the new one', () => {
    // `null` is both "never set" and "go back to inheriting". Only the patch
    // knows which, so this is where a deliberate clear is protected from the
    // heal that would otherwise resurrect the old account.
    const merged = { runtimes: { claudeCode: { activeAccount: '/a', defaultAccount: null } } };
    settleLegacyAccountAlias(merged, { runtimes: { claudeCode: { defaultAccount: null } } });
    expect(merged.runtimes.claudeCode).not.toHaveProperty('activeAccount');

    const untouched = { runtimes: { claudeCode: { activeAccount: '/a', defaultAccount: null } } };
    settleLegacyAccountAlias(untouched, { ui: { theme: 'light' } });
    expect(untouched.runtimes.claudeCode).toHaveProperty('activeAccount');
  });

  it('refuses two accounts sharing an id', () => {
    // An id is a REFERENCE: an agent manifest and a launch hint name an account
    // by it and the resolver takes the first match, so a duplicate makes one
    // account unreachable and silently bills every agent naming it to the other
    // one's subscription. Healing can never produce this; a hand edit can.
    const result = UserConfigSchema.safeParse({
      version: 1,
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'acme-corp', path: '/a/.claude', label: 'Acme Corp' },
            { id: 'acme-corp', path: '/b/.claude', label: 'Other' },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Duplicate Claude account id');
    // Named at the row that collides, so an editor can point at it.
    expect(result.error?.issues[0]?.path).toEqual(['runtimes', 'claudeCode', 'accounts', 1, 'id']);
  });

  it('keeps a default account and a labelled roster verbatim', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: {
          defaultAccount: '/Users/me/.claude2',
          accounts: [
            { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp' },
            { id: 'claude2', path: '/Users/me/.claude2', label: null },
          ],
        },
      },
    });
    expect(result.runtimes.claudeCode).toEqual({
      defaultAccount: '/Users/me/.claude2',
      accounts: [
        { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp', color: null },
        { id: 'claude2', path: '/Users/me/.claude2', label: null, color: null },
      ],
      defaultAccountColor: null,
      defaultAccountOnlyProjects: null,
      projectAccounts: {},
      dismissedFolders: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: true,
      maxWarmProcesses: null,
    });
  });

  it('leaves a block with no retired key completely alone', () => {
    const block = { defaultAccount: null, accounts: [] };
    expect(healClaudeAccountRename(block)).toBe(block);
  });
});

// Both helpers had a regex CodeQL flags as quadratic (js/polynomial-redos):
// `^-+|-+$` after a collapse, and `[/\\]+$` on an uncapped path out of
// `~/.dork/config.json`. Neither was exploitable — the collapse makes hyphen
// runs impossible, and the config is operator-written — but the invariant that
// defused the first one is invisible from the line it protects, and the fixes
// are one character each. These cases pin the answers so the rewrites cannot
// have moved one.
describe('slugifyAccountId', () => {
  it.each([
    ['Work Account', 'work-account'],
    ['  spaced  ', 'spaced'],
    ['---dashes---', 'dashes'],
    ['!!!', ''],
    ['', ''],
    ['-', ''],
    ['a-', 'a'],
    ['-a', 'a'],
    ['-a-', 'a'],
    ['a - - b', 'a-b'],
    ['Ünïcödé', 'n-c-d'],
    ['2026 review', '2026-review'],
  ])('slugifies %j to %j', (input, expected) => {
    expect(slugifyAccountId(input)).toBe(expected);
  });
});

describe('claudeAccountId', () => {
  it.each([
    ['/home/me/.claude', 'claude'],
    ['/home/me/.claude/', 'claude'],
    ['/home/me/.claude///', 'claude'],
    ['C:\\Users\\me\\.claude\\\\', 'claude'],
    ['/', 'account'],
    ['///', 'account'],
  ])('falls back to the basename of %j, ignoring trailing separators', (path, expected) => {
    expect(claudeAccountId({ label: null, path, taken: [] })).toBe(expected);
  });

  it('uniquifies against ids already taken', () => {
    expect(claudeAccountId({ label: 'work', path: '/x', taken: ['work', 'work-2'] })).toBe(
      'work-3'
    );
  });

  it('handles a path with a huge INTERNAL separator run quickly', () => {
    // The run is followed by one more character on purpose. A run at the very
    // end is the cheap case for both the old and the new form, so timing one
    // proves nothing; with something after it, every start position must fail,
    // which is the quadratic — 5181ms before the lookbehind, 0.43ms after.
    const path = `/home/me/.claude${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(claudeAccountId({ label: null, path, taken: [] })).toBe('x');
    expect(performance.now() - started).toBeLessThan(100);
  });
});
