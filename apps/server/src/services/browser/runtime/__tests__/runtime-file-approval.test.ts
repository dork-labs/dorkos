import { createBrowserRuntimeOwnerResolution } from '../runtime-owner-resolution.js';
import { expect, it, onTestFinished } from 'vitest';
import { approvals, workspaces, roomMembers, eq } from '@dorkos/db';
import { fixture } from '../../api/__tests__/input-routes.fixture.js';
import { ApprovalService, hashApprovalInput } from '../../../core/approvals/index.js';
import { findOwnerAccount } from '../../../core/auth/accounts.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { AuthorRegistry } from '../../../rooms/author-registry.js';
import { captureRuntimeBrowserBirth } from '../runtime-birth.js';
import { createRuntimeFileApprovals } from '../runtime-file-approval.js';
import type { OwnedBrowserGrants } from '../../api/grants.js';

// Real account/approval/runtime credential/grant services; the input fixture's native engine is doubled.
async function approvedFixture(
  runtime: 'claude-code' | 'codex' | 'opencode',
  ownerKind: 'user' | 'local_install' = 'user'
) {
  const bank: {
    starting?: Promise<Awaited<ReturnType<typeof fixture>>>;
    setup?: Promise<unknown>;
    closed: boolean;
    finishing?: Promise<void>;
  } = { closed: false };
  const lifetimes: ReturnType<OwnedBrowserGrants['scopeOwner']>[] = [];
  const final = () => {
    bank.closed = true;
    return (bank.finishing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...(bank.starting ? [bank.starting] : []),
        ...(bank.setup ? [bank.setup] : []),
      ]);
      let first: Readonly<{ value: unknown }> | undefined;
      for (const result of results)
        if (result.status === 'rejected') first ??= { value: result.reason };
      for (const result of await Promise.allSettled(
        lifetimes.map((value) => Promise.resolve().then(() => value.close()))
      ))
        if (result.status === 'rejected') first ??= { value: result.reason };
      if (first) throw first.value;
    }));
  };
  onTestFinished(final);
  const starting = (bank.starting = fixture(undefined, final));
  const setup = Promise.resolve().then(async () => {
    const f = await starting;
    if (bank.closed) throw new Error('FILE_FIXTURE_CLOSED');
    const db = f.canvasScope.db,
      account = findOwnerAccount(db);
    if (!account) throw new Error('ORIGINAL_OWNER_MISSING');
    const signal = new AbortController().signal;
    const state = { active: true };
    const principals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        authorizeTurn: async () => ({
          owner:
            ownerKind === 'user'
              ? { kind: 'user' as const, userId: account.id }
              : {
                  kind: 'local_install' as const,
                  installationId: 'installation-file-original',
                },
          agentId: 'file-manifest-original',
        }),
        revalidateTurn: async () => !bank.closed && state.active,
      },
    });
    await principals.initializeBoot();
    if (bank.closed) throw new Error('FILE_FIXTURE_CLOSED');
    const path = '/fixture/file-agent';
    db.insert(workspaces)
      .values({
        id: 'file-workspace',
        projectKey: 'file-project',
        key: 'main',
        path,
        source: path,
        provider: 'clone',
        status: 'ready',
        ownerKind: 'agent',
        ownerRef: path,
        portBase: 6400,
        portBlockSize: 10,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      })
      .run();
    const turn = await principals.openTurn(
      {
        runtime,
        canonicalSessionId: 'file-session-original',
        agentPath: path,
        canonicalCwd: path,
        signal,
      },
      { isCurrent: () => !bank.closed && state.active }
    );
    if (bank.closed) throw new Error('FILE_FIXTURE_CLOSED');
    const resolved = await principals.resolve({
      bearer: turn.bearer,
      expectedRuntime: runtime,
      expectedCanonicalCwd: path,
    });
    if (bank.closed || resolved.status !== 'resolved')
      throw new Error('ORIGINAL_PRINCIPAL_MISSING');
    const authors = new AuthorRegistry(db, {
      byPath: () => ({
        id: 'file-manifest-original',
        name: 'File Agent',
        displayName: 'File Agent',
        responseMode: 'always',
        emoji: null,
        color: null,
      }),
    });
    const context = {
      serverPrincipal: resolved.principal,
      identity: {
        agentPath: path,
        displayName: 'File Agent',
        createdAt: new Date().toISOString(),
      },
      sessionId: 'file-session-original',
      signal,
    };
    const birth = await captureRuntimeBrowserBirth({
      db,
      principals,
      authors,
      context,
      owners: createBrowserRuntimeOwnerResolution({
        db,
        authors,
        installationId: 'installation-file-original',
        enabled: () => !bank.closed,
      }),
      enabled: () => !bank.closed,
    });
    if (bank.closed) throw new Error('FILE_FIXTURE_CLOSED');
    db.insert(roomMembers)
      .values({
        roomId: f.canvasScope.roomId,
        authorId: birth.recipientId,
        responseMode: 'always',
        joinedAt: new Date().toISOString(),
      })
      .run();
    const fileApproval = createRuntimeFileApprovals({
      db,
      enabled: () => !bank.closed,
      refuse: () => new Error('FILE_PERMISSION_REFUSED'),
      subject: () => ({
        birth,
        current: () => !bank.closed && birth.actor(),
        issue(binding, permissions, expiresAt, approvalCurrent) {
          if (bank.closed) throw new Error('FILE_FIXTURE_CLOSED');
          const original = f.grants.scopeOwner(approvalCurrent);
          lifetimes.push(original);
          return original.issue(
            f.ownerAuth.current,
            binding,
            birth.recipientId,
            { kind: 'room', roomId: f.canvasScope.roomId },
            permissions,
            expiresAt
          );
        },
      }),
    });
    const decision = (operation: 'upload' | 'download') => {
      const input = {
        binding: f.seat.binding,
        sessionId: birth.sessionId,
        operation,
      };
      const change = fileApproval.describe(input);
      const service = new ApprovalService(db);
      const binding = {
        capabilityId: 'browser.file_access',
        inputHash: hashApprovalInput({ input, change }),
      };
      const ticket = service.request({
        ...binding,
        summary: 'Allow this file transfer',
        requestedBy: 'File Agent',
        requestedByPath: path,
        requestingSession: { sessionId: birth.sessionId, cwd: path },
      });
      if (service.grant(ticket.approvalId, account.id)) throw new Error('APPROVAL_FAILED');
      const consumed = service.consume(ticket.token, binding);
      if (consumed.outcome !== 'granted') throw new Error('APPROVAL_FAILED');
      return {
        input,
        id: ticket.approvalId,
        context: {
          ...context,
          approvedChange: change,
          approval: {
            via: 'approval' as const,
            approvalId: consumed.approvalId,
            decidedByUserId: consumed.decidedByUserId,
          },
        },
      };
    };
    const credential = Object.freeze({});
    return {
      f,
      db,
      birth,
      state,
      fileApproval,
      decision,
      reader: () => (birth.actor() ? { owner: birth.recipientId, credential } : undefined),
    };
  });
  bank.setup = setup;
  return setup;
}

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'consumes an actual owner decision for %s and revokes later original file grant admission without granting control',
  async (runtime) => {
    const h = await approvedFixture(runtime),
      decision = h.decision('upload');
    const grant = h.fileApproval.issue(decision.input, decision.context);
    expect(grant.permissions).toEqual(['browser.artifact', 'browser.upload']);
    expect(() =>
      h.f.grants.admit(
        h.reader,
        grant.grantId,
        grant.grantRevision,
        h.f.seat.binding,
        'browser.upload'
      )
    ).not.toThrow();
    expect(() =>
      h.f.grants.admit(
        h.reader,
        grant.grantId,
        grant.grantRevision,
        h.f.seat.binding,
        'browser.control'
      )
    ).toThrow();
    expect(() => h.fileApproval.issue(decision.input, decision.context)).toThrow(
      'FILE_PERMISSION_REFUSED'
    );
    h.db.update(approvals).set({ state: 'denied' }).where(eq(approvals.id, decision.id)).run();
    expect(() =>
      h.f.grants.admit(
        h.reader,
        grant.grantId,
        grant.grantRevision,
        h.f.seat.binding,
        'browser.upload'
      )
    ).toThrow();
  }
);

