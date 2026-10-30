import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAccountLoginMetadata } from '../../runtimes/claude-code/accounts/account-login-metadata.js';
vi.mock('../../runtimes/claude-code/claude-config-dir.js', () => ({
  claudeConfigDirEnv: (root: string) => ({ CLAUDE_CONFIG_DIR: root }),
}));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-identity-metadata-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('reads only IDs and a masked email from fake CLI metadata', () => {
  fs.writeFileSync(
    path.join(root, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        accountUuid: '11111111-1111-4111-8111-111111111111',
        organizationUuid: '22222222-2222-4222-8222-222222222222',
        emailAddress: 'dorian@example.test',
      },
      ignoredToken: 'synthetic-not-a-credential',
    })
  );
  expect(readAccountLoginMetadata(root)).toEqual({
    accountUuid: '11111111-1111-4111-8111-111111111111',
    organizationUuid: '22222222-2222-4222-8222-222222222222',
    maskedEmail: 'd…@example.test',
  });
});
it('refuses unreadable or incomplete metadata and never follows a symlink', () => {
  expect(readAccountLoginMetadata(root)).toBeNull();
  fs.writeFileSync(
    path.join(root, 'elsewhere.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'dorian@example.test' } })
  );
  fs.symlinkSync(path.join(root, 'elsewhere.json'), path.join(root, '.claude.json'));
  expect(readAccountLoginMetadata(root)).toBeNull();
});
