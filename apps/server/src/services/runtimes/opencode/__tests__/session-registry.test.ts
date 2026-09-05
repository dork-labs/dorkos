import { describe, it, expect, beforeEach } from 'vitest';
import { DIRECTORY_MEMBERSHIP_VECTORS } from '@dorkos/test-utils';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { OpenCodeSessionRegistry } from '../sessions/session-registry.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_DIR = '/projects/demo';

describe('OpenCodeSessionRegistry', () => {
  let registry: OpenCodeSessionRegistry;

  beforeEach(() => {
    registry = new OpenCodeSessionRegistry();
  });

  it('excludes cwd-less sessions from every project list while keeping them reachable by id (DOR-202)', () => {
    registry.register(SESSION_ID); // the PATCH-before-first-message path — no cwd yet
    registry.register(OTHER_SESSION_ID, { cwd: PROJECT_DIR });

    expect(registry.list(PROJECT_DIR).map((s) => s.id)).toEqual([OTHER_SESSION_ID]);
    expect(registry.list('/projects/other')).toEqual([]);
    expect(registry.get(SESSION_ID)?.id).toBe(SESSION_ID);
  });

  it('never announces cwd-less sessions on the live stream (DOR-202)', async () => {
    // Pre-fix, both the inventory snapshot and live pushes announced cwd-less
    // sessions fleet-wide over /api/events — ghost rows under every agent,
    // contradicting list()'s "belongs to NO list" rule.
    registry.register(SESSION_ID); // tracked before subscribe → snapshot candidate

    const iterator = registry.subscribe();
    const first = iterator.next();

    registry.register(OTHER_SESSION_ID); // cwd-less live push → suppressed
    registry.recordMessage(OTHER_SESSION_ID, 'first turn', { cwd: PROJECT_DIR });

    const event = (await first).value as SessionListEvent;
    await iterator.return?.(undefined);

    // The first delivered event is the cwd-resolving upsert — the snapshot
    // skipped the cwd-less session and the cwd-less register was suppressed.
    expect(event).toMatchObject({
      type: 'session_upserted',
      session: expect.objectContaining({ id: OTHER_SESSION_ID, cwd: PROJECT_DIR }),
    });
  });

  it('announces a previously silent session once a turn resolves its cwd', async () => {
    registry.register(SESSION_ID);

    const iterator = registry.subscribe();
    const first = iterator.next();

    registry.recordMessage(SESSION_ID, 'hello opencode', { cwd: PROJECT_DIR });

    const event = (await first).value as SessionListEvent;
    await iterator.return?.(undefined);

    expect(event).toMatchObject({
      type: 'session_upserted',
      session: expect.objectContaining({
        id: SESSION_ID,
        cwd: PROJECT_DIR,
        lastMessagePreview: 'hello opencode',
      }),
    });
  });
});

describe.each(DIRECTORY_MEMBERSHIP_VECTORS)(
  'membership vector: $name',
  ({ root, candidate, within }) => {
    it(`${within ? 'includes' : 'excludes'} it`, () => {
      // The registry answers the SAME table as the OpenCode sidecar listing,
      // the server's per-agent fan-out and the client's selector — one rule,
      // every call site that decides which project a session belongs to
      // (DOR-674, completed for the registries by DOR-1550).
      const registry = new OpenCodeSessionRegistry();
      registry.register(SESSION_ID, { cwd: candidate });

      expect(registry.list(root).map((s) => s.id)).toEqual(within ? [SESSION_ID] : []);
    });
  }
);
