/** Actual computer proxy, local file and SQLite settings with no guest acquisition. */
import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, sessionBirthAllocations, sessionLocations, sessionMetadata } from '@dorkos/db';
import { RuntimeRegistry } from '../../../../core/runtime-registry.js';
import { runPreparedSettingsMutation } from '../../../../core/runtime-seam/prepared-settings-write.js';
import type { SessionBirthWriteContext } from '../../../../core/runtime-seam/session-birth-write.js';
import { createComputerRuntime } from '../index.js';
import { ComputerSessionMap } from '../session-map.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'computer-prepared-')));
  chmodSync(home, 0o700);
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createTestDb();
  cleanups.push(() => db.$client.close());
  const settings = new RuntimeRegistry();
  settings.setDb(db);
  const endpoint = vi.fn(async () => {
    throw new Error('Unexpected guest acquisition');
  });
  const path = join(home, 'sessions.json');
  const { runtime } = createComputerRuntime({
    runtimeId: 'computer-local',
    anchor: home,
    guestDirectory: '/home/agent/project',
    sessionMapPath: path,
    currentEnabled: () => true,
    ensureEndpoint: endpoint,
  });
  if (!runtime.setSessionSettings) throw new Error('Actual settings port unavailable');
  runtime.setSessionSettings(settings);
  const id = 'allocated-computer';
  const stamp = '2026-11-19T00:00:00.000Z';
  db.insert(sessionLocations)
    .values({ id: 'location', ownerId: 'person', cwd: home, createdAt: stamp })
    .run();
  db.insert(sessionBirthAllocations)
    .values({
      sessionId: id,
      version: 1,
      createdAt: stamp,
      sourceKind: 'person-location',
      ownerId: 'person',
      locationId: 'location',
    })
    .run();
  const birth: SessionBirthWriteContext = {
    kind: 'person-location',
    sessionId: id,
    ownerId: 'person',
    locationId: 'location',
    cwd: home,
    allocationCreatedAt: stamp,
  };
  const row = () =>
    db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
  const allocations = () => db.select().from(sessionBirthAllocations).all();
  return { home, path, runtime, endpoint, id, birth, row, allocations };
}
it('preserves a genuine computer-local prepared preference through the actual proxy without guest work', async () => {
  const f = fixture();
  expect(f.runtime.type).toBe('computer-local');
  await expect(
    runPreparedSettingsMutation(f.id, f.birth, () =>
      Promise.resolve(
        f.runtime.updateSession(f.id, { model: 'guest-model', permissionMode: 'default' })
      )
    )
  ).resolves.toEqual({ updated: true });
  expect(f.row()).toMatchObject({
    runtime: null,
    model: 'guest-model',
    modelLaunchState: 'pending-v1',
  });
  expect(f.allocations()).toEqual([]);
  expect(f.endpoint).not.toHaveBeenCalled();
});
it('refuses another real file owner binding written after the actual computer proxy hydrated', async () => {
  const f = fixture();
  const before = f.allocations();
  new ComputerSessionMap(f.path).bind(f.id, 'ses_late_owned');
  await expect(
    runPreparedSettingsMutation(f.id, f.birth, () =>
      Promise.resolve(f.runtime.updateSession(f.id, { model: 'stale' }))
    )
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(f.row()).toBeUndefined();
  expect(f.allocations()).toEqual(before);
  expect(new ComputerSessionMap(f.path).listAll()).toEqual([
    { sessionId: f.id, ocSessionId: 'ses_late_owned' },
  ]);
  expect(f.endpoint).not.toHaveBeenCalled();
});
it('refuses a replaced symlink instead of claiming live-file absence', () => {
  const f = fixture();
  const map = new ComputerSessionMap(f.path);
  symlinkSync(join(f.home, 'missing-target'), f.path);
  expect(() => map.readBinding(f.id)).toThrow('COMPUTER_SESSION_STORE_REFUSED');
  expect(f.endpoint).not.toHaveBeenCalled();
});

it.each([
  {
    name: 'duplicate session ids',
    hydrationError: Error,
    contents: JSON.stringify([
      { sessionId: 'one', ocSessionId: 'ses_one' },
      { sessionId: 'one', ocSessionId: 'ses_two' },
    ]),
  },
  {
    name: 'duplicate native ids',
    hydrationError: Error,
    contents: JSON.stringify([
      { sessionId: 'one', ocSessionId: 'ses_one' },
      { sessionId: 'two', ocSessionId: 'ses_one' },
    ]),
  },
  { name: 'malformed JSON', hydrationError: SyntaxError, contents: '{' },
])(
  'refuses invalid $name for both hydration and strict live reads',
  ({ contents, hydrationError }) => {
    const f = fixture();
    new ComputerSessionMap(f.path).bind('other', 'ses_owned');
    const map = new ComputerSessionMap(f.path);
    writeFileSync(f.path, contents);
    expect(() => new ComputerSessionMap(f.path)).toThrow(hydrationError);
    expect(() => map.readBinding(f.id)).toThrow('COMPUTER_SESSION_STORE_REFUSED');
    expect(map.listAll()).toEqual([{ sessionId: 'other', ocSessionId: 'ses_owned' }]);
    expect(f.endpoint).not.toHaveBeenCalled();
  }
);

it('refuses a replacement private parent even when its file contents are valid', () => {
  const f = fixture();
  new ComputerSessionMap(f.path).bind('other', 'ses_owned');
  const map = new ComputerSessionMap(f.path);
  const moved = f.home + '-original';
  renameSync(f.home, moved);
  cleanups.push(() => rmSync(moved, { recursive: true, force: true }));
  mkdirSync(f.home, { mode: 0o700 });
  writeFileSync(f.path, JSON.stringify([{ sessionId: 'replacement', ocSessionId: 'ses_other' }]), {
    mode: 0o600,
  });
  expect(() => map.readBinding(f.id)).toThrow('COMPUTER_SESSION_STORE_REFUSED');
  expect(f.endpoint).not.toHaveBeenCalled();
});

it('refuses an unreadable valid private file without treating it as missing', () => {
  const f = fixture();
  new ComputerSessionMap(f.path).bind('other', 'ses_owned');
  const map = new ComputerSessionMap(f.path);
  chmodSync(f.path, 0o000);
  try {
    expect(() => map.readBinding(f.id)).toThrow('COMPUTER_SESSION_STORE_REFUSED');
  } finally {
    chmodSync(f.path, 0o600);
  }
  expect(f.endpoint).not.toHaveBeenCalled();
});
