import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import { openConnectorTurn, type OpenConnectorTurnRequest } from '../open-connector-turn.js';

import { liveTurnFixture } from '../../../connectors/principal/__tests__/runtime-tool-turn.fixture.js';
import { clearTestHomes } from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import {
  ConnectorRuntimeAuthorityError,
  RuntimeToolContextUnavailableError,
} from '@dorkos/shared/connections-lease';

const BINDING = {
  bindingId: 'binding-1',
  bearer: 'secret',
  expiresAt: '2099-01-01T00:00:00.000Z',
  renewalPermit: {} as never,
};

function tools(openTurn: ConnectorRuntimeTools['principals']['openTurn']) {
  const principals = { openTurn, renew: vi.fn(), resolve: vi.fn(), revoke: vi.fn() };
  return {
    principals: principals as unknown as ConnectorRuntimeTools['principals'],
    revoke: principals.revoke,
    listenerUrl: 'http://127.0.0.1:4341/mcp',
    agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
    isConnectorCapabilityId: () => false,
    createLeaseSupervisor: vi.fn(() => ({
      state: 'active' as const,
      stop: vi.fn(),
      assertUsable: vi.fn(),
    })),
  };
}

function request(overrides: Partial<OpenConnectorTurnRequest> = {}): OpenConnectorTurnRequest {
  return {
    runtime: 'codex',
    sessionId: 's1',
    agentPath: '/agents/a',
    cwd: '/agents/a',
    signal: new AbortController().signal,
    isCurrent: () => true,
    onLost: vi.fn(),
    ...overrides,
  };
}

const unrecorded = () =>
  new ConnectorRuntimeAuthorityError('agent_unrecorded', 'no recorded agent');

describe('openConnectorTurn (DOR-2752)', () => {
  it('opens the binding, its lease and the MCP injection', async () => {
    const t = tools(vi.fn().mockResolvedValue(BINDING));
    const opened = await openConnectorTurn(t, request());
    expect(opened?.binding).toBe(BINDING);
    expect(opened?.injection.url).toBe(t.listenerUrl);
    expect(t.createLeaseSupervisor).toHaveBeenCalledOnce();
  });

  it('returns null when the chat has no recorded agent', async () => {
    const t = tools(vi.fn().mockRejectedValue(unrecorded()));
    await expect(openConnectorTurn(t, request())).resolves.toBeNull();
  });

  it('still throws any other refusal, such as a real authority failure', async () => {
    const refused = new ConnectorRuntimeAuthorityError('authority_refused', 'not confirmed');
    const t = tools(vi.fn().mockRejectedValue(refused));
    await expect(openConnectorTurn(t, request())).rejects.toBe(refused);
  });

  it('still throws when a newer turn replaced this one', async () => {
    const t = tools(vi.fn().mockRejectedValue(unrecorded()));
    await expect(openConnectorTurn(t, request({ isCurrent: () => false }))).rejects.toThrow(
      ConnectorRuntimeAuthorityError
    );
  });

  it('still throws when the turn was cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const t = tools(vi.fn().mockRejectedValue(unrecorded()));
    await expect(openConnectorTurn(t, request({ signal: controller.signal }))).rejects.toThrow(
      'cancelled'
    );
  });

  it('still throws any other failure', async () => {
    const t = tools(vi.fn().mockRejectedValue(new Error('database is locked')));
    await expect(openConnectorTurn(t, request())).rejects.toThrow('database is locked');
  });

  it('revokes the binding when the lease cannot be set up', async () => {
    const t = tools(vi.fn().mockResolvedValue(BINDING));
    t.createLeaseSupervisor.mockImplementationOnce(() => {
      throw new Error('no lease');
    });
    await expect(openConnectorTurn(t, request())).rejects.toThrow('no lease');
    expect(t.revoke).toHaveBeenCalledWith('binding-1', 'setup_failed');
  });
});

// Cross the helper into actual SQLite bindings and canonical live authority.
describe('openConnectorTurn live tool ownership', () => {
  const fixtures: Awaited<ReturnType<typeof liveTurnFixture>>[] = [];
  afterEach(() => {
    for (const f of fixtures.splice(0)) f.db.$client.close();
    clearTestHomes();
    vi.restoreAllMocks();
  });

  async function open(readTools: boolean) {
    const f = await liveTurnFixture();
    fixtures.push(f);
    const readToolTurn = vi.fn(() => f.facts);
    const openTurn = vi.spyOn(f.service, 'openTurn');
    const t = { ...tools(openTurn), principals: f.service };
    const opened = await openConnectorTurn(
      t,
      request({
        runtime: f.input.runtime,
        sessionId: f.input.canonicalSessionId,
        agentPath: f.home,
        cwd: f.input.canonicalCwd,
        signal: f.abort.signal,
        isCurrent: f.ownership.isCurrent,
        ...(readTools ? { readToolTurn } : {}),
      })
    );
    expect(opened).not.toBeNull();
    expect(readToolTurn).not.toHaveBeenCalled();
    const resolved = await f.service.resolve({
      bearer: opened!.binding.bearer,
      expectedRuntime: f.input.runtime,
      expectedCanonicalCwd: f.input.canonicalCwd,
    });
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('Expected current helper principal');
    return { f, opened: opened!, principal: resolved.principal, readToolTurn, openTurn };
  }

  it('forwards the unchanged callback and reads fresh facts only after open', async () => {
    const { f, principal, readToolTurn, openTurn } = await open(true);
    // The old helper drops the callback and fails this actual caller lookup.
    await expect(f.service.resolveToolTurn(principal)).resolves.toMatchObject({
      sessionId: f.input.canonicalSessionId,
      agentHome: f.home,
      workingDirectory: f.input.canonicalCwd,
    });
    expect(openTurn.mock.calls[0][1].readToolTurn).toBe(readToolTurn);
    const caller = await f.service.resolveToolTurn(principal);
    expect(caller.read()).toBe(f.facts);
    const session = { eventQueue: [], eventQueueNotify: vi.fn() };
    f.facts = { ...f.facts!, effectiveMode: 'default', chosenMode: 'full', session };
    expect(caller.read()).toBe(f.facts);
    expect(caller.read().session).toBe(session);
    expect(caller.read().signal).toBe(f.abort.signal);
    f.setCurrent(false);
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    await expect(caller.assertCurrent()).rejects.toBeInstanceOf(RuntimeToolContextUnavailableError);
  });

  it('keeps a legacy connection owner usable without manufacturing tool facts', async () => {
    const { f, principal, opened, readToolTurn } = await open(false);
    expect(f.service.isPrincipalCurrent(principal)).toBe(true);
    await expect(
      f.service.renew({
        bindingId: opened.binding.bindingId,
        permit: opened.binding.renewalPermit,
      })
    ).resolves.toMatchObject({ status: 'renewed' });
    await expect(f.service.resolveToolTurn(principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
    expect(readToolTurn).not.toHaveBeenCalled();
  });

  it('retires a legacy helper binding on close without restoring tool authority', async () => {
    const { f, principal, opened } = await open(false);
    expect(f.service.isPrincipalCurrent(principal)).toBe(true);
    await f.service.revoke(opened.binding.bindingId, 'turn_terminal');
    expect(f.service.isPrincipalCurrent(principal)).toBe(false);
    await expect(f.service.resolveToolTurn(principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
  });
});
