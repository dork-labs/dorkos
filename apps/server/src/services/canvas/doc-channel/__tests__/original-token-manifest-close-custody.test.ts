/** Genuine acquired manifest close-reporting failure; SOURCE UNRUN. */
import { expect, it, vi } from 'vitest';
import nativeFs from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

it('retains earliest manifest close UNKNOWN while positively draining the original Room peer', async () => {
  // The production reader captures closeSync at module construction. Select the literal fault
  // before fresh original modules load, without replacing the reader or its owner recognition.
  const mark = shard2BodyPhases();
  mark('begin');
  vi.resetModules();
  const actualClose = nativeFs.closeSync,
    actualFstat = nativeFs.fstatSync;
  let armed = false,
    selected = false,
    actualCloseSucceeded = false,
    closeCalls = 0;
  let inode: { dev: number; ino: number } | undefined;
  const closeSpy = vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
    const row = actualFstat(fd);
    if (armed && !selected && inode && row.dev === inode.dev && row.ino === inode.ino) {
      selected = true;
      closeCalls++;
      actualClose(fd);
      actualCloseSucceeded = true;
      throw undefined;
    }
    actualClose(fd);
  });
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'original-token-manifest-close-'))
  );
  let h:
    | Awaited<
        ReturnType<
          typeof import('../writes/__tests__/authority-fixtures.js').nativeRoomAuthorityFixture
        >
      >
    | undefined;
  let failed = false,
    first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  let drain: Promise<void> | undefined;
  let services: typeof import('../service.js') | undefined;
  let stopWriter:
    typeof import('../writes/installation-file-writes.js').stopInstallationFileWrites | undefined;
  try {
    const { nativeRoomAuthorityFixture } =
      await import('../writes/__tests__/authority-fixtures.js');
    mark('authority-import-return');
    services = await import('../service.js');
    mark('service-import-return');
    const {
      issueServiceOriginalDocToken,
      currentRoomDueServicePort,
      readServiceOriginalTokenDrainData,
    } = services;
    const { stopInstallationFileWrites } = await import('../writes/installation-file-writes.js');
    stopWriter = stopInstallationFileWrites;
    mark('writer-import-return');
    h = await nativeRoomAuthorityFixture(root, 'codex', randomUUID(), randomUUID(), {
      checkboxFile: true,
    });
    mark('fixture-return');
    const own = h,
      port = currentRoomDueServicePort(own.http.service);
    port.nextDueAt(); // Actual original constructor, not a timer/holder stand-in.
    expect(readServiceOriginalTokenDrainData(own.http.service).roomConstructed).toBe(true);
    await fs.mkdir(join(root, '.dork'), { recursive: true });
    const manifest = join(root, '.dork', 'app.json');
    await fs.writeFile(manifest, '{}');
    const stat = await fs.stat(manifest);
    inode = { dev: stat.dev, ino: stat.ino };
    armed = true;
    mark('manifest-ready');
    // Compilation and INSERT are never reached: this asserts earliest real acquired FD custody.
    await expect(
      issueServiceOriginalDocToken(
        own.http.service,
        own.operator,
        {
          documentId: own.documentId,
          allowedTypes: ['md.comment'],
          directions: ['upstream'],
          permissions: ['replay'],
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        [own.granted.grant.grantId]
      )
    ).rejects.toBeUndefined();
    mark('issue-close-observed');
    expect(selected).toBe(true);
    expect(actualCloseSucceeded).toBe(true);
    expect(closeCalls).toBe(1);
    armed = false;
    drain = port.stopPump();
    mark('drain-start-return');
    await expect(drain).rejects.toBeUndefined();
    mark('drain-observed');
    expect(port.stopPump()).toBe(drain);
    expect(readServiceOriginalTokenDrainData(own.http.service)).toEqual({
      roomPeerClosed: true,
      roomConstructed: true,
      activeTokenOperations: 0,
      liveTokenStreams: 0,
    });
    // Parent child custody remains UNKNOWN; it must not close Db or remove either source/Db directory.
    const remove = vi.spyOn(fs, 'rm');
    await expect(own.cleanup()).rejects.toBeUndefined();
    mark('custody-cleanup-observed');
    expect(remove).not.toHaveBeenCalled();
    expect(own.db.$client.open).toBe(true);
    expect((await fs.stat(own.file)).isFile()).toBe(true);
    expect((await fs.stat(manifest)).isFile()).toBe(true);
    await stopInstallationFileWrites(own.http.fileWrites, own.db, own.http.channels);
    mark('writer-stop-return');
  } catch (cause) {
    remember(cause);
  } finally {
    armed = false;
    try {
      closeSpy.mockRestore();
    } catch (cause) {
      remember(cause);
    }
    if (h) {
      // These exact actual helpers were captured before h was acquired; no fallible cleanup imports.
      const { currentRoomDueServicePort, readServiceOriginalTokenDrainData } = services!;
      const stopInstallationFileWrites = stopWriter!;
      // Start both original drains independently, even after a failed assertion.
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => currentRoomDueServicePort(h!.http.service).stopPump()),
        Promise.resolve().then(() =>
          stopInstallationFileWrites(h!.http.fileWrites, h!.db, h!.http.channels)
        ),
      ]);
      mark('final-drains-return');
      if (outcomes[0]!.status !== 'rejected' || outcomes[0]!.reason !== undefined)
        remember(new Error('Original manifest drain did not retain its raw failure.'));
      if (outcomes[1]!.status === 'rejected') remember(outcomes[1]!.reason);
      let closedPeers: boolean;
      try {
        const data = readServiceOriginalTokenDrainData(h.http.service);
        closedPeers =
          outcomes[1]!.status === 'fulfilled' &&
          actualCloseSucceeded &&
          data.roomPeerClosed &&
          data.activeTokenOperations === 0 &&
          data.liveTokenStreams === 0;
      } catch (cause) {
        closedPeers = false;
        remember(cause);
      }
      // Test-only final close uses observed actual FD success and original peer witnesses. No recursive rm.
      if (closedPeers)
        try {
          if (h.db.$client.open) h.db.$client.close();
        } catch (cause) {
          remember(cause);
        }
      try {
        await fs.writeFile(
          join(root, 'CONTROL-RESOURCE-CUSTODY.json'),
          JSON.stringify({
            role: 'original earliest manifest close-reporting negative control',
            ownedDirectory: root,
            nativeFixtureDirectory: h.dir,
            databaseFile: h.file,
            actualCloseSucceeded,
            closedPeers,
            databaseOpen: h.db.$client.open,
            removal: 'REFUSED_AND_RETAINED',
          })
        );
      } catch (cause) {
        remember(cause);
      }
    }
    try {
      vi.restoreAllMocks();
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw first;
});

