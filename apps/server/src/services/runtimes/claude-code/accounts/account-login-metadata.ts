import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../../../../lib/logger.js';
import {
  accountSigninPolicy,
  isNeverUseClaudeFolder,
  mayAutoPick,
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

/** A folder's verdict and the identity it was read from (kept server-side). */
function inspect(root: string): { view: LoginIdentityView; identity: LoginIdentity | null } {
  const policy = accountSigninPolicy();
  if (!policy) return { view: { state: 'grandfathered' }, identity: null };
  // An alias of an excluded folder is excluded too, before anything reads it.
  if (isNeverUseClaudeFolder(root)) return { view: { state: 'never-use' }, identity: null };
  const identity = readAccountLoginMetadata(root);
  return { view: policy.observe(root, identity), identity };
}

/**
 * The shared account health read: launch, failover and the app read this
 * same verdict. With no policy installed (a test, a tool) nothing is excluded.
 */
export function accountLoginIdentity(root: string): LoginIdentityView {
  return inspect(root).view;
}

/**
 * Whether DorkOS may pick this folder on its own: only a confirmed or
 * grandfathered sign-in. A person or agent naming it still runs.
 *
 * @param root - A Claude account folder.
 */
export function mayAutoPickClaudeRoot(root: string): boolean {
  return mayAutoPick(accountLoginIdentity(root).state);
}

/** One sign-in a person should look at: new, or no longer what it was. */
export interface AccountLoginNotice {
  /** The account folder. */
  accountRoot: string;
  /** `new` for an unconfirmed folder, `changed` for a different sign-in. */
  change: 'new' | 'changed';
  /** The masked email it holds now. */
  email?: string;
  /** The masked email it was bound to. */
  previousEmail?: string;
  /** For `changed`: whether the organization changed too. */
  orgChanged?: boolean;
  /** A short hash of folder + identity: the same sign-in is said once. */
  fingerprint: string;
}

/** Told about each new or changed sign-in, once per sign-in per process. */
export type AccountLoginNoticeSink = (notice: AccountLoginNotice) => void;
let noticeSink: AccountLoginNoticeSink | null = null;
const noticed = new Set<string>();
const unreadableLogged = new Set<string>();

/**
 * Install (or tear down) what hears about new and changed sign-ins. Called
 * once by the composition root.
 *
 * @param next - The sink, or `null` to tear it down.
 */
export function setAccountLoginNoticeSink(next: AccountLoginNoticeSink | null): void {
  noticeSink = next;
}

/** Test seam: forget which sign-ins were already said. */
export function resetAccountLoginNotices(): void {
  noticed.clear();
  unreadableLogged.clear();
}

/** A person-set rule refused this launch: an excluded folder or a denied organization. */
export class AccountLoginRefusedError extends Error {
  /** Stable code the turn's error carries. */
  readonly code = 'account_login_refused';
  constructor(message: string) {
    super(message);
    this.name = 'AccountLoginRefusedError';
  }
}

function fingerprintOf(root: string, identity: LoginIdentity): string {
  return crypto
    .createHash('sha256')
    .update(`${path.resolve(root)}\u0000${identity.accountUuid}\u0000${identity.organizationUuid}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The launch check, before every turn (including one on a warm process). It
 * refuses only for the person's own two rules: a folder they excluded, or a
 * sign-in in an organization they ruled out. Anything else runs: a new or
 * changed sign-in is said once, as a notice, and is skipped only by pickers
 * that choose on their own.
 *
 * @param root - The account folder this turn runs on.
 * @throws AccountLoginRefusedError for an excluded folder or a denied organization.
 */
export function noteAccountLogin(root: string): void {
  const { view, identity } = inspect(root);
  if (view.state === 'never-use') {
    throw new AccountLoginRefusedError('This Claude folder is excluded in Settings → Runtimes.');
  }
  if (view.state === 'blocked') {
    throw new AccountLoginRefusedError(
      'This Claude sign-in is in an organization you ruled out in Settings → Runtimes.'
    );
  }
  if (view.state === 'unreadable') {
    if (!unreadableLogged.has(root)) {
      unreadableLogged.add(root);
      logger.info('[account-signin] A Claude sign-in could not be read; it runs as before');
    }
    return;
  }
  if ((view.state !== 'unconfirmed' && view.state !== 'changed') || !identity) return;
  const fingerprint = fingerprintOf(root, identity);
  if (noticed.has(fingerprint)) return;
  noticed.add(fingerprint);
  try {
    noticeSink?.({
      accountRoot: root,
      change: view.state === 'changed' ? 'changed' : 'new',
      ...(view.email ? { email: view.email } : {}),
      ...(view.previousEmail ? { previousEmail: view.previousEmail } : {}),
      ...(view.orgChanged !== undefined ? { orgChanged: view.orgChanged } : {}),
      fingerprint,
    });
  } catch (err) {
    // A notice that could not be said never costs the turn.
    logger.warn('[account-signin] Could not say a sign-in needs a look', { err: String(err) });
  }
}
