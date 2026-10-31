import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountSigninPolicy, type LoginIdentity } from '../account-signin-policy.js';
const account = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const forbidden = '33333333-3333-4333-8333-333333333333';
const identity: LoginIdentity = {
  accountUuid: account,
  organizationUuid: org,
  maskedEmail: 'd…@example.com',
};
let home: string;
let policy: AccountSigninPolicy;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-signin-policy-'));
  policy = new AccountSigninPolicy(home);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
describe('account identity policy', () => {
  it('fails closed with missing, unreadable policy or metadata', () => {
    expect(policy.assess('/fake/claude5', identity).state).toBe('unreadable');
    policy.addOrganization(forbidden, 'Excluded company');
    policy.removeOrganization(forbidden);
    expect(policy.assess('/fake/claude5', identity).state).toBe('unconfirmed');
    policy.addOrganization(forbidden, 'Excluded company');
    expect(policy.assess('/fake/claude5', null).state).toBe('unreadable');
    fs.writeFileSync(path.join(home, 'account-signin-policy.json'), '{');
    expect(new AccountSigninPolicy(home).accept('/fake/claude5', identity)).toBe(false);
  });
  it('initializes an explicit empty list and never rebinds after restart or policy deletion', () => {
    const read = vi.fn(() => identity);
    policy.initializeInstall(true, ['/fake/existing'], read);
    expect(policy.assess('/fake/existing', identity).state).toBe('confirmed');
    const changed = { ...identity, accountUuid: forbidden };
    policy.initializeInstall(true, ['/fake/existing'], () => changed);
    expect(policy.assess('/fake/existing', changed).state).toBe('changed');
    fs.unlinkSync(path.join(home, 'account-signin-policy.json'));
    const missing = new AccountSigninPolicy(home);
    missing.initializeInstall(true, ['/fake/existing'], read);
    expect(missing.assess('/fake/existing', identity).state).toBe('unreadable');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('does not read any excluded folder during an upgrade', () => {
    policy.addFolder({ accountId: 'excluded', path: '/fake/excluded', label: 'Excluded' });
    const read = vi.fn(() => identity);
    policy.initializeInstall(true, ['/fake/excluded'], read);
    expect(read).not.toHaveBeenCalled();
    expect(policy.assess('/fake/excluded', null).state).toBe('never-use');
  });
  it('requires first confirmation and pauses a UUID mismatch even with the same email', () => {
    policy.addOrganization(forbidden, 'Excluded company');
    expect(policy.assess('/fake/claude5', identity).state).toBe('unconfirmed');
    expect(policy.accept('/fake/claude5', identity)).toBe(true);
    const changed = { ...identity, accountUuid: forbidden };
    expect(policy.assess('/fake/claude5', changed).state).toBe('changed');
    expect(policy.assess('/fake/claude4', identity).state).toBe('unconfirmed');
    expect(new AccountSigninPolicy(home).assess('/fake/claude5', identity).state).toBe('confirmed');
  });
  it('never accepts an Art Blocks fixture, even when the owner asks', () => {
    policy.addOrganization(forbidden, 'Art Blocks fixture');
    const blocked = { ...identity, organizationUuid: forbidden };
    expect(policy.assess('/fake/claude5', blocked)).toEqual({ state: 'blocked' });
    expect(policy.accept('/fake/claude5', blocked)).toBe(false);
  });
  it('folder exclusion precedes identity and includes descendants', () => {
    policy.addFolder({ accountId: 'excluded', path: '/fake/off-limits', label: 'Excluded folder' });
    expect(policy.assess('/fake/off-limits', identity)).toEqual({ state: 'never-use' });
    expect(policy.neverUses('/fake/off-limits/projects/one')).toBe(true);
    expect(policy.neverUses('/fake/off-limits-other')).toBe(false);
    expect(policy.accept('/fake/off-limits', identity)).toBe(false);
  });
});
