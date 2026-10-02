import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
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

const app = createApp({ admission: new MainRequestAdmission() });
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

it('rejects a known recording upload with wrong or missing lifetime binding without consuming or writing it', async () => {
  const sessionId = crypto.randomUUID();
  const recordingId = `BOUND${crypto.randomUUID()}`;
  const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
  const base = { ...binding, logicalUrl: 'page', seq: 0, console: [], network: [] };
  devtoolsCaptureStore.ingest(sessionId, { ...base, active: true, instrumented: true }, 'host');
  const pending = devtoolsCaptureStore.awaitRecording(
    'bound-upload',
    { recordingId, cwd, full: false, binding },
    5000
  );
  const post = (client: string, generation?: string, documentId: string | undefined = 'doc') => {
    const req = request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .set('X-Client-Id', client)
      .field('requestId', 'bound-upload')
      .field('frames', '1')
      .field('durationMs', '500');
    if (documentId) req.field('documentId', documentId);
    if (generation) req.field('bridgeGeneration', generation);
    return req.attach('recording', GIF, { filename: 'ignored.gif', contentType: 'image/gif' });
  };
  for (const [client, generation, documentId] of [
    ['other', 'generation', 'doc'],
    ['host', undefined, 'doc'],
    ['host', 'wrong', 'doc'],
    ['host', 'generation', ''],
    ['host', 'generation', 'wrong-doc'],
  ] as const) {
    expect((await post(client, generation, documentId)).status).toBe(409);
    expect(devtoolsCaptureStore.pendingRecording('bound-upload')).toBeDefined();
    await expect(
      fs.stat(path.join(cwd, '.dork', '.temp', 'recordings', `${recordingId}.gif`))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect((await post('host', 'generation')).status).toBe(204);
  expect(await pending).toMatchObject({ ok: true });
});

it('refuses an old-open-host recording upload omitting its pinned document without writing or consuming', async () => {
  const sessionId = crypto.randomUUID();
  const recordingId = `LEGACY${crypto.randomUUID()}`;
  const binding = { clientId: 'old-host', documentId: 'doc' };
  devtoolsCaptureStore.ingest(
    sessionId,
    {
      documentId: 'doc',
      logicalUrl: 'page',
      seq: 0,
      console: [],
      network: [],
      active: true,
      instrumented: true,
    },
    'old-host'
  );
  const pending = devtoolsCaptureStore.awaitRecording(
    'legacy-document',
    { recordingId, cwd, full: false, binding },
    5000
  );
  const response = await request(testServer)
    .post(`/api/sessions/${sessionId}/devtools/recording`)
    .set('X-Client-Id', 'old-host')
    .field('requestId', 'legacy-document')
    .field('frames', '1')
    .field('durationMs', '500')
    .attach('recording', GIF, { filename: 'ignored.gif', contentType: 'image/gif' });
  expect(response.status).toBe(409);
  expect(devtoolsCaptureStore.pendingRecording('legacy-document')).toBeDefined();
  await expect(
    fs.stat(path.join(cwd, '.dork', '.temp', 'recordings', `${recordingId}.gif`))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  devtoolsCaptureStore.resolveRecording('legacy-document', {
    ok: false,
    error: 'Canceled by host.',
    provenance: 'host',
  });
  await pending;
});

it.each(['file', 'error'] as const)(
  'a concurrent %s upload cannot delete or overwrite the successful winner bytes or receipt',
  async (competitor) => {
    const sessionId = crypto.randomUUID();
    const recordingId = `DUPLICATE${crypto.randomUUID()}`;
    const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
    devtoolsCaptureStore.ingest(
      sessionId,
      {
        ...binding,
        logicalUrl: 'page',
        seq: 0,
        console: [],
        network: [],
        active: true,
        instrumented: true,
      },
      'host'
    );
    const waiter = devtoolsCaptureStore.awaitRecording(
      'duplicate-upload',
      { recordingId, cwd, full: false, binding },
      5000
    );
    const firstBytes = Buffer.from('GIF89a-first');
    const secondBytes = Buffer.from('GIF89a-second');
    const originalWrite = fs.writeFile.bind(fs);
    const mkdir = vi.spyOn(fs, 'mkdir');
    const rename = vi.spyOn(fs, 'rename');
    const unlink = vi.spyOn(fs, 'unlink');
    const settlement = vi.spyOn(devtoolsCaptureStore, 'resolveRecording');
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const writes: string[] = [];
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      const bytes = args[1];
      if (Buffer.isBuffer(bytes) && bytes.subarray(0, 6).toString() === 'GIF89a') {
        writes.push(String(args[0]));
        await new Promise<void>((resolve) => {
          if (bytes.equals(firstBytes)) releaseFirst = resolve;
          else releaseSecond = resolve;
        });
      }
      return originalWrite(...args);
    });
    const post = (bytes: Buffer) =>
      request(testServer)
        .post(`/api/sessions/${sessionId}/devtools/recording`)
        .set('X-Client-Id', 'host')
        .field('requestId', 'duplicate-upload')
        .field('documentId', 'doc')
        .field('bridgeGeneration', 'generation')
        .field('frames', '1')
        .field('durationMs', '500')
        .attach('recording', bytes, { filename: 'ignored.gif', contentType: 'image/gif' });
    const first = post(firstBytes).then((response) => response);
    let second: typeof first | undefined;
    try {
      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      const ownerDirectoryCalls = mkdir.mock.calls.length;
      let secondStatus: number | undefined;
      const secondRequest =
        competitor === 'file'
          ? post(secondBytes)
          : request(testServer)
              .post(`/api/sessions/${sessionId}/devtools/recording`)
              .set('X-Client-Id', 'host')
              .field('requestId', 'duplicate-upload')
              .field('documentId', 'doc')
              .field('bridgeGeneration', 'generation')
              .field('error', 'A competing page failure.');
      second = secondRequest.then((response) => {
        secondStatus = response.status;
        return response;
      });
      await vi.waitFor(() =>
        expect(releaseSecond !== undefined || secondStatus !== undefined).toBe(true)
      );
      expect(secondStatus).toBe(409);
      expect(releaseSecond).toBeUndefined();
      expect(writes).toHaveLength(1);
      expect(mkdir.mock.calls).toHaveLength(ownerDirectoryCalls);
      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      releaseFirst!();
      expect((await first).status).toBe(204);
      const outcome = await waiter;
      expect(outcome).toMatchObject({ ok: true, bytes: firstBytes.length });
      const file = path.join(cwd, '.dork', '.temp', 'recordings', `${recordingId}.gif`);
      expect(await fs.readFile(file)).toEqual(firstBytes);
      releaseSecond?.();
      expect((await second).status).toBe(409);
      expect(await fs.readFile(file)).toEqual(firstBytes);
      expect(writes).toHaveLength(1);
      expect(settlement).toHaveBeenCalledTimes(1);
      expect(devtoolsCaptureStore.pendingRecording('duplicate-upload')).toBeUndefined();
    } finally {
      releaseFirst?.();
      releaseSecond?.();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      vi.restoreAllMocks();
    }
  }
);

it.each(['timeout', 'revocation', 'canonical-rekey'] as const)(
  'an upload preserves the correct publication outcome across %s during a filesystem await',
  async (boundary) => {
    const sessionId = crypto.randomUUID();
    const recordingId = `RETIRE${crypto.randomUUID()}`;
    const requestId = `retire-${boundary}`;
    const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
    const claim = {
      ...binding,
      logicalUrl: 'page',
      seq: 0,
      console: [],
      network: [],
      active: true,
      instrumented: true,
    };
    devtoolsCaptureStore.ingest(sessionId, claim, 'host');
    const waiter = devtoolsCaptureStore.awaitRecording(
      requestId,
      { recordingId, cwd, full: false, binding },
      boundary === 'timeout' ? 500 : 5000
    );
    let release: (() => void) | undefined;
    const write = fs.writeFile.bind(fs);
    const rename = fs.rename.bind(fs);
    if (boundary === 'timeout')
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return write(...args);
      });
    else
      vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return rename(...args);
      });
    const upload = request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .set('X-Client-Id', 'host')
      .field('requestId', requestId)
      .field('documentId', 'doc')
      .field('bridgeGeneration', 'generation')
      .field('frames', '1')
      .field('durationMs', '500')
      .attach('recording', GIF, { filename: 'ignored.gif', contentType: 'image/gif' })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(release).toBeDefined());
      if (boundary === 'timeout') expect(await waiter).toBeUndefined();
      else if (boundary === 'revocation')
        devtoolsCaptureStore.ingest(sessionId, { ...claim, active: false }, 'host');
      else devtoolsCaptureStore.rekeySession(sessionId, crypto.randomUUID());
      release!();
      expect((await upload).status).toBe(boundary === 'canonical-rekey' ? 204 : 409);
      if (boundary === 'canonical-rekey')
        expect(await waiter).toMatchObject({ ok: true, bytes: GIF.length });
      const directory = path.join(cwd, '.dork', '.temp', 'recordings');
      await vi.waitFor(async () => {
        const files = await fs.readdir(directory);
        if (boundary === 'canonical-rekey')
          expect(await fs.readFile(path.join(directory, `${recordingId}.gif`))).toEqual(GIF);
        else expect(files).not.toContain(`${recordingId}.gif`);
        expect(files.filter((name) => name.endsWith('.upload'))).toHaveLength(0);
      });
      // Restoring the exact claim permits a fresh owner after the retired owner's cleanup.
      if (boundary !== 'canonical-rekey') devtoolsCaptureStore.ingest(sessionId, claim, 'host');
      if (boundary === 'revocation') {
        const lease = devtoolsCaptureStore.claimRecordingUpload(requestId, binding);
        expect(lease).toBeDefined();
        devtoolsCaptureStore.resolveRecordingUpload(lease!, {
          ok: false,
          error: 'Host cleanup.',
          provenance: 'host',
        });
        devtoolsCaptureStore.releaseRecordingUpload(lease!);
        await waiter;
      }
    } finally {
      release?.();
      await upload;
      vi.restoreAllMocks();
    }
  }
);

