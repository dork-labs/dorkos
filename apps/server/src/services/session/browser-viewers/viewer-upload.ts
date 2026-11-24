import busboy from 'busboy';
import type { IncomingMessage } from 'node:http';
import type { BrowserPersonFile } from '../local-browser/leases/broker-contract.js';
import { BrowserViewerError } from './viewer-contract.js';

const PAYLOAD_LIMIT = 25 * 1024 * 1024;
const WIRE_LIMIT = PAYLOAD_LIMIT + 16 * 1024;

/** Authorized volatile multipart only. No paths, temporary files or unbounded formData(). */
export function readViewerUpload(
  req: IncomingMessage,
  signal: AbortSignal
): Promise<BrowserPersonFile[]> {
  if (Number(req.headers['content-length']) > WIRE_LIMIT)
    return Promise.reject(new BrowserViewerError('viewer_limit'));
  return new Promise((resolve, reject) => {
    const files: BrowserPersonFile[] = [];
    const chunks = new Set<Buffer>();
    let total = 0,
      wire = 0,
      fileCount = 0,
      finished = false;
    let parser: ReturnType<typeof busboy>;
    const clear = () => {
      for (const buffer of chunks) buffer.fill(0);
      for (const file of files) file.buffer.fill(0);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      req.off('data', countWire);
      req.off('aborted', aborted);
      req.off('error', aborted);
      if (parser) req.unpipe(parser);
    };
    const fail = (code: 'viewer_limit' | 'viewer_stale' = 'viewer_limit') => {
      if (finished) return;
      finished = true;
      cleanup();
      clear();
      parser?.destroy();
      req.resume();
      reject(new BrowserViewerError(code));
    };
    const aborted = () => fail('viewer_stale');
    const countWire = (buffer: Buffer) => {
      wire += buffer.length;
      if (wire > WIRE_LIMIT) fail();
    };
    const timer = setTimeout(aborted, 10_000);
    timer.unref?.();
    try {
      parser = busboy({
        headers: req.headers,
        preservePath: true,
        defParamCharset: 'utf8',
        limits: {
          files: 11,
          fields: 1,
          parts: 11,
          fileSize: PAYLOAD_LIMIT + 1,
          fieldNameSize: 16,
          headerPairs: 16,
        },
      });
      parser.on('file', (field, stream, info) => {
        // Destroying multipart also destroys its current file stream. Install before validation.
        stream.on('error', aborted);
        const { filename: name, mimeType } = info;
        if (
          finished ||
          ++fileCount > 10 ||
          field !== 'files' ||
          !name ||
          name.length > 255 ||
          /[\\/]/.test(name) ||
          Array.from(name).some((c) => c.charCodeAt(0) < 32) ||
          name === '.' ||
          name === '..' ||
          mimeType.length > 128
        ) {
          stream.resume();
          fail();
          return;
        }
        const parts: Buffer[] = [];
        stream.on('data', (data: Buffer) => {
          if (finished) return;
          total += data.length;
          if (total > PAYLOAD_LIMIT) {
            fail();
            return;
          }
          const part = Buffer.from(data);
          parts.push(part);
          chunks.add(part);
        });
        stream.on('limit', () => fail());
        stream.on('end', () => {
          if (finished) return;
          const buffer = Buffer.concat(parts);
          for (const part of parts) {
            part.fill(0);
            chunks.delete(part);
          }
          files.push({ name, mimeType, buffer });
        });
      });
      parser.on('field', () => fail());
      parser.on('filesLimit', () => fail());
      parser.on('fieldsLimit', () => fail());
      parser.on('partsLimit', () => fail());
      parser.on('error', () => fail());
      parser.on('close', () => {
        if (finished) return;
        if (!files.length) {
          fail();
          return;
        }
        finished = true;
        cleanup();
        resolve(files);
      });
      signal.addEventListener('abort', aborted, { once: true });
      req.on('aborted', aborted);
      req.on('error', aborted);
      if (signal.aborted || req.aborted) {
        aborted();
        return;
      }
      req.on('data', countWire);
      req.pipe(parser);
    } catch {
      fail();
    }
  });
}
