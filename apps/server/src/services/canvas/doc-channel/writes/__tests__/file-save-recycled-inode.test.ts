/** DOR-3409: a recycled inode must not fence an unrelated new file; a real conflict still must. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { sql } from '@dorkos/db';
import { CanvasDocIncarnationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { initBoundary } from '../../../../../lib/boundary.js';
import { fixture } from './checkbox-fixture.js';
import { saveOriginalDocumentFile } from '../installation-file-writes.js';
import {
  assertFileSaveAdmission,
  fileBirthMs,
  FileSaveWriteFencedError,
  readFileSaveIntent,
} from '../file-save-intents.js';
import type { CanonicalFileIdentity } from '../canonical-writer.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Run `fn` as if on `platform`: the exemption is Linux-only, and CI and laptops differ. */
function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** One real in-doubt original save: its row keeps the replaced original's device+inode. */
async function inDoubtSave(aliasName?: string) {
  const h = await fixture();
  cleanups.push(h.cleanup);
  await initBoundary(h.dir);
  cleanups.push(() => h.http.fileWrites.stop());
  // A hard link made BEFORE the save keeps the original inode alive after the rename replaces it.
  const alias = aliasName ? join(h.dir, aliasName) : undefined;
  if (alias) await fs.link(h.path, alias);
  const snapshot = await h.http.service.replay(h.documentId, h.actor);
  const incarnation = CanvasDocIncarnationSchema.parse(snapshot.incarnation);
  const before = await fs.readFile(h.path, 'utf8');
  h.db.run(
    sql`CREATE TRIGGER refuse_saved_receipt BEFORE INSERT ON canvas_doc_events WHEN NEW.type='doc.saved' BEGIN SELECT RAISE(ABORT,'saved receipt unavailable'); END`
  );
  const eventId = randomUUID();
  await expect(
    saveOriginalDocumentFile(
      h.http.fileWrites,
      {
        cwd: h.dir,
        path: h.path,
        content: 'bytes whose receipt was lost',
        expectedContent: before,
        documentSave: { documentId: h.documentId, eventId, incarnation },
      },
      { headers: {} }
    )
  ).rejects.toThrow('saved receipt unavailable');
  const row = readFileSaveIntent(h.db, h.documentId, eventId)!;
  expect(row.status).toBe('in_doubt');
  return { h, row, alias };
}

it('a new file that reuses the freed original inode is not fenced; unknown or early birth still is', async () => {
  const { h, row } = await inDoubtSave();
  const created = Date.parse(row.createdAt);
  // Linux hands a freed inode to the next file; model that file deterministically.
  const reused: CanonicalFileIdentity = {
    canonicalPath: join(h.dir, 'unrelated-new-file.txt'),
    device: row.beforeDevice,
    inode: row.beforeInode,
  };
  onPlatform('linux', () =>
    expect(() =>
      assertFileSaveAdmission(h.db, reused, undefined, () => created + 60_000)
    ).not.toThrow()
  );
  // Fail closed: no birth time, a birth inside the clock margin, or a birth before the row.
  for (const born of [undefined, created + 1_000, created - 1_000])
    onPlatform('linux', () =>
      expect(() => assertFileSaveAdmission(h.db, reused, undefined, () => born)).toThrow(
        FileSaveWriteFencedError
      )
    );
});

it('off Linux, the original-inode match still fences even a file born later (owners can set APFS creation dates)', async () => {
  const { h, row } = await inDoubtSave();
  const reused: CanonicalFileIdentity = {
    canonicalPath: join(h.dir, 'unrelated-new-file.txt'),
    device: row.beforeDevice,
    inode: row.beforeInode,
  };
  const late = () => Date.parse(row.createdAt) + 60_000;
  for (const platform of ['darwin', 'win32'] as const)
    onPlatform(platform, () =>
      expect(() => assertFileSaveAdmission(h.db, reused, undefined, late)).toThrow(
        FileSaveWriteFencedError
      )
    );
});

it('a real conflicting edit is still fenced: same path, the replacement inode, and a surviving hard link', async () => {
  const { h, row, alias } = await inDoubtSave('alias-of-original.txt');
  const late = () => Date.parse(row.createdAt) + 60_000;
  const physical = await fs.stat(h.path, { bigint: true });
  const samePath = {
    canonicalPath: await fs.realpath(h.path),
    device: String(physical.dev),
    inode: String(physical.ino),
  };
  expect(() => assertFileSaveAdmission(h.db, samePath, undefined, late)).toThrow(
    FileSaveWriteFencedError
  );
  const replacement = {
    canonicalPath: join(h.dir, 'elsewhere.txt'),
    device: row.replacementDevice!,
    inode: row.replacementInode!,
  };
  expect(() => assertFileSaveAdmission(h.db, replacement, undefined, late)).toThrow(
    FileSaveWriteFencedError
  );
  // The hard link IS the original inode, born before the row: the real birth time keeps it fenced.
  const linked = await fs.stat(alias!, { bigint: true });
  expect(String(linked.ino)).toBe(row.beforeInode);
  const aliasIdentity = {
    canonicalPath: await fs.realpath(alias!),
    device: String(linked.dev),
    inode: String(linked.ino),
  };
  expect(() => assertFileSaveAdmission(h.db, aliasIdentity)).toThrow(FileSaveWriteFencedError);
});

it('fileBirthMs reads only the file the identity names, and never guesses', async () => {
  const { h } = await inDoubtSave();
  const info = await fs.stat(h.path, { bigint: true });
  const identity = { canonicalPath: h.path, device: String(info.dev), inode: String(info.ino) };
  const born = fileBirthMs(identity);
  // A filesystem without birth times reads as unknown; with one, it is this file's recent birth.
  if (born !== undefined) expect(Math.abs(born - Date.now())).toBeLessThan(5 * 60_000);
  expect(fileBirthMs({ ...identity, inode: `${identity.inode}0` })).toBeUndefined();
  expect(fileBirthMs({ ...identity, canonicalPath: join(h.dir, 'missing.txt') })).toBeUndefined();
});
