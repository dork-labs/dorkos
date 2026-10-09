import { createBrowserRuntimeOwnerResolution } from '../runtime-owner-resolution.js';
import {
  createRuntimeWorkspaceDelegations,
  type RuntimeWorkspaceDelegation,
} from '../runtime-workspace-delegation.js';
import { ApprovalService, hashApprovalInput } from '../../../core/approvals/index.js';
import type { CapabilityHandlerContext } from '../../../core/capabilities/registry.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createDb,
  runMigrations,
  user,
  workspaces,
  connectorRuntimeBindings,
  approvals,
  eq,
} from '@dorkos/db';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { AuthorRegistry } from '../../../rooms/author-registry.js';
import { captureRuntimeBrowserBirth } from '../runtime-birth.js';

async function fixture(
  runtime: 'claude-code' | 'codex' | 'opencode' = 'claude-code',
  ownerKind: 'user' | 'local_install' = 'user',
  installationId = 'installation-birth'
) {
  let closed = false,
    active = true,
    enabled = true,
    loginEnabled = true;
  let db: ReturnType<typeof createDb> | undefined;
  const pending = new Set<Promise<unknown>>(),
    releases: Array<() => void> = [],
    expected = new Set<unknown>();
  const retained: { starting?: Promise<unknown> } = {};
  let closing: Promise<void> | undefined;
  const finalize = () => {
    if (closing) return closing;
    closed = true;
    active = false;
    enabled = false;
    closing = Promise.resolve().then(async () => {
      for (const release of releases) release();
      const results = await Promise.allSettled([
        ...(retained.starting ? [retained.starting] : []),
        ...pending,
      ]);
      let first: { value: unknown } | undefined;
      for (const result of results)
        if (result.status === 'rejected' && !expected.has(result.reason))
          first ??= { value: result.reason };
      try {
        db?.$client.close();
      } catch (value) {
        first ??= { value };
      }
      if (first) throw first.value;
    });
    return closing;
  };
  onTestFinished(finalize);
  const setup = Promise.resolve().then(async () => {
    if (closed) throw new Error('FIXTURE_CLOSED');
    db = createDb(':memory:');
    runMigrations(db);
    db.insert(user)
      .values({
        id: 'owner-birth',
        name: 'Owner',
        email: 'owner@fixture.invalid',
      })
      .run();
    db.insert(workspaces)
      .values({
        id: 'workspace-birth',
        projectKey: 'project-birth',
        key: 'main',
        path: '/fixture/workspace',
        source: '/fixture/project',
        provider: 'worktree',
        status: 'ready',
        portBase: 6200,
        portBlockSize: 10,
        ownerKind: 'agent',
        ownerRef: '/fixture/agent',
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      })
      .run();
    const authority = {
      authorizeTurn: vi.fn(async () => ({
        owner:
          ownerKind === 'user'
            ? { kind: 'user' as const, userId: 'owner-birth' }
            : {
                kind: 'local_install' as const,
                installationId: 'installation-birth',
              },
        agentId: 'manifest-birth',
      })),
      revalidateTurn: vi.fn(async () => active),
    };
    const principals = new ConnectorRuntimePrincipalService({ db, authority });
    await principals.initializeBoot();
    if (closed) throw new Error('FIXTURE_CLOSED');
    const input = {
      runtime,
      canonicalSessionId: 'session-birth',
      agentPath: '/fixture/agent',
      canonicalCwd: '/fixture/workspace',
      signal: new AbortController().signal,
    };
    const opened = await principals.openTurn(input, {
      isCurrent: () => active,
    });
    if (closed) throw new Error('FIXTURE_CLOSED');
    const resolved = await principals.resolve({
      bearer: opened.bearer,
      expectedRuntime: runtime,
      expectedCanonicalCwd: input.canonicalCwd,
    });
    if (closed || resolved.status !== 'resolved') throw new Error('FIXTURE_CLOSED');
    let occupant = 'manifest-birth';
    const authors = new AuthorRegistry(db, {
      byPath: () => ({
        id: occupant,
        name: 'Fixture Agent',
        displayName: 'Fixture Agent',
        responseMode: 'always',
        emoji: null,
        color: null,
      }),
    });
    const owners = createBrowserRuntimeOwnerResolution({
      db,
      authors,
      installationId,
      enabled: () => loginEnabled && enabled && !closed,
    });
    const context = {
      serverPrincipal: resolved.principal,
      identity: {
        agentPath: input.agentPath,
        displayName: 'Fixture Agent',
        createdAt: new Date().toISOString(),
      },
      sessionId: input.canonicalSessionId,
      signal: input.signal,
    };
    const capture = (delegation?: RuntimeWorkspaceDelegation) => {
      const operation = captureRuntimeBrowserBirth({
        db: db!,
        principals,
        authors,
        context,
        owners,
        delegation,
        enabled: () => enabled && !closed,
      });
      pending.add(operation);
      return operation;
    };
    const delegations = createRuntimeWorkspaceDelegations({
      db,
      owners,
      enabled: () => enabled && !closed,
      refuse: () => new Error('DELEGATION_REFUSED'),
    });
    releases.push(() => delegations.close());
    const approveDelegation = () => {
      const input = {
        workspaceId: 'workspace-birth',
        sessionId: 'session-birth',
      };
      const change = delegations.describe(input);
      const service = new ApprovalService(db!);
      const binding = {
        capabilityId: 'browser.open_delegated',
        inputHash: hashApprovalInput({ input, change }),
      };
      const ticket = service.request({
        ...binding,
        summary: 'Allow this workspace browser',
        requestedBy: 'Fixture Agent',
        requestedByPath: '/fixture/agent',
        requestingSession: {
          sessionId: 'session-birth',
          cwd: '/fixture/workspace',
        },
      });
      if (service.grant(ticket.approvalId, 'owner-birth')) throw new Error('APPROVAL_FAILED');
      const consumed = service.consume(ticket.token, binding);
      if (consumed.outcome !== 'granted') throw new Error('APPROVAL_FAILED');
      const approvedContext: CapabilityHandlerContext = {
        ...context,
        approvedChange: change,
        approval: {
          via: 'approval',
          approvalId: consumed.approvalId,
          decidedByUserId: consumed.decidedByUserId,
        },
      };
      return {
        input,
        approvedContext,
        id: consumed.approvalId,
        issue: () => delegations.issue(input, input, approvedContext, principals, authors),
      };
    };
    return {
      db,
      principals,
      authors,
      authority,
      context,
      capture,
      approveDelegation,
      delegations,
      expected,
      releases,
      pending,
      finalize,
      replace: () => {
        occupant = 'replacement-manifest';
      },
      revoke: () => {
        active = false;
      },
      disableLogin: () => {
        loginEnabled = false;
      },
      disable: () => {
        enabled = false;
      },
    };
  });
  retained.starting = setup;
  return await setup;
}

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'genuine %s turn resolves its actual agent-owned workspace and durable author without cookies',
  async (runtime) => {
    const f = await fixture(runtime),
      credential = await f.capture();
    expect(credential.workspaceId).toBe('workspace-birth');
    expect(credential.recipientId).toBe(
      f.authors.resolveAgent('/fixture/agent', 'Fixture Agent').id
    );
    expect(credential.recipientId).not.toBe('manifest-birth');
    expect(credential.actor.ownerId).toBe(f.authors.bindOwner('owner-birth').id);
    expect(credential.actor.ownerId).not.toBe('owner-birth');
    expect(credential.actor()).toBe(true);
    f.revoke();
    expect(credential.actor()).toBe(false);
  }
);

