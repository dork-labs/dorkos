/**
 * The Claude account registry's identity rules (spec `claude-account-fleet` D1,
 * marketplace `specs/flow-cli-core` §1.1a at ff13a795): the color field, the
 * reserved `default` id, and the read rules flow and DorkOS must agree on.
 */
import { describe, it, expect } from 'vitest';
import {
  ClaudeCodeAccountSchema,
  claudeAccountId,
  classifyClaudeAccountRows,
  readClaudeAccountSettings,
} from '../config-schema.js';
import { DEFAULT_ACCOUNT_COLORS, resolveAccountColor } from '../account-usage.js';

/**
 * The contract's `account-id.cases.json` (fixtures 3.0.0, marketplace
 * ff13a795), copied case for case: `mint(label, path, taken)` must give
 * `expected.id` exactly.
 */
const ACCOUNT_ID_CASES: {
  name: string;
  input: { label: string | null; path: string; taken: string[] };
  expected: string;
}[] = [
  {
    name: 'label wins over the path',
    input: { label: 'Work Account', path: '/Users/me/.claude-work', taken: [] },
    expected: 'work-account',
  },
  {
    name: "no label falls back to the path's last segment",
    input: { label: null, path: '/Users/me/.claude-work', taken: [] },
    expected: 'claude-work',
  },
  {
    name: 'an empty label falls back to the path',
    input: { label: '', path: '/Users/me/Personal', taken: [] },
    expected: 'personal',
  },
  {
    name: 'a label that slugifies to nothing falls back to the path',
    input: { label: '!!!', path: '/Users/me/.claude', taken: [] },
    expected: 'claude',
  },
  {
    name: "nothing usable at all gives 'account'",
    input: { label: null, path: '/', taken: [] },
    expected: 'account',
  },
  {
    name: 'trailing separators are ignored',
    input: { label: null, path: '/Users/me/Claude Max/', taken: [] },
    expected: 'claude-max',
  },
  {
    name: 'a Windows path splits on backslashes',
    input: { label: null, path: 'C:\\Users\\me\\.claude-alt', taken: [] },
    expected: 'claude-alt',
  },
  {
    name: 'runs of separators collapse to one hyphen',
    input: { label: 'ACME--Org__Seat', path: '/x', taken: [] },
    expected: 'acme-org-seat',
  },
  {
    name: 'letters outside a-z are separators, not transliterated',
    input: { label: '  Ünïcode—Name  ', path: '/x', taken: [] },
    expected: 'n-code-name',
  },
  {
    name: 'a taken base gets -2',
    input: { label: 'main', path: '/x', taken: ['main'] },
    expected: 'main-2',
  },
  {
    name: 'the first free suffix wins',
    input: { label: 'Claude 3', path: '/x', taken: ['claude-3', 'claude-3-2'] },
    expected: 'claude-3-3',
  },
  {
    name: 'a label that slugifies to default is reserved: it becomes default-2',
    input: { label: 'Default', path: '/Users/me/.claude-x', taken: [] },
    expected: 'default-2',
  },
  {
    name: 'a folder named default is reserved too',
    input: { label: null, path: '/Users/me/default', taken: ['default-2'] },
    expected: 'default-3',
  },
];

describe('claudeAccountId: the contract account-id cases', () => {
  it.each(ACCOUNT_ID_CASES)('$name', ({ input, expected }) => {
    expect(claudeAccountId(input)).toBe(expected);
  });
});

describe('ClaudeCodeAccountSchema color and unknown fields', () => {
  const row = { id: 'acme', path: '/a', label: null };

  it('reads an absent color as null', () => {
    expect(ClaudeCodeAccountSchema.parse(row).color).toBeNull();
  });

  it('keeps a lowercase #rrggbb color', () => {
    expect(ClaudeCodeAccountSchema.parse({ ...row, color: '#12ab9f' }).color).toBe('#12ab9f');
  });

  it.each(['#12AB9F', 'red', '#123', 42])('reads the bad color %s as null', (color) => {
    expect(ClaudeCodeAccountSchema.parse({ ...row, color }).color).toBeNull();
  });
});

