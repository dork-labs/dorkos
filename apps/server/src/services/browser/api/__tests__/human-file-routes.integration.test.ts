import { expect, it, onTestFinished, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { BrowserUploadRequestSchema } from '@dorkos/shared/browser-schemas';
import { fixture } from './input-routes.fixture.js';
import { BrowserUploadArtifacts } from '../files/upload-artifacts.js';
import { BrowserControllerUpload } from '../controller-upload.js';
import { BrowserControllerDownload } from '../controller-download.js';
import { BrowserHumanFileRoutes } from '../human-file-routes.js';
const io = vi.hoisted(() => ({
  closed: undefined as (() => void) | undefined,
  observe: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async realpath(...args: Parameters<typeof actual.realpath>) {
      const original = await actual.realpath(...args);
      await io.observe?.(String(args[0]));
      return original;
    },
  };
});
afterEach(() => {
  io.observe = undefined;
  io.closed = undefined;
});
async function humanFixture() {
  const originals: {
    routes?: BrowserHumanFileRoutes;
    upload?: BrowserControllerUpload;
    download?: BrowserControllerDownload;
    artifacts?: BrowserUploadArtifacts;
    home?: string;
  } = {};
  onTestFinished(async () => {
    let first: Readonly<{ value: unknown }> | undefined;
    for (const duty of [
      () => originals.routes?.close(),
      () => originals.upload?.close(),
      () => originals.download?.close(),
      () => originals.artifacts?.close(),
    ]) {
      try {
        await duty();
      } catch (value) {
        first ??= { value };
      }
    }
    if (first) throw first.value;
    if (originals.home) await rm(originals.home, { recursive: true, force: false });
  });
  originals.home = await mkdtemp(join(tmpdir(), 'browser-human-files-'));
  const home = await realpath(originals.home),
    stage = join(home, 'stage'),
    profile = join(home, 'profile');
  await Promise.all([mkdir(stage, { mode: 0o700 }), mkdir(profile, { mode: 0o700 })]);
  const f = await fixture();
  const artifacts = (originals.artifacts = new BrowserUploadArtifacts(stage, [profile]));
  const upload = (originals.upload = new BrowserControllerUpload(
    artifacts,
    f.identities,
    f.grants,
    () => true
  ));
  const download = (originals.download = new BrowserControllerDownload(
    artifacts,
    f.identities,
    f.grants,
    () => true
  ));
  upload.bindHost(f.control);
  download.bindHost(f.control);
  const dispatch = vi.fn<Parameters<typeof upload.owner.registerDispatcher>[0]['upload']>(
    async (value, _authority, lease, signal) => {
      const command = BrowserUploadRequestSchema.parse(value);
      await lease.consume(signal ?? new AbortController().signal);
      await lease.enter(async () => {});
      return f.input.capture(f.ownerRequest.req, f.ownerRequest.res).input(
        {
          kind: 'input',
          requestId: command.requestId,
          binding: command.binding,
          steps: [{ kind: 'mouseMove', x: 32, y: 36 }],
        },
        f.seat.controllerId!,
        undefined,
        signal
      );
    }
  );
  upload.owner.registerDispatcher({ upload: dispatch });
  const routes = (originals.routes = new BrowserHumanFileRoutes(
    upload,
    download,
    artifacts,
    f.identities,
    f.grants,
    () => true
  ));
  f.canvasHttp.app.use('/api/private-browser-files', (_req, res, next) => {
    res.once('close', () => io.closed?.());
    next();
  });
  f.canvasHttp.app.use('/api/private-browser-files', routes.router);
  const send = (
    kind: string,
    body: unknown,
    cookie = f.cookieOwner,
    origin: string | null = f.origin
  ) => {
    let original = request(f.canvasHttp.server)
      .post('/api/private-browser-files/files/' + kind)
      .set('Host', f.host)
      .set('Cookie', cookie);
    if (origin !== null) original = original.set('Origin', origin);
    return original.send(body as Parameters<typeof original.send>[0]);
  };
  const issue = () =>
    send('grant', {
      binding: f.seat.binding,
      attachment: f.issueGrant(['browser.view']).attachment,
      permissions: ['browser.artifact', 'browser.upload'],
      expiresInMs: 60000,
    });
  return { f, send, issue, dispatch, stage };
}
// Genuine HTTP/cookie/SQLite/grants/staging IO; only the native chooser dispatcher is controlled.
it('explicit self grant stages and retrieves only original private bytes, then dispatches upload once', async () => {
  const h = await humanFixture(),
    issued = await h.issue();
  expect(issued.status).toBe(200);
  const grant = { grantId: issued.body.grantId, revision: issued.body.grantRevision };
  const body = {
    binding: h.f.seat.binding,
    artifactGrant: grant,
    name: 'note.txt',
    mimeType: 'text/plain',
    base64: Buffer.from('human file').toString('base64'),
  };
  const staged = await h.send('stage', body);
  expect(staged.status).toBe(200);
  const read = await h.send('read', {
    binding: h.f.seat.binding,
    artifactGrant: grant,
    artifactId: staged.body.artifactId,
  });
  expect(read.status).toBe(200);
  expect(Buffer.from(read.body.base64, 'base64').toString()).toBe('human file');
  expect(JSON.stringify(read.body)).not.toContain('path');
  const command = {
    kind: 'upload',
    requestId: 'request_human_upload_fixture_01',
    binding: h.f.seat.binding,
    artifactId: staged.body.artifactId,
    activation: { x: 32, y: 36 },
  };
  const uploaded = await h.send('upload', {
    binding: h.f.seat.binding,
    controllerId: h.f.seat.controllerId,
    artifactGrant: grant,
    transferGrant: grant,
    command,
  });
  expect(uploaded.status).toBe(200);
  expect(uploaded.body.outcome).toBe('completed');
  expect(uploaded.body.requestId).toBe(command.requestId);
  expect(uploaded.body).not.toHaveProperty('kind');
  expect(h.dispatch).toHaveBeenCalledOnce();
});
it('outsider, missing origin, forged identity/path and unknown artifact do not acquire file authority', async () => {
  const h = await humanFixture(),
    issued = await h.issue();
  expect(issued.status).toBe(200);
  const grant = { grantId: issued.body.grantId, revision: issued.body.grantRevision };
  const body = {
    binding: h.f.seat.binding,
    artifactGrant: grant,
    name: 'note.txt',
    mimeType: 'text/plain',
    base64: 'aHVtYW4=',
  };
  expect((await h.send('stage', body, h.f.cookieOtherViewer)).status).toBe(404);
  expect((await h.send('stage', body, h.f.cookieOwner, null)).status).toBe(404);
  expect((await h.send('stage', { ...body, owner: h.f.canvasScope.owner })).status).toBe(400);
  expect((await h.send('stage', { ...body, name: '../profile/cookies' })).status).toBe(400);
  expect(
    (
      await h.send('read', {
        binding: h.f.seat.binding,
        artifactGrant: grant,
        artifactId: 'artifact_unknown_fixture_01',
      })
    ).status
  ).toBe(404);
  expect(h.dispatch).not.toHaveBeenCalled();
  expect((await h.send('stage', body)).status).toBe(200);
});
it('revoking the original artifact grant fences later byte retrieval without stopping its browser', async () => {
  const h = await humanFixture(),
    issued = await h.issue();
  expect(issued.status).toBe(200);
  const grant = { grantId: issued.body.grantId, revision: issued.body.grantRevision };
  const staged = await h.send('stage', {
    binding: h.f.seat.binding,
    artifactGrant: grant,
    name: 'note.txt',
    mimeType: 'text/plain',
    base64: 'aHVtYW4=',
  });
  expect(staged.status).toBe(200);
  expect(
    (await h.send('revoke', { binding: h.f.seat.binding, grant, permission: 'browser.artifact' }))
      .status
  ).toBe(200);
  const read = await h.send('read', {
    binding: h.f.seat.binding,
    artifactGrant: grant,
    artifactId: staged.body.artifactId,
  });
  expect(read.status).toBe(404);
  expect(read.body).not.toHaveProperty('base64');
  expect(h.f.engine.listTabs(h.f.opened.browserId, h.f.opened.browserGeneration)).toHaveLength(1);
});

it('grant revocation during an entered original file read refuses that read without poisoning another authorized artifact', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  const h = await humanFixture();
  const issued = await h.issue();
  expect(issued.status).toBe(200);
  const grant = { grantId: issued.body.grantId, revision: issued.body.grantRevision };
  const stage = async (name: string) =>
    h.send('stage', {
      binding: h.f.seat.binding,
      artifactGrant: grant,
      name,
      mimeType: 'text/plain',
      base64: Buffer.from(name).toString('base64'),
    });
  const first = await stage('first.txt'),
    second = await stage('second.txt');
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  io.observe = async (path) => {
    if (path === join(h.stage, first.body.artifactId)) {
      entered();
      await held;
    }
  };
  const original = h
    .send('read', {
      binding: h.f.seat.binding,
      artifactGrant: grant,
      artifactId: first.body.artifactId,
    })
    .then((response) => response);
  onTestFinished(async () => {
    release();
    await original;
  });
  await started;
  expect(
    (await h.send('revoke', { binding: h.f.seat.binding, grant, permission: 'browser.artifact' }))
      .status
  ).toBe(200);
  release();
  const refused = await original;
  expect(refused.status).toBe(404);
  expect(refused.body).not.toHaveProperty('base64');
  io.observe = undefined;
  const renewed = await h.issue();
  expect(renewed.status).toBe(200);
  const authorized = await h.send('read', {
    binding: h.f.seat.binding,
    artifactGrant: { grantId: renewed.body.grantId, revision: renewed.body.grantRevision },
    artifactId: second.body.artifactId,
  });
  expect(authorized.status).toBe(200);
  expect(Buffer.from(authorized.body.base64, 'base64').toString()).toBe('second.txt');
});

