/**
 * Where a finished browser recording lands, and what it is never allowed to
 * choose (spec `canvas-agent-seat` §3.4).
 *
 * The destination is the interesting half: nothing on this request names a
 * path, so these cases prove the file goes where the SERVER's own recording
 * state said it would, and that an upload nothing is awaiting writes nothing at
 * all.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) =>
      key === 'uploads' ? { maxFileSize: 1_024, maxFiles: 10, allowedTypes: ['*/*'] } : null
    ),
    set: vi.fn(),
  },
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp } from '../../app.js';
import { initBoundary } from '../../lib/boundary.js';
import { devtoolsCaptureStore } from '../../services/session/index.js';
import type { RecordingOutcome } from '../../services/session/index.js';

const app = createApp();
const testServer = listeningServer(app);

/** A one-pixel PNG, so the keyframe part sniffs as a real image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** Three bytes that read as a GIF header, which is all the route stores. */
const GIF = Buffer.from('GIF89a-not-really-a-gif', 'utf8');

let cwd: string;

beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-recording-'));
  // The boundary has to contain the temp directory the recording lands in;
  // `realpath` because macOS hands out `/var/...` for a `/private/var/...` dir
  // and containment is decided on canonical paths.
  cwd = await fs.realpath(cwd);
  await initBoundary(cwd);
});

afterEach(() => devtoolsCaptureStore.clear());

/** Start awaiting one recording upload, exactly as `browser_record_stop` does. */
function awaitUpload(requestId: string, recordingId = '01J8ZRECORDING') {
  return devtoolsCaptureStore.awaitRecording(requestId, { recordingId, cwd, full: false }, 5_000);
}

describe('POST /api/sessions/:id/devtools/recording', () => {
  it('writes the GIF where the server said, and resolves the waiting tool call', async () => {
    const sessionId = crypto.randomUUID();
    const waiter = awaitUpload('req-1');

    const res = await request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .field('requestId', 'req-1')
      .field('frames', '6')
      .field('durationMs', '3000')
      .attach('recording', GIF, { filename: 'run.gif', contentType: 'image/gif' })
      .attach('keyframe', PNG, { filename: 'last.png', contentType: 'image/png' });

    expect(res.status).toBe(204);
    const outcome = (await waiter) as Extract<RecordingOutcome, { ok: true }>;
    expect(outcome.ok).toBe(true);
    expect(outcome.path).toBe(path.join('.dork', '.temp', 'recordings', '01J8ZRECORDING.gif'));
    expect(outcome.frames).toBe(6);
    expect(outcome.bytes).toBe(GIF.byteLength);
    expect(outcome.keyframe).toEqual({ data: PNG.toString('base64'), mimeType: 'image/png' });

    const written = await fs.readFile(path.join(cwd, outcome.path));
    expect(written.equals(GIF)).toBe(true);
  });

  it('takes the filename from the recording state, never from the upload', async () => {
    const sessionId = crypto.randomUUID();
    const waiter = awaitUpload('req-2', 'SERVERCHOSE');

    await request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .field('requestId', 'req-2')
      .field('frames', '2')
      .field('durationMs', '1000')
      .attach('recording', GIF, {
        // A filename that would escape the directory if it were ever believed.
        filename: '../../../escaped.gif',
        contentType: 'image/gif',
      })
      .attach('keyframe', PNG, { filename: 'last.png', contentType: 'image/png' });

    const outcome = (await waiter) as Extract<RecordingOutcome, { ok: true }>;
    expect(outcome.path).toBe(path.join('.dork', '.temp', 'recordings', 'SERVERCHOSE.gif'));
    await expect(fs.access(path.join(cwd, outcome.path))).resolves.toBeUndefined();
  });

  it('keeps no picture from a keyframe part whose bytes are not a PNG', async () => {
    const sessionId = crypto.randomUUID();
    const waiter = awaitUpload('req-3');

    await request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .field('requestId', 'req-3')
      .field('frames', '1')
      .field('durationMs', '500')
      .attach('recording', GIF, { filename: 'run.gif', contentType: 'image/gif' })
      // Declared a PNG, and it is not one. The bytes decide.
      .attach('keyframe', Buffer.from('<script>alert(1)</script>'), {
        filename: 'last.png',
        contentType: 'image/png',
      });

    const outcome = (await waiter) as Extract<RecordingOutcome, { ok: true }>;
    expect(outcome.keyframe).toBeNull();
  });

  it('refuses an upload nothing is awaiting, and writes nothing', async () => {
    const sessionId = crypto.randomUUID();

    const res = await request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .field('requestId', 'nobody-is-waiting')
      .field('frames', '3')
      .field('durationMs', '1000')
      .attach('recording', GIF, { filename: 'run.gif', contentType: 'image/gif' })
      .attach('keyframe', PNG, { filename: 'last.png', contentType: 'image/png' });

    expect(res.status).toBe(404);
    await expect(fs.readdir(path.join(cwd, '.dork', '.temp', 'recordings'))).resolves.not.toContain(
      'nobody-is-waiting.gif'
    );
  });

  it('answers 413 for a recording over the configured upload ceiling', async () => {
    const sessionId = crypto.randomUUID();
    const waiter = awaitUpload('req-4');

    const res = await request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .field('requestId', 'req-4')
      .field('frames', '3')
      .field('durationMs', '1000')
      .attach('recording', Buffer.alloc(4_096, 7), {
        filename: 'run.gif',
        contentType: 'image/gif',
      });

    expect(res.status).toBe(413);
    // The tool is still waiting; nothing claimed a file that was never written.
    devtoolsCaptureStore.resolveRecording('req-4', { ok: false, error: 'gave up' });
    expect(await waiter).toMatchObject({ ok: false });
  });

  it('relays the sentence a window sends instead of a file', async () => {
    const sessionId = crypto.randomUUID();
    const waiter = awaitUpload('req-5');

    const res = await request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .field('requestId', 'req-5')
      .field('error', 'The recording came out bigger than 8 MB, so it was not saved.');

    expect(res.status).toBe(204);
    expect(await waiter).toEqual({
      ok: false,
      error: 'The recording came out bigger than 8 MB, so it was not saved.',
    });
  });

  it('rejects a malformed session id before reading a byte', async () => {
    const res = await request(testServer)
      .post('/api/sessions/..%2Fescape/devtools/recording')
      .field('requestId', 'req-6');

    expect(res.status).toBe(400);
  });
});
