/**
 * Which runtime a turn runs on, against the REAL registry and a real database.
 *
 * The seam this file exists for is the one a mock cannot prove: the binding
 * `persistSessionRuntime` writes and the binding `resolveTurnRuntimeType` reads
 * are the same row. A stubbed registry that answers `bound: true` only encodes
 * the hypothesis that they agree — so here the write is real, the SQLite is
 * real, and the manifest is the only thing standing in for the disk.
 *
 * Seeded defects, both run and both red before the code stood:
 *
 * - Reading the manifest first (the DOR-764 shape) reddens the two binding
 *   cases: a bound session follows an edit made mid-conversation.
 * - Reading the registry's session answer first, ignoring `bound`, reddens the
 *   two unbound cases: an id nobody owns takes the legacy claude-code
 *   inference, so a codex agent's opening turn runs on the wrong program and is
 *   then bound there for good.
 *
 * @module server/services/runtimes/shared/__tests__/resolve-turn-runtime-type
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';

/** What the addressed agent's `.dork/agent.json` says right now. */
let agentManifest: { runtime?: string } | null = null;

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: () => Promise.resolve(agentManifest),
}));

const { runtimeRegistry } = await import('../../../core/runtime-registry.js');
const { logger } = await import('../../../../lib/logger.js');
const { resolveAgentRuntimeType, resolveTurnRuntimeType } =
  await import('../resolve-agent-runtime-type.js');

describe('resolveTurnRuntimeType', () => {
  beforeEach(() => {
    agentManifest = null;
    runtimeRegistry.setDb(createTestDb());
    runtimeRegistry.register(new FakeAgentRuntime('claude-code'));
    runtimeRegistry.register(new FakeAgentRuntime('codex'));
    runtimeRegistry.setDefault('claude-code');
  });

  it('runs a bound session on its owner, however the manifest has been edited since', async () => {
    // ADR-0255, on the path that used to bypass it (DOR-764). The first turn
    // bound this session to codex; somebody has since changed the agent to
    // claude-code. That change is about the agent's NEXT session — this
    // conversation's history lives in codex, and a turn handed to claude-code
    // answers it from nothing.
    await runtimeRegistry.persistSessionRuntime('room-session', 'codex', '/repo/ana');
    agentManifest = { runtime: 'claude-code' };

    expect(
      await resolveTurnRuntimeType({ sessionId: 'room-session', agentPath: '/repo/ana' })
    ).toBe('codex');
  });

  it('starts an unbound session on the manifest runtime, not on the legacy inference', async () => {
    // The registry answers every unbound id with claude-code so that reads
    // before the first message do not fail. That tolerance is the wrong answer
    // for a turn about to RUN: taken here it would start every codex agent's
    // first room turn on claude-code and bind it there.
    agentManifest = { runtime: 'codex' };

    expect(await resolveTurnRuntimeType({ sessionId: null, agentPath: '/repo/ana' })).toBe('codex');
    expect(await resolveTurnRuntimeType({ sessionId: 'no-row-yet', agentPath: '/repo/ana' })).toBe(
      'codex'
    );
  });

  it('treats a row without a runtime as unbound, because a preference is not a binding', async () => {
    // A settings change before the first message mints a row whose `runtime` is
    // NULL (DOR-812). Reading that as an owner would pin the session to whatever
    // the registry infers, which is the very thing that write refuses to say.
    await runtimeRegistry.saveSessionSettings('picked-before-sending', { model: 'gpt-5.3-codex' });
    agentManifest = { runtime: 'codex' };

    expect(
      await resolveTurnRuntimeType({ sessionId: 'picked-before-sending', agentPath: '/repo/ana' })
    ).toBe('codex');
  });

  it('reports a bound runtime this server does not have, rather than redirecting the turn', async () => {
    // The honest failure. A build without the Codex adapter cannot answer this
    // conversation, and falling back to a registered runtime would resume it on
    // a program holding none of its transcript — the same re-decision DOR-764 is
    // about, arrived at from the other side. The caller's `runtimeRegistry.get`
    // is what turns this into the refusal.
    await runtimeRegistry.persistSessionRuntime('room-session', 'opencode', '/repo/ana');
    agentManifest = { runtime: 'claude-code' };

    expect(
      await resolveTurnRuntimeType({ sessionId: 'room-session', agentPath: '/repo/ana' })
    ).toBe('opencode');
    expect(() => runtimeRegistry.get('opencode')).toThrow(/not registered/);
  });
});

describe('resolveAgentRuntimeType says when it substitutes', () => {
  beforeEach(() => {
    agentManifest = null;
    runtimeRegistry.setDb(createTestDb());
    runtimeRegistry.register(new FakeAgentRuntime('claude-code'));
    runtimeRegistry.setDefault('claude-code');
  });

  it('warns when an agent runs on a runtime this server did not start', async () => {
    // The soft fallback is deliberate — a test-mode server could trigger
    // nothing without it — but it is still a different program answering under
    // that agent's name, and an operator has no other way to find that out.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    agentManifest = { runtime: 'opencode' };

    expect(await resolveAgentRuntimeType('/repo/ana')).toBe('claude-code');

    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('/repo/ana');
    expect(line).toContain('opencode');
    expect(line).toContain('claude-code');
    warn.mockRestore();
  });

  it('says nothing when the manifest names a runtime it can have', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    agentManifest = { runtime: 'claude-code' };

    expect(await resolveAgentRuntimeType('/repo/ana')).toBe('claude-code');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('says nothing when the agent expressed no preference at all', async () => {
    // Nothing was substituted: an agent with no manifest runtime asked for
    // nothing, and the default is the answer rather than a replacement for one.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    agentManifest = {};

    expect(await resolveAgentRuntimeType('/repo/ana')).toBe('claude-code');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
