/**
 * The Claude sign-in policy on its own (DOR-3245): an upgrade seeds and pauses
 * nothing, an empty organization list excludes nothing, a changed or new
 * sign-in is only "not picked on its own", and the person's two lists are the
 * only refusals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountSigninPolicy, mayAutoPick, type LoginIdentity } from '../account-signin-policy.js';

const account = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const forbidden = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const identity: LoginIdentity = {
  accountUuid: account,
  organizationUuid: org,
  maskedEmail: 'd…@example.com',
};
const NOW = new Date('2026-10-30T00:00:00.000Z');
let home: string;
let policy: AccountSigninPolicy;
const file = () => path.join(home, 'account-signin-policy.json');
const onDisk = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-signin-policy-'));
  policy = new AccountSigninPolicy(home);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('upgrade: the first boot seeds and pauses nothing', () => {
  it('binds three known folders, stamps once, and a second boot changes nothing', () => {
    const second = { ...identity, accountUuid: other };
    policy.seed(
      [
        { root: '/fake/claude', identity },
        { root: '/fake/claude2', identity: second },
        { root: '/fake/claude3', identity: null },
      ],
      NOW
    );
    const written = onDisk();
    expect(Object.keys(written.bindings).sort()).toEqual(['/fake/claude', '/fake/claude2']);
    expect(written.grandfatheredUnread).toEqual(['/fake/claude3']);
    expect(written.seededAt).toBe(NOW.toISOString());
    expect(written.deniedOrganizations).toEqual([]);
    expect(written.neverUseFolders).toEqual([]);
    // All three run and stay pickable.
    expect(policy.assess('/fake/claude', identity).state).toBe('confirmed');
    expect(policy.assess('/fake/claude2', second).state).toBe('confirmed');
    expect(policy.assess('/fake/claude3', null).state).toBe('grandfathered');

    const before = fs.readFileSync(file(), 'utf8');
    const reboot = new AccountSigninPolicy(home);
    expect(reboot.canSeed()).toBe(false);
    reboot.seed([{ root: '/fake/claude4', identity }], new Date('2026-11-01T00:00:00Z'));
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  });

  it('binds a grandfathered folder the first time it reads cleanly (trust on first read)', () => {
    policy.seed([{ root: '/fake/claude3', identity: null }], NOW);
    expect(policy.observe('/fake/claude3', identity).state).toBe('confirmed');
    expect(onDisk().grandfatheredUnread).toEqual([]);
    expect(policy.assess('/fake/claude3', { ...identity, accountUuid: other }).state).toBe(
      'changed'
    );
  });

  it('before the seed runs, every folder counts as known: nothing is held back', () => {
    expect(policy.assess('/fake/claude5', identity).state).toBe('grandfathered');
    expect(mayAutoPick(policy.assess('/fake/claude5', null).state)).toBe(true);
  });

  it('leaves a hand-broken file alone, and excludes nothing while it is broken', () => {
    fs.writeFileSync(file(), '{');
    const broken = new AccountSigninPolicy(home);
    expect(broken.canSeed()).toBe(false);
    broken.seed([{ root: '/fake/claude', identity }], NOW);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{');
    expect(mayAutoPick(broken.assess('/fake/claude', identity).state)).toBe(true);
  });
});

describe('after the seed', () => {
  beforeEach(() => policy.seed([{ root: '/fake/claude', identity }], NOW));

  it('an empty organization list excludes nothing and pauses nothing', () => {
    expect(onDisk().deniedOrganizations).toEqual([]);
    expect(policy.assess('/fake/claude', identity).state).toBe('confirmed');
    expect(policy.assess('/fake/claude', null).state).toBe('unreadable');
    expect(policy.assess('/fake/claude5', identity).state).toBe('unconfirmed');
  });

  it('a new folder is unconfirmed, and only confirmed or grandfathered is picked alone', () => {
    expect(mayAutoPick(policy.assess('/fake/claude5', identity).state)).toBe(false);
    expect(policy.accept('/fake/claude5', identity)).toBe(true);
    expect(mayAutoPick(policy.assess('/fake/claude5', identity).state)).toBe(true);
  });

  it('a UUID change is "changed", even with the same email; keeping it binds the new one', () => {
    const changed = { ...identity, organizationUuid: other };
    expect(policy.assess('/fake/claude', changed)).toEqual({
      state: 'changed',
      email: 'd…@example.com',
      previousEmail: 'd…@example.com',
      orgChanged: true,
    });
    expect(mayAutoPick('changed')).toBe(false);
    expect(policy.accept('/fake/claude', changed)).toBe(true);
    expect(new AccountSigninPolicy(home).assess('/fake/claude', changed).state).toBe('confirmed');
  });

  it('a denied organization is blocked and can never be accepted', () => {
    policy.addOrganization(forbidden, 'Excluded fixture');
    const blocked = { ...identity, organizationUuid: forbidden };
    expect(policy.assess('/fake/claude', blocked)).toEqual({ state: 'blocked' });
    expect(policy.accept('/fake/claude', blocked)).toBe(false);
  });

  it('a never-use folder precedes identity and includes descendants', () => {
    policy.addFolder({ accountId: 'excluded', path: '/fake/off-limits', label: 'Excluded' });
    expect(policy.assess('/fake/off-limits', identity)).toEqual({ state: 'never-use' });
    expect(policy.neverUses('/fake/off-limits/projects/one')).toBe(true);
    expect(policy.neverUses('/fake/off-limits-other')).toBe(false);
    expect(policy.accept('/fake/off-limits', identity)).toBe(false);
  });
});
