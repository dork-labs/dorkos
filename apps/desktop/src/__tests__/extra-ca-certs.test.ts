/**
 * A company network's certificates reach `fetch` and `https` in the desktop app
 * (DOR-3361), against a real TLS server whose certificate a throwaway CA
 * signed. The control comes first: before the bundle is added, both refuse the
 * server; after, both reach it.
 *
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https, { type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyExtraCaCerts } from '../extra-ca-certs';

let dir: string;
let server: Server;
let url: string;

/** Run openssl quietly in the scratch folder. */
function openssl(args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

/** A self-signed CA, written as `<name>.key` and `<name>.pem`. */
function makeCa(name: string): void {
  openssl(
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${name}`].concat([
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.pem`,
    ])
  );
}

/** What `fetch` and `https.get` each made of the server. */
async function reach(): Promise<{ fetch: string; https: string }> {
  const viaFetch = await fetch(url).then(
    (res) => res.text(),
    (err: Error & { cause?: { code?: string } }) => `refused: ${err.cause?.code}`
  );
  const viaHttps = await new Promise<string>((resolve) => {
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', (err: NodeJS.ErrnoException) => resolve(`refused: ${err.code}`));
  });
  return { fetch: viaFetch, https: viaHttps };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dorkos-extra-ca-'));
  makeCa('company-ca');
  makeCa('other-ca');
  openssl(
    ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost'].concat([
      '-keyout',
      'server.key',
      '-out',
      'server.csr',
    ])
  );
  writeFileSync(path.join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl(
    [
      'x509',
      '-req',
      '-in',
      'server.csr',
      '-CA',
      'company-ca.pem',
      '-CAkey',
      'company-ca.key',
    ].concat(['-CAcreateserial', '-days', '1', '-extfile', 'san.ext', '-out', 'server.pem'])
  );
  server = https.createServer(
    {
      key: readFileSync(path.join(dir, 'server.key')),
      cert: readFileSync(path.join(dir, 'server.pem')),
    },
    (_req, res) => res.end('reached')
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `https://localhost:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe('applyExtraCaCerts', () => {
  it('does nothing when the variable is not set', () => {
    expect(applyExtraCaCerts({ env: {}, electron: true })).toEqual({
      outcome: 'not-set',
      added: 0,
    });
  });

  // Plain Node read the file itself, so adding it again would only duplicate it.
  it('leaves plain Node to read the file itself', () => {
    const env = { NODE_EXTRA_CA_CERTS: path.join(dir, 'company-ca.pem') };
    expect(applyExtraCaCerts({ env, electron: false })).toEqual({ outcome: 'native', added: 0 });
  });

  it('skips, and says so, a file it cannot read or that holds no certificate', () => {
    const warn = vi.fn();
    const missing = { NODE_EXTRA_CA_CERTS: path.join(dir, 'missing.pem') };
    expect(applyExtraCaCerts({ env: missing, electron: true, warn }).outcome).toBe('unreadable');
    writeFileSync(path.join(dir, 'empty.pem'), 'not a certificate\n');
    const empty = { NODE_EXTRA_CA_CERTS: path.join(dir, 'empty.pem') };
    expect(applyExtraCaCerts({ env: empty, electron: true, warn }).outcome).toBe('empty');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain('missing.pem');
  });

  // One case, in order, because the trust store is the process's own: the
  // control has to run before the bundle is added.
  it('lets fetch and https reach a server the company CA signed, and only after', async () => {
    expect(await reach()).toEqual({
      fetch: 'refused: UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      https: 'refused: UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    // A bundle of two, as a company file often is: every certificate in it counts.
    const bundle = path.join(dir, 'bundle.pem');
    writeFileSync(
      bundle,
      `${readFileSync(path.join(dir, 'other-ca.pem'), 'utf8')}\n${readFileSync(path.join(dir, 'company-ca.pem'), 'utf8')}`
    );
    const result = applyExtraCaCerts({ env: { NODE_EXTRA_CA_CERTS: bundle }, electron: true });
    expect(result).toEqual({ outcome: 'added', added: 2 });
    expect(await reach()).toEqual({ fetch: 'reached', https: 'reached' });
  });
});
