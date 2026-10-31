/** Lifecycle unit ports only; none of these mock tool results is server acceptance evidence. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocChannelStore } from '../../../../canvas/doc-channel/store.js';
import type { ConnectorRuntimeTools } from '../../../connector-tools.js';
import type { ConnectorTurnLeaseSupervisorOptions } from '../../../connectors/connector-turn-lease-supervisor.js';
const wire = vi.hoisted(() => ({ connect: vi.fn(), call: vi.fn(), close: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = wire.connect;
    callTool = wire.call;
    close = wire.close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(
      readonly url: URL,
      readonly options: unknown
    ) {}
  },
}));
import { createDocFrameSdkProbe, type DocFrameSdkProbeInput } from '../doc-frame-sdk-probe.js';
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const mcp = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function fixture(enabled = true) {
  let lease: ConnectorTurnLeaseSupervisorOptions | undefined;
  const permit = Object.freeze({}) as never;
  const principals: ConnectorRuntimeTools['principals'] = {
    openTurn: vi.fn(async () => ({
      bindingId: 'binding',
      bearer: 'private-unit-bearer',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      renewalPermit: permit,
    })),
    resolve: vi.fn(),
    renew: vi.fn(),
    revoke: vi.fn(async () => {}),
  };
  const supervisor = { state: 'active' as const, stop: vi.fn(), assertUsable: vi.fn() };
  const createLeaseSupervisor = vi.fn((options: ConnectorTurnLeaseSupervisorOptions) => {
    lease = options;
    return supervisor;
  });
  const tools: ConnectorRuntimeTools = {
    principals,
    listenerUrl: 'http://127.0.0.1:1/mcp',
    agentToolsUrl: 'http://127.0.0.1:1/agent-mcp',
    isConnectorCapabilityId: () => false,
    createLeaseSupervisor,
  };
  // A lifecycle-port row, not a persisted grant or proof of actual authorization.
  const getGrant = vi.fn(
    () =>
      ({
        documentId: 'doc',
        routeId: 'fixture-log',
        normalizedRoute: {
          id: 'fixture-log',
          on: 'fixture.changed',
          to: 'log',
          turn: { mode: 'none' },
        },
        approvalId: null,
        approvalEvidence: { kind: 'verified_opener' },
        allowedTypes: ['fixture.changed'],
      }) as ReturnType<DocChannelStore['getGrant']>
  );
  const bindProbeSession = vi.fn(async () => {});
  const run = createDocFrameSdkProbe({
    enabled,
    tools,
    channels: { getGrant },
    bindProbeSession,
  });
  const controller = new AbortController(),
    ready = held<void>(),
    browser = held<void>();
  const onReady = vi.fn(() => ready.resolve());
  const input: DocFrameSdkProbeInput = {
    sessionId: 'chat',
    agentPath: '/agent',
    sourcePath: '/agent/fixture.html',
    signal: controller.signal,
    onReady,
    waitForBrowser: () => browser.promise,
  };
  return {
    run,
    input,
    principals,
    tools,
    supervisor,
    createLeaseSupervisor,
    permit,
    getGrant,
    bindProbeSession,
    controller,
    ready,
    browser,
    onReady,
    lease: () => lease,
  };
}
beforeEach(() => {
  wire.connect.mockReset().mockResolvedValue(undefined);
  wire.close.mockReset().mockResolvedValue(undefined);
  wire.call
    .mockReset()
    .mockImplementation(async ({ name }: { name: string }) =>
      mcp(
        name === 'control_ui'
          ? { success: true, documentId: 'doc' }
          : name === 'configure_doc_channel'
            ? { configured: true }
            : { kind: 'granted', grantId: 'grant' }
      )
    );
});
describe('fixed original-boot Doc SDK workflow lifecycle', () => {
  it('refuses disabled test runtime before persisting a session, opening or connecting', async () => {
    const f = fixture(false);
    await expect(f.run(f.input)).rejects.toThrow('disabled');
    expect(f.bindProbeSession).not.toHaveBeenCalled();
    expect(f.principals.openTurn).not.toHaveBeenCalled();
    expect(wire.connect).not.toHaveBeenCalled();
  });
  it('keeps one binding, original supervisor and client across exactly three fixed tools and the browser step', async () => {
    const f = fixture(),
      work = f.run(f.input);
    await f.ready.promise;
    expect(f.principals.openTurn).toHaveBeenCalledTimes(1);
    expect(wire.connect).toHaveBeenCalledTimes(1);
    expect(f.createLeaseSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        principals: f.principals,
        bindingId: 'binding',
        permit: f.permit,
        runtime: 'claude-code',
      })
    );
    expect(wire.call.mock.calls.map(([call]) => call.name)).toEqual([
      'control_ui',
      'configure_doc_channel',
      'approve_doc_route',
    ]);
    expect(wire.call.mock.calls[1][0].arguments.channel.routes).toEqual([
      { id: 'fixture-log', on: 'fixture.changed', to: 'log', turn: { mode: 'none' } },
    ]);
    expect(wire.call.mock.calls[2][0].arguments.allowedTypes).toEqual(['fixture.changed']);
    expect(f.onReady).toHaveBeenCalledWith({
      documentId: 'doc',
      eventType: 'fixture.changed',
      grantEvidence: 'verified_opener',
    });
    expect(JSON.stringify(f.onReady.mock.calls)).not.toContain('private-unit-bearer');
    expect(f.principals.revoke).not.toHaveBeenCalled();
    f.browser.resolve();
    await work;
    expect(wire.close).toHaveBeenCalledTimes(1);
    expect(f.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(f.principals.revoke).toHaveBeenCalledWith('binding', 'turn_terminal');
  });
  it('stops on an actual approval_required result without deciding, retrying or publishing its token', async () => {
    wire.call.mockImplementation(async ({ name }: { name: string }) =>
      mcp(
        name === 'control_ui'
          ? { success: true, documentId: 'doc' }
          : name === 'configure_doc_channel'
            ? { configured: true }
            : { kind: 'approval_required', ticket: { token: 'private-approval-token' } }
      )
    );
    const f = fixture();
    await expect(f.run(f.input)).rejects.toThrow('fixed Doc SDK workflow');
    expect(wire.call).toHaveBeenCalledTimes(3);
    expect(f.onReady).not.toHaveBeenCalled();
    expect(f.principals.revoke).toHaveBeenCalledWith('binding', 'setup_failed');
  });
  it('sanitizes a refused tool response and still revokes its original binding', async () => {
    wire.call.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'private-unit-bearer' }],
    });
    const f = fixture();
    await expect(f.run(f.input)).rejects.toThrow('The fixed Doc SDK workflow did not complete.');
    expect(f.onReady).not.toHaveBeenCalled();
    expect(f.principals.revoke).toHaveBeenCalledWith('binding', 'setup_failed');
  });
  it('aborts a held browser step and revokes once without requiring that step to resolve', async () => {
    const f = fixture(),
      work = f.run(f.input);
    const outcome = expect(work).rejects.toThrow('cancelled by owner');
    await f.ready.promise;
    f.controller.abort(new Error('cancelled by owner'));
    await outcome;
    expect(f.principals.revoke).toHaveBeenCalledTimes(1);
    expect(f.principals.revoke).toHaveBeenCalledWith('binding', 'turn_cancelled');
  });
  it('closes a replaced same-session workflow before the new managed binding opens', async () => {
    const f = fixture(),
      first = f.run(f.input);
    const firstOutcome = expect(first).rejects.toThrow('did not complete');
    await f.ready.promise;
    const ready = held<void>(),
      finish = held<void>();
    const second = f.run({
      ...f.input,
      onReady: () => ready.resolve(),
      waitForBrowser: () => finish.promise,
    });
    await firstOutcome;
    await ready.promise;
    expect(f.principals.openTurn).toHaveBeenCalledTimes(2);
    expect(f.principals.revoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.principals.revoke).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.principals.openTurn).mock.invocationCallOrder[1]
    );
    finish.resolve();
    await second;
    expect(f.principals.revoke).toHaveBeenCalledTimes(2);
  });
  it('ends the held workflow when the original lease supervisor reports loss', async () => {
    const f = fixture(),
      work = f.run(f.input);
    const outcome = expect(work).rejects.toThrow('did not complete');
    await f.ready.promise;
    f.lease()!.onLost!({
      bindingId: 'binding',
      runtime: 'claude-code',
      reason: 'expired',
      expiresAt: new Date().toISOString(),
      at: new Date().toISOString(),
    });
    await outcome;
    expect(f.principals.revoke).toHaveBeenCalledWith('binding', 'turn_cancelled');
  });
  it('does not invent a fallback when original authority refuses to open the turn', async () => {
    const f = fixture();
    vi.mocked(f.principals.openTurn).mockRejectedValue(new Error('authority refused'));
    await expect(f.run(f.input)).rejects.toThrow('did not complete');
    expect(wire.connect).not.toHaveBeenCalled();
    expect(wire.call).not.toHaveBeenCalled();
  });
  it('closes and revokes after a transport connection failure', async () => {
    const f = fixture();
    wire.connect.mockRejectedValue(new Error('private-unit-bearer'));
    await expect(f.run(f.input)).rejects.toThrow('did not complete');
    expect(wire.close).toHaveBeenCalledTimes(1);
    expect(f.principals.revoke).toHaveBeenCalledWith('binding', 'setup_failed');
  });
  it('retains cleanup failure as a safe failure rather than reporting successful completion', async () => {
    const f = fixture(),
      work = f.run(f.input);
    const outcome = expect(work).rejects.toThrow('could not confirm managed-turn cleanup');
    await f.ready.promise;
    vi.mocked(f.principals.revoke).mockRejectedValue(new Error('private-unit-bearer'));
    f.browser.resolve();
    await outcome;
  });
  it('does not label operator or mismatched stored evidence as verified-opener readiness', async () => {
    const f = fixture();
    f.getGrant.mockReturnValue(undefined);
    await expect(f.run(f.input)).rejects.toThrow('did not complete');
    expect(f.onReady).not.toHaveBeenCalled();
    expect(f.principals.revoke).toHaveBeenCalledWith('binding', 'setup_failed');
  });
});

it('observes a caller abort triggered reentrantly while replacing the old workflow', async () => {
  const f = fixture(),
    first = f.run(f.input);
  const oldOutcome = expect(first).rejects.toThrow('did not complete');
  await f.ready.promise;
  const next = new AbortController();
  const oldSignal = vi.mocked(f.principals.openTurn).mock.calls[0][0].signal;
  oldSignal.addEventListener('abort', () => next.abort(new Error('replacement caller cancelled')), {
    once: true,
  });
  await expect(f.run({ ...f.input, signal: next.signal })).rejects.toThrow(
    'replacement caller cancelled'
  );
  await oldOutcome;
  expect(f.principals.openTurn).toHaveBeenCalledTimes(1);
});

it('still closes, revokes and settles replacement ownership when supervisor.stop throws', async () => {
  const f = fixture(),
    first = f.run(f.input);
  const failed = expect(first).rejects.toThrow('could not confirm managed-turn cleanup');
  await f.ready.promise;
  f.supervisor.stop.mockImplementationOnce(() => {
    throw new Error('scheduler clear failed');
  });
  f.browser.resolve();
  await failed;
  expect(wire.close).toHaveBeenCalledTimes(1);
  expect(f.principals.revoke).toHaveBeenCalledTimes(1);
  const ready = held<void>(),
    finish = held<void>();
  const next = f.run({
    ...f.input,
    onReady: () => ready.resolve(),
    waitForBrowser: () => finish.promise,
  });
  await ready.promise;
  finish.resolve();
  await next;
  expect(f.principals.openTurn).toHaveBeenCalledTimes(2);
  expect(f.principals.revoke).toHaveBeenCalledTimes(2);
});
