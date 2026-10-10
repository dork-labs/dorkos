/** Hold the actual verified FILE descriptor; original installation retirement must drain it. */
import { expect, it, vi } from 'vitest';
import fs, { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from '@dorkos/db';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { toggleOriginalCheckboxWriter } from '../writes/checkbox-service.js';
import { stopInstallationFileWrites } from '../writes/installation-file-writes.js';
import { env as serverEnv } from '../../../../env.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

it('drains a held original verified FILE completion before permitting database cleanup', async () => {
  const dir = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'original-checkbox-held-completion-'))
  );
  const oldMode = serverEnv.DORKOS_TEST_RUNTIME;
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let failed = false,
    first: unknown,
    cleaned = false;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let selected = false,
    selectedCloses = 0,
    passSettled = false,
    stopSettled = false;
  let pass: Promise<PromiseSettledResult<unknown>> | undefined;
  let stop: Promise<void> | undefined;
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', randomUUID(), randomUUID(), {
      checkboxFile: true,
    });
    const actual = h,
      request = await actual.checkboxRequest(true);
    const originalEvents = actual.db.get<{
      n: number;
    }>(sql`SELECT count(*) AS n FROM canvas_doc_events
      WHERE document_id=${actual.documentId}`)!.n;
    const originalBatches = actual.db.get<{
      n: number;
    }>(sql`SELECT count(*) AS n FROM canvas_doc_batches
      WHERE document_id=${actual.documentId}`)!.n;
    const originalOpen = fs.open.bind(fs);
    vi.mocked(open).mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      // Observe the original persisted phase only after the genuine descriptor is acquired.
      const replaced =
        !selected &&
        String(file) === actual.checkboxPath &&
        flags === 'r' &&
        actual.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_write_intents
          WHERE document_id=${actual.documentId} AND status='replaced'`)!.n === 1;
      if (replaced) {
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
            await close();
            selectedCloses++;
          },
        });
      }
      return handle;
    });
    pass = toggleOriginalCheckboxWriter(actual.http.checkboxWriter, request, actual.operator).then(
      (value) => {
        passSettled = true;
        return { status: 'fulfilled' as const, value };
      },
      (reason: unknown) => {
        passSettled = true;
        return { status: 'rejected' as const, reason };
      }
    );
    // Early original refusal/fulfillment fails the control instead of leaving an entered wait hung.
    await Promise.race([
      acquired,
      pass.then((outcome) => {
        if (outcome.status === 'rejected') throw outcome.reason;
        throw new Error(
          'Original FILE operation completed before verified descriptor acquisition.'
        );
      }),
    ]);
    expect(selected).toBe(true);
    expect(passSettled).toBe(false);
    const publicStop = vi.spyOn(actual.http.checkboxWriter, 'stop').mockResolvedValue(undefined);
    stop = stopInstallationFileWrites(actual.http.fileWrites, actual.db, actual.http.channels);
    expect(
      stopInstallationFileWrites(actual.http.fileWrites, actual.db, actual.http.channels)
    ).toBe(stop);
    void stop.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      }
    );
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(publicStop).not.toHaveBeenCalled();
    expect(actual.db.$client.open).toBe(true);
    await expect(
      toggleOriginalCheckboxWriter(actual.http.checkboxWriter, request, actual.operator)
    ).rejects.toThrow();
    release();
    expect((await pass).status).toBe('rejected');
    await stop;
    expect(selectedCloses).toBe(1);
    expect(actual.db.$client.open).toBe(true);
    expect(
      actual.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_events
      WHERE document_id=${actual.documentId}`)!.n
    ).toBe(originalEvents);
    expect(
      actual.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_batches
      WHERE document_id=${actual.documentId}`)!.n
    ).toBe(originalBatches);
    expect((await fs.readFile(actual.checkboxPath!, 'utf8')).startsWith('- [x]')).toBe(true);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    release();
    const drains = await Promise.allSettled([...(pass ? [pass] : []), ...(stop ? [stop] : [])]);
    for (const outcome of drains)
      if (outcome.status === 'rejected' && !failed) {
        failed = true;
        first = outcome.reason;
      }
    vi.mocked(open).mockImplementation(fs.open.bind(fs));
    vi.restoreAllMocks();
    try {
      if (h) {
        await h.cleanup();
        cleaned = true;
      }
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (cleaned)
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    serverEnv.DORKOS_TEST_RUNTIME = oldMode;
  }
  if (failed) throw first;
});
