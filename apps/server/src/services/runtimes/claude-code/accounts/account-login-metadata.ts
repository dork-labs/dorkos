import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  accountSigninPolicy,
  isNeverUseClaudeFolder,
  type LoginIdentity,
  type LoginIdentityView,
} from '../../../health/account-signin-policy.js';
import { claudeConfigDirEnv } from '../claude-config-dir.js';

const MetadataSchema = z.object({
  oauthAccount: z.object({
    accountUuid: z.uuid(),
    organizationUuid: z.uuid(),
    emailAddress: z.email(),
  }),
});

/** Only non-secret CLI metadata, never a credential store or a vendor process. */
export function readAccountLoginMetadata(root: string): LoginIdentity | null {
  if (isNeverUseClaudeFolder(root)) return null;
  // Mirror the env the login uses: an explicitly pinned folder keeps its
  // own .claude.json; the CLI's unset default uses the sibling ~/.claude.json.
  const pinned = claudeConfigDirEnv(root).CLAUDE_CONFIG_DIR;
  const metadata = pinned
    ? path.join(pinned, '.claude.json')
    : path.join(path.dirname(root), '.claude.json');
  try {
    // Refuse symlinks instead of following one to a credential file or a
    // different account. No fallback to another folder when this is missing.
    const stat = fs.lstatSync(metadata);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const result = MetadataSchema.safeParse(JSON.parse(fs.readFileSync(metadata, 'utf8')));
    if (!result.success) return null;
    const { accountUuid, organizationUuid, emailAddress } = result.data.oauthAccount;
    const [local, domain] = emailAddress.split('@');
    return { accountUuid, organizationUuid, maskedEmail: `${local[0]}…@${domain}` };
  } catch {
    return null; // Never log raw file content, parser errors or an email.
  }
}

/** The shared account health read: failover and launch read this same verdict. */
export function accountLoginIdentity(root: string): LoginIdentityView {
  const policy = accountSigninPolicy();
  if (!policy) return { state: 'unreadable' };
  if (policy.neverUses(root)) return policy.assess(root, null);
  return policy.assess(root, readAccountLoginMetadata(root));
}

/** Refuse before any turn (including one reusing a persistent process). */
export function requireConfirmedAccountLogin(root: string): void {
  if (accountLoginIdentity(root).state !== 'confirmed') {
    throw new Error('This Claude sign-in needs your review in Runtimes.');
  }
}
