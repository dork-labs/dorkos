/**
 * Naming and validating Claude account paths (spec `claude-code-accounts`).
 *
 * These strings are shown to a person — a badge in a list row, an option in the
 * switcher, the rename toast — and they are SERVER-side paths, so the platform
 * they came from is not the platform the cockpit runs on.
 */
import { describe, it, expect } from 'vitest';
import { claudeAccountName, claudeAccountOptions, isAbsoluteAccountPath } from '../claude-accounts';

describe('claudeAccountName', () => {
  it("prefers the operator's label, because that is the answer they want", () => {
    expect(
      claudeAccountName('/Users/dev/.claude2', [
        { path: '/Users/dev/.claude2', label: 'Acme Corp' },
      ])
    ).toBe('Acme Corp');
  });

  it('falls back to the folder name when the account has no label', () => {
    expect(
      claudeAccountName('/Users/dev/.claude2', [{ path: '/Users/dev/.claude2', label: null }])
    ).toBe('.claude2');
  });

  it('takes the folder name off a WINDOWS path too', () => {
    // Windows x64 is a shipped download target. Splitting on `/` alone returns
    // the whole path here, and it lands in the row badge, its accessible name,
    // the switcher, and the rename toast.
    expect(claudeAccountName('C:\\Users\\dev\\.claude2', [])).toBe('.claude2');
    expect(claudeAccountName('\\\\build-host\\share\\.claude3', [])).toBe('.claude3');
  });

  it('ignores a trailing separator on either platform', () => {
    expect(claudeAccountName('/Users/dev/.claude2/', [])).toBe('.claude2');
    expect(claudeAccountName('C:\\Users\\dev\\.claude2\\', [])).toBe('.claude2');
  });

  it('returns the input when there is no segment to take', () => {
    expect(claudeAccountName('/', [])).toBe('/');
  });
});

describe('claudeAccountOptions', () => {
  it("carries each account's usability through, so a picker can say what the server found", () => {
    expect(
      claudeAccountOptions(
        [
          { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
          {
            id: 'acme-corp',
            path: '/Users/dev/.claude2',
            label: 'Acme Corp',
            isAccountRoot: false,
          },
        ],
        null
      )
    ).toEqual([
      { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
      { id: 'acme-corp', path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: false },
    ]);
  });

  it('appends the account in use when it was never registered, claiming no verdict about it', () => {
    const options = claudeAccountOptions(
      [{ id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true }],
      '/Users/dev/.claude9'
    );

    expect(options).toHaveLength(2);
    // `id: null` because nobody registered this root: it can be SHOWN, but
    // nothing can point at it, so a picker whose value is a reference must leave
    // it out. And not `isAccountRoot: false`: the server reports the structural
    // check for registered accounts only, and "unusable" would be a claim nobody
    // made.
    expect(options[1]).toEqual({
      id: null,
      path: '/Users/dev/.claude9',
      label: null,
      isAccountRoot: undefined,
    });
  });

  it('does not duplicate the account in use when it IS registered', () => {
    expect(
      claudeAccountOptions(
        [{ path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: true }],
        '/Users/dev/.claude2'
      )
    ).toHaveLength(1);
  });
});

describe('isAbsoluteAccountPath', () => {
  it('accepts a POSIX path', () => {
    expect(isAbsoluteAccountPath('/Users/dev/.claude2')).toBe(true);
  });

  it('accepts a Windows drive or network path', () => {
    expect(isAbsoluteAccountPath('C:\\Users\\dev\\.claude2')).toBe(true);
    expect(isAbsoluteAccountPath('C:/Users/dev/.claude2')).toBe(true);
    expect(isAbsoluteAccountPath('\\\\build-host\\share\\.claude3')).toBe(true);
  });

  it('rejects a ~ path, which nothing on the way to the config file expands', () => {
    // The card's own placeholder used to be `~/.claude2`, and typing it
    // registered a folder that does not exist — which then flipped the
    // multi-account badge on for what was really one account.
    expect(isAbsoluteAccountPath('~/.claude2')).toBe(false);
  });

  it('rejects a relative path and an empty one', () => {
    expect(isAbsoluteAccountPath('.claude2')).toBe(false);
    expect(isAbsoluteAccountPath('claude/accounts')).toBe(false);
    expect(isAbsoluteAccountPath('')).toBe(false);
  });
});
