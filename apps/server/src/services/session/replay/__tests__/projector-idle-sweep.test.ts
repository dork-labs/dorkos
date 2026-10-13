import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { RawSessionEvent } from '../../session-state-projector.js';
import { SessionEventStore } from '../../session-event-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
  setSessionEventStore,
} from '../../session-state-projector.js';
import { sweepIdleProjectors } from '../projector-idle-sweep.js';

/**
 * A Codex, OpenCode or Doe chat's projector used to stay in memory for the
 * life of the server once opened (DOR-2897). These are log-backed: the store
 * holds the whole conversation, so an idle projector is only a cache of it.
 */

const IDS = ['idle-a', 'idle-b', 'idle-c'];

function turn(projector: ReturnType<typeof getOrCreateProjector>, text: string): void {
  projector.ingest({ type: 'turn_start' } as RawSessionEvent);
  projector.ingest({ type: 'text_delta', text } as RawSessionEvent);
  projector.ingest({ type: 'turn_end' } as RawSessionEvent);
}

function logBacked(id: string) {
  return getOrCreateProjector(id, '/work', { persist: 'history' });
}

afterEach(() => {
  for (const id of IDS) disposeProjector(id);
  setSessionEventStore(undefined);
});

describe('sweepIdleProjectors', () => {
  it('drops an idle log-backed projector on the second sweep, and the store still has it', () => {
    const store = new SessionEventStore(createTestDb());
    setSessionEventStore(store);
    turn(logBacked('idle-a'), 'hello');

    expect(sweepIdleProjectors()).toBe(0); // first sighting
    expect(peekProjector('idle-a')).toBeDefined();
    expect(sweepIdleProjectors()).toBe(1);
    expect(peekProjector('idle-a')).toBeUndefined();

    // The conversation was in the store all along.
    expect(store.readAll('idle-a').some((event) => event.type === 'text_delta')).toBe(true);
  });

  it('keeps a projector that moved between sweeps', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = logBacked('idle-a');
    turn(projector, 'one');
    sweepIdleProjectors();
    turn(projector, 'two');

    expect(sweepIdleProjectors()).toBe(0);
    expect(peekProjector('idle-a')).toBe(projector);
  });

  it('keeps a projector somebody is reading', async () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = logBacked('idle-a');
    turn(projector, 'hello');
    const abort = new AbortController();
    const reading = (async () => {
      for await (const _event of projector.subscribe(projector.getCursor(), abort.signal)) break;
    })();
    await new Promise((resolve) => setImmediate(resolve));

    sweepIdleProjectors();
    expect(sweepIdleProjectors()).toBe(0);
    abort.abort();
    await reading;
  });

  it('keeps a projector with a turn still running', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = logBacked('idle-a');
    projector.ingest({ type: 'turn_start' } as RawSessionEvent);

    sweepIdleProjectors();
    expect(sweepIdleProjectors()).toBe(0);
  });

  it('keeps a projector waiting on an approval', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = logBacked('idle-a');
    projector.ingest({ type: 'turn_start' } as RawSessionEvent);
    projector.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: Date.now(),
      remainingMs: 600_000,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);

    sweepIdleProjectors();
    expect(sweepIdleProjectors()).toBe(0);
  });

  it('keeps a session whose last turn failed, so every window still shows the error', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = logBacked('idle-a');
    projector.ingest({ type: 'turn_start' } as RawSessionEvent);
    projector.ingest({ type: 'turn_end', terminalReason: 'error' } as RawSessionEvent);
    expect(projector.getStatus().lifecycle).toBe('error');

    sweepIdleProjectors();
    expect(sweepIdleProjectors()).toBe(0);
  });

  it('drops a session whose last turn was stopped', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = logBacked('idle-a');
    projector.ingest({ type: 'turn_start' } as RawSessionEvent);
    projector.ingest({ type: 'turn_end', terminalReason: 'interrupted' } as RawSessionEvent);
    expect(projector.getStatus().lifecycle).toBe('interrupted');

    sweepIdleProjectors();
    expect(sweepIdleProjectors()).toBe(1);
  });

  it('keeps a turn held on a capability approval', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = logBacked('idle-a');
    projector.ingest({ type: 'turn_start' } as RawSessionEvent);
    const now = Date.now();
    projector.ingest({
      type: 'capability_approval_required',
      approval: {
        approvalId: 'appr-1',
        capabilityId: 'mcp.add',
        capabilityTitle: 'Add an MCP server',
        tier: 'destructive',
        summary: 'Prober wants to run "Add an MCP server"',
        hasAgentPath: true,
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 7_200_000).toISOString(),
      },
      startedAt: now,
      capMs: 600_000,
    } as unknown as RawSessionEvent);
    expect(projector.hasPendingInteractions()).toBe(true);

    sweepIdleProjectors();
    expect(sweepIdleProjectors()).toBe(0);
  });

  it('keeps a sign-in card that outlived its turn', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = logBacked('idle-a');
    projector.ingest({ type: 'turn_start' } as RawSessionEvent);
    projector.ingest({
      type: 'mcp_signin_required',
      serverName: 'granola',
      agentId: '01HV7KJZZZ0000000000000000',
      flowId: 'flow-1',
      authorizeUrl: 'https://mcp.test.local/authorize',
      disclosure: 'DorkOS stores the token on this machine.',
    } as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);

    sweepIdleProjectors();
    expect(sweepIdleProjectors()).toBe(0);
  });

  it('keeps a projector somebody fetched since the last sweep', () => {
    // A caller fetches the projector, then awaits before its first event. A
    // turn fed into an instance the registry dropped would never be stored.
    setSessionEventStore(new SessionEventStore(createTestDb()));
    turn(logBacked('idle-a'), 'hello');
    sweepIdleProjectors();
    const held = logBacked('idle-a');

    expect(sweepIdleProjectors()).toBe(0);
    expect(peekProjector('idle-a')).toBe(held);
  });

  it('comes back from the store after a drop, continuing its numbering', async () => {
    const store = new SessionEventStore(createTestDb());
    setSessionEventStore(store);
    const first = logBacked('idle-a');
    turn(first, 'before');
    const cursor = first.getCursor();
    sweepIdleProjectors();
    sweepIdleProjectors();

    const again = logBacked('idle-a');
    expect(again).not.toBe(first);
    expect(again.streamGeneration).not.toBe(first.streamGeneration);
    expect(again.getCursor()).toBe(cursor);
    turn(again, 'after');
    const texts = store
      .readAll('idle-a')
      .flatMap((event) => (event.type === 'text_delta' ? [event.text] : []));
    expect(texts).toEqual(['before', 'after']);
  });

  it('never drops a projector whose history is not in the store', () => {
    // Claude Code's history is its transcript, and a projector with no store
    // holds the only copy of its log.
    getOrCreateProjector('idle-b', '/work');
    setSessionEventStore(new SessionEventStore(createTestDb()));
    getOrCreateProjector('idle-c', '/work', { persist: 'record' });
    turn(peekProjector('idle-b')!, 'x');
    turn(peekProjector('idle-c')!, 'y');

    sweepIdleProjectors();
    expect(sweepIdleProjectors()).toBe(0);
    expect(peekProjector('idle-b')).toBeDefined();
    expect(peekProjector('idle-c')).toBeDefined();
  });
});
