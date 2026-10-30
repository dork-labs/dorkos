/**
 * Which Claude sign-in each account folder is expected to hold, and the two
 * lists only a person fills: organizations DorkOS must never use, and folders
 * it must never touch (DOR-3245).
 *
 * Nothing here pauses or refuses on its own. An unconfirmed or changed sign-in
 * still runs; it only stops DorkOS from picking that folder by itself
 * (`account-ranking.ts`). The two person-set lists are the only refusals, and
 * both are empty until a person fills them.
 *
 * The file is `~/.dork/account-signin-policy.json`. The first boot writes it
 * and binds every folder DorkOS already knows to the sign-in it has then
 * (`seed-signin-policy.ts`), so an upgrade pauses nothing.
 *
 * @module services/health/account-signin-policy
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

const IdentitySchema = z.object({
  accountUuid: z.uuid(),
  organizationUuid: z.uuid(),
  maskedEmail: z.string().max(254),
});
const FolderSchema = z.object({ accountId: z.string(), path: z.string(), label: z.string() });
const PolicySchema = z.object({
  deniedOrganizations: z.array(z.object({ id: z.uuid(), label: z.string().min(1).max(80) })),
  neverUseFolders: z.array(FolderSchema),
  bindings: z.record(z.string(), IdentitySchema),
  /** Folders known at the first boot whose sign-in could not be read then. */
  grandfatheredUnread: z.array(z.string()).default([]),
  /** When the first boot seeded this file. Absent: the seed has not run. */
  seededAt: z.string().optional(),
});
type Policy = z.infer<typeof PolicySchema>;
/** The non-secret sign-in a folder's `.claude.json` names. */
export type LoginIdentity = z.infer<typeof IdentitySchema>;
/** A folder a person told DorkOS never to touch. */
export type NeverUseFolder = z.infer<typeof FolderSchema>;
/** Where a folder's sign-in stands, as every picker and the app read it. */
export type LoginIdentityState =
  | 'unreadable'
  | 'unconfirmed'
  | 'changed'
  | 'blocked'
  | 'confirmed'
  | 'grandfathered'
  | 'never-use';
/** A folder's sign-in state, with masked emails only. */
export interface LoginIdentityView {
  state: LoginIdentityState;
  email?: string;
  previousEmail?: string;
  /** For `changed`: whether the organization changed too. */
  orgChanged?: boolean;
}
const empty = (): Policy => ({
  deniedOrganizations: [],
  neverUseFolders: [],
  bindings: {},
  grandfatheredUnread: [],
});

/**
 * Whether DorkOS may pick a folder in this state on its own (the launch ladder,
 * failover, auto-handoff, room reseat). A person or agent naming it still runs.
 *
 * @param state - The folder's sign-in state.
 */
export function mayAutoPick(state: LoginIdentityState): boolean {
  return state === 'confirmed' || state === 'grandfathered';
}

