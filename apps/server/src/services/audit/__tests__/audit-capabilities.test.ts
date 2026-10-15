/**
 * The audit domain (spec `audit-trail`): one declaration per capability,
 * projected onto both MCP servers, the CLI and HTTP, read under one rule.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { composeRegistry } from '../../core/capabilities/registry.js';
import { AuditLog } from '../audit-log.js';
import { auditDomain } from '../audit-capabilities.js';
import { AccountIds } from '../account-ids.js';
import type { SessionVisibility } from '../session-visibility.js';
import type { AuditQueryResult, TranscriptPage } from '@dorkos/shared/audit-schemas';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

describe('audit.verify', () => {
  it('is an observe capability on both MCP servers and GET /api/audit/verify', () => {
    const [capability] = auditDomain.capabilities;
    expect(capability).toMatchObject({
      id: 'audit.verify',
      tier: 'observe',
      area: null,
      surfaces: {
        mcp: { toolName: 'audit_verify', servers: ['in-session', 'external'] },
        http: { method: 'get', path: '/api/audit/verify' },
      },
    });
  });

  it('walks the real chain through the registry', async () => {
    const log = new AuditLog(createTestDb());
    log.record({
      actor: { accountId: 'system', kind: 'system', name: 'DorkOS' },
      source: { surface: 'system' },
      action: 'system.started',
      operation: 'execute',
      outcome: 'ok',
      summary: 'DorkOS started',
    });
    const registry = composeRegistry([auditDomain], { logger: LOGGER, auditDeps: { log } });
    await expect(registry.invoke('audit.verify', {}, {})).resolves.toMatchObject({
      ok: true,
      checked: 1,
      lastSeq: 1,
    });
  });
});

describe('the audit read capabilities', () => {
  const RESEARCHER = {
    agentPath: '/projects/researcher',
    displayName: 'Researcher',
    createdAt: '',
  };

  /** A log with one row of each visibility, and a registry over it. */
  function setup() {
    const db = createTestDb();
    const log = new AuditLog(db);
    const accounts = new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null });
    const lookups: string[][] = [];
    const base = {
      actor: { accountId: 'install:inst-1', kind: 'person' as const, name: 'Owner' },
      operation: 'execute' as const,
      outcome: 'ok' as const,
    };
    log.record({
      ...base,
      source: { surface: 'app', sessionId: 'run-1' },
      action: 'config.changed',
      summary: 'Changed a setting',
    });
    log.record({
      ...base,
      source: { surface: 'http', ip: '10.0.0.1' },
      action: 'auth.signed_in',
      summary: 'Signed in',
      visibility: 'admins',
    });
    const transcripts: Record<string, TranscriptPage> = {
      'run-1': { total: 1, messages: [{ id: 'm1', role: 'assistant', content: 'Ran the report' }] },
      'chat-1': { total: 1, messages: [{ id: 'm2', role: 'user', content: 'thinking aloud' }] },
    };
    const registry = composeRegistry([auditDomain], {
      logger: LOGGER,
      auditDeps: {
        log,
        accounts,
        sessionVisibilities: (ids) => {
          lookups.push([...ids]);
          const known: Record<string, SessionVisibility> = {
            'run-1': 'space',
            'chat-1': 'participants',
          };
          return new Map(ids.filter((id) => id in known).map((id) => [id, known[id]!]));
        },
        readTranscript: async (id) => transcripts[id],
      },
    });
    return { log, registry, lookups };
  }

  const ofAgent = { identity: RESEARCHER, mcpServer: 'in-session' as const, sessionId: 's' };

  it('are observe capabilities with no area on both MCP servers', () => {
    const byId = Object.fromEntries(auditDomain.capabilities.map((c) => [c.id, c]));
    for (const [id, toolName] of [
      ['audit.query', 'audit_query'],
      ['audit.get', 'audit_get'],
      ['audit.account_timeline', 'account_timeline'],
      ['audit.transcript_read', 'transcript_read'],
    ] as const) {
      expect(byId[id]).toMatchObject({
        tier: 'observe',
        area: null,
        surfaces: { mcp: { toolName, servers: ['in-session', 'external'] } },
      });
    }
  });

  it('never show an agent an admins row; the owner sees it', async () => {
    const { registry } = setup();
    const asAgent = (await registry.invoke('audit.query', {}, ofAgent)) as AuditQueryResult;
    expect(asAgent.events.map((e) => e.action)).toEqual(['config.changed']);
    const unidentified = (await registry.invoke(
      'audit.query',
      {},
      { agentIdentityPresented: true }
    )) as AuditQueryResult;
    expect(unidentified.events.map((e) => e.action)).toEqual(['config.changed']);
    const asOwner = (await registry.invoke('audit.query', {}, {})) as AuditQueryResult;
    expect(asOwner.events.map((e) => e.action)).toEqual(['auth.signed_in', 'config.changed']);
  });

  it('refuse an agent an admins row by id as not found', async () => {
    const { registry, log } = setup();
    const admins = log.query({ action: 'auth.', limit: 1 }, { kind: 'owner' }).events[0]!;
    await expect(registry.invoke('audit.get', { id: admins.id }, ofAgent)).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND' },
    });
    await expect(registry.invoke('audit.get', { id: admins.id }, {})).resolves.toMatchObject({
      event: { action: 'auth.signed_in' },
    });
  });

  it('resolve an event’s session and whether the reader may read it', async () => {
    const { registry, log } = setup();
    const row = log.query({ action: 'config.', limit: 1 }, { kind: 'owner' }).events[0]!;
    await expect(registry.invoke('audit.get', { id: row.id }, ofAgent)).resolves.toMatchObject({
      event: { id: row.id },
      session: { id: 'run-1', readable: true },
    });
  });

  it('never confirm to an agent that a person’s own chat exists', async () => {
    const { registry, log } = setup();
    log.record({
      actor: { accountId: 'agent-1', kind: 'agent', name: 'Researcher' },
      source: { surface: 'runtime-tool', sessionId: 'chat-1', turnId: 't1', toolCallId: 'c1' },
      action: 'runtime.tool_used',
      operation: 'execute',
      outcome: 'ok',
      summary: 'Ran a tool',
    });
    const inChat = log.query({ action: 'runtime.', limit: 1 }, { kind: 'owner' }).events[0]!;

    // The action is shown; where it happened is not.
    const page = (await registry.invoke('audit.query', {}, ofAgent)) as AuditQueryResult;
    const seen = page.events.find((e) => e.id === inChat.id)!;
    expect(seen.source).toEqual({ surface: 'runtime-tool' });
    expect(page.events.find((e) => e.action === 'config.changed')!.source.sessionId).toBe('run-1');
    const one = await registry.invoke('audit.get', { id: inChat.id }, ofAgent);
    expect(one).not.toHaveProperty('session');
    expect((one as { event: { source: object } }).event.source).toEqual({
      surface: 'runtime-tool',
    });

    // A filter on the private chat answers like a chat that does not exist.
    for (const sessionId of ['chat-1', 'nobody']) {
      await expect(registry.invoke('audit.query', { sessionId }, ofAgent)).resolves.toEqual({
        events: [],
      });
      await expect(
        registry.invoke('audit.account_timeline', { accountId: 'agent-1', sessionId }, ofAgent)
      ).resolves.toEqual({ events: [] });
    }

    // The owner sees all of it.
    const forOwner = (await registry.invoke(
      'audit.query',
      { sessionId: 'chat-1' },
      {}
    )) as AuditQueryResult;
    expect(forOwner.events[0]!.source).toMatchObject({ sessionId: 'chat-1', turnId: 't1' });
    await expect(registry.invoke('audit.get', { id: inChat.id }, {})).resolves.toMatchObject({
      session: { id: 'chat-1', readable: true },
    });
  });

  it('hide a person’s own chat when it is what a row acted on', async () => {
    const { registry, log } = setup();
    log.record({
      actor: { accountId: 'agent-1', kind: 'agent', name: 'Researcher' },
      source: { surface: 'mcp' },
      action: 'chat.stopped',
      operation: 'execute',
      target: { type: 'session', id: 'chat-1', name: 'My private plans' },
      outcome: 'ok',
      summary: 'Stopped a chat',
    });
    const row = log.query({ action: 'chat.', limit: 1 }, { kind: 'owner' }).events[0]!;

    const page = (await registry.invoke('audit.query', {}, ofAgent)) as AuditQueryResult;
    expect(page.events.find((e) => e.id === row.id)!.target).toBeNull();
    const one = (await registry.invoke('audit.get', { id: row.id }, ofAgent)) as {
      event: { target: unknown };
    };
    expect(one.event.target).toBeNull();
    // Filtering on the private chat as a target matches nothing.
    await expect(registry.invoke('audit.query', { targetId: 'chat-1' }, ofAgent)).resolves.toEqual({
      events: [],
    });
    // Not even by a cursor that says more rows matched further back.
    log.record({
      actor: { accountId: 'agent-1', kind: 'agent', name: 'Researcher' },
      source: { surface: 'mcp' },
      action: 'chat.stopped',
      operation: 'execute',
      target: { type: 'session', id: 'chat-1', name: 'My private plans' },
      outcome: 'ok',
      summary: 'Stopped a chat',
    });
    await expect(
      registry.invoke('audit.query', { targetId: 'chat-1', limit: 1 }, ofAgent)
    ).resolves.toEqual({ events: [] });

    // The owner sees it whole.
    const forOwner = (await registry.invoke(
      'audit.query',
      { targetId: 'chat-1' },
      {}
    )) as AuditQueryResult;
    expect(forOwner.events[0]!.target).toMatchObject({ id: 'chat-1', name: 'My private plans' });
  });

  it('look up every session on a page at once', async () => {
    const { registry, log, lookups } = setup();
    for (const sessionId of ['chat-1', 'run-2', 'run-3']) {
      log.record({
        actor: { accountId: 'agent-1', kind: 'agent', name: 'Researcher' },
        source: { surface: 'mcp', sessionId },
        action: 'chat.sent',
        operation: 'execute',
        outcome: 'ok',
        summary: 'Sent a message',
      });
    }
    await registry.invoke('audit.query', {}, ofAgent);
    expect(lookups).toHaveLength(1);
    expect([...lookups[0]!].sort()).toEqual(['chat-1', 'run-1', 'run-2', 'run-3']);
  });

  it('let an agent read agent work and refuse a person’s own chat as TRANSCRIPT_PRIVATE', async () => {
    const { registry } = setup();
    await expect(
      registry.invoke('audit.transcript_read', { sessionId: 'run-1' }, ofAgent)
    ).resolves.toMatchObject({ total: 1, messages: [{ content: 'Ran the report' }] });
    await expect(
      registry.invoke('audit.transcript_read', { sessionId: 'chat-1' }, ofAgent)
    ).rejects.toMatchObject({ payload: { code: 'TRANSCRIPT_PRIVATE' } });
    // An unknown session is private too, so a refusal confirms nothing.
    await expect(
      registry.invoke('audit.transcript_read', { sessionId: 'nobody' }, ofAgent)
    ).rejects.toMatchObject({ payload: { code: 'TRANSCRIPT_PRIVATE' } });
    await expect(
      registry.invoke('audit.transcript_read', { sessionId: 'chat-1' }, {})
    ).resolves.toMatchObject({ total: 1 });
  });

  it('join an account’s ids only through a link the reader may read', async () => {
    const { registry, log } = setup();
    log.record({
      actor: { accountId: 'user-9', kind: 'person', name: 'Owner' },
      source: { surface: 'system' },
      action: 'account.linked',
      operation: 'modify',
      outcome: 'ok',
      change: [{ field: 'accountId', before: 'install:inst-1', after: 'user-9' }],
      summary: 'Made an account',
      visibility: 'admins',
    });
    const forAgent = (await registry.invoke(
      'audit.account_timeline',
      { accountId: 'user-9' },
      ofAgent
    )) as AuditQueryResult;
    expect(forAgent.events).toEqual([]);
    const forOwner = (await registry.invoke(
      'audit.account_timeline',
      { accountId: 'user-9' },
      {}
    )) as AuditQueryResult;
    expect(forOwner.events.map((e) => e.action)).toEqual([
      'account.linked',
      'auth.signed_in',
      'config.changed',
    ]);
  });

  it('read one account’s timeline under both of its ids', async () => {
    const { registry, log } = setup();
    log.record({
      actor: { accountId: 'user-9', kind: 'person', name: 'Owner' },
      source: { surface: 'system' },
      action: 'account.linked',
      operation: 'modify',
      outcome: 'ok',
      change: [{ field: 'accountId', before: 'install:inst-1', after: 'user-9' }],
      summary: 'Made an account',
    });
    const timeline = (await registry.invoke(
      'audit.account_timeline',
      { accountId: 'user-9' },
      ofAgent
    )) as AuditQueryResult;
    expect(timeline.events.map((e) => e.action)).toEqual(['account.linked', 'config.changed']);
  });
});
