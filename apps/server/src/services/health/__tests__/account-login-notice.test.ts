/**
 * The launch check (DOR-3245), against real policy files and fake CLI
 * metadata: a changed or new sign-in runs and is said once; only the
 * person's two lists refuse. The check reads no permission level, so what
 * holds here holds at Default and at Full or Bypass alike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountSigninPolicy, initAccountSigninPolicy } from '../account-signin-policy.js';
import {
  AccountLoginRefusedError,
  mayAutoPickClaudeRoot,
  noteAccountLogin,
  readAccountLoginMetadata,
  resetAccountLoginNotices,
  setAccountLoginNoticeSink,
  type AccountLoginNotice,
} from '../../runtimes/claude-code/accounts/account-login-metadata.js';

vi.mock('../../runtimes/claude-code/claude-config-dir.js', () => ({
  claudeConfigDirEnv: (root: string) => ({ CLAUDE_CONFIG_DIR: root }),
}));

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const DENIED_ORG = '44444444-4444-4444-8444-444444444444';

let home: string;
let folder: string;
let notices: AccountLoginNotice[];

function signIn(root: string, account: string, org: string, email: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude.json'),
    JSON.stringify({
      oauthAccount: { accountUuid: account, organizationUuid: org, emailAddress: email },
    })
  );
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dork-login-notice-')));
  folder = path.join(home, 'claude2');
  signIn(folder, ACCOUNT, ORG, 'dana@example.test');
  initAccountSigninPolicy(path.join(home, 'dork'));
  accountSigninPolicy()!.seed(
    [{ root: folder, identity: readAccountLoginMetadata(folder) }],
    new Date('2026-10-30T00:00:00Z')
  );
  notices = [];
  resetAccountLoginNotices();
  setAccountLoginNoticeSink((notice) => notices.push(notice));
});
afterEach(() => {
  setAccountLoginNoticeSink(null);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('noteAccountLogin', () => {
  it('a grandfathered folder runs and says nothing', () => {
    expect(() => noteAccountLogin(folder)).not.toThrow();
    expect(notices).toEqual([]);
    expect(mayAutoPickClaudeRoot(folder)).toBe(true);
  });

  it('a changed sign-in runs, is said once, is skipped by automatic picks, and keeping it restores them', () => {
    signIn(folder, OTHER_ACCOUNT, DENIED_ORG, 'erin@example.test');
    expect(() => noteAccountLogin(folder)).not.toThrow();
    expect(() => noteAccountLogin(folder)).not.toThrow();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      accountRoot: folder,
      change: 'changed',
      email: 'e…@example.test',
      previousEmail: 'd…@example.test',
      orgChanged: true,
    });
    // The notice carries no account or organization id.
    expect(JSON.stringify(notices[0])).not.toContain(OTHER_ACCOUNT);
    expect(JSON.stringify(notices[0])).not.toContain(DENIED_ORG);
    expect(mayAutoPickClaudeRoot(folder)).toBe(false);

    // "Keep": the person binds what the server reads now.
    accountSigninPolicy()!.accept(folder, readAccountLoginMetadata(folder));
    expect(mayAutoPickClaudeRoot(folder)).toBe(true);
    noteAccountLogin(folder);
    expect(notices).toHaveLength(1);
  });

  it('a new folder runs when named and is said once, as new', () => {
    const fresh = path.join(home, 'claude3');
    signIn(fresh, OTHER_ACCOUNT, ORG, 'erin@example.test');
    expect(() => noteAccountLogin(fresh)).not.toThrow();
    expect(notices).toEqual([expect.objectContaining({ accountRoot: fresh, change: 'new' })]);
    expect(mayAutoPickClaudeRoot(fresh)).toBe(false);
  });

  it('an unreadable sign-in runs and says nothing new', () => {
    fs.rmSync(path.join(folder, '.claude.json'));
    expect(() => noteAccountLogin(folder)).not.toThrow();
    expect(notices).toEqual([]);
  });

  it('a sign-in in an organization the person ruled out is refused', () => {
    accountSigninPolicy()!.addOrganization(DENIED_ORG, 'Ruled out');
    signIn(folder, ACCOUNT, DENIED_ORG, 'dana@example.test');
    expect(() => noteAccountLogin(folder)).toThrow(AccountLoginRefusedError);
    expect(notices).toEqual([]);
  });

  it('a folder the person excluded is refused', () => {
    accountSigninPolicy()!.addFolder({ accountId: 'two', path: folder, label: 'Two' });
    expect(() => noteAccountLogin(folder)).toThrow(AccountLoginRefusedError);
  });
});