it.each(['human', 'foreign-agent'] as const)(
  'refuses an actual %s workspace instead of borrowing it from the runtime cwd',
  async (owner) => {
    const f = await fixture();
    f.db
      .update(workspaces)
      .set(
        owner === 'human' ? { ownerKind: null, ownerRef: null } : { ownerRef: '/fixture/foreign' }
      )
      .where(eq(workspaces.id, 'workspace-birth'))
      .run();
    const operation = f.capture();
    const refusal = await operation.catch((value) => value);
    f.expected.add(refusal);
    expect(refusal).toBeInstanceOf(Error);
  }
);

it('original durable author occupancy replacement fences an already returned runtime birth credential', async () => {
  const f = await fixture(),
    credential = await f.capture();
  f.replace();
  expect(credential.actor()).toBe(false);
  expect(() => credential.expiresAt()).toThrow();
});

it('held original turn refresh cannot publish a birth after Off, and teardown joins its original settlement', async () => {
  const f = await fixture();
  let release!: (value: boolean) => void;
  const held = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  f.releases.push(() => release(false));
  f.authority.revalidateTurn.mockImplementationOnce(() => held);
  const operation = f.capture();
  await Promise.resolve();
  f.disable();
  release(false);
  const refusal = await operation.catch((value) => value);
  f.expected.add(refusal);
  expect(refusal).toBeInstanceOf(Error);
});

