import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CATALOG_MAX_BYTES,
  PACKAGE_TEXT_MAX_BYTES,
  TooLargeError,
  readResponseTextWithin,
  readTextFileWithin,
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

  // Purpose: the read loop is the guarantee, not the size check before it. A
  // named pipe reports size 0 and never ends; the read still stops one byte
  // past the limit.
  it.skipIf(process.platform === 'win32')(
    'stops reading a source that reports no size at one byte past the limit',
    async () => {
      const fifo = path.join(dir, 'pipe');
      execFileSync('mkfifo', [fifo]);
      const writer = spawn(process.execPath, [
        '-e',
        `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(fifo)}, 'w');` +
          `const chunk = Buffer.alloc(64 * 1024, 120);` +
          `try { for (;;) fs.writeSync(fd, chunk); } catch {}`,
      ]);
      try {
        await expect(readTextFileWithin(fifo, 256 * 1024, 'The pipe')).rejects.toBeInstanceOf(
          TooLargeError
        );
      } finally {
        writer.kill();
      }
    },
    15_000
  );

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