describe('readClaudeAccountSettings: the contract read rules, in order', () => {
  it('mints ids over every row BEFORE skipping any, so a skip never shifts a later id', () => {
    // Skipping the relative row first would give the third row `acme`; the
    // contract mints first, so it is `acme-2` on both sides.
    const { accounts } = readClaudeAccountSettings({
      accounts: [
        { path: '/a', label: 'Acme' },
        { path: 'relative/b', label: 'Acme' },
        { path: '/c', label: 'Acme' },
      ],
    });
    expect(accounts.map((a) => a.id)).toEqual(['acme', 'acme-3']);
  });

  it('skips a row with a missing or relative path, with one warning each', () => {
    const { accounts, warnings } = readClaudeAccountSettings({
      accounts: [
        { id: 'good', path: '/a', label: null },
        { id: 'relative', path: '~/.claude2', label: null },
        { id: 'pathless', label: null },
      ],
    });
    expect(accounts.map((a) => a.id)).toEqual(['good']);
    expect(warnings.map((w) => [w.code, w.index])).toEqual([
      ['path-invalid', 1],
      ['path-invalid', 2],
    ]);
  });

  it('keeps the first of two rows sharing an id', () => {
    const { accounts, warnings } = readClaudeAccountSettings({
      accounts: [
        { id: 'acme', path: '/first', label: null },
        { id: 'acme', path: '/second', label: null },
      ],
    });
    expect(accounts.map((a) => a.path)).toEqual(['/first']);
    expect(warnings).toMatchObject([{ code: 'id-duplicate', index: 1 }]);
  });

  it('reads a bad color as the positional default, with a warning', () => {
    const { accounts, warnings } = readClaudeAccountSettings({
      accounts: [{ id: 'acme', path: '/a', label: null, color: 'RED' }],
    });
    expect(accounts[0]).toMatchObject({ color: DEFAULT_ACCOUNT_COLORS[0], colorIsDefault: true });
    expect(warnings).toMatchObject([{ code: 'color-invalid', index: 0 }]);
  });

  it('lists a row still called default, with an id-reserved warning', () => {
    const { accounts, warnings } = readClaudeAccountSettings({
      accounts: [{ id: 'default', path: '/a', label: null }],
    });
    expect(accounts.map((a) => a.id)).toEqual(['default']);
    expect(warnings).toMatchObject([{ code: 'id-reserved', index: 0 }]);
  });

  it('lists a row whose id fails the pattern, with an id-invalid warning', () => {
    const { accounts, warnings } = readClaudeAccountSettings({
      accounts: [{ id: 'Acme_Corp', path: '/a', label: null }],
    });
    expect(accounts.map((a) => a.id)).toEqual(['Acme_Corp']);
    expect(warnings).toMatchObject([{ code: 'id-invalid', index: 0 }]);
  });

  it('resolves colors by position among the LISTED rows, and marks stored ones', () => {
    const { accounts } = readClaudeAccountSettings({
      accounts: [
        { id: 'a', path: '/a', label: null },
        { id: 'hidden', path: 'relative', label: null },
        { id: 'b', path: '/b', label: null, color: '#000000' },
        { id: 'c', path: '/c', label: null, color: null },
      ],
    });
    expect(accounts.map((a) => [a.id, a.color, a.colorIsDefault])).toEqual([
      ['a', resolveAccountColor(null, 0), true],
      ['b', '#000000', false],
      ['c', resolveAccountColor(null, 2), true],
    ]);
  });

  it('reads a missing label as null and keeps unknown fields', () => {
    const { accounts } = readClaudeAccountSettings({
      accounts: [{ id: 'a', path: '/a', seat: 3 }],
    });
    expect(accounts[0]).toMatchObject({ label: null, seat: 3 });
  });

  it('classifies a non-object row as unlisted rather than throwing', () => {
    const { rows, warnings } = classifyClaudeAccountRows(['nope', { id: 'a', path: '/a' }]);
    expect(rows.map((r) => r.listed)).toEqual([false, true]);
    expect(warnings).toMatchObject([{ code: 'row-invalid', index: 0 }]);
  });
});