/** Temporary bounded scalar diagnostic; original body operations remain unchanged. */
let shard2BodyPhaseRows = 0;
function shard2BodyPhases() {
  let start = NaN;
  let previous = NaN;
  try {
    start = performance.now();
    previous = start;
  } catch {
    /* secondary diagnostic */
  }
  return (
    phase:
      | 'begin'
      | 'authority-import-return'
      | 'service-import-return'
      | 'writer-import-return'
      | 'fixture-return'
      | 'manifest-ready'
      | 'issue-close-observed'
      | 'drain-start-return'
      | 'drain-observed'
      | 'custody-cleanup-observed'
      | 'writer-stop-return'
      | 'final-drains-return'
  ): void => {
    try {
      if (shard2BodyPhaseRows >= 128) return;
      const now = performance.now();
      const elapsed = now - start;
      if (
        !Number.isFinite(start) ||
        start < 0 ||
        !Number.isFinite(now) ||
        now < previous ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed > 600000
      )
        return;
      previous = now;
      const row = '[doc-shard2-body-phase] manifest-custody ' + phase + ' ' + elapsed.toFixed(3);
      if (row.length > 255) return;
      shard2BodyPhaseRows++;
      console.error(row);
    } catch {
      /* Clock or logger failure never replaces the original cause. */
    }
  };
}
