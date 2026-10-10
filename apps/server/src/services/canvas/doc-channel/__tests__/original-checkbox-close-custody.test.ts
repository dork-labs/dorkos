/** Actual acquired FILE close reporting failure must retain original drain and cleanup refusal. */
import { expect, it, vi } from 'vitest';
import fs, { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from '@dorkos/db';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { toggleOriginalCheckboxWriter } from '../writes/checkbox-service.js';
import { stopInstallationFileWrites } from '../writes/installation-file-writes.js';
import { currentRoomDueServicePort } from '../service.js';
import { env as serverEnv } from '../../../../env.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

it('retains raw undefined close failure, refuses original drain and leaves the native fixture intact', async () => {
  const dir = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'original-checkbox-close-custody-'))
  );
  const oldMode = serverEnv.DORKOS_TEST_RUNTIME;
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let failed = false,
    first: unknown;
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
  let pass: Promise<PromiseSettledResult<unknown>> | undefined, stop: Promise<void> | undefined;
  let pumpStop: Promise<void> | undefined;
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', randomUUID(), randomUUID(), {
      checkboxFile: true,
    });
    const actual = h,
      request = await actual.checkboxRequest(true);
    const originalOpen = fs.open.bind(fs);
    vi.mocked(open).mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (
        !selected &&
        String(file) === actual.checkboxPath &&
        flags === 'r' &&
        actual.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_write_intents
          WHERE document_id=${actual.documentId} AND status='replaced'`)!.n === 1
      ) {
        selected = true;
        const read = handle.read.bind(handle),
          close = handle.close.bind(handle);
        Object.defineProperty(handle, 'read', {
          value: async (buffer: Buffer, offset: number, length: number, position: number) => {
            entered();
            await held;
            return read(buffer, offset, length, position);
          },
        });
        Object.defineProperty(handle, 'close', {
          value: async () => {
            closeCalls++;
            // The original native handle really closes. Only its reported rejection is injected.
            await close();
            actualCloseSucceeded = true;
            throw undefined;
          },
        });
      }
      return handle;
    });
    pass = toggleOriginalCheckboxWriter(actual.http.checkboxWriter, request, actual.operator).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    await Promise.race([
      acquired,
      pass.then((outcome) => {
        if (outcome.status === 'rejected') throw outcome.reason;
        throw new Error('Original FILE operation completed before acquired replaced-source read.');
      }),
    ]);
    stop = stopInstallationFileWrites(actual.http.fileWrites, actual.db, actual.http.channels);
    // Attach the refusal observer before releasing the genuine held continuation.
    const stopOutcome = stop.then(
      () => ({ status: 'fulfilled' as const }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    release();
    const operation = await pass,
      retirement = await stopOutcome;
    expect(operation.status).toBe('rejected');
    if (operation.status === 'rejected') {
      // Stop already retired the original boundary while the actual read was held.
      // Its resumed assertFs is the first body failure; later close undefined is
      // separately retained by the original stop/cleanup custody below.
      expect(operation.reason).toBeInstanceOf(Error);
      expect(operation.reason).toHaveProperty('message', 'Checkbox writes are not available.');
    }
    expect(retirement.status).toBe('rejected');
    if (retirement.status === 'rejected') expect(retirement.reason).toBeUndefined();
    expect(closeCalls).toBe(1);
    expect(actualCloseSucceeded).toBe(true);
    expect(
      stopInstallationFileWrites(actual.http.fileWrites, actual.db, actual.http.channels)
    ).toBe(stop);
    await expect(
      toggleOriginalCheckboxWriter(actual.http.checkboxWriter, request, actual.operator)
    ).rejects.toBeUndefined();
    const remove = vi.spyOn(fs, 'rm');
    await expect(actual.cleanup()).rejects.toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
    expect(actual.db.$client.open).toBe(true);
    expect((await fs.lstat(actual.file)).isFile()).toBe(true);
    expect((await fs.readFile(actual.checkboxPath!, 'utf8')).startsWith('- [x]')).toBe(true);
    expect(
      actual.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_write_intents
      WHERE document_id=${actual.documentId}`)!.n
    ).toBe(1);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    release();
    if (h) {
      try {
        stop ??= stopInstallationFileWrites(h.http.fileWrites, h.db, h.http.channels);
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      try {
        pumpStop = currentRoomDueServicePort(h.http.service).stopPump();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    const ownedContinuations = [
      ...(pass ? [{ kind: 'operation', promise: pass }] : []),
      ...(stop ? [{ kind: 'installation', promise: stop }] : []),
      ...(pumpStop ? [{ kind: 'pump', promise: pumpStop }] : []),
    ];
    const continuations = await Promise.allSettled(
      ownedContinuations.map((value) => value.promise)
    );
    let ownsSettledContinuations = !!h && !!stop && !!pumpStop && actualCloseSucceeded;
    // A rejected original close drain is expected; every continuation still must settle.
    for (const [index, outcome] of continuations.entries())
      if (outcome.status === 'rejected') {
        if (
          ownedContinuations[index].kind === 'installation' &&
          actualCloseSucceeded &&
          outcome.reason === undefined
        )
          continue;
        ownsSettledContinuations = false;
        if (!failed) {
          failed = true;
          first = outcome.reason;
        }
      }
    vi.mocked(open).mockImplementation(fs.open.bind(fs));
    vi.restoreAllMocks();
    if (h && ownsSettledContinuations) {
      // Test-only custody: actual FD close success was observed above and all original admissions
      // are closed/drained. Close only this fixture's original DB handle, retaining both directories.
      try {
        if (h.db.$client.open) h.db.$client.close();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    if (h) {
      try {
        await fs.writeFile(
          join(dir, 'CONTROL-RESOURCE-CUSTODY.json'),
          JSON.stringify({
            role: 'original checkbox close-reporting negative control',
            ownedDirectory: dir,
            nativeFixtureDirectory: h.dir,
            databaseFile: h.file,
            actualCloseSucceeded,
            settledContinuations: ownsSettledContinuations,
            databaseOpen: h.db.$client.open,
            removal: 'REFUSED_AND_RETAINED',
          })
        );
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    // No recursive removal is authorized by a reported native close failure.
    serverEnv.DORKOS_TEST_RUNTIME = oldMode;
  }
  if (failed) throw first;
});
