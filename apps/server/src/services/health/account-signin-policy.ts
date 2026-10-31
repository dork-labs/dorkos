import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const IdentitySchema = z.object({
  accountUuid: z.uuid(),
  organizationUuid: z.uuid(),
  maskedEmail: z.string().max(254),
});
const FolderSchema = z.object({ accountId: z.string(), path: z.string(), label: z.string() });
const PolicySchema = z.object({
  deniedOrganizations: z.array(z.object({ id: z.uuid(), label: z.string().min(1).max(80) })),
  folders: z.array(FolderSchema),
  bindings: z.record(z.string(), IdentitySchema),
});
type Policy = z.infer<typeof PolicySchema>;
export type LoginIdentity = z.infer<typeof IdentitySchema>;
export type NeverUseFolder = z.infer<typeof FolderSchema>;
export type LoginIdentityState =
  'unreadable' | 'unconfirmed' | 'changed' | 'blocked' | 'confirmed' | 'never-use';
export interface LoginIdentityView {
  state: LoginIdentityState;
  email?: string;
  previousEmail?: string;
}
const empty = (): Policy => ({ deniedOrganizations: [], folders: [], bindings: {} });

/** Owner-managed identity policy. It never discovers accounts or reads credentials. */
export class AccountSigninPolicy {
  private readonly file: string;
  private value: Policy | null;
  constructor(dorkHome: string) {
    this.file = path.join(dorkHome, 'account-signin-policy.json');
    try {
      this.value = PolicySchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // Missing, malformed and unreadable are the same closed state. A person
      // can explicitly initialize the list through the step-up guarded route.
      this.value = null;
    }
  }
  /** One-time upgrade: trust existing non-secret metadata, never future logins.
   * The separate receipt prevents deletion or an interrupted migration from
   * silently binding a different identity on the next start.
   */
  initializeInstall(
    existingInstall: boolean,
    roots: readonly string[],
    readMetadata: (root: string) => LoginIdentity | null
  ): void {
    const receipt = path.join(path.dirname(this.file), 'account-signin-policy.initialized');
    if (fs.existsSync(receipt)) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(receipt, '1', { flag: 'wx', mode: 0o600 });
    if (fs.existsSync(this.file)) return; // Preserve existing policy, including malformed policy.
    this.value = empty();
    if (existingInstall) {
      for (const root of roots) {
        if (this.neverUses(root)) continue;
        const identity = readMetadata(root);
        if (identity && this.assess(root, identity).state === 'unconfirmed') {
          this.value.bindings[path.resolve(root)] = identity;
        }
      }
    }
    this.save(this.value);
  }
  isReadable(): boolean {
    return this.value !== null;
  }
  /** Only policy metadata; UUIDs are not inferred from any account folder. */
  snapshot(): Omit<Policy, 'bindings'> {
    return this.value
      ? structuredClone({
          deniedOrganizations: this.value.deniedOrganizations,
          folders: this.value.folders,
        })
      : { deniedOrganizations: [], folders: [] };
  }
  /** Pure path comparison: no realpath/stat of an off-limits folder. */
  neverUses(root: string): boolean {
    if (!this.value) return false;
    const key = path.resolve(root);
    return (
      this.value?.folders.some((folder) => {
        const denied = path.resolve(folder.path);
        return key === denied || key.startsWith(denied + path.sep);
      }) ?? false
    );
  }
  /** Call before reading metadata or launching any account-specific process. */
  assess(root: string, identity: LoginIdentity | null): LoginIdentityView {
    if (!this.value) return { state: 'unreadable' };
    if (this.neverUses(root)) return { state: 'never-use' };
    if (!identity) return { state: 'unreadable' };
    if (this.value.deniedOrganizations.some((entry) => entry.id === identity.organizationUuid)) {
      return { state: 'blocked' }; // Deliberately discloses no identity or owner.
    }
    const bound = this.value.bindings[path.resolve(root)];
    if (!bound) return { state: 'unconfirmed', email: identity.maskedEmail };
    if (
      bound.accountUuid !== identity.accountUuid ||
      bound.organizationUuid !== identity.organizationUuid
    ) {
      return { state: 'changed', email: identity.maskedEmail, previousEmail: bound.maskedEmail };
    }
    return { state: 'confirmed', email: identity.maskedEmail };
  }
  /** Caller must have passed owner + fresh step-up; the identity is server-read. */
  accept(root: string, identity: LoginIdentity | null): boolean {
    const view = this.assess(root, identity);
    if (!identity || !['unconfirmed', 'changed', 'confirmed'].includes(view.state)) return false;
    this.save({
      ...this.value!,
      bindings: { ...this.value!.bindings, [path.resolve(root)]: identity },
    });
    return true;
  }
  addOrganization(id: string, label: string): void {
    const entry = PolicySchema.shape.deniedOrganizations.element.parse({ id, label });
    const value = this.value ?? empty();
    if (value.deniedOrganizations.some((item) => item.id === entry.id)) return;
    this.save({ ...value, deniedOrganizations: [...value.deniedOrganizations, entry] });
  }
  removeOrganization(id: string): void {
    const value = this.value ?? empty();
    this.save({
      ...value,
      deniedOrganizations: value.deniedOrganizations.filter((item) => item.id !== id),
    });
  }
  addFolder(folder: NeverUseFolder): void {
    const entry = FolderSchema.parse({ ...folder, path: path.resolve(folder.path) });
    const value = this.value ?? empty();
    this.save({
      ...value,
      folders: [...value.folders.filter((item) => item.accountId !== entry.accountId), entry],
    });
  }
  removeFolder(accountId: string): void {
    const value = this.value ?? empty();
    this.save({ ...value, folders: value.folders.filter((item) => item.accountId !== accountId) });
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

let policy: AccountSigninPolicy | undefined;
/** Initialize the owner policy from the private app home. */
export function initAccountSigninPolicy(dorkHome: string): void {
  policy = new AccountSigninPolicy(dorkHome);
}
/** Return the initialized policy without reading an account folder. */
export function accountSigninPolicy(): AccountSigninPolicy | undefined {
  return policy;
}
/** Block explicit exclusions and unreadable policy before account I/O. */
export function isNeverUseClaudeFolder(root: string): boolean {
  return policy ? !policy.isReadable() || isExplicitlyNeverUseClaudeFolder(root) : false;
}

/** Refuse excluded paths before resolution, and aliases before any account read. */
export function isExplicitlyNeverUseClaudeFolder(root: string): boolean {
  if (!policy) return false;
  if (policy.neverUses(root)) return true;
  try {
    return policy.neverUses(fs.realpathSync.native(root));
  } catch {
    return false; // A missing folder is not an alias; other health checks fail closed.
  }
}
