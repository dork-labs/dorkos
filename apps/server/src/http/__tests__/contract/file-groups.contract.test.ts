/**
 * Contract for the route groups that read, write, upload and serve files,
 * which move to Hono together in DOR-2800: files (`/api/files`), diff review
 * (`/api/diff`), uploads (`/api/uploads`), the operator's profile
 * (`/api/profile`) and the embedded browser's file serving (`/api/workbench`).
 * That PR must pass this file unchanged.
 *
 * Every one of these routes takes a path, a file or both from the caller, so
 * the refusals are the heart of it: a `..` walk, an encoded `%2e%2e`, an
 * absolute path outside the boundary, a symlink out of the working directory,
 * a NUL byte, and for uploads every limit the multipart parser enforces (size,
 * count, field, type) and every malformed body it can be handed. The composed
 * server runs with a fresh data directory and login off, so the caller is the
 * person at the keyboard unless a case sends an agent header.
 *
 * Two answers here are pinned as they are, not as they should be:
 *
 * - `GET /api/uploads/:filename` is a 404 for a file that exists. Uploads land
 *   under `{cwd}/.dork/.temp/uploads/`, and the file sender ignores any path
 *   with a dotfile segment in it.
 * - A path parameter that walks out with dot segments (`/api/uploads/%2e%2e`)
 *   is refused, but which refusal depends on who normalizes the URL first, so
 *   those cases check only that nothing was served.
 *
 * Everything this file writes goes under the git-ignored `.temp/` at the
 * repository root (the server's directory boundary) and is removed afterwards.
 */
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DiffBaselineResponseSchema,
  FileListResponseSchema,
  FileTreeResponseSchema,
} from '@dorkos/shared/schemas';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  contractSuite,
  type ComposedServer,
} from './harness.js';

/** The repository root: the composed server's directory boundary. */
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
);
/** The working directory every case reads and writes in, git-ignored. */
const CWD = path.join(REPO_ROOT, '.temp', `contract-files-${randomUUID().slice(0, 8)}`);
/** A folder outside the boundary, for the symlink escapes. */
const OUTSIDE_DIR = realpathSync(tmpdir());
const OUTSIDE_FILE = path.join(OUTSIDE_DIR, `contract-outside-${randomUUID().slice(0, 8)}.svg`);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n';
const AUDIO = 'abcdefghij';
const NOTES = 'hello from the contract\n';
const PAGE = '<!doctype html><html><head><title>t</title></head><body>page</body></html>\n';
const STYLE = 'body { color: red; }\n';

mkdirSync(path.join(CWD, 'sub'), { recursive: true });
mkdirSync(path.join(CWD, 'site', 'css'), { recursive: true });
writeFileSync(path.join(CWD, 'pic.svg'), SVG);
writeFileSync(path.join(CWD, 'clip.mp3'), AUDIO);
writeFileSync(path.join(CWD, 'notes.txt'), NOTES);
writeFileSync(path.join(CWD, 'binary.txt'), 'a\0b');
writeFileSync(path.join(CWD, 'sub', 'inner.txt'), 'inner\n');
writeFileSync(path.join(CWD, 'site', 'index.html'), PAGE);
writeFileSync(path.join(CWD, 'site', 'css', 'style.css'), STYLE);
writeFileSync(path.join(CWD, 'site', 'blob.xyz'), 'opaque');
writeFileSync(OUTSIDE_FILE, SVG);
symlinkSync(OUTSIDE_FILE, path.join(CWD, 'escape.svg'));
symlinkSync(OUTSIDE_FILE, path.join(CWD, 'site', 'escape.html'));
afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
  rmSync(OUTSIDE_FILE, { force: true });
});

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const OUTSIDE = {
  error: 'Access denied: path outside directory boundary',
  code: 'OUTSIDE_BOUNDARY',
};
const NULL_BYTE = { error: 'Invalid path: null bytes not allowed', code: 'NULL_BYTE' };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
const INTERNAL = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const INVALID_QUERY = z.object({ error: z.literal('Invalid query'), details: z.unknown() });
const INVALID_BODY = z.object({ error: z.literal('Invalid body'), details: z.unknown() });
const VALIDATION_FAILED = z.object({ error: z.literal('Validation failed') }).loose();
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const SESSION = '3f1c2a64-8d3e-4b5f-9a7c-1e2d3c4b5a69';
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const q = encodeURIComponent;
const at = (rel: string) => `cwd=${q(CWD)}&path=${q(rel)}`;

/** The boundary every multipart body below is cut on. */
const BOUNDARY = '----dorkos-contract-boundary';
const MULTIPART = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

/** One part of a multipart body. */
interface Part {
  field: string;
  filename?: string;
  type?: string;
  content: string;
}

/** A `multipart/form-data` body, as a browser's `FormData` writes it. */
function multipart(parts: readonly Part[], options: { close?: boolean } = {}): string {
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(`--${BOUNDARY}`);
    const file = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    lines.push(`Content-Disposition: form-data; name="${part.field}"${file}`);
    if (part.type) lines.push(`Content-Type: ${part.type}`);
    lines.push('', part.content);
  }
  if (options.close !== false) lines.push(`--${BOUNDARY}--`, '');
  return lines.join('\r\n');
}

/** The smallest bytes the avatar sniffer reads as a WebP: all ASCII, so a string carries them. */
const WEBP = `RIFF\0\0\0\0WEBPVP8 ${'x'.repeat(16)}`;
/** One byte past the avatar cap (2 MB). */
const TOO_BIG_WEBP = WEBP + 'x'.repeat(2 * 1024 * 1024 + 1 - WEBP.length);

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

