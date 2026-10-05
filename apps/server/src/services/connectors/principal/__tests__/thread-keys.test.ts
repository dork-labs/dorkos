import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { logger } from '../../../../lib/logger.js';
import type { OpenConnectorTurnInput } from '../../runtime-principal-port.js';
import {
  ConnectorRuntimePrincipalService,
  type ConnectorRuntimeAuthorityResolver,
} from '../runtime-principal-service.js';
import { ConnectorThreadKeyRegistry, THREAD_KEY_PREFIX } from '../thread-keys.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const SCOPE = {
  runtime: 'codex',
  canonicalSessionId: 'session-a',
  canonicalCwd: '/project',
  processKey: 'proc-1',
} as const;

describe('ConnectorThreadKeyRegistry', () => {
  it('mints 256-bit prefixed keys that are unique and looked up by value', () => {
    const registry = new ConnectorThreadKeyRegistry();
    const a = registry.mint(SCOPE);
    const b = registry.mint(SCOPE);
    expect(a.key.startsWith(THREAD_KEY_PREFIX)).toBe(true);
    // 32 bytes of base64url is 43 characters.
    expect(Buffer.from(a.key.slice(THREAD_KEY_PREFIX.length), 'base64url')).toHaveLength(32);
    expect(a.key).not.toBe(b.key);
    expect(a.keyId).not.toBe(b.keyId);
    expect(registry.lookup(a.key)).toEqual({ keyId: a.keyId, scope: SCOPE, bindingId: undefined });
    expect(registry.lookup(`${THREAD_KEY_PREFIX}forged`)).toBeUndefined();
    expect(registry.lookup('not-a-thread-key')).toBeUndefined();
  });

  it('attaches one turn at a time, only for its own session, and detaches exactly that turn', () => {
    const registry = new ConnectorThreadKeyRegistry();
    const { keyId, key } = registry.mint(SCOPE);
    expect(() =>
      registry.attach(keyId, { bindingId: 'b1', canonicalSessionId: 'session-b' })
    ).toThrow(/another session/);
    registry.attach(keyId, { bindingId: 'b1', canonicalSessionId: 'session-a' });
    expect(registry.lookup(key)?.bindingId).toBe('b1');
    expect(() =>
      registry.attach(keyId, { bindingId: 'b2', canonicalSessionId: 'session-a' })
    ).toThrow(/still attached/);
    registry.detach(keyId, 'b2');
    expect(registry.lookup(key)?.bindingId).toBe('b1');
    registry.detach(keyId, 'b1');
    expect(registry.lookup(key)?.bindingId).toBeUndefined();
    registry.attach(keyId, { bindingId: 'b2', canonicalSessionId: 'session-a' });
    expect(registry.lookup(key)?.bindingId).toBe('b2');
  });

  it('revokes one key, or every key of a process, for good', () => {
    const registry = new ConnectorThreadKeyRegistry();
    const one = registry.mint(SCOPE);
    const two = registry.mint({ ...SCOPE, canonicalSessionId: 'session-b' });
    const other = registry.mint({ ...SCOPE, processKey: 'proc-2' });
    registry.revoke(one.keyId, 'thread_unloaded');
    registry.revoke(one.keyId, 'thread_unloaded');
    expect(registry.lookup(one.key)).toBeUndefined();
    expect(() =>
      registry.attach(one.keyId, { bindingId: 'b', canonicalSessionId: 'session-a' })
    ).toThrow(/not live/);
    registry.revokeProcess('proc-1', 'process_exited');
    expect(registry.lookup(two.key)).toBeUndefined();
    expect(registry.lookup(other.key)).toBeDefined();
    expect(registry.size).toBe(1);
  });

  it('never writes a key value to the log, only its id', () => {
    const debug = vi.spyOn(logger, 'debug');
    try {
      const registry = new ConnectorThreadKeyRegistry();
      const { keyId, key } = registry.mint(SCOPE);
      registry.attach(keyId, { bindingId: 'b1', canonicalSessionId: 'session-a' });
      registry.lookup(key);
      registry.revoke(keyId, 'shutdown');
      const logged = JSON.stringify(debug.mock.calls);
      expect(logged).toContain(keyId);
      expect(logged).not.toContain(key);
      expect(logged).not.toContain(key.slice(THREAD_KEY_PREFIX.length));
    } finally {
      debug.mockRestore();
    }
  });
});

