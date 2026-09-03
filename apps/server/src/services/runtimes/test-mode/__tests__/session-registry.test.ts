import { describe, it, expect, beforeEach } from 'vitest';
import { DIRECTORY_MEMBERSHIP_VECTORS } from '@dorkos/test-utils';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { TestModeSessionRegistry } from '../session-registry.js';
import { TEST_MODE_CAPABILITIES } from '../runtime-constants.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_DIR = '/projects/demo';

describe('TestModeSessionRegistry', () => {
  let registry: TestModeSessionRegistry;

  beforeEach(() => {
    registry = new TestModeSessionRegistry();
  });

  // A session is born at whatever the registry fills in when nothing asks for a
  // mode, and that used to be the literal `'default'` — an id this runtime does
  // not declare. The session then showed a stop its own picker could not offer,
  // and once the PATCH route began checking requests against the runtime's
  // declaration (DOR-811), switching BACK to it was refused: a session stranded
  // in a mode it could not return to.
  //
  // Stated as membership in the DECLARED set, never as an id, so a future
  // profile that renames or re-orders its modes keeps this test meaningful.
  it.each([
    ['no settings at all', undefined],
    ['settings that name no mode', { cwd: PROJECT_DIR }],
  ])('is born in a mode this runtime declares (%s)', (_case, patch) => {
    registry.register(SESSION_ID, patch);

    const declaredIds = TEST_MODE_CAPABILITIES.permissionModes.values.map((v) => v.id);
    expect(declaredIds).toContain(registry.get(SESSION_ID)?.permissionMode);
    // And specifically the mode the runtime nominates as its default, so the
    // session and `/api/capabilities` agree about where the dial starts.
    expect(registry.get(SESSION_ID)?.permissionMode).toBe(
      TEST_MODE_CAPABILITIES.permissionModes.default
    );
  });

  it('excludes cwd-less sessions from every project list while keeping them reachable by id (DOR-202)', () => {
    registry.register(SESSION_ID); // no cwd — belongs to no project list
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
});

describe.each(DIRECTORY_MEMBERSHIP_VECTORS)(
  'membership vector: $name',
  ({ root, candidate, within }) => {
    it(`${within ? 'includes' : 'excludes'} it`, () => {
      // The registry answers the SAME table as the OpenCode sidecar listing,
      // the server's per-agent fan-out and the client's selector — one rule,
      // every call site that decides which project a session belongs to
      // (DOR-674, completed for the registries by DOR-1550).
      const registry = new TestModeSessionRegistry();
      registry.register(SESSION_ID, { cwd: candidate });

      expect(registry.list(root).map((s) => s.id)).toEqual(within ? [SESSION_ID] : []);
    });
  }
);