contractSuite('file, diff, upload and profile groups', [
  {
    name: 'GET /api/files/raw serves a media file with its type, length and policy',
    path: `/api/files/raw?${at('pic.svg')}`,
    expect: {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml',
        'content-length': String(Buffer.byteLength(SVG)),
        'accept-ranges': 'bytes',
        'content-disposition': 'inline',
        'cache-control': 'private, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff',
        'content-security-policy': SVG_CSP,
      },
      body: SVG,
    },
  },
  {
    name: 'HEAD /api/files/raw answers the headers with no body',
    method: 'HEAD',
    path: `/api/files/raw?${at('pic.svg')}`,
    expect: {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml',
        'content-length': String(Buffer.byteLength(SVG)),
      },
      body: '',
    },
  },
  {
    name: 'GET /api/files/raw answers a byte range with 206',
    path: `/api/files/raw?${at('clip.mp3')}`,
    headers: { range: 'bytes=2-5' },
    expect: {
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-range': 'bytes 2-5/10',
        'content-length': '4',
        'content-security-policy': null,
      },
      body: 'cdef',
    },
  },
  {
    name: 'GET /api/files/raw answers a suffix range',
    path: `/api/files/raw?${at('clip.mp3')}`,
    headers: { range: 'bytes=-3' },
    expect: { status: 206, headers: { 'content-range': 'bytes 7-9/10' }, body: 'hij' },
  },
  {
    name: 'GET /api/files/raw serves the whole file for a multi-range request',
    path: `/api/files/raw?${at('clip.mp3')}`,
    headers: { range: 'bytes=0-1,4-5' },
    expect: { status: 200, headers: { 'content-range': null }, body: AUDIO },
  },
  {
    name: 'GET /api/files/raw refuses a range past the end with 416',
    path: `/api/files/raw?${at('clip.mp3')}`,
    headers: { range: 'bytes=20-' },
    expect: {
      status: 416,
      headers: { ...JSON_TYPE, 'content-range': 'bytes */10' },
      body: { error: 'Requested range not satisfiable', code: 'RANGE_NOT_SATISFIABLE' },
    },
  },
  {
    name: 'GET /api/files/raw is a 404 for a missing file',
    path: `/api/files/raw?${at('missing.svg')}`,
    expect: { status: 404, body: { error: 'File not found', code: 'NOT_FOUND' } },
  },
  {
    name: 'GET /api/files/raw refuses a type it does not serve',
    path: `/api/files/raw?${at('notes.txt')}`,
    expect: {
      status: 415,
      body: {
        error: 'Only image, PDF, 3D-model, audio, and video files can be served',
        code: 'UNSUPPORTED_TYPE',
      },
    },
  },
  {
    name: 'GET /api/files/raw refuses a folder',
    path: `/api/files/raw?cwd=${q(CWD)}&path=${q('sub.png')}`,
    expect: { status: 404, body: { error: 'File not found', code: 'NOT_FOUND' } },
  },
  {
    name: 'GET /api/files/raw refuses a .. walk out of the working directory',
    path: `/api/files/raw?${at('../../../../etc/hosts.png')}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/files/raw refuses an encoded %2e%2e walk',
    path: `/api/files/raw?cwd=${q(CWD)}&path=%252e%252e/%2e%2e/%2e%2e/%2e%2e/x.png`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/files/raw refuses an absolute path outside the boundary',
    path: `/api/files/raw?${at(OUTSIDE_FILE)}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/files/raw refuses a symlink out of the working directory',
    path: `/api/files/raw?${at('escape.svg')}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/files/raw refuses a NUL byte',
    path: `/api/files/raw?cwd=${q(CWD)}&path=pic%00.svg`,
    expect: { status: 400, body: NULL_BYTE },
  },
  {
    name: 'GET /api/files/raw refuses a working directory outside the boundary',
    path: `/api/files/raw?cwd=${q(OUTSIDE_DIR)}&path=x.svg`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/files/raw refuses a missing query',
    path: '/api/files/raw',
    expect: { status: 400, schema: INVALID_QUERY },
  },
  {
    name: 'GET /api/files/raw refuses a foreign Host',
    path: `/api/files/raw?${at('pic.svg')}`,
    headers: { host: 'evil.example' },
    expect: { status: 403, headers: JSON_TYPE },
  },
  {
    name: 'GET /api/files lists the working directory',
    path: `/api/files?cwd=${q(CWD)}`,
    expect: { status: 200, headers: JSON_TYPE, schema: FileListResponseSchema },
  },
  {
    name: 'GET /api/files refuses a folder outside the boundary',
    path: `/api/files?cwd=${q(OUTSIDE_DIR)}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/files/tree lists one level',
    path: `/api/files/tree?cwd=${q(CWD)}`,
    expect: { status: 200, schema: FileTreeResponseSchema },
  },
  {
    name: 'GET /api/files/tree refuses a file',
    path: `/api/files/tree?${at('notes.txt')}`,
    expect: { status: 400, body: { error: 'Not a directory', code: 'NOT_A_DIRECTORY' } },
  },
  {
    name: 'GET /api/files/tree refuses a .. walk',
    path: `/api/files/tree?${at('../../..')}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/files/content reads a text file with its hash',
    path: `/api/files/content?${at('notes.txt')}`,
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z
        .object({
          content: z.literal(NOTES),
          hash: z.string().length(64),
          encoding: z.literal('utf-8'),
        })
        .strict(),
    },
  },
  {
    name: 'GET /api/files/content refuses a binary file',
    path: `/api/files/content?${at('binary.txt')}`,
    expect: {
      status: 415,
      body: { error: 'Binary files cannot be opened as text', code: 'BINARY_FILE' },
    },
  },
  {
    name: 'GET /api/files/content refuses a folder',
    path: `/api/files/content?${at('sub')}`,
    expect: { status: 400, body: { error: 'Not a regular file', code: 'NOT_A_FILE' } },
  },
  {
    name: 'GET /api/files/content is a 404 for a missing file',
    path: `/api/files/content?${at('missing.txt')}`,
    expect: { status: 404, body: { error: 'File not found', code: 'NOT_FOUND' } },
  },
  {
    name: 'PUT /api/files/content writes nothing for the same bytes',
    method: 'PUT',
    path: '/api/files/content',
    body: { cwd: CWD, path: 'notes.txt', content: NOTES },
    expect: {
      status: 200,
      schema: z.object({ ok: z.literal(true), hash: z.string(), effect: z.literal('no_op') }),
    },
  },
  {
    name: 'PUT /api/files/content refuses a stale hash with the current bytes',
    method: 'PUT',
    path: '/api/files/content',
    body: { cwd: CWD, path: 'notes.txt', content: 'x', expectedHash: '0'.repeat(64) },
    expect: {
      status: 409,
      schema: z.object({
        error: z.literal('File changed on disk since it was opened'),
        code: z.literal('CONFLICT'),
        currentHash: z.string(),
        currentContent: z.literal(NOTES),
      }),
    },
  },
  {
    name: 'PUT /api/files/content never creates a file',
    method: 'PUT',
    path: '/api/files/content',
    body: { cwd: CWD, path: 'new.txt', content: 'x' },
    expect: { status: 404, body: { error: 'File not found', code: 'NOT_FOUND' } },
  },
  {
    name: 'PUT /api/files/content refuses a symlink out',
    method: 'PUT',
    path: '/api/files/content',
    body: { cwd: CWD, path: 'escape.svg', content: 'x' },
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'PUT /api/files/content refuses an empty body',
    method: 'PUT',
    path: '/api/files/content',
    expect: { status: 400, schema: INVALID_BODY },
  },
  {
    name: 'PUT /api/files/content refuses malformed JSON as the chain does',
    method: 'PUT',
    path: '/api/files/content',
    headers: { 'content-type': 'application/json' },
    body: '{"cwd":',
    expect: { status: 500, schema: INTERNAL },
  },
  {
    name: 'POST /api/files creates a file',
    method: 'POST',
    path: '/api/files',
    body: { cwd: CWD, path: 'made/new.txt', type: 'file', content: 'made' },
    expect: { status: 201, body: { ok: true, path: 'made/new.txt' } },
  },
  {
    name: 'POST /api/files refuses a name that is taken (after the case above)',
    method: 'POST',
    path: '/api/files',
    body: { cwd: CWD, path: 'made/new.txt', type: 'file' },
    expect: { status: 409, body: { error: 'Target already exists', code: 'CONFLICT' } },
  },
  {
    name: 'POST /api/files refuses the working directory itself',
    method: 'POST',
    path: '/api/files',
    body: { cwd: CWD, path: '.', type: 'dir' },
    expect: {
      status: 400,
      body: { error: 'Refusing to create over the working-directory root', code: 'REFUSE_ROOT' },
    },
  },
  {
    name: 'POST /api/files refuses a .. walk',
    method: 'POST',
    path: '/api/files',
    body: { cwd: CWD, path: '../../escape.txt', type: 'file' },
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'POST /api/files/copy copies a file (after the cases above)',
    method: 'POST',
    path: '/api/files/copy',
    body: { cwd: CWD, from: 'made/new.txt', to: 'made/copy.txt' },
    expect: { status: 200, body: { ok: true } },
  },
  {
    name: 'POST /api/files/copy refuses a folder into itself',
    method: 'POST',
    path: '/api/files/copy',
    body: { cwd: CWD, from: 'made', to: 'made/inner' },
    expect: {
      status: 400,
      body: { error: 'Refusing to copy a folder into itself', code: 'COPY_INTO_SELF' },
    },
  },
  {
    name: 'POST /api/files/rename moves a file (after the cases above)',
    method: 'POST',
    path: '/api/files/rename',
    body: { cwd: CWD, from: 'made/copy.txt', to: 'made/moved.txt' },
    expect: { status: 200, body: { ok: true } },
  },
  {
    name: 'POST /api/files/rename is a 404 for a missing source',
    method: 'POST',
    path: '/api/files/rename',
    body: { cwd: CWD, from: 'made/nothing.txt', to: 'made/other.txt' },
    expect: { status: 404, body: { error: 'Source not found', code: 'NOT_FOUND' } },
  },
  {
    name: 'DELETE /api/files refuses a non-empty folder without recursive',
    method: 'DELETE',
    path: `/api/files?${at('made')}`,
    expect: {
      status: 409,
      body: { error: 'Directory is not empty; pass recursive', code: 'DIR_NOT_EMPTY' },
    },
  },
  {
    name: 'DELETE /api/files removes a folder with recursive',
    method: 'DELETE',
    path: `/api/files?${at('made')}&recursive=true`,
    expect: { status: 200, body: { ok: true } },
  },
  {
    name: 'DELETE /api/files refuses the working directory itself',
    method: 'DELETE',
    path: `/api/files?${at('.')}`,
    expect: {
      status: 400,
      body: { error: 'Refusing to delete the working-directory root', code: 'REFUSE_ROOT' },
    },
  },
  {
    name: 'POST /api/files/reveal is a 404 for a missing path',
    method: 'POST',
    path: '/api/files/reveal',
    body: { cwd: CWD, path: 'nothing-here.txt' },
    expect: { status: 404, body: { error: 'Path not found', code: 'NOT_FOUND' } },
  },
  {
    name: 'POST /api/files/reveal refuses an empty body',
    method: 'POST',
    path: '/api/files/reveal',
    expect: { status: 400, schema: INVALID_BODY },
  },
  {
    name: 'GET /api/files/nothing is the /api 404',
    path: '/api/files/nothing',
    expect: { status: 404, body: NOT_FOUND },
  },

  // diff
  {
    name: 'GET /api/diff/baseline diffs a file against an empty base',
    path: `/api/diff/baseline?${at('notes.txt')}&sessionId=${SESSION}`,
    expect: { status: 200, headers: JSON_TYPE, schema: DiffBaselineResponseSchema },
  },
  {
    name: 'GET /api/diff/baseline is a 404 to an agent that may not read the session',
    path: `/api/diff/baseline?${at('notes.txt')}&sessionId=${SESSION}`,
    headers: AGENT,
    expect: { status: 404, body: { error: 'Session not found', code: 'SESSION_NOT_FOUND' } },
  },
  {
    name: 'GET /api/diff/baseline refuses a binary file',
    path: `/api/diff/baseline?${at('binary.txt')}&sessionId=${SESSION}`,
    expect: {
      status: 415,
      body: { error: 'Binary files cannot be diffed as text', code: 'BINARY_FILE' },
    },
  },
  {
    name: 'GET /api/diff/baseline refuses a .. walk',
    path: `/api/diff/baseline?${at('../../../x.txt')}&sessionId=${SESSION}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/diff/baseline refuses a NUL byte',
    path: `/api/diff/baseline?cwd=${q(CWD)}&path=a%00.txt&sessionId=${SESSION}`,
    expect: { status: 400, body: NULL_BYTE },
  },
  {
    name: 'GET /api/diff/baseline refuses a missing session',
    path: `/api/diff/baseline?${at('notes.txt')}`,
    expect: { status: 400, schema: INVALID_QUERY },
  },
  {
    name: 'GET /api/diff/pending lists nothing for a fresh session',
    path: `/api/diff/pending?cwd=${q(CWD)}&sessionId=${SESSION}`,
    expect: { status: 200, body: { files: [] } },
  },
  {
    name: 'GET /api/diff/pending refuses a folder outside the boundary',
    path: `/api/diff/pending?cwd=${q(OUTSIDE_DIR)}&sessionId=${SESSION}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/diff/baseline/raw is a 404 when there is no before',
    path: `/api/diff/baseline/raw?${at('pic.svg')}&sessionId=${SESSION}`,
    expect: { status: 404, body: { error: 'No baseline for this file', code: 'NO_BASELINE' } },
  },
  {
    name: 'GET /api/diff/baseline/raw refuses a type it does not serve',
    path: `/api/diff/baseline/raw?${at('notes.txt')}&sessionId=${SESSION}`,
    expect: {
      status: 415,
      body: {
        error: 'Only image, PDF, and 3D-model baselines can be served',
        code: 'UNSUPPORTED_TYPE',
      },
    },
  },
  {
    name: 'GET /api/diff/baseline/raw refuses a symlink out',
    path: `/api/diff/baseline/raw?${at('escape.svg')}&sessionId=${SESSION}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'POST /api/diff/baseline/advance is a no-op with no baseline',
    method: 'POST',
    path: '/api/diff/baseline/advance',
    body: { cwd: CWD, path: 'notes.txt', sessionId: SESSION },
    expect: { status: 200, body: { ok: true } },
  },
  {
    name: 'POST /api/diff/baseline/advance refuses an agent that may not read the session',
    method: 'POST',
    path: '/api/diff/baseline/advance',
    headers: AGENT,
    body: { cwd: CWD, path: 'notes.txt', sessionId: SESSION },
    expect: { status: 404, body: { error: 'Session not found', code: 'SESSION_NOT_FOUND' } },
  },
  {
    name: 'POST /api/diff/revert is a 404 with nothing to restore',
    method: 'POST',
    path: '/api/diff/revert',
    body: { cwd: CWD, path: 'notes.txt', sessionId: SESSION },
    expect: {
      status: 404,
      body: { error: 'No baseline to restore for this file', code: 'NO_BASELINE' },
    },
  },
  {
    name: 'POST /api/diff/revert refuses an empty body',
    method: 'POST',
    path: '/api/diff/revert',
    expect: { status: 400, schema: INVALID_BODY },
  },

  // uploads
  {
    name: 'PATCH /api/config narrows the upload limits for the cases below',
    method: 'PATCH',
    path: '/api/config',
    body: { uploads: { maxFileSize: 64, maxFiles: 2, allowedTypes: ['text/plain'] } },
    expect: { status: 200 },
  },
  {
    name: 'POST /api/uploads refuses a missing cwd',
    method: 'POST',
    path: '/api/uploads',
    expect: { status: 400, body: { error: 'Missing required parameter: cwd' } },
  },
  {
    name: 'POST /api/uploads refuses a folder outside the boundary before reading the body',
    method: 'POST',
    path: `/api/uploads?cwd=${q(OUTSIDE_DIR)}`,
    headers: MULTIPART,
    body: multipart([{ field: 'files', filename: 'a.txt', type: 'text/plain', content: 'a' }]),
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'POST /api/uploads refuses a NUL byte in the cwd',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}%00`,
    expect: { status: 403, body: NULL_BYTE },
  },
  {
    name: 'POST /api/uploads answers no files for a request with no body',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    expect: { status: 400, body: { error: 'No files provided' } },
  },
  {
    name: 'POST /api/uploads answers no files for a JSON body',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    body: { files: ['a.txt'] },
    expect: { status: 400, body: { error: 'No files provided' } },
  },
  {
    name: 'POST /api/uploads answers no files for a multipart body with only fields',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([{ field: 'note', content: 'just a field' }]),
    expect: { status: 400, body: { error: 'No files provided' } },
  },
  {
    name: 'POST /api/uploads saves one file under a sanitized, prefixed name',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([{ field: 'files', filename: 'one.txt', type: 'text/plain', content: 'one' }]),
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z
        .object({
          uploads: z
            .array(
              z
                .object({
                  originalName: z.literal('one.txt'),
                  savedPath: z.string().startsWith(path.join(CWD, '.dork', '.temp', 'uploads')),
                  filename: z.string().regex(/^[0-9a-f]{8}-one\.txt$/),
                  size: z.literal(3),
                  mimeType: z.literal('text/plain'),
                })
                .strict()
            )
            .length(1),
        })
        .strict(),
    },
  },
  {
    name: 'POST /api/uploads saves several files in the order sent',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([
      { field: 'files', filename: 'first.txt', type: 'text/plain', content: 'first' },
      { field: 'note', content: 'a field between them' },
      { field: 'files', filename: 'second.txt', type: 'text/plain', content: 'second!' },
    ]),
    expect: {
      status: 200,
      schema: z.object({
        uploads: z.tuple([
          z.object({ originalName: z.literal('first.txt'), size: z.literal(5) }).loose(),
          z.object({ originalName: z.literal('second.txt'), size: z.literal(7) }).loose(),
        ]),
      }),
    },
  },
  {
    name: 'POST /api/uploads keeps only the last path segment of a filename and sanitizes it',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([
      { field: 'files', filename: '../../up/we ird$name.txt', type: 'text/plain', content: 'x' },
      { field: 'files', filename: 'C:\\dir\\back.txt', type: 'text/plain', content: 'y' },
    ]),
    expect: {
      status: 200,
      schema: z.object({
        uploads: z.tuple([
          z
            .object({
              originalName: z.literal('we ird$name.txt'),
              filename: z.string().regex(/^[0-9a-f]{8}-we_ird_name\.txt$/),
            })
            .loose(),
          z
            .object({
              originalName: z.literal('back.txt'),
              filename: z.string().regex(/^[0-9a-f]{8}-back\.txt$/),
            })
            .loose(),
        ]),
      }),
    },
  },
  {
    name: 'POST /api/uploads reads a raw non-ASCII filename as latin1 and sanitizes it',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([{ field: 'files', filename: 'café.txt', type: 'text/plain', content: 'z' }]),
    expect: {
      status: 200,
      schema: z.object({
        uploads: z.tuple([
          z
            .object({
              originalName: z.literal('cafÃ©.txt'),
              filename: z.string().regex(/^[0-9a-f]{8}-caf__\.txt$/),
            })
            .loose(),
        ]),
      }),
    },
  },
  {
    name: 'POST /api/uploads refuses a file over the size limit',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([
      { field: 'files', filename: 'big.txt', type: 'text/plain', content: 'b'.repeat(65) },
    ]),
    expect: {
      status: 400,
      body: { error: `File too large (max ${64 / 1024 / 1024}MB)`, code: 'LIMIT_FILE_SIZE' },
    },
  },
  {
    name: 'POST /api/uploads accepts a file exactly at the size limit',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([
      { field: 'files', filename: 'edge.txt', type: 'text/plain', content: 'e'.repeat(64) },
    ]),
    expect: {
      status: 200,
      schema: z.object({ uploads: z.tuple([z.object({ size: z.literal(64) }).loose()]) }),
    },
  },
  {
    name: 'POST /api/uploads refuses more files than the limit',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([
      { field: 'files', filename: '1.txt', type: 'text/plain', content: '1' },
      { field: 'files', filename: '2.txt', type: 'text/plain', content: '2' },
      { field: 'files', filename: '3.txt', type: 'text/plain', content: '3' },
    ]),
    expect: { status: 400, body: { error: 'Too many files', code: 'LIMIT_FILE_COUNT' } },
  },
  {
    name: 'POST /api/uploads refuses a file in another field',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([{ field: 'other', filename: 'o.txt', type: 'text/plain', content: 'o' }]),
    expect: {
      status: 400,
      body: { error: 'Unexpected file field', code: 'LIMIT_UNEXPECTED_FILE' },
    },
  },
  {
    name: 'POST /api/uploads refuses a type the config does not allow',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([{ field: 'files', filename: 'p.png', type: 'image/png', content: 'png' }]),
    expect: { status: 400, body: { error: 'File type not allowed: image/png' } },
  },
  {
    name: 'POST /api/uploads refuses a multipart type with no boundary',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: { 'content-type': 'multipart/form-data' },
    body: 'nothing',
    expect: { status: 400, body: { error: 'Multipart: Boundary not found' } },
  },
  {
    name: 'POST /api/uploads refuses a body cut off before its closing boundary',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: multipart([{ field: 'files', filename: 'cut.txt', type: 'text/plain', content: 'c' }], {
      close: false,
    }),
    expect: { status: 400, body: { error: 'Unexpected end of form' } },
  },
  {
    name: 'POST /api/uploads refuses an empty multipart body',
    method: 'POST',
    path: `/api/uploads?cwd=${q(CWD)}`,
    headers: MULTIPART,
    body: '',
    expect: { status: 400, body: { error: 'Unexpected end of form' } },
  },
  {
    name: 'GET /api/uploads/:filename refuses a missing cwd',
    path: '/api/uploads/one.txt',
    expect: { status: 400, body: { error: 'Missing required parameter: cwd' } },
  },
  {
    name: 'GET /api/uploads/:filename refuses a folder outside the boundary',
    path: `/api/uploads/one.txt?cwd=${q(OUTSIDE_DIR)}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/uploads/:filename is a 404 for a missing file',
    path: `/api/uploads/missing.txt?cwd=${q(CWD)}`,
    expect: { status: 404, headers: JSON_TYPE, body: { error: 'File not found' } },
  },
  {
    name: 'GET /api/uploads/:filename keeps only the last segment of an encoded path',
    path: `/api/uploads/${q('../../notes.txt')}?cwd=${q(CWD)}`,
    expect: { status: 404, body: { error: 'File not found' } },
  },

  // profile
  {
    name: 'PATCH /api/profile saves what the operator wants to be called',
    method: 'PATCH',
    path: '/api/profile',
    body: { displayName: '  Contract Person  ' },
    expect: { status: 200, headers: JSON_TYPE, body: { displayName: 'Contract Person' } },
  },
  {
    name: 'PATCH /api/profile refuses an empty name',
    method: 'PATCH',
    path: '/api/profile',
    body: { displayName: '   ' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH /api/profile refuses an empty body',
    method: 'PATCH',
    path: '/api/profile',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH /api/profile refuses an agent it cannot verify',
    method: 'PATCH',
    path: '/api/profile',
    headers: AGENT,
    body: { displayName: 'Agent' },
    expect: { status: 401, headers: JSON_TYPE },
  },
  {
    name: 'POST /api/profile/avatar refuses an agent before reading the body',
    method: 'POST',
    path: '/api/profile/avatar',
    headers: { ...AGENT, ...MULTIPART },
    body: multipart([{ field: 'avatar', filename: 'a.webp', type: 'image/webp', content: WEBP }]),
    expect: { status: 401, headers: JSON_TYPE },
  },
  {
    name: 'POST /api/profile/avatar asks for the image when there is none',
    method: 'POST',
    path: '/api/profile/avatar',
    expect: {
      status: 400,
      body: { error: "Attach the image as the 'avatar' field.", code: 'AVATAR_MISSING' },
    },
  },
  {
    name: 'POST /api/profile/avatar refuses bytes that are not an image',
    method: 'POST',
    path: '/api/profile/avatar',
    headers: MULTIPART,
    body: multipart([{ field: 'avatar', filename: 'a.png', type: 'image/png', content: 'text' }]),
    expect: {
      status: 415,
      body: {
        error: 'That file is not a PNG, JPEG, or WebP image.',
        code: 'AVATAR_TYPE_UNSUPPORTED',
      },
    },
  },
  {
    name: 'POST /api/profile/avatar refuses an image over 2 MB',
    method: 'POST',
    path: '/api/profile/avatar',
    headers: MULTIPART,
    body: multipart([
      { field: 'avatar', filename: 'a.webp', type: 'image/webp', content: TOO_BIG_WEBP },
    ]),
    expect: {
      status: 413,
      body: { error: 'That image is larger than 2 MB.', code: 'AVATAR_TOO_LARGE' },
    },
  },
  {
    name: 'POST /api/profile/avatar refuses two images',
    method: 'POST',
    path: '/api/profile/avatar',
    headers: MULTIPART,
    body: multipart([
      { field: 'avatar', filename: 'a.webp', type: 'image/webp', content: WEBP },
      { field: 'avatar', filename: 'b.webp', type: 'image/webp', content: WEBP },
    ]),
    expect: {
      status: 400,
      body: { error: "Send one image as 'avatar'.", code: 'AVATAR_UPLOAD_REJECTED' },
    },
  },
  {
    name: 'POST /api/profile/avatar refuses an image in another field',
    method: 'POST',
    path: '/api/profile/avatar',
    headers: MULTIPART,
    body: multipart([{ field: 'photo', filename: 'a.webp', type: 'image/webp', content: WEBP }]),
    expect: {
      status: 400,
      body: { error: "Send one image as 'avatar'.", code: 'AVATAR_UPLOAD_REJECTED' },
    },
  },
  {
    name: 'POST /api/profile/avatar refuses a malformed body',
    method: 'POST',
    path: '/api/profile/avatar',
    headers: { 'content-type': 'multipart/form-data' },
    body: 'nothing',
    expect: {
      status: 400,
      body: { error: 'That upload could not be read.', code: 'AVATAR_UPLOAD_REJECTED' },
    },
  },
  {
    name: 'GET /api/profile/avatar/:id is a 404 for an identity with no photo',
    path: '/api/profile/avatar/nobody',
    expect: {
      status: 404,
      body: { error: 'No photo for that identity.', code: 'AVATAR_NOT_FOUND' },
    },
  },
  {
    name: 'GET /api/profile/avatar/:id finds no photo under an id that could be read as a path',
    path: `/api/profile/avatar/${q('a/b')}`,
    expect: {
      status: 404,
      body: { error: 'No photo for that identity.', code: 'AVATAR_NOT_FOUND' },
    },
  },
  {
    name: 'DELETE /api/profile/avatar removes a photo that is not there',
    method: 'DELETE',
    path: '/api/profile/avatar',
    expect: { status: 204, body: '' },
  },
  {
    name: 'DELETE /api/profile/avatar refuses an agent',
    method: 'DELETE',
    path: '/api/profile/avatar',
    headers: AGENT,
    expect: { status: 401, headers: JSON_TYPE },
  },
  {
    name: 'POST /api/profile/identities/:authorId is a 404 for an author that does not exist',
    method: 'POST',
    path: '/api/profile/identities/platform%3Anobody',
    expect: { status: 404, headers: JSON_TYPE },
  },
  {
    name: 'DELETE /api/profile/identities/:authorId is a 404 for an author that does not exist',
    method: 'DELETE',
    path: '/api/profile/identities/platform%3Anobody',
    expect: { status: 404, body: { error: 'No such author', code: 'MEMBER_NOT_FOUND' } },
  },
  {
    name: 'GET /api/profile is the /api 404',
    path: '/api/profile',
    expect: { status: 404, body: NOT_FOUND },
  },

  // workbench (the token-bearing cases are below)
  {
    name: 'POST /api/workbench/sign refuses a folder outside the boundary',
    method: 'POST',
    path: '/api/workbench/sign',
    body: { kind: 'serve', cwd: OUTSIDE_DIR },
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'POST /api/workbench/sign refuses a NUL byte',
    method: 'POST',
    path: '/api/workbench/sign',
    body: { kind: 'serve', cwd: `${CWD}\0` },
    expect: { status: 400, body: NULL_BYTE },
  },
  {
    name: 'POST /api/workbench/sign refuses a start path out of the folder',
    method: 'POST',
    path: '/api/workbench/sign',
    body: { kind: 'serve', cwd: CWD, path: '../outside.html' },
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'POST /api/workbench/sign refuses the folder itself as a start path',
    method: 'POST',
    path: '/api/workbench/sign',
    body: { kind: 'serve', cwd: CWD, path: '.' },
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'POST /api/workbench/sign refuses a port out of range',
    method: 'POST',
    path: '/api/workbench/sign',
    body: { kind: 'proxy', port: 70000 },
    expect: { status: 400, schema: INVALID_BODY },
  },
  {
    name: 'POST /api/workbench/sign refuses an empty body',
    method: 'POST',
    path: '/api/workbench/sign',
    expect: { status: 400, schema: INVALID_BODY },
  },
  {
    name: 'POST /api/workbench/sign opens a preview origin on the host the caller reached',
    method: 'POST',
    path: '/api/workbench/sign',
    body: { kind: 'proxy', port: 5173 },
    headers: { host: '127.0.0.1' },
    expect: {
      status: 200,
      schema: z
        .object({ url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+\/\?\w+=[^&]+$/) })
        .strict(),
    },
  },
  {
    name: 'POST /api/workbench/probe reports a port with nothing on it',
    method: 'POST',
    path: '/api/workbench/probe',
    body: { port: 1 },
    expect: { status: 200, body: { listening: false } },
  },
  {
    name: 'POST /api/workbench/probe refuses a body with no port',
    method: 'POST',
    path: '/api/workbench/probe',
    body: {},
    expect: { status: 400, schema: INVALID_BODY },
  },
  {
    name: 'GET /api/workbench/serve/:token refuses a forged token, with the sandbox policy',
    path: '/api/workbench/serve/not-a-token/index.html',
    expect: {
      status: 403,
      headers: { ...JSON_TYPE, 'content-security-policy': /^sandbox allow-scripts / },
      schema: z.object({ error: z.string(), code: z.string() }).strict(),
    },
  },
  {
    name: 'GET /api/workbench/sign is the /api 404',
    path: '/api/workbench/sign',
    expect: { status: 404, body: NOT_FOUND },
  },
]);

