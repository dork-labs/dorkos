/**
 * Serve a transcript through a mocked `fs/promises`, for tests that mock the
 * filesystem rather than writing real files.
 *
 * The reader's history cache reads a transcript with `stat` and `open` and
 * reads byte ranges from the handle (`transcript-history-cache.ts`), not with
 * one `readFile`. A test that used to answer `readFile` with the JSONL answers
 * these instead.
 *
 * @module services/runtimes/claude-code/sessions/transcripts/__tests__/serve-mocked-transcript
 */
import type fs from 'fs/promises';
import { vi } from 'vitest';

/**
 * Answer the next transcript read with `content`, or with `error` for a
 * missing file.
 *
 * @param mockFs - The mocked `fs/promises` default export.
 * @param content - The transcript text, or an error every call rejects with.
 */
export function serveMockedTranscript(mockFs: typeof fs, content: string | Error): void {
  const stat = vi.mocked(mockFs.stat);
  const open = vi.mocked(mockFs.open);
  if (content instanceof Error) {
    stat.mockRejectedValue(content);
    open.mockRejectedValue(content);
    return;
  }
  const bytes = Buffer.from(content, 'utf8');
  stat.mockResolvedValue({ size: bytes.length, mtimeMs: 1, ino: 1 } as Awaited<
    ReturnType<typeof fs.stat>
  >);
  open.mockResolvedValue({
    read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: bytes.copy(buffer, offset, position, position + length),
      buffer,
    }),
    close: async () => undefined,
  } as unknown as Awaited<ReturnType<typeof fs.open>>);
}
