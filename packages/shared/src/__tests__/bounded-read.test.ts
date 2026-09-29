import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { Stats } from 'node:fs';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CATALOG_MAX_BYTES,
  PACKAGE_TEXT_MAX_BYTES,
  TooLargeError,
  UnsafeFileError,
  readPackageFileHooks,
  readPackageFileWithin,
  readResponseTextWithin,
  readTextFileWithin,
  readTextFileWithinSync,
} from '../bounded-read.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dorkos-bounded-read-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readTextFileWithin', () => {
  // Purpose: a file at or under the cap reads exactly like readFile(…, 'utf-8'),
  // BOM included, so callers see no change.
  it('reads a file within the limit exactly as readFile does', async () => {
    const file = path.join(dir, 'a.md');
    const text = '\uFEFF---\nname: é\n---\nbody\n';
    await writeFile(file, text);
    expect(await readTextFileWithin(file, 1024, 'This file')).toBe(text);
  });

  // Purpose: the boundary is inclusive: exactly the limit reads, one byte over
  // is refused.
  it('reads a file of exactly the limit and refuses one byte more', async () => {
    const file = path.join(dir, 'b.md');
    await writeFile(file, 'x'.repeat(100));
    expect(await readTextFileWithin(file, 100, 'This file')).toHaveLength(100);
    await writeFile(file, 'x'.repeat(101));
    await expect(readTextFileWithin(file, 100, 'This file')).rejects.toBeInstanceOf(TooLargeError);
  });

  // Purpose: the refusal reads in plain words and names the limit.
  it('says what is too large and by how much', async () => {
    const file = path.join(dir, 'c.md');
    await writeFile(file, 'x'.repeat(3 * 1024 * 1024));
    await expect(readTextFileWithin(file, 1024 * 1024, 'The SKILL.md')).rejects.toThrow(
      'The SKILL.md is larger than 1 MB, which is more than DorkOS will read.'
    );
  });

  // Purpose: the read loop is the guarantee, not the size check before it:
  // a file that reports a small size but holds more is still stopped.
  it('stops a file that holds more than its reported size', async () => {
    const file = path.join(dir, 'grows.md');
    await writeFile(file, 'x'.repeat(4096));
    const probe = await open(file, 'r');
    const proto = Object.getPrototypeOf(probe) as { stat: () => Promise<Stats> };
    await probe.close();
    const realStat = proto.stat;
    const spy = vi.spyOn(proto, 'stat').mockImplementation(async function (this: unknown) {
      const stats = await realStat.call(this);
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { size: 10 });
    });
    try {
      await expect(readTextFileWithin(file, 1024, 'The file')).rejects.toBeInstanceOf(
        TooLargeError
      );
    } finally {
      spy.mockRestore();
    }
  });

  // Purpose: a link to a pipe, a terminal or stdin would hold a thread-pool
  // thread forever. The file opens without blocking and anything but a regular
  // file is refused, quickly.
  it.skipIf(process.platform === 'win32').each([
    ['a named pipe with no writer', 'fifo'],
    ['a link to /dev/stdin', 'stdin'],
    ['a link to a directory', 'dir'],
  ])('refuses %s without waiting', async (_label, kind) => {
    const target = path.join(dir, 'target');
    if (kind === 'fifo') execFileSync('mkfifo', [target]);
    else if (kind === 'stdin') await symlink('/dev/stdin', target);
    else await symlink(dir, target);
    const started = Date.now();
    const error = await readTextFileWithin(target, 1024, 'The file').then(
      () => new Error('read'),
      (err: unknown) => err as Error
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    // /dev/stdin may itself be missing where the test runs without a terminal
    // or pipe (Linux CI gives ENXIO at open). Either way the read is refused
    // at once; where it opens, it is refused as not a regular file.
    if ((error as NodeJS.ErrnoException).code === 'ENXIO') return;
    expect(error.message).toBe('The file is not a regular file, so DorkOS will not read it.');
  });

  // Purpose: other read errors pass through unchanged, so callers that treat
  // a missing file as "absent" keep doing so.
  it('passes a missing-file error through', async () => {
    await expect(
      readTextFileWithin(path.join(dir, 'missing.md'), 1024, 'This file')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/** A response whose body arrives in chunks, recording how much was pulled. */
function chunkedResponse(
  chunks: string[],
  headers: Record<string, string> = {}
): { response: Response; pulled: () => number; cancelled: () => boolean } {
  let index = 0;
  let pulledBytes = 0;
  let wasCancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const bytes = encoder.encode(chunks[index++]);
      pulledBytes += bytes.length;
      controller.enqueue(bytes);
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return {
    response: new Response(body, { headers }),
    pulled: () => pulledBytes,
    cancelled: () => wasCancelled,
  };
}

describe('readResponseTextWithin', () => {
  // Purpose: a body within the limit decodes exactly as response.text() does.
  it('reads a body within the limit exactly as response.text() does', async () => {
    const text = '\uFEFF{"name": "é"}';
    const { response } = chunkedResponse([text.slice(0, 3), text.slice(3)]);
    expect(await readResponseTextWithin(response, 1024, 'The catalog')).toBe(
      await new Response(text).text()
    );
  });

  // Purpose: a body that runs past the limit is refused while streaming, and
  // the rest of the body is never pulled: the stream is cancelled.
  it('stops reading and cancels the body once it passes the limit', async () => {
    const chunk = 'x'.repeat(1024);
    const { response, pulled, cancelled } = chunkedResponse(Array(100).fill(chunk));
    await expect(readResponseTextWithin(response, 4 * 1024, 'The catalog')).rejects.toThrow(
      TooLargeError
    );
    expect(pulled()).toBeLessThanOrEqual(6 * 1024);
    expect(cancelled()).toBe(true);
  });

  // Purpose: a declared length over the limit is refused before any byte is read.
  it('refuses a declared content-length over the limit without reading', async () => {
    const { response, pulled, cancelled } = chunkedResponse(['x'], {
      'content-length': String(10 * 1024 * 1024),
    });
    await expect(readResponseTextWithin(response, 1024, 'The catalog')).rejects.toThrow(
      'The catalog is larger than 1 KB, which is more than DorkOS will read.'
    );
    expect(pulled()).toBe(0);
    expect(cancelled()).toBe(true);
  });

  // Purpose: an empty body is an empty string, not an error.
  it('reads an empty body', async () => {
    expect(await readResponseTextWithin(new Response(null), 10, 'The catalog')).toBe('');
  });
});

describe('the limits sit well above real files', () => {
  // Purpose: the largest real marketplace.json seen is ~188 KB (Anthropic's
  // official catalog) and the largest SKILL.md ~65 KB; both limits leave more
  // than 10x headroom, and a change that shrank them would fail here.
  it('keeps at least 10x headroom over the largest real files', () => {
    expect(CATALOG_MAX_BYTES).toBeGreaterThanOrEqual(10 * 188 * 1024);
    expect(PACKAGE_TEXT_MAX_BYTES).toBeGreaterThanOrEqual(10 * 65 * 1024);
  });
});

describe('readPackageFileWithin', () => {
  const SECRET = 'host-secret-7f3a';
  let host: string;
  let pkg: string;

  beforeEach(async () => {
    host = path.join(dir, 'host-secret.txt');
    await writeFile(host, `---\nname: ${SECRET}\n---\n`);
    pkg = path.join(dir, 'pkg');
    await mkdir(path.join(pkg, 'skills', 'a'), { recursive: true });
  });

  // Purpose: an ordinary file inside the package reads normally.
  it('reads a regular file inside the package', async () => {
    await writeFile(path.join(pkg, 'skills', 'a', 'SKILL.md'), 'ok');
    expect(await readPackageFileWithin(pkg, 'skills/a/SKILL.md', 1024, 'The SKILL.md')).toBe('ok');
  });

  // Purpose: a package cannot point DorkOS at a host file through a link,
  // whether the file itself or a directory on the way is the link, and the
  // refusal never carries the target's text.
  it.each([
    ['the file is a link', async () => symlink(host, path.join(pkg, 'skills', 'a', 'SKILL.md'))],
    [
      'a directory on the way is a link',
      async () => {
        await rm(path.join(pkg, 'skills', 'a'), { recursive: true });
        await mkdir(path.join(dir, 'elsewhere'));
        await writeFile(path.join(dir, 'elsewhere', 'SKILL.md'), `name: ${SECRET}`);
        await symlink(path.join(dir, 'elsewhere'), path.join(pkg, 'skills', 'a'));
      },
    ],
  ])('refuses a symbolic link when %s', async (_label, arrange) => {
    await arrange();
    const error = await readPackageFileWithin(pkg, 'skills/a/SKILL.md', 1024, 'The SKILL.md').catch(
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(UnsafeFileError);
    expect((error as Error).message).toBe(
      'The SKILL.md is reached through a symbolic link, which DorkOS does not follow inside a package.'
    );
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  // Purpose: a path cannot climb out of the package.
  it.each(['../host-secret.txt', '/etc/hosts'])('refuses the path %j', async (rel) => {
    await expect(readPackageFileWithin(pkg, rel, 1024, 'The file')).rejects.toThrow(
      'The file is outside the package, so DorkOS will not read it.'
    );
  });

  // Purpose: a missing file still reads as missing, so callers keep their
  // "absent" answer.
  it('passes a missing-file error through', async () => {
    await expect(
      readPackageFileWithin(pkg, 'skills/a/SKILL.md', 1024, 'The SKILL.md')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('readPackageFileWithin while the tree changes (DOR-2319)', () => {
  let pkg: string;
  let outside: string;

  beforeEach(async () => {
    pkg = path.join(dir, 'pkg');
    outside = path.join(dir, 'outside');
    await mkdir(path.join(pkg, 'skills', 'a'), { recursive: true });
    await writeFile(path.join(pkg, 'skills', 'a', 'SKILL.md'), 'inside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'SKILL.md'), 'host-secret-2b61');
  });

  afterEach(() => {
    delete readPackageFileHooks.beforeOpen;
    delete readPackageFileHooks.afterOpen;
  });

  // Purpose: a directory swapped for a link out of the package after the
  // link checks but before the open is caught after the open, and the
  // outside file's text is never returned.
  it('refuses a directory swapped for a link before the open', async () => {
    readPackageFileHooks.beforeOpen = async () => {
      await rm(path.join(pkg, 'skills', 'a'), { recursive: true });
      await symlink(outside, path.join(pkg, 'skills', 'a'));
    };
    const error = await readPackageFileWithin(pkg, 'skills/a/SKILL.md', 1024, 'The SKILL.md').catch(
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(UnsafeFileError);
    expect((error as Error).message).toBe(
      'The SKILL.md changed while DorkOS was reading it, so DorkOS will not read it.'
    );
  });

  // Purpose: a file replaced after it was opened is caught by comparing the
  // opened file with what the path now names.
  it('refuses a file replaced after the open', async () => {
    readPackageFileHooks.afterOpen = async () => {
      await rm(path.join(pkg, 'skills', 'a', 'SKILL.md'));
      await writeFile(path.join(pkg, 'skills', 'a', 'SKILL.md'), 'replaced');
    };
    await expect(
      readPackageFileWithin(pkg, 'skills/a/SKILL.md', 1024, 'The SKILL.md')
    ).rejects.toThrow('changed while DorkOS was reading it');
  });

  // Purpose: with no change, the checks pass and the file reads.
  it('reads an unchanged file', async () => {
    readPackageFileHooks.beforeOpen = async () => {};
    expect(await readPackageFileWithin(pkg, 'skills/a/SKILL.md', 1024, 'The SKILL.md')).toBe(
      'inside'
    );
  });
});

describe('readTextFileWithinSync (DOR-2321)', () => {
  // Purpose: the synchronous reader matches the asynchronous one: exact text
  // within the limit, refusal one byte over, and no blocking on a pipe.
  it('reads within the limit and refuses one byte more', async () => {
    const file = path.join(dir, 'sync.md');
    await writeFile(file, '\uFEFFé'.padEnd(100, 'x'));
    expect(readTextFileWithinSync(file, 1024, 'The file')).toBe('\uFEFFé'.padEnd(100, 'x'));
    await writeFile(file, 'x'.repeat(101));
    expect(() => readTextFileWithinSync(file, 100, 'The file')).toThrow(TooLargeError);
  });

  it.skipIf(process.platform === 'win32')('refuses a named pipe without waiting', () => {
    const fifo = path.join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(() => readTextFileWithinSync(fifo, 1024, 'The file')).toThrow(
      'The file is not a regular file, so DorkOS will not read it.'
    );
  });
});
