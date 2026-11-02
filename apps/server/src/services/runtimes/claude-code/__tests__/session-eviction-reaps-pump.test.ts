import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

import {
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
} from '../../../session/session-state-projector.js';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { SESSIONS } from '../../../../config/constants.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { SessionPumpRegistry } from '../sessions/session-pump-registry.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

describe('session eviction gives the session process back', () => {
  let ClaudeCodeRuntime: typeof import('../claude-code-runtime.js').ClaudeCodeRuntime;
  let runtime: InstanceType<typeof ClaudeCodeRuntime>;
  let evict: MockInstance<SessionPumpRegistry['evict']>;

  beforeEach(async () => {
    vi.useFakeTimers();
    evict = vi.spyOn(SessionPumpRegistry.prototype, 'evict');
    const mod = await import('../claude-code-runtime.js');
    ClaudeCodeRuntime = mod.ClaudeCodeRuntime;
    runtime = new ClaudeCodeRuntime('/tmp/dorkos-test');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    disposeProjector('capacity-0');
  });

  it('reclaims an idle record at capacity and releases its pump and projector', () => {
    for (let n = 0; n < SESSIONS.MAX_SESSIONS; n++)
      runtime.ensureSession(`capacity-${n}`, { permissionMode: 'default' });
    getOrCreateProjector('capacity-0');
    runtime.ensureSession('capacity-new', { permissionMode: 'default' });
    expect(runtime.hasSession('capacity-new')).toBe(true);
    expect(runtime.hasSession('capacity-0')).toBe(false);
    expect(evict).toHaveBeenCalledWith('capacity-0');
    expect(peekProjector('capacity-0')).toBeUndefined();
    expect(runtime.getSessionCapacity()).toMatchObject({
      runtime: 'claude-code',
      records: 50,
      live: 0,
      available: 50,
    });
  });

  it('reports capacity through every registered runtime decorator', () => {
    const registry = new RuntimeRegistry();
    registry.register(runtime);
    runtime.ensureSession('registered-capacity', { permissionMode: 'default' });
    expect(registry.get('claude-code').getSessionCapacity?.()).toMatchObject({
      runtime: 'claude-code',
      records: 1,
      live: 0,
      available: 50,
    });
  });

  it('protects an opening turn before it has an SDK query', () => {
    for (let n = 0; n < SESSIONS.MAX_SESSIONS; n++)
      runtime.ensureSession(`capacity-${n}`, { permissionMode: 'default' });
    getOrCreateProjector('capacity-0').ingest({ type: 'turn_start' });
    runtime.ensureSession('capacity-new', { permissionMode: 'default' });
    expect(runtime.hasSession('capacity-0')).toBe(true);
    expect(runtime.hasSession('capacity-1')).toBe(false);
    expect(runtime.getSessionCapacity()).toMatchObject({ records: 50, live: 1, available: 49 });
  });

  it('protects a sign-in card still waiting after its turn ended', () => {
    for (let n = 0; n < SESSIONS.MAX_SESSIONS; n++)
      runtime.ensureSession(`capacity-${n}`, { permissionMode: 'default' });
    const projector = getOrCreateProjector('capacity-0');
    projector.ingest({ type: 'turn_start' });
    const signin = {
      type: 'mcp_signin_required',
      serverName: 'test',
      agentId: 'test-agent',
      flowId: 'test-flow',
      authorizeUrl: 'https://example.test/auth',
      disclosure: 'Sign in to continue.',
    } satisfies Omit<Extract<SessionEvent, { type: 'mcp_signin_required' }>, 'seq'>;
    projector.ingest(signin);
    projector.ingest({ type: 'turn_end' });
    runtime.ensureSession('capacity-new', { permissionMode: 'default' });
    expect(runtime.hasSession('capacity-0')).toBe(true);
    expect(runtime.hasSession('capacity-1')).toBe(false);
  });

  // Purpose: eviction ALWAYS implies a reap. A session record retiring while its
  // subprocess kept running would leave a CLI child (and its MCP children) with
  // nothing left in DorkOS that could ever close it.
  it('hands every evicted session to the pump registry', () => {
    runtime.ensureSession('sess-1', { permissionMode: 'default' });
    expect(runtime.hasSession('sess-1')).toBe(true);

    vi.advanceTimersByTime(SESSIONS.TIMEOUT_MS + 60_000);
    runtime.checkSessionHealth();

    expect(runtime.hasSession('sess-1')).toBe(false);
    expect(evict.mock.calls.flat()).toContain('sess-1');
  });

  // Purpose: the other direction, so the assertion above is about eviction and
  // not merely about the sweep running. A reap is never handed out to a session
  // that is still alive — warmth is not what the 30-minute timer governs.
  it('leaves a session inside its timeout alone', () => {
    runtime.ensureSession('sess-1', { permissionMode: 'default' });

    vi.advanceTimersByTime(SESSIONS.TIMEOUT_MS - 60_000);
    runtime.checkSessionHealth();

    expect(runtime.hasSession('sess-1')).toBe(true);
    expect(evict).not.toHaveBeenCalled();
  });
});
