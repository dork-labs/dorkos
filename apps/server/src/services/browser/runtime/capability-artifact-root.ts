import { constants } from 'node:fs';
import { mkdtemp, realpath, lstat, rmdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Original private staging acquisition, never a directory taken from an HTTP or tool argument. */
export function createCapabilityArtifactRoot() {
  let closed = false;
  let acquisition: Promise<Readonly<{ directory: string; dev: number; ino: number }>> | undefined;
  let closing: Promise<void> | undefined;
  let raw: string | undefined;
  let first: Readonly<{ value: unknown }> | undefined;
  const fail = (value: unknown) => {
    first ??= Object.freeze({ value });
  };
  const acquire = () => {
    if (closed) throw new Error('BROWSER_CAPABILITY_CLOSED');
    if (acquisition) return acquisition;
    // Assignment precedes the filesystem producer, so close always joins late acquisition.
    acquisition = Promise.resolve().then(async () => {
      if (closed) throw new Error('BROWSER_CAPABILITY_CLOSED');
      raw = await mkdtemp(join(tmpdir(), 'dorkos-browser-capabilities-'));
      // A no-follow original handle identifies the created directory before canonicalization.
      const descriptor = await open(
        raw,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      let acquired: Readonly<{ directory: string; dev: number; ino: number }> | undefined;
      let failure: Readonly<{ value: unknown }> | undefined;
      try {
        const original = await descriptor.stat();
        const rawBefore = await lstat(raw);
        if (
          !original.isDirectory() ||
          !rawBefore.isDirectory() ||
          rawBefore.isSymbolicLink() ||
          rawBefore.dev !== original.dev ||
          rawBefore.ino !== original.ino
        )
          throw new Error('BROWSER_ARTIFACT_ROOT_REFUSED');
        const directory = await realpath(raw);
        const rawAfter = await lstat(raw),
          canonical = await lstat(directory);
        if (
          !rawAfter.isDirectory() ||
          rawAfter.isSymbolicLink() ||
          !canonical.isDirectory() ||
          canonical.isSymbolicLink() ||
          rawAfter.dev !== original.dev ||
          rawAfter.ino !== original.ino ||
          canonical.dev !== original.dev ||
          canonical.ino !== original.ino
        )
          throw new Error('BROWSER_ARTIFACT_ROOT_REFUSED');
        acquired = Object.freeze({
          directory,
          dev: original.dev,
          ino: original.ino,
        });
      } catch (value) {
        failure = { value };
      }
      // The original descriptor return is joined even when canonicalization rejects falsy.
      try {
        await descriptor.close();
      } catch (value) {
        failure ??= { value };
      }
      if (failure) throw failure.value;
      if (!acquired) throw new Error('BROWSER_ARTIFACT_ROOT_REFUSED');
      return acquired;
    });
    void acquisition.catch(fail);
    return acquisition;
  };
  const close = (release: () => Promise<void>): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      // Failure of native/artifact release preserves the private root and original first cause.
      let released = false;
      try {
        await release();
        released = true;
      } catch (value) {
        fail(value);
      }
      let acquired: Awaited<ReturnType<typeof acquire>> | undefined;
      if (acquisition) {
        try {
          acquired = await acquisition;
        } catch (value) {
          fail(value);
        }
      }
      if (released && raw && acquired) {
        try {
          const directory = await realpath(raw),
            stat = await lstat(directory);
          if (
            directory !== acquired.directory ||
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.dev !== acquired.dev ||
            stat.ino !== acquired.ino
          )
            throw new Error('BROWSER_ARTIFACT_ROOT_REFUSED');
          // No recursive deletion: unexpected retained files make cleanup fail closed.
          await rmdir(directory);
        } catch (value) {
          fail(value);
        }
      }
      if (first) throw first.value;
    });
    return closing;
  };
  return Object.freeze({ acquire, close });
}
