/**
 * The in-process (Obsidian) transport honours the same upload contract the HTTP
 * one does — in particular, that a cancel actually lands (DOR-494).
 *
 * Real filesystem, real temp directory: the whole point of this transport is
 * that it writes files, and a mocked `fs` would let a "cancelled" upload leave
 * something on disk without any test noticing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectSystemMethods } from '../system-methods';
import { UPLOAD_CANCELED_MESSAGE } from '../../transport/upload-contract';
import type { DirectTransportServices } from '../services';
import type { UploadFile } from '@dorkos/shared/transport';

let cwd: string;

const methods = () => createDirectSystemMethods({} as DirectTransportServices);
const uploadDir = () => join(cwd, '.dork', '.temp', 'uploads');

/** A file whose bytes are produced by `read`, so a test can act mid-upload. */
function fileNamed(name: string, read: () => void = () => {}): UploadFile {
  return {
    name,
    type: 'text/plain',
    size: 4,
    arrayBuffer: () => {
      read();
      return Promise.resolve(new ArrayBuffer(4));
    },
  } as UploadFile;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dorkos-direct-upload-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('direct uploadFiles', () => {
  it('writes the files when nothing cancels', async () => {
    const results = await methods().uploadFiles([fileNamed('notes.txt')], cwd);

    expect(results).toHaveLength(1);
    expect(await readdir(uploadDir())).toHaveLength(1);
  });

  // The case that used to be impossible to cancel at all: with one file, the
  // loop had already passed its only checkpoint by the time anyone could press
  // the button, so the upload reported SUCCESS moments after Cancel and the
  // message went out carrying the attachment the person had just stopped.
  it('cancels a single-file upload raised while it is being read', async () => {
    const controller = new AbortController();
    const file = fileNamed('notes.txt', () => controller.abort());

    await expect(methods().uploadFiles([file], cwd, undefined, controller.signal)).rejects.toThrow(
      UPLOAD_CANCELED_MESSAGE
    );
  });

  it('leaves nothing behind when it cancels', async () => {
    const controller = new AbortController();
    const file = fileNamed('notes.txt', () => controller.abort());

    await expect(methods().uploadFiles([file], cwd, undefined, controller.signal)).rejects.toThrow(
      UPLOAD_CANCELED_MESSAGE
    );

    // A cancelled upload must not seed the agent's temp directory with a file
    // nobody asked it to read.
    expect(await readdir(uploadDir())).toEqual([]);
  });

  it('cancels the rest of a batch and removes what it already wrote', async () => {
    const controller = new AbortController();
    const files = [fileNamed('first.txt'), fileNamed('second.txt', () => controller.abort())];

    await expect(methods().uploadFiles(files, cwd, undefined, controller.signal)).rejects.toThrow(
      UPLOAD_CANCELED_MESSAGE
    );

    expect(await readdir(uploadDir())).toEqual([]);
  });

  it('refuses before reading anything when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let read = false;

    await expect(
      methods().uploadFiles(
        [
          fileNamed('notes.txt', () => {
            read = true;
          }),
        ],
        cwd,
        undefined,
        controller.signal
      )
    ).rejects.toThrow(UPLOAD_CANCELED_MESSAGE);

    expect(read).toBe(false);
  });
});