it('uncancelled original refresh undefined is retained as the exact caller failure rather than an ordinary refusal', async () => {
  const f = await fixture();
  f.expected.add(undefined);
  f.authority.revalidateTurn.mockRejectedValueOnce(undefined);
  await expect(f.capture()).rejects.toBeUndefined();
});

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'real owner approval delegates an ordinary workspace for the current %s principal without changing ownership',
  async (runtime) => {
    const f = await fixture(runtime);
    f.db
      .update(workspaces)
      .set({ ownerKind: null, ownerRef: null })
      .where(eq(workspaces.id, 'workspace-birth'))
      .run();
    const decision = f.approveDelegation(),
      original = decision.issue();
    const birth = await f.capture(original);
    expect(birth.actor()).toBe(true);
    expect(birth.workspaceId).toBe('workspace-birth');
    const row = f.db.select().from(workspaces).where(eq(workspaces.id, 'workspace-birth')).get();
    expect(row?.ownerKind).toBeNull();
    expect(row?.ownerRef).toBeNull();
    expect(() => decision.issue()).toThrow('DELEGATION_REFUSED');
    f.db.update(approvals).set({ state: 'denied' }).where(eq(approvals.id, decision.id)).run();
    expect(birth.actor()).toBe(false);
  }
);
it('an approved workspace path change refuses delegated birth before native acquisition', async () => {
  const f = await fixture();
  f.db
    .update(workspaces)
    .set({ ownerKind: null, ownerRef: null })
    .where(eq(workspaces.id, 'workspace-birth'))
    .run();
  const decision = f.approveDelegation();
  f.db
    .update(workspaces)
    .set({ path: '/fixture/replaced' })
    .where(eq(workspaces.id, 'workspace-birth'))
    .run();
  expect(() => decision.issue()).toThrow('DELEGATION_REFUSED');
});
it('a real delegated birth is fenced by original approval expiry and runtime author replacement', async () => {
  const f = await fixture();
  f.db
    .update(workspaces)
    .set({ ownerKind: null, ownerRef: null })
    .where(eq(workspaces.id, 'workspace-birth'))
    .run();
  const decision = f.approveDelegation(),
    birth = await f.capture(decision.issue());
  f.db
    .update(approvals)
    .set({ expiresAt: new Date(0).toISOString() })
    .where(eq(approvals.id, decision.id))
    .run();
  expect(birth.actor()).toBe(false);
  f.db
    .update(approvals)
    .set({ expiresAt: new Date(Date.now() + 60_000).toISOString() })
    .where(eq(approvals.id, decision.id))
    .run();
  expect(birth.actor()).toBe(false); // Expiry is sticky; restoring metadata cannot revive the original grant.
  f.replace();
  expect(birth.actor()).toBe(false);
});
it('an ordinary workspace reference and copied approval context do not mint a delegation for another canonical session', async () => {
  const f = await fixture();
  f.db
    .update(workspaces)
    .set({ ownerKind: null, ownerRef: null })
    .where(eq(workspaces.id, 'workspace-birth'))
    .run();
  const decision = f.approveDelegation();
  expect(() =>
    f.delegations.issue(
      decision.input,
      decision.input,
      { ...decision.approvedContext, sessionId: 'foreign-session' },
      f.principals,
      f.authors
    )
  ).toThrow('DELEGATION_REFUSED');
  expect(() =>
    f.delegations.issue(decision.input, decision.input, f.context, f.principals, f.authors)
  ).toThrow('DELEGATION_REFUSED');
});

