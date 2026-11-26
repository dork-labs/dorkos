import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorRuntimeBindings } from '@dorkos/db';
import { clearTestHomes } from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { RuntimeToolContextUnavailableError } from '@dorkos/shared/connections-lease';
import { createServerPrincipal } from '../server-principal.js';
import { liveTurnFixture } from './runtime-tool-turn.fixture.js';

const fixtures: Awaited<ReturnType<typeof liveTurnFixture>>[] = [];
async function fixture() {
  const f = await liveTurnFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.$client.close();
  clearTestHomes();
  vi.restoreAllMocks();
});

describe('live runtime tool caller', () => {
  it('reads fresh modes, Never ask, cancellation and the exact queue without stored-mode fallback', async () => {
    const f = await fixture();
    const caller = await f.service.resolveToolTurn(f.principal);
    expect(caller).toMatchObject({
      runtime: 'opencode',
      sessionId: 'session-a',
      agentHome: f.home,
      workingDirectory: '/test/desk',
    });
    expect(caller.read()).toBe(f.facts);
    const session = { eventQueue: [], eventQueueNotify: vi.fn() };
    f.facts = {
      effectiveMode: undefined,
      chosenMode: 'full',
      neverAsks: true,
      session,
      signal: f.abort.signal,
    };
    expect(caller.read()).toBe(f.facts);
    expect(caller.read().effectiveMode).toBeUndefined();
    expect(caller.read().session).toBe(session);
    await expect(caller.assertCurrent()).resolves.toBeUndefined();
  });

  it('keeps the original live callback through genuine permit renewal', async () => {
    const f = await fixture();
    const caller = await f.service.resolveToolTurn(f.principal);
    await expect(
      f.service.renew({ bindingId: f.opened.bindingId, permit: f.opened.renewalPermit })
    ).resolves.toMatchObject({ status: 'renewed' });
    f.facts = { ...f.facts!, effectiveMode: 'careful', neverAsks: true };
    expect(caller.read()).toBe(f.facts);
  });

  it('rejects JSON provenance and authenticated non-runtime principals', async () => {
    const f = await fixture();
    for (const p of [
      JSON.parse(JSON.stringify(f.principal)),
      createServerPrincipal({
        kind: 'operator',
        owner: { kind: 'local_install', installationId: 'install-a' },
      }),
    ]) {
      await expect(f.service.resolveToolTurn(p)).rejects.toBeInstanceOf(
        RuntimeToolContextUnavailableError
      );
    }
  });

  it.each([
    ['runtime', 'codex'],
    ['canonicalSessionId', 'foreign-session'],
    ['agentPath', '/foreign'],
    ['canonicalCwd', '/foreign-desk'],
    ['agentId', 'foreign-agent'],
    ['owner', { kind: 'local_install', installationId: 'foreign-owner' }],
    ['canonicalCwd', undefined],
  ])('rejects authenticated mismatched %s claims (%j)', async (key, value) => {
    const f = await fixture();
    const forged = createServerPrincipal({ ...f.principal.claims, [key]: value });
    await expect(f.service.resolveToolTurn(forged)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
  });

  it.each(['runtime', 'home', 'agent'] as const)(
    'revalidates current canonical %s authority',
    async (field) => {
      const f = await fixture();
      const caller = await f.service.resolveToolTurn(f.principal);
      if (field === 'runtime') f.setRuntime('codex');
      if (field === 'home') f.setHome('/foreign');
      if (field === 'agent') f.setAgent('foreign-agent');
      await expect(caller.assertCurrent()).rejects.toBeInstanceOf(
        RuntimeToolContextUnavailableError
      );
      expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    }
  );

  it('refuses absent facts and unregistered homes without substituting another owner', async () => {
    const f = await fixture();
    const caller = await f.service.resolveToolTurn(f.principal);
    f.facts = undefined;
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    await expect(f.service.resolveToolTurn(f.principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
    f.registry.homes.clear();
    await expect(f.service.resolveToolTurn(f.principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
  });

  it('refuses a connection-only owner without eagerly reading tools during open', async () => {
    const f = await fixture();
    const opened = await f.service.openTurn(f.input, { isCurrent: () => true });
    const p = await f.service.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: f.input.canonicalCwd,
    });
    expect(p.status).toBe('resolved');
    if (p.status !== 'resolved') throw new Error('Expected connection principal');
    await expect(f.service.resolveToolTurn(p.principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
  });

  it.each(['abort', 'owner', 'expiry', 'revoke'] as const)(
    'invalidates an already returned caller on %s',
    async (cause) => {
      const f = await fixture();
      const caller = await f.service.resolveToolTurn(f.principal);
      if (cause === 'abort') f.abort.abort();
      if (cause === 'owner') f.setCurrent(false);
      if (cause === 'expiry') f.expire();
      if (cause === 'revoke') await f.service.revoke(f.opened.bindingId, 'turn_terminal');
      expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
      await expect(caller.assertCurrent()).rejects.toBeInstanceOf(
        RuntimeToolContextUnavailableError
      );
    }
  );

  it('checks ownership and abort again after the fresh callback itself runs', async () => {
    const f = await fixture();
    const caller = await f.service.resolveToolTurn(f.principal);
    f.ownership.readToolTurn = () => {
      f.setCurrent(false);
      return f.facts;
    };
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    f.setCurrent(true);
    f.ownership.readToolTurn = () => {
      f.abort.abort();
      return f.facts;
    };
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
  });

  it.each(['resolve', 'assert'] as const)(
    'rejects replacement during awaited authority at %s before returning authority',
    async (operation) => {
      const f = await fixture();
      const caller = await f.service.resolveToolTurn(f.principal);
      let enter!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      let release!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const canonical = f.authority.revalidateTurn.bind(f.authority);
      vi.spyOn(f.authority, 'revalidateTurn').mockImplementationOnce(async (claims) => {
        enter();
        await blocked;
        return canonical(claims);
      });
      const result =
        operation === 'resolve' ? f.service.resolveToolTurn(f.principal) : caller.assertCurrent();
      const refusal = expect(result).rejects.toBeInstanceOf(RuntimeToolContextUnavailableError);
      await entered;
      f.setCurrent(false);
      release();
      await refusal;
      // This oracle observes resolver delivery itself, not a later caller.read() fence.
      f.setCurrent(true);
      const replacement = await f.service.openTurn(f.input, {
        isCurrent: () => true,
        readToolTurn: () => f.facts,
      });
      const p = await f.service.resolve({
        bearer: replacement.bearer,
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: f.input.canonicalCwd,
      });
      if (p.status !== 'resolved') throw new Error('Expected replacement');
      await expect(f.service.resolveToolTurn(p.principal)).resolves.toMatchObject({
        sessionId: 'session-a',
      });
    }
  );

  it('rejects abort during authority validation even while ownership remains current', async () => {
    const f = await fixture();
    const canonical = f.authority.revalidateTurn.bind(f.authority);
    vi.spyOn(f.authority, 'revalidateTurn').mockImplementationOnce(async (claims) => {
      const authorized = await canonical(claims);
      f.abort.abort();
      return authorized;
    });
    await expect(f.service.resolveToolTurn(f.principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
  });

  it('rejects facts disappearing during awaited authority before delivering a caller', async () => {
    const f = await fixture();
    const canonical = f.authority.revalidateTurn.bind(f.authority);
    vi.spyOn(f.authority, 'revalidateTurn').mockImplementationOnce(async (claims) => {
      const authorized = await canonical(claims);
      f.facts = undefined;
      return authorized;
    });
    await expect(f.service.resolveToolTurn(f.principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
  });

  it('propagates rejected authority without delivering a caller or cached facts', async () => {
    const f = await fixture();
    const caller = await f.service.resolveToolTurn(f.principal);
    const failure = new Error('Authority read failed');
    f.failSessionRead(failure);
    await expect(caller.assertCurrent()).rejects.toBe(failure);
    f.failSessionRead();
    await expect(caller.assertCurrent()).resolves.toBeUndefined();
  });

  it('keeps a failed durable revoke denied while the database remains readable', async () => {
    const f = await fixture();
    const caller = await f.service.resolveToolTurn(f.principal);
    f.db.$client.exec(
      "CREATE TRIGGER fail_revoke BEFORE UPDATE ON connector_runtime_bindings BEGIN SELECT RAISE(FAIL, 'injected revoke failure'); END"
    );
    await expect(f.service.revoke(f.opened.bindingId, 'turn_terminal')).rejects.toThrow(
      'injected revoke failure'
    );
    expect(f.db.select().from(connectorRuntimeBindings).get()?.revokedAt).toBeNull();
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    await expect(caller.assertCurrent()).rejects.toBeInstanceOf(RuntimeToolContextUnavailableError);
    await expect(f.service.resolveToolTurn(f.principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
  });

  it('never hops an old thread principal to a newer attached binding', async () => {
    const f = await fixture();
    const key = f.threadKeys.mint({
      runtime: 'opencode',
      canonicalSessionId: 'session-a',
      canonicalCwd: f.input.canonicalCwd,
      processKey: 'unit-process',
    });
    f.threadKeys.attach(key.keyId, {
      bindingId: f.opened.bindingId,
      canonicalSessionId: 'session-a',
    });
    const resolveKey = () =>
      f.service.resolve({
        bearer: key.key,
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: f.input.canonicalCwd,
      });
    const old = await resolveKey();
    if (old.status !== 'resolved') throw new Error('Expected attached principal');
    f.threadKeys.detach(key.keyId, f.opened.bindingId);
    await f.service.revoke(f.opened.bindingId, 'turn_terminal');
    expect((await resolveKey()).status).toBe('refused');
    const next = await f.service.openTurn(f.input, {
      isCurrent: () => true,
      readToolTurn: () => f.facts,
    });
    f.threadKeys.attach(key.keyId, { bindingId: next.bindingId, canonicalSessionId: 'session-a' });
    await expect(f.service.resolveToolTurn(old.principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
    const fresh = await resolveKey();
    if (fresh.status !== 'resolved') throw new Error('Expected new attached principal');
    await expect(f.service.resolveToolTurn(fresh.principal)).resolves.toMatchObject({
      sessionId: 'session-a',
    });
  });

  it('retires old live callers before a boot-reset write can fail while SQLite stays readable', async () => {
    const f = await fixture();
    const caller = await f.service.resolveToolTurn(f.principal);
    f.db.$client.exec(
      "CREATE TRIGGER fail_boot_reset BEFORE UPDATE ON connector_runtime_bindings BEGIN SELECT RAISE(FAIL, 'injected reset failure'); END"
    );
    await expect(f.service.initializeBoot()).rejects.toThrow('injected reset failure');
    expect(f.db.select().from(connectorRuntimeBindings).all()).toHaveLength(1);
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    await expect(f.service.resolveToolTurn(f.principal)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
    f.db.$client.exec('DROP TRIGGER fail_boot_reset');
    await f.service.initializeBoot();
    const opened = await f.service.openTurn(f.input, f.ownership);
    const p = await f.service.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: f.input.canonicalCwd,
    });
    if (p.status !== 'resolved') throw new Error('Expected new boot principal');
    await expect(f.service.resolveToolTurn(p.principal)).resolves.toMatchObject({
      agentHome: f.home,
    });
  });
});
