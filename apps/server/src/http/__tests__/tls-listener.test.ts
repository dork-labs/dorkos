/**
 * DorkOS's own https listener (DOR-3172): off unless all three settings are
 * set, and a request on it is the one direct request that counts as on an
 * encrypted connection. Driven over a real TLS socket with a throwaway
 * self-signed certificate, through the same front-door server the app uses.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from '../api-chain.js';
import { createFrontDoorServer } from '../front-door.js';
import { honoRequestFacts } from '../request-facts.js';
import { readTlsListenerSettings, startTlsListener } from '../tls-listener.js';
import { isOnEncryptedConnection } from '../../services/core/auth/gate-policy.js';

const quiet = { info: vi.fn(), warn: vi.fn() };

describe('readTlsListenerSettings', () => {
  it('is off when nothing is set: a normal boot opens no https listener', () => {
    expect(readTlsListenerSettings({})).toBeNull();
    const create = vi.fn();
    expect(startTlsListener({}, create, vi.fn(), quiet)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses half a setup rather than honouring part of it', () => {
    expect(() => readTlsListenerSettings({ DORKOS_TLS_PORT: 4443 })).toThrow(/together/);
    expect(() => readTlsListenerSettings({ DORKOS_TLS_CERT: 'c', DORKOS_TLS_KEY: 'k' })).toThrow();
    const create = vi.fn();
    expect(startTlsListener({ DORKOS_TLS_PORT: 4443 }, create, vi.fn(), quiet)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('binds loopback unless told otherwise', () => {
    const all = { DORKOS_TLS_PORT: 4443, DORKOS_TLS_CERT: 'c', DORKOS_TLS_KEY: 'k' };
    expect(readTlsListenerSettings(all)?.host).toBe('127.0.0.1');
    expect(readTlsListenerSettings({ ...all, DORKOS_TLS_HOST: '192.168.1.5' })?.host).toBe(
      '192.168.1.5'
    );
  });
});

describe('a request on the https listener', () => {
  let dir: string;
  let server: Server | null = null;
  let port = 0;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dorkos-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' }
    );
    const app = new Hono<ApiEnv>();
    app.get('/probe', (c) => c.json({ encrypted: isOnEncryptedConnection(honoRequestFacts(c)) }));
    await new Promise<void>((resolve) => {
      server = startTlsListener(
        {
          DORKOS_TLS_PORT: 0 as unknown as number,
          DORKOS_TLS_CERT: path.join(dir, 'cert.pem'),
          DORKOS_TLS_KEY: path.join(dir, 'key.pem'),
        },
        (tls) => createFrontDoorServer(app, { tls }),
        (opened) => {
          port = (opened.address() as { port: number }).port;
          resolve();
        },
        quiet
      );
    });
  });

  afterAll(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** GET /probe over TLS with the given `Host`. */
  function probe(host: string): Promise<{ encrypted: boolean }> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port, path: '/probe', headers: { host }, rejectUnauthorized: false },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(JSON.parse(body) as { encrypted: boolean }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('reads the certificate it was given', () => {
    expect(readFileSync(path.join(dir, 'cert.pem'), 'utf8')).toContain('BEGIN CERTIFICATE');
  });

  it('counts another device on it as on an encrypted connection', async () => {
    expect(await probe('box.example:4443')).toEqual({ encrypted: true });
  });

  it('leaves this computer itself as this computer', async () => {
    expect(await probe(`127.0.0.1:${port}`)).toEqual({ encrypted: false });
  });
});