it.each(['write', 'publication'] as const)(
  'a staged %s failure settles the host waiter, cleans its stage and permits another upload',
  async (failure) => {
    const sessionId = crypto.randomUUID();
    const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
    devtoolsCaptureStore.ingest(
      sessionId,
      {
        ...binding,
        logicalUrl: 'page',
        seq: 0,
        console: [],
        network: [],
        active: true,
        instrumented: true,
      },
      'host'
    );
    const recordingId = `FAIL${crypto.randomUUID()}`;
    const waiter = devtoolsCaptureStore.awaitRecording(
      'failing-upload',
      { recordingId, cwd, full: false, binding },
      5000
    );
    const directory = path.join(cwd, '.dork', '.temp', 'recordings');
    const previous = Buffer.from('GIF89a-existing-owned-artifact');
    if (failure === 'publication') {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${recordingId}.gif`), previous);
    }
    const write = fs.writeFile.bind(fs);
    const spy = failure === 'write' ? vi.spyOn(fs, 'writeFile') : vi.spyOn(fs, 'rename');
    if (failure === 'write')
      vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
        await write(...args);
        throw new Error('Controlled filesystem failure after partial stage allocation.');
      });
    else spy.mockRejectedValueOnce(new Error('Controlled publication failure.'));
    const post = (requestId: string) =>
      request(testServer)
        .post(`/api/sessions/${sessionId}/devtools/recording`)
        .set('X-Client-Id', 'host')
        .field('requestId', requestId)
        .field('documentId', 'doc')
        .field('bridgeGeneration', 'generation')
        .field('frames', '1')
        .field('durationMs', '500')
        .attach('recording', GIF, { filename: 'ignored.gif', contentType: 'image/gif' });
    try {
      expect((await post('failing-upload')).status).toBe(500);
      expect(await waiter).toMatchObject({ ok: false, provenance: 'host' });
      await vi.waitFor(async () => {
        const files = await fs.readdir(directory);
        if (failure === 'publication')
          expect(await fs.readFile(path.join(directory, `${recordingId}.gif`))).toEqual(previous);
        else expect(files).not.toContain(`${recordingId}.gif`);
        expect(files.filter((name) => name.endsWith('.upload'))).toHaveLength(0);
      });
      spy.mockRestore();
      const next = devtoolsCaptureStore.awaitRecording(
        'next-upload',
        { recordingId: `NEXT${recordingId}`, cwd, full: false, binding },
        5000
      );
      expect((await post('next-upload')).status).toBe(204);
      expect(await next).toMatchObject({ ok: true });
    } finally {
      vi.restoreAllMocks();
    }
  }
);

it('holds exclusion through expired-owner final-file cleanup before a replacement may publish', async () => {
  const sessionId = crypto.randomUUID();
  const recordingId = `CLEANUP${crypto.randomUUID()}`;
  const requestId = 'cleanup-owner';
  const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
  devtoolsCaptureStore.ingest(
    sessionId,
    { ...binding, seq: 0, console: [], network: [], active: true, instrumented: true },
    'host'
  );
  const oldWaiter = devtoolsCaptureStore.awaitRecording(
    requestId,
    { recordingId, cwd, full: false, binding },
    500
  );
  const destination = path.join(cwd, '.dork', '.temp', 'recordings', `${recordingId}.gif`);
  const rename = fs.rename.bind(fs);
  const unlink = fs.unlink.bind(fs);
  let releaseRename: (() => void) | undefined;
  let releaseCleanup: (() => void) | undefined;
  let cleanupFinished = false;
  vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    return rename(...args);
  });
  vi.spyOn(fs, 'unlink').mockImplementation(async (...args) => {
    if (String(args[0]) === destination && !cleanupFinished) {
      await new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      await unlink(...args);
      cleanupFinished = true;
      return;
    }
    return unlink(...args);
  });
  const post = (bytes: Buffer) =>
    request(testServer)
      .post(`/api/sessions/${sessionId}/devtools/recording`)
      .set('X-Client-Id', 'host')
      .field('requestId', requestId)
      .field('documentId', 'doc')
      .field('bridgeGeneration', 'generation')
      .field('frames', '1')
      .field('durationMs', '500')
      .attach('recording', bytes, { filename: 'ignored.gif', contentType: 'image/gif' });
  const oldUpload = post(Buffer.from('GIF89a-expired')).then((response) => response);
  try {
    await vi.waitFor(() => expect(releaseRename).toBeDefined());
    expect(await oldWaiter).toBeUndefined();
    let replacementSettled = false;
    const replacement = devtoolsCaptureStore
      .awaitRecording(requestId, { recordingId, cwd, full: false, binding }, 5000)
      .then((outcome) => {
        replacementSettled = true;
        return outcome;
      });
    releaseRename!();
    await vi.waitFor(() => expect(releaseCleanup).toBeDefined());
    expect((await oldUpload).status).toBe(409);
    expect(await fs.readFile(destination)).toEqual(Buffer.from('GIF89a-expired'));
    expect((await post(Buffer.from('GIF89a-too-early'))).status).toBe(409);
    expect(replacementSettled).toBe(false);
    expect(devtoolsCaptureStore.pendingRecording(requestId)?.recordingId).toBe(recordingId);
    releaseCleanup!();
    await vi.waitFor(() => expect(cleanupFinished).toBe(true));
    const winner = Buffer.from('GIF89a-replacement');
    expect((await post(winner)).status).toBe(204);
    expect(await replacement).toMatchObject({ ok: true, bytes: winner.length });
    expect(await fs.readFile(destination)).toEqual(winner);
    expect(devtoolsCaptureStore.pendingRecording(requestId)).toBeUndefined();
  } finally {
    releaseRename?.();
    releaseCleanup?.();
    await oldUpload;
    vi.restoreAllMocks();
  }
});
