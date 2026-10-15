/** Actual acquired async authority manifest: operation cause and close custody are distinct. */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from '@dorkos/db';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { toggleOriginalCheckboxWriter } from '../writes/checkbox-service.js';
import { stopInstallationFileWrites } from '../writes/installation-file-writes.js';
import { currentRoomDueServicePort } from '../service.js';

it.each(['undefined', 'error'] as const)(
  'keeps the first %s manifest read cause and refuses original writer shutdown on separate close failure',
  async (kind) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'authority-manifest-close-')));
    const readCause =
      kind === 'undefined' ? undefined : new Error('Original manifest read failed.');
    const closeCause = new Error('Original manifest close reported failure.');
    let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
    let failed = false,
      first: unknown;
    const remember = (cause: unknown) => {
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let selected = false,
      actualCloseSucceeded = false,
      closeCalls = 0;
    let manifestHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let operation: Promise<PromiseSettledResult<unknown>> | undefined;
    let stop: Promise<void> | undefined, pumpStop: Promise<void> | undefined;
    try {
      h = await nativeRoomAuthorityFixture(root, 'claude-code', randomUUID(), randomUUID(), {
        checkboxFile: true,
      });
      const own = h,
        request = await own.checkboxRequest(true);
      await fs.mkdir(join(root, '.dork'), { recursive: true });
      const manifest = join(root, '.dork', 'app.json');
      await fs.writeFile(manifest, JSON.stringify({ v: 1, types: {} }));
      const originalOpen = fs.open.bind(fs);
      // Production authority owns the default fs receiver. Capture its actual open
      // before installing this spy so delegation cannot recurse through the mock.
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (!selected && String(file) === manifest) {
          selected = true;
          manifestHandle = handle;
          const read = handle.read.bind(handle),
            close = handle.close.bind(handle);
          Object.defineProperty(handle, 'read', {
            value: async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null
            ) => {
              // The original FD really reads. Only the reported read continuation is injected.
              await read(buffer, offset, length, position);
              entered();
              await held;
              throw readCause;
            },
          });
          Object.defineProperty(handle, 'close', {
            value: async () => {
              closeCalls++;
              await close();
              actualCloseSucceeded = true;
              throw closeCause;
            },
          });
        }
        return handle;
      });
      operation = toggleOriginalCheckboxWriter(own.http.checkboxWriter, request, own.operator).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      );
      await Promise.race([
        acquired,
        operation.then((outcome) => {
          if (outcome.status === 'rejected') throw outcome.reason;
          throw new Error('Original operation completed without acquiring the manifest handle.');
        }),
      ]);
      stop = stopInstallationFileWrites(own.http.fileWrites, own.db, own.http.channels);
      const retirement = stop.then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      );
      release();
      const outcome = await operation,
        stopped = await retirement;
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(outcome.reason).toBe(readCause);
      expect(stopped.status).toBe('rejected');
      if (stopped.status === 'rejected') expect(stopped.reason).toBe(closeCause);
      expect(selected).toBe(true);
      expect(actualCloseSucceeded).toBe(true);
      expect(closeCalls).toBe(1);
      expect(manifestHandle).toBeDefined();
      await expect(manifestHandle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
      expect(stopInstallationFileWrites(own.http.fileWrites, own.db, own.http.channels)).toBe(stop);
      await expect(
        toggleOriginalCheckboxWriter(own.http.checkboxWriter, request, own.operator)
      ).rejects.toBe(closeCause);
      const remove = vi.spyOn(fs, 'rm');
      await expect(own.cleanup()).rejects.toBe(closeCause);
      expect(remove).not.toHaveBeenCalled();
      expect(own.db.$client.open).toBe(true);
      expect((await fs.stat(own.file)).isFile()).toBe(true);
      expect((await fs.stat(manifest)).isFile()).toBe(true);
      expect((await fs.readFile(own.checkboxPath!, 'utf8')).startsWith('- [ ]')).toBe(true);
      expect(
        own.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_write_intents
        WHERE document_id=${own.documentId}`)!.n
      ).toBe(0);
    } catch (cause) {
      remember(cause);
    } finally {
      release();
      if (h) {
        try {
          stop ??= stopInstallationFileWrites(h.http.fileWrites, h.db, h.http.channels);
        } catch (cause) {
          remember(cause);
        }
        try {
          pumpStop = currentRoomDueServicePort(h.http.service).stopPump();
        } catch (cause) {
          remember(cause);
        }
      }
      const continuations = [
        ...(operation ? [{ kind: 'operation', promise: operation }] : []),
        ...(stop ? [{ kind: 'installation', promise: stop }] : []),
        ...(pumpStop ? [{ kind: 'pump', promise: pumpStop }] : []),
      ];
      const settled = await Promise.allSettled(continuations.map((value) => value.promise));
      let closedPeers = !!h && !!stop && !!pumpStop && actualCloseSucceeded;
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status !== 'rejected') continue;
        if (
          continuations[index].kind === 'installation' &&
          actualCloseSucceeded &&
          outcome.reason === closeCause
        )
          continue;
        closedPeers = false;
        remember(outcome.reason);
      }
      try {
        vi.restoreAllMocks();
      } catch (cause) {
        remember(cause);
      }
      if (h && closedPeers) {
        // Test-only final FD success + settled original peers; original semantic shutdown is UNKNOWN.
        // Retain both directories. Never authorize recursive removal from the test observation.
        try {
          if (h.db.$client.open) h.db.$client.close();
        } catch (cause) {
          remember(cause);
        }
      }
      if (h)
        try {
          await fs.writeFile(
            join(root, 'CONTROL-RESOURCE-CUSTODY.json'),
            JSON.stringify({
              role: 'original async authority manifest read/close negative control',
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
    if (failed) throw first;
  }
);