/** Person-managed identity policy. It never discovers accounts or reads credentials. */
export class AccountSigninPolicy {
  private readonly file: string;
  private value: Policy;
  private readonly malformed: boolean;
  constructor(dorkHome: string) {
    this.file = path.join(dorkHome, 'account-signin-policy.json');
    let raw: string | null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      raw = null; // Missing: the boot seed writes it.
    }
    const parsed = raw === null ? null : safeParse(raw);
    this.malformed = raw !== null && !parsed;
    if (this.malformed) {
      // Kept on disk for the person to fix; nothing pauses while it is broken.
      logger.warn('[account-signin] The sign-in list could not be read; nothing is excluded');
    }
    this.value = parsed ?? empty();
  }
  /** Whether the first-boot seed has written this install's bindings. */
  isSeeded(): boolean {
    return this.value.seededAt !== undefined;
  }
  /** Whether a seed may write: the file is missing, or readable and never seeded. */
  canSeed(): boolean {
    return !this.isSeeded() && !this.malformed;
  }
  /** Only policy metadata; UUIDs are not inferred from any account folder. */
  snapshot(): { deniedOrganizations: Policy['deniedOrganizations']; folders: NeverUseFolder[] } {
    return structuredClone({
      deniedOrganizations: this.value.deniedOrganizations,
      folders: this.value.neverUseFolders,
    });
  }
  /** Pure path comparison: no realpath/stat of an off-limits folder. */
  neverUses(root: string): boolean {
    const key = path.resolve(root);
    return this.value.neverUseFolders.some((folder) => {
      const denied = path.resolve(folder.path);
      return key === denied || key.startsWith(denied + path.sep);
    });
  }
  /** Whether an organization is on the person's deny list. */
  deniesOrganization(organizationUuid: string): boolean {
    return this.value.deniedOrganizations.some((entry) => entry.id === organizationUuid);
  }
  /** Pure verdict for a folder and the sign-in it holds now. Never writes. */
  assess(root: string, identity: LoginIdentity | null): LoginIdentityView {
    if (this.neverUses(root)) return { state: 'never-use' };
    if (identity && this.deniesOrganization(identity.organizationUuid)) {
      return { state: 'blocked' }; // Deliberately discloses no identity or owner.
    }
    const key = bindingKey(root);
    const bound = this.value.bindings[key];
    const grandfathered = !this.isSeeded() || this.value.grandfatheredUnread.includes(key);
    if (!identity) return { state: grandfathered && !bound ? 'grandfathered' : 'unreadable' };
    if (!bound) {
      return grandfathered
        ? { state: 'grandfathered', email: identity.maskedEmail }
        : { state: 'unconfirmed', email: identity.maskedEmail };
    }
    if (
      bound.accountUuid !== identity.accountUuid ||
      bound.organizationUuid !== identity.organizationUuid
    ) {
      return {
        state: 'changed',
        email: identity.maskedEmail,
        previousEmail: bound.maskedEmail,
        orgChanged: bound.organizationUuid !== identity.organizationUuid,
      };
    }
    return { state: 'confirmed', email: identity.maskedEmail };
  }
  /**
   * Trust on first read: a folder grandfathered unread at the seed is bound
   * the first time its sign-in reads cleanly. Returns the verdict after.
   */
  observe(root: string, identity: LoginIdentity | null): LoginIdentityView {
    const view = this.assess(root, identity);
    const key = bindingKey(root);
    if (
      identity &&
      view.state === 'grandfathered' &&
      this.value.grandfatheredUnread.includes(key)
    ) {
      this.save({
        ...this.value,
        bindings: { ...this.value.bindings, [key]: identity },
        grandfatheredUnread: this.value.grandfatheredUnread.filter((item) => item !== key),
      });
      return this.assess(root, identity);
    }
    return view;
  }
  /** Bind a folder to the sign-in the server read. Callers check the person first. */
  accept(root: string, identity: LoginIdentity | null): boolean {
    const view = this.assess(root, identity);
    if (!identity || view.state === 'blocked' || view.state === 'never-use') return false;
    const key = bindingKey(root);
    this.save({
      ...this.value,
      bindings: { ...this.value.bindings, [key]: identity },
      grandfatheredUnread: this.value.grandfatheredUnread.filter((item) => item !== key),
    });
    return true;
  }
  /**
   * The first boot's bindings: every known folder to the sign-in it has now,
   * or grandfathered until it reads. Runs once, then stamps `seededAt`.
   *
   * @param folders - Every folder DorkOS knows, each with what it reads as now.
   * @param now - The stamp to write.
   */
  seed(folders: ReadonlyArray<{ root: string; identity: LoginIdentity | null }>, now: Date): void {
    if (!this.canSeed()) return;
    const bindings = { ...this.value.bindings };
    const unread = new Set(this.value.grandfatheredUnread);
    for (const { root, identity } of folders) {
      if (this.neverUses(root)) continue;
      const key = bindingKey(root);
      if (bindings[key]) continue;
      if (identity) bindings[key] = identity;
      else unread.add(key);
    }
    this.save({
      ...this.value,
      bindings,
      grandfatheredUnread: [...unread],
      seededAt: now.toISOString(),
    });
  }
  addOrganization(id: string, label: string): void {
    const entry = PolicySchema.shape.deniedOrganizations.element.parse({ id, label });
    if (this.deniesOrganization(entry.id)) return;
    this.save({
      ...this.value,
      deniedOrganizations: [...this.value.deniedOrganizations, entry],
    });
  }
  removeOrganization(id: string): void {
    this.save({
      ...this.value,
      deniedOrganizations: this.value.deniedOrganizations.filter((item) => item.id !== id),
    });
  }
  addFolder(folder: NeverUseFolder): void {
    const entry = FolderSchema.parse({ ...folder, path: path.resolve(folder.path) });
    this.save({
      ...this.value,
      neverUseFolders: [
        ...this.value.neverUseFolders.filter((item) => item.accountId !== entry.accountId),
        entry,
      ],
    });
  }
  removeFolder(accountId: string): void {
    this.save({
      ...this.value,
      neverUseFolders: this.value.neverUseFolders.filter((item) => item.accountId !== accountId),
    });
  }
  private save(value: Policy): void {
    const next = PolicySchema.parse(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const pending = this.file + '.pending';
    fs.writeFileSync(pending, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(pending, this.file);
    this.value = next;
  }
}

function safeParse(raw: string): Policy | null {
  try {
    const result = PolicySchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * The key a folder's binding is stored under: its real path when it resolves,
 * so `~/.claude2` and a symlink to it are one folder. Only called for folders
 * that are not excluded, so it never stats a never-use folder.
 */
function bindingKey(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

let policy: AccountSigninPolicy | undefined;
/** Initialize the person's policy from the private app home. */
export function initAccountSigninPolicy(dorkHome: string): void {
  policy = new AccountSigninPolicy(dorkHome);
}
/** Return the initialized policy without reading an account folder. */
export function accountSigninPolicy(): AccountSigninPolicy | undefined {
  return policy;
}
/** Whether a person excluded this folder (or one it sits in) from DorkOS. */
export function isNeverUseClaudeFolder(root: string): boolean {
  return isExplicitlyNeverUseClaudeFolder(root);
}

/** Refuse excluded paths before resolution, and aliases before any account read. */
export function isExplicitlyNeverUseClaudeFolder(root: string): boolean {
  if (!policy) return false;
  if (policy.neverUses(root)) return true;
  try {
    return policy.neverUses(fs.realpathSync.native(root));
  } catch {
    return false; // A missing folder is not an alias.
  }
}
