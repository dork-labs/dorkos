/**
 * Stable account ids for the audit log (spec `audit-trail` §3.2).
 *
 * The Activity feed names an agent by its folder path and a person, with login
 * off, by nothing at all ("You"). Neither survives: moving an agent splits its
 * history, and "You" cannot be looked up. The audit log keys every actor on an
 * id that outlives renames and moves:
 *
 * | Who                                    | Account id                                         |
 * | -------------------------------------- | -------------------------------------------------- |
 * | A registered agent                     | its mesh ULID (the `agents` table)                  |
 * | An agent the mesh does not know        | `unregistered:` + 16 hex of sha256(path)           |
 * | A caller that presented an agent token DorkOS could not resolve | `unidentified`             |
 * | A signed-in person                     | their account id                                   |
 * | The owner at this computer, login off  | the owner account's id when one exists, else `install:<install id>` |
 * | DorkOS itself                          | `system`                                           |
 *
 * The `agents` table is read directly rather than through `MeshCore`, because it
 * exists from the moment the database opens, while the mesh is built later in
 * startup; an Activity event written in between must get the same id as one
 * written after.
 *
 * The install id is the one `lib/instance-id.ts` keeps, the same id connectors
 * already treat as the local owner when nobody has an account
 * (`ownerKind: 'local_install'`).
 *
 * @module services/audit/account-ids
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { agents, eq, type Db } from '@dorkos/db';
import type { AuditActor } from '@dorkos/shared/audit-schemas';

/** The account id DorkOS itself acts under. */
export const SYSTEM_ACCOUNT_ID = 'system';

/** The account id of a caller that presented an agent token nobody could resolve. */
export const UNIDENTIFIED_ACCOUNT_ID = 'unidentified';

/** What the resolver needs to know about this install. */
export interface AccountIdDeps {
  /** The consolidated database. */
  db: Db;
  /** This install's stable id (`lib/instance-id.ts`). */
  installId: string;
  /** The account that owns this install, or `null` while nobody has one. */
  readOwnerAccount: () => { id: string; name: string } | null;
}

/** The name the log gives the owner when no account names them. */
const OWNER_NAME = 'Owner';

/**
 * Resolves who acted into a stable {@link AuditActor}.
 */
export class AccountIds {
  constructor(private readonly deps: AccountIdDeps) {}

  /** The id the owner is known by before any account exists: `install:<install id>`. */
  installAccountId(): string {
    return `install:${this.deps.installId}`;
  }

  /**
   * The person who owns this install: their account when there is one, else
   * the install itself.
   */
  owner(): AuditActor {
    const account = this.deps.readOwnerAccount();
    return account
      ? { accountId: account.id, kind: 'person', name: account.name || OWNER_NAME }
      : { accountId: this.installAccountId(), kind: 'person', name: OWNER_NAME };
  }

  /**
   * A signed-in person, by their account id.
   *
   * @param userId - The account id.
   * @param name - Their name as shown now.
   */
  person(userId: string, name: string): AuditActor {
    return { accountId: userId, kind: 'person', name };
  }

  /**
   * An agent, by the path or id DorkOS knows it by.
   *
   * @param ref - The agent's project path, or its mesh id.
   * @param name - Its name as shown now.
   */
  agent(ref: string, name: string): AuditActor {
    return { accountId: this.agentAccountId(ref), kind: 'agent', name };
  }

  /**
   * A signed-in account: the owner (with their name) when it is theirs, else a
   * person known only by id. A local install has one account, so the second
   * branch is for spaces with more than one.
   *
   * @param userId - The account id the request proved.
   */
  forUser(userId: string): AuditActor {
    const owner = this.deps.readOwnerAccount();
    return owner && owner.id === userId
      ? this.owner()
      : { accountId: userId, kind: 'person', name: 'Person' };
  }

  /**
   * An agent caller: the agent its token named, or `unidentified` when the token
   * named nobody.
   *
   * @param identity - What the token resolved to, if anything.
   */
  forAgentIdentity(identity: { agentPath: string; displayName: string } | undefined): AuditActor {
    return identity
      ? this.agent(identity.agentPath, identity.displayName || path.basename(identity.agentPath))
      : this.unidentified('Unidentified caller');
  }

  /** DorkOS itself, under the name a reader should see. */
  system(name = 'DorkOS'): AuditActor {
    return { accountId: SYSTEM_ACCOUNT_ID, kind: 'system', name };
  }

  /** A caller that presented an agent token DorkOS could not resolve. */
  unidentified(name: string): AuditActor {
    return { accountId: UNIDENTIFIED_ACCOUNT_ID, kind: 'external', name };
  }

  /**
   * The stable id for an agent reference. A path is looked up in the `agents`
   * table; anything else is taken to be a mesh id already.
   *
   * @param ref - A project path or a mesh id.
   */
  agentAccountId(ref: string): string {
    if (!path.isAbsolute(ref)) return ref;
    const row = this.deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.projectPath, ref))
      .get();
    if (row) return row.id;
    const digest = createHash('sha256').update(ref, 'utf8').digest('hex').slice(0, 16);
    return `unregistered:${digest}`;
  }
}

/**
 * A credential as the log names it: its kind and a short, one-way hash of its
 * id. Never the credential itself.
 *
 * @param kind - What kind of credential acted.
 * @param id - A stable id for it (an API key record id, a token digest).
 */
export function credentialRef(
  kind: 'cookie' | 'api-key' | 'agent-token' | 'mcp-local',
  id: string
): { kind: string; idHash: string } {
  return { kind, idHash: createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12) };
}