describe('the listener resolving a thread key', () => {
  let db: Db;
  let resolver: ConnectorRuntimeAuthorityResolver;
  let ownerCurrent: boolean;
  let registry: ConnectorThreadKeyRegistry;
  let service: ConnectorRuntimePrincipalService;
  let bearers: number;

  const turn: OpenConnectorTurnInput = {
    runtime: 'codex',
    canonicalSessionId: 'session-a',
    agentPath: '/project',
    canonicalCwd: '/project',
    signal: new AbortController().signal,
  };

  beforeEach(async () => {
    db = createDb(':memory:');
    runMigrations(db);
    ownerCurrent = true;
    bearers = 0;
    resolver = {
      authorizeTurn: vi.fn().mockResolvedValue({ owner: OWNER, agentId: 'agent-a' }),
      revalidateTurn: vi.fn(async () => true),
    };
    registry = new ConnectorThreadKeyRegistry();
    service = new ConnectorRuntimePrincipalService({
      db,
      authority: resolver,
      makeBearer: () => `turn-bearer-${++bearers}`,
      threadKeys: registry,
    });
    await service.initializeBoot();
  });

  const resolve = (bearer: string, overrides: Partial<{ runtime: 'codex'; cwd: string }> = {}) =>
    service.resolve({
      bearer,
      expectedRuntime: overrides.runtime ?? 'codex',
      expectedCanonicalCwd: overrides.cwd ?? '/project',
    });

  it('refuses a key with no open turn, resolves it to the open turn, and refuses it after', async () => {
    const { keyId, key } = registry.mint(SCOPE);
    await expect(resolve(key)).resolves.toEqual({ status: 'refused', reason: 'expired' });

    const opened = await service.openTurn(turn, { isCurrent: () => ownerCurrent });
    registry.attach(keyId, { bindingId: opened.bindingId, canonicalSessionId: 'session-a' });
    const resolved = await resolve(key);
    expect(resolved.status).toBe('resolved');
    expect(resolved.status === 'resolved' && resolved.principal.claims).toMatchObject({
      kind: 'runtime',
      bindingId: opened.bindingId,
      canonicalSessionId: 'session-a',
    });

    registry.detach(keyId, opened.bindingId);
    await expect(resolve(key)).resolves.toEqual({ status: 'refused', reason: 'expired' });
  });

  it('refuses a key whose attached turn has ended, even if it is still attached', async () => {
    const { keyId, key } = registry.mint(SCOPE);
    const opened = await service.openTurn(turn, { isCurrent: () => ownerCurrent });
    registry.attach(keyId, { bindingId: opened.bindingId, canonicalSessionId: 'session-a' });
    await service.revoke(opened.bindingId, 'turn_terminal');
    await expect(resolve(key)).resolves.toEqual({ status: 'refused', reason: 'revoked' });
  });

  it('refuses the wrong cwd, a revoked key, and a binding from another session', async () => {
    const { keyId, key } = registry.mint(SCOPE);
    const opened = await service.openTurn(turn, { isCurrent: () => ownerCurrent });
    registry.attach(keyId, { bindingId: opened.bindingId, canonicalSessionId: 'session-a' });
    await expect(resolve(key, { cwd: '/elsewhere' })).resolves.toEqual({
      status: 'refused',
      reason: 'wrong_cwd',
    });

    // A key minted for session-b, wrongly handed session-a's binding by a
    // buggy attach, still never resolves to it.
    const foreign = registry.mint({ ...SCOPE, canonicalSessionId: 'session-b' });
    (registry as unknown as { entryById(id: string): { attachedBindingId?: string } }).entryById(
      foreign.keyId
    ).attachedBindingId = opened.bindingId;
    await expect(resolve(foreign.key)).resolves.toEqual({ status: 'refused', reason: 'invalid' });

    registry.revokeProcess('proc-1', 'process_exited');
    await expect(resolve(key)).resolves.toEqual({ status: 'refused', reason: 'invalid' });
  });

  it('still resolves an ordinary turn bearer exactly as before', async () => {
    const opened = await service.openTurn(turn, { isCurrent: () => ownerCurrent });
    expect(opened.bearer.startsWith(THREAD_KEY_PREFIX)).toBe(false);
    await expect(resolve(opened.bearer)).resolves.toMatchObject({ status: 'resolved' });
  });
});