it('disconnecting an entered original HTTP read cancels only that read and leaves another authorized artifact readable', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  const h = await humanFixture(),
    issued = await h.issue();
  expect(issued.status).toBe(200);
  const grant = { grantId: issued.body.grantId, revision: issued.body.grantRevision };
  const stage = async (name: string) =>
    h.send('stage', {
      binding: h.f.seat.binding,
      artifactGrant: grant,
      name,
      mimeType: 'text/plain',
      base64: Buffer.from(name).toString('base64'),
    });
  const first = await stage('first.txt'),
    second = await stage('second.txt');
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  let entered!: () => void, closed!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const serverClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  io.observe = async (path) => {
    if (path === join(h.stage, first.body.artifactId)) {
      entered();
      await held;
    }
  };
  io.closed = closed;
  const address = h.f.canvasHttp.server.address();
  if (!address || typeof address === 'string') throw new Error('ORIGINAL_HTTP_ADDRESS_REQUIRED');
  const body = JSON.stringify({
    binding: h.f.seat.binding,
    artifactGrant: grant,
    artifactId: first.body.artifactId,
  });
  const original = httpRequest({
    host: '127.0.0.1',
    port: address.port,
    method: 'POST',
    path: '/api/private-browser-files/files/read',
    headers: {
      Host: h.f.host,
      Cookie: h.f.cookieOwner,
      Origin: h.f.origin,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  const clientClosed = new Promise<void>((resolve) => {
    original.once('close', resolve);
  });
  original.on('error', () => {}); // Destroy's original socket error is expected; close is joined below.
  original.on('response', (response) => response.resume());
  onTestFinished(async () => {
    original.destroy();
    release();
    await clientClosed;
  });
  original.end(body);
  await started;
  original.destroy();
  await Promise.all([clientClosed, serverClosed]);
  io.closed = undefined;
  release();
  io.observe = undefined;
  const authorized = await h.send('read', {
    binding: h.f.seat.binding,
    artifactGrant: grant,
    artifactId: second.body.artifactId,
  });
  expect(authorized.status).toBe(200);
  expect(Buffer.from(authorized.body.base64, 'base64').toString()).toBe('second.txt');
});