// These original service-issued local-install principals match production's
// canonical owner shape; no createServerPrincipal/user-claims substitution.
it('maps a genuine local-install Codex turn into the current account author without changing stored connector authority', async () => {
  const f = await fixture('codex', 'local_install');
  const birth = await f.capture();
  const principal = f.context.serverPrincipal;
  expect(principal.claims.kind).toBe('runtime');
  if (principal.claims.kind !== 'runtime') throw new Error('RUNTIME_PRINCIPAL_REQUIRED');
  expect(principal.claims.owner).toEqual({
    kind: 'local_install',
    installationId: 'installation-birth',
  });
  const row = f.db
    .select()
    .from(connectorRuntimeBindings)
    .where(eq(connectorRuntimeBindings.id, principal.claims.bindingId))
    .get();
  expect(row?.ownerKind).toBe('local_install');
  expect(row?.ownerId).toBe('installation-birth');
  expect(birth.accountId).toBe('owner-birth');
  expect(birth.actor.ownerId).toBe(f.authors.bindOwner('owner-birth').id);
  expect(birth.accountCurrent()).toBe(true);
  f.disableLogin();
  expect(birth.accountCurrent()).toBe(false);
  expect(birth.actor()).toBe(false);
});
it.each(['foreign-installation', 'login-off', 'missing-owner'] as const)(
  'refuses local-install browser birth for %s',
  async (reason) => {
    const f = await fixture(
      'codex',
      'local_install',
      reason === 'foreign-installation' ? 'foreign-installation' : 'installation-birth'
    );
    if (reason === 'login-off') f.disableLogin();
    if (reason === 'missing-owner') f.db.delete(user).where(eq(user.id, 'owner-birth')).run();
    const failure = await f.capture().catch((value) => value);
    f.expected.add(failure);
    expect(failure).toBeInstanceOf(Error);
  }
);
it('owner replacement during the original async principal refresh cannot publish a local-install browser owner', async () => {
  const f = await fixture('codex', 'local_install');
  let release!: (value: boolean) => void, entered!: () => void;
  const held = new Promise<boolean>((done) => {
      release = done;
    }),
    admission = new Promise<void>((done) => {
      entered = done;
    });
  f.releases.push(() => release(false));
  f.authority.revalidateTurn.mockImplementationOnce(() => {
    entered();
    return held;
  });
  const capture = f.capture();
  await admission;
  f.db.delete(user).where(eq(user.id, 'owner-birth')).run();
  f.db
    .insert(user)
    .values({
      id: 'replacement-owner-birth',
      name: 'Replacement',
      email: 'replacement@fixture.invalid',
    })
    .run();
  release(true);
  const refusal = await capture.catch((value) => value);
  f.expected.add(refusal);
  expect(refusal).toBeInstanceOf(Error);
});
it('actual consumed owner approval delegates an ordinary workspace for a local-install principal, then account loss fences it', async () => {
  const f = await fixture('codex', 'local_install');
  f.db
    .update(workspaces)
    .set({ ownerKind: null, ownerRef: null })
    .where(eq(workspaces.id, 'workspace-birth'))
    .run();
  const decision = f.approveDelegation(),
    delegation = decision.issue();
  const birth = await f.capture(delegation);
  expect(birth.actor()).toBe(true);
  f.db.delete(user).where(eq(user.id, 'owner-birth')).run();
  expect(birth.actor()).toBe(false);
});