it('an approval for download cannot be substituted for upload or another current task', async () => {
  const h = await approvedFixture('claude-code'),
    decision = h.decision('download');
  expect(() =>
    h.fileApproval.issue({ ...decision.input, operation: 'upload' }, decision.context)
  ).toThrow('FILE_PERMISSION_REFUSED');
  const next = h.decision('download');
  expect(() =>
    h.fileApproval.issue({ ...next.input, sessionId: 'foreign-task' }, next.context)
  ).toThrow('FILE_PERMISSION_REFUSED');
});

it('the original agent turn and owner decision expiry independently fence later real file grant admission', async () => {
  const h = await approvedFixture('codex'),
    decision = h.decision('download');
  const issued = h.fileApproval.issue(decision.input, decision.context);
  h.db
    .update(approvals)
    .set({ expiresAt: new Date(0).toISOString() })
    .where(eq(approvals.id, decision.id))
    .run();
  expect(() =>
    h.f.grants.admit(
      h.reader,
      issued.grantId,
      issued.grantRevision,
      h.f.seat.binding,
      'browser.download'
    )
  ).toThrow();
  const next = h.decision('upload');
  h.state.active = false;
  expect(() => h.fileApproval.issue(next.input, next.context)).toThrow('FILE_PERMISSION_REFUSED');
});

it('a real consumed owner file approval qualifies the unchanged local-install Codex authority and still rejects a foreign owner decision', async () => {
  const h = await approvedFixture('codex', 'local_install');
  const decision = h.decision('download');
  const issued = h.fileApproval.issue(decision.input, decision.context);
  expect(issued.permissions).toContain('browser.download');
  const other = h.decision('upload');
  expect(() =>
    h.fileApproval.issue(other.input, {
      ...other.context,
      approval: {
        ...other.context.approval!,
        decidedByUserId: 'foreign-owner',
      },
    })
  ).toThrow('FILE_PERMISSION_REFUSED');
});