// ---------------------------------------------------------------------------
// The cases that need what the server hands out: tokens, stored photos, files.
// ---------------------------------------------------------------------------

/** One raw answer, body kept as bytes. */
interface RawAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** Send one request and read the whole answer. */
function call(
  baseUrl: string,
  method: string,
  target: string,
  options: { headers?: Record<string, string>; body?: string } = {}
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(target, baseUrl),
      { method, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** POST a JSON body. */
function postJson(baseUrl: string, target: string, body: unknown): Promise<RawAnswer> {
  return call(baseUrl, 'POST', target, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('contract: tokens, stored photos and saved uploads', () => {
  let server: ComposedServer | undefined;
  let base = '';
  beforeAll(async () => {
    server = await bootComposedServer();
    base = server.baseUrl;
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  /** Sign the contract's site folder and answer the serve URL's path. */
  async function signSite(start?: string): Promise<string> {
    const res = await postJson(base, '/api/workbench/sign', {
      kind: 'serve',
      cwd: path.join(CWD, 'site'),
      ...(start === undefined ? {} : { path: start }),
    });
    expect(res.status).toBe(200);
    const { url } = JSON.parse(res.text) as { url: string };
    expect(url.startsWith(`${base}/api/workbench/serve/`)).toBe(true);
    return new URL(url).pathname;
  }

  it('signs a serve URL on the host the caller reached, honoring X-Forwarded-Proto', async () => {
    const res = await call(base, 'POST', '/api/workbench/sign', {
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https, http' },
      body: JSON.stringify({ kind: 'serve', cwd: path.join(CWD, 'site'), path: 'css/style.css' }),
    });
    expect(res.status).toBe(200);
    const { url } = JSON.parse(res.text) as { url: string };
    expect(url).toMatch(
      new RegExp(`^https://${new URL(base).host}/api/workbench/serve/[^/]+/css/style\\.css$`)
    );
  });

  it('serves the page with the sandbox policy and frame scripts, never sniffed or cached', async () => {
    const res = await call(base, 'GET', await signSite());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toMatch(
      /^sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self' /
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.text)));
    expect(res.text).toContain('<body>page</body>');
    expect(res.text.length).toBeGreaterThan(PAGE.length);
  });

  it('serves index.html at the bare token and at the token with a trailing slash', async () => {
    const pathname = await signSite();
    const token = pathname.split('/')[4]!;
    for (const bare of [`/api/workbench/serve/${token}`, `/api/workbench/serve/${token}/`]) {
      const res = await call(base, 'GET', bare);
      expect(res.status, bare).toBe(200);
      expect(res.text).toContain('<body>page</body>');
    }
  });

  it('serves an asset by extension, an unknown type as a download, and HEAD with no body', async () => {
    const token = (await signSite()).split('/')[4]!;
    const css = await call(base, 'GET', `/api/workbench/serve/${token}/css/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['content-length']).toBe(String(Buffer.byteLength(STYLE)));
    expect(css.text).toBe(STYLE);

    const encoded = await call(base, 'GET', `/api/workbench/serve/${token}/css%2Fstyle.css`);
    expect(encoded.status).toBe(200);
    expect(encoded.text).toBe(STYLE);

    const blob = await call(base, 'GET', `/api/workbench/serve/${token}/blob.xyz`);
    expect(blob.status).toBe(200);
    expect(blob.headers['content-type']).toBe('application/octet-stream');
    expect(blob.text).toBe('opaque');

    const head = await call(base, 'HEAD', `/api/workbench/serve/${token}/css/style.css`);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(STYLE)));
    expect(head.text).toBe('');
  });

  it('refuses what the token does not cover, keeping the sandbox policy on every refusal', async () => {
    const token = (await signSite()).split('/')[4]!;
    const cases: Array<[string, number, unknown]> = [
      [
        `/api/workbench/serve/${token}/missing.html`,
        404,
        { error: 'File not found', code: 'NOT_FOUND' },
      ],
      [`/api/workbench/serve/${token}/css`, 404, { error: 'Not a file', code: 'NOT_A_FILE' }],
      [`/api/workbench/serve/${token}/escape.html`, 403, OUTSIDE],
      [`/api/workbench/serve/${token}/a%00b.html`, 400, NULL_BYTE],
      [`/api/workbench/serve/${token}/%2e%2e%2F%2e%2e%2Fpackage.json`, 403, OUTSIDE],
    ];
    for (const [target, status, body] of cases) {
      const res = await call(base, 'GET', target);
      expect(res.status, target).toBe(status);
      expect(JSON.parse(res.text), target).toEqual(body);
      expect(res.headers['content-security-policy'], target).toMatch(/^sandbox allow-scripts /);
    }
  });

  it('never serves a file through a dot-segment walk in the path itself', async () => {
    const token = (await signSite()).split('/')[4]!;
    for (const target of [
      `/api/workbench/serve/${token}/%2e%2e/%2e%2e/package.json`,
      `/api/workbench/serve/${token}/../../package.json`,
      `/api/uploads/%2e%2e?cwd=${q(CWD)}`,
      `/api/profile/avatar/%2e%2e`,
    ]) {
      const res = await call(base, 'GET', target);
      expect([400, 403, 404], target).toContain(res.status);
      expect(res.text, target).not.toContain('"name"');
    }
  });

  it('pins that a saved upload is not served back: its folder is a dotfile path', async () => {
    const res = await call(base, 'POST', `/api/uploads?cwd=${q(CWD)}`, {
      headers: MULTIPART,
      body: multipart([{ field: 'files', filename: 'back.txt', type: 'text/plain', content: 'b' }]),
    });
    expect(res.status).toBe(200);
    const [saved] = (JSON.parse(res.text) as { uploads: Array<{ filename: string }> }).uploads;
    const get = await call(base, 'GET', `/api/uploads/${q(saved!.filename)}?cwd=${q(CWD)}`);
    expect(get.status).toBe(404);
    expect(JSON.parse(get.text)).toEqual({ error: 'File not found' });
    const head = await call(base, 'HEAD', `/api/uploads/${q(saved!.filename)}?cwd=${q(CWD)}`);
    expect(head.status).toBe(404);
    expect(head.text).toBe('');
  });

  it('stores a photo and serves it with its validator, cache rule and isolation headers', async () => {
    const res = await call(base, 'POST', '/api/profile/avatar', {
      headers: MULTIPART,
      body: multipart([
        { field: 'avatar', filename: 'me.webp', type: 'image/webp', content: WEBP },
      ]),
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json\b/);
    const { imageUrl } = JSON.parse(res.text) as { imageUrl: string };
    expect(imageUrl).toMatch(/^\/api\/profile\/avatar\/[^/?]+\?v=[^&]+$/);

    const current = await call(base, 'GET', imageUrl);
    expect(current.status).toBe(200);
    expect(current.headers['content-type']).toBe('image/webp');
    expect(current.headers['x-content-type-options']).toBe('nosniff');
    expect(current.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(current.headers['content-disposition']).toBe('inline');
    expect(current.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(current.text).toBe(WEBP);
    const etag = current.headers.etag!;
    expect(etag).toMatch(/^"[^"]+"$/);

    const bare = imageUrl.split('?')[0]!;
    const unversioned = await call(base, 'GET', bare);
    expect(unversioned.status).toBe(200);
    expect(unversioned.headers['cache-control']).toBe('private, max-age=0, must-revalidate');

    const conditional = await call(base, 'GET', bare, { headers: { 'if-none-match': etag } });
    expect(conditional.status).toBe(304);
    expect(conditional.text).toBe('');

    const removed = await call(base, 'DELETE', '/api/profile/avatar');
    expect(removed.status).toBe(204);
    expect((await call(base, 'GET', bare)).status).toBe(404);
  });
});
