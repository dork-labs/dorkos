import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

import { SESSIONS } from '../../../../config/constants.js';
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
