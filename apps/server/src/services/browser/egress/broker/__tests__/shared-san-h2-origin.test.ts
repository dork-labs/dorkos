import { it, expect, onTestFinished } from 'vitest';
import { connect, type ClientHttp2Session } from 'node:http2';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  captureOriginalCertificateProducer,
  ownOriginalCertificateJoins,
} from './shared-san-h2-certificate.fixture.js';
import {
  createSharedSANH2Origin,
  assertSharedSANH2Evidence,
} from './shared-san-h2-origin.fixture.js';

it('named coalesced-authority mutant reaches denied SAN on the SAME warmed TLS/H2 session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'original-shared-san-h2-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const keyPath = join(home, 'key.pem');
  const certPath = join(home, 'cert.pem');
  const child = spawn(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=allowed.test',
      '-addext',
      'subjectAltName=DNS:allowed.test,DNS:denied.test',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const producer = captureOriginalCertificateProducer(child);
  onTestFinished(() => producer.close());
  await producer.wait();
  const certificate = await readFile(certPath);
  const origin = await createSharedSANH2Origin({
    key: await readFile(keyPath),
    certificate,
    allowedHostname: 'allowed.test',
    deniedHostname: 'denied.test',
    listenAddress: '127.0.0.1',
  });
  onTestFinished(() => origin.close());
  const allowedAuthority = `allowed.test:${origin.port}`;
  const deniedAuthority = `denied.test:${origin.port}`;
  // Calibration only: real loopback endpoint and explicit CA, never a production DNS/grant exception.
  const session = connect(`https://127.0.0.1:${origin.port}`, {
    ca: certificate,
    servername: 'allowed.test',
  });
  const returnedSession = new Promise<void>((resolve) => session.once('close', resolve));
  session.on('error', () => {});
  onTestFinished(async () => {
    session.destroy();
    await returnedSession;
  });
  await request(session, allowedAuthority, '/warm');
  const warmed = origin.snapshot();
  expect(warmed.connections).toBe(1);
  await request(session, deniedAuthority, '/forbidden');
  await request(session, allowedAuthority, '/continue');
  const actual = origin.snapshot();
  expect(actual.connections).toBe(1);
  expect(new Set(actual.rows.map((row) => row.session)).size).toBe(1);
  expect(() =>
    assertSharedSANH2Evidence({
      ...actual,
      allowedAuthority,
      deniedAuthority,
      allowedSession: actual.rows[0]!.session,
      originalConnectDenials: [],
    })
  ).toThrow('H2_FORBIDDEN_UPSTREAM_REQUEST');
});

it('missing original CONNECT denial cannot qualify otherwise healthy warmed-session observations', () => {
  expect(() =>
    assertSharedSANH2Evidence({
      allowedAuthority: 'allowed.test:443',
      deniedAuthority: 'denied.test:443',
      allowedSession: 1,
      rows: [
        { session: 1, authority: 'allowed.test:443', path: '/warm' },
        { session: 1, authority: 'allowed.test:443', path: '/continue' },
      ],
      originalConnectDenials: [],
    })
  ).toThrow('H2_SEPARATE_ORIGINAL_CONNECT_DENIAL_REQUIRED');
});

function request(session: ClientHttp2Session, authority: string, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = session.request({ ':authority': authority, ':path': path });
    stream.once('error', reject);
    stream.once('end', resolve);
    stream.resume();
    stream.end();
  });
}

it.each([false, undefined])(
  'original spawn/pipe cause %s still independently stops and joins held child and second pipe',
  async (cause) => {
    let releaseChild!: () => void;
    let releaseStderr!: () => void;
    const terminal = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const stderr = new Promise<void>((resolve) => {
      releaseStderr = resolve;
    });
    let stopped = 0;
    const owner = ownOriginalCertificateJoins({
      terminal,
      stdout: Promise.resolve(),
      stderr,
      stop() {
        stopped++;
        throw Error('LATER_STOP_FAILURE');
      },
    });
    owner.fail(cause);
    let returned = false;
    const closing = owner.close();
    const observed = closing.then(
      () => {
        returned = true;
      },
      (error) => {
        returned = true;
        expect(error).toBe(cause);
      }
    );
    onTestFinished(async () => {
      releaseChild();
      releaseStderr();
      await observed;
    });
    expect(owner.close()).toBe(closing);
    await Promise.resolve();
    expect(stopped).toBe(1);
    expect(returned).toBe(false);
    releaseChild();
    await Promise.resolve();
    expect(returned).toBe(false);
    releaseStderr();
    await observed;
    expect(returned).toBe(true);
  }
);

it.each([false, undefined])(
  'original stop throws %s without skipping either held pipe or child join',
  async (cause) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = ownOriginalCertificateJoins({
      terminal: held,
      stdout: held,
      stderr: held,
      stop() {
        throw cause;
      },
    });
    let returned = false;
    const observed = owner.close().then(
      () => {
        throw Error('STOP_FAILURE_LOST');
      },
      (error) => {
        returned = true;
        expect(error).toBe(cause);
      }
    );
    onTestFinished(async () => {
      release();
      await observed;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    release();
    await observed;
  }
);
