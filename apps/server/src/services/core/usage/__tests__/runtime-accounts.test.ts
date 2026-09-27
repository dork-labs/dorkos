import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACCOUNT_LABEL,
  accountForPath,
  pruneTargets,
  resolveAccountRef,
  resolveRuntimeAccounts,
} from '../runtime-accounts.js';

const HOME = '/home/op';
/** Nothing exists on this fake machine except the symlink below. */
const realpath = (dir: string) => (dir === '/links/main' ? '/home/op/.claude' : null);

function config(accounts: unknown[], extra: Record<string, unknown> = {}) {
  return { runtimes: { claudeCode: { defaultAccount: null, accounts, ...extra } } };
}

describe('resolveRuntimeAccounts (contract §1.1a rev 6d)', () => {
  it("the operator's setup: only claude3 registered elsewhere, so default stands alone, listed last", () => {
    const { accounts } = resolveRuntimeAccounts('claude-code', {
      config: config([{ id: 'claude3', path: '/home/op/.claude3', label: 'Claude3' }]),
      home: HOME,
      realpath,
    });
    expect(accounts.map((a) => [a.id, a.ledgerId, a.isDefault, a.label, a.path])).toEqual([
      ['claude3', 'claude3', false, 'Claude3', '/home/op/.claude3'],
      ['default', 'default', true, DEFAULT_ACCOUNT_LABEL, '/home/op/.claude'],
    ]);
  });

  it('a routable row in the default folder (through a symlink) makes default its alias', () => {
    const { accounts } = resolveRuntimeAccounts('claude-code', {
      config: config([{ id: 'main', path: '/links/main', label: null }]),
      home: HOME,
      realpath,
    });
    expect(accounts.map((a) => [a.id, a.isDefault])).toEqual([['main', true]]);
    expect(resolveAccountRef(accounts, 'claude-code', 'default')?.id).toBe('main');
    expect(accountForPath(accounts, 'claude-code', '/home/op/.claude/', HOME, realpath)?.id).toBe(
      'main'
    );
  });

  it('a pattern-failing or reserved row in the default folder never becomes the alias', () => {
    const { accounts, warnings } = resolveRuntimeAccounts('claude-code', {
      config: config([
        { id: 'Bad_Id', path: '/home/op/.claude', label: null },
        { id: 'default', path: '/home/op/.claude', label: null },
      ]),
      home: HOME,
      realpath,
    });
    expect(accounts.map((a) => [a.id, a.routable, a.ledgerId, a.isDefault])).toEqual([
      ['Bad_Id', false, null, false],
      ['default', false, null, false],
      ['default', true, 'default', true],
    ]);
    expect(warnings.map((w) => w.code)).toEqual(['id-invalid', 'id-reserved']);
    expect(resolveAccountRef(accounts, 'claude-code', 'default')?.implicit).toBe(true);
  });

  it('mints missing ids before skipping bad rows, and never mints `default`', () => {
    const { accounts } = resolveRuntimeAccounts('claude-code', {
      config: config([
        { path: 'relative', label: 'x' },
        { path: '/a/default', label: 'Default' },
      ]),
      home: HOME,
      realpath,
    });
    expect(accounts.map((a) => a.id)).toEqual(['default-2', 'default']);
  });

  it('defaultAccount (with ~) and the legacy activeAccount name the default folder', () => {
    const set = resolveRuntimeAccounts('claude-code', {
      config: config([], { defaultAccount: '~/.claude2' }),
      home: HOME,
      realpath,
    });
    expect(set.accounts.at(-1)?.path).toBe('/home/op/.claude2');
    const legacy = resolveRuntimeAccounts('claude-code', {
      config: { runtimes: { claudeCode: { activeAccount: '/legacy' } } },
      home: HOME,
      realpath,
    });
    expect(legacy.accounts.at(-1)?.path).toBe('/legacy');
  });

  it('codex defaults to ~/.codex; opencode keeps a folder-less default only while unregistered', () => {
    expect(resolveRuntimeAccounts('codex', { config: null, home: HOME }).accounts[0]?.path).toBe(
      '/home/op/.codex'
    );
    expect(resolveRuntimeAccounts('opencode', { config: null, home: HOME }).accounts).toEqual([
      expect.objectContaining({ id: 'default', path: null, ledgerId: 'default' }),
    ]);
    const registered = resolveRuntimeAccounts('opencode', {
      config: { runtimes: { opencode: { accounts: [{ id: 'or', path: '/p/or', label: null }] } } },
      home: HOME,
    });
    expect(registered.accounts.map((a) => a.id)).toEqual(['or']);
  });
});

describe('pruneTargets (prune.cases shapes, rev 6d)', () => {
  it('removes unregistered ids per runtime, in on-disk order', () => {
    expect(
      pruneTargets(
        { 'claude-code': ['work', 'claude3'] },
        { 'claude-code': ['claude2', 'claude3', 'work'] }
      )
    ).toEqual({ 'claude-code': ['claude2'], codex: [], opencode: [] });
  });

  it('an aliased default adds no id, so a leftover default.json goes; a standalone default keeps it', () => {
    expect(
      pruneTargets({ 'claude-code': ['claude3'] }, { 'claude-code': ['claude3', 'default'] })
    ).toEqual({ 'claude-code': ['default'], codex: [], opencode: [] });
    expect(
      pruneTargets(
        { 'claude-code': ['claude3', 'default'] },
        { 'claude-code': ['claude3', 'default'] }
      )
    ).toEqual({ 'claude-code': [], codex: [], opencode: [] });
  });
});
