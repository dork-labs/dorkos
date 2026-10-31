/**
 * The packaged smoke's company-certificate row (DOR-3053): the seed writes a
 * real certificate and names it in the smoke home's `config.json`, and the
 * check passes only when the running app reports that exact file loaded.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  companyCertificateFailure,
  seedCompanyCertificate,
  type CompanyCertificatesReport,
} from '../smoke-company-certificates';

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-smoke-cert-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('seedCompanyCertificate', () => {
  it('writes one certificate, no key, and names it in the data folder the app reads', () => {
    const certificate = seedCompanyCertificate(home);
    const pem = readFileSync(certificate, 'utf8');
    expect(pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1);
    expect(pem).not.toContain('PRIVATE KEY');
    const config = JSON.parse(readFileSync(path.join(home, '.dork', 'config.json'), 'utf8'));
    expect(config).toEqual({ network: { extraCaCertsPath: certificate } });
  });
});

describe('companyCertificateFailure', () => {
  const file = '/tmp/home/company-ca.pem';
  type Loaded = NonNullable<CompanyCertificatesReport['network']>['companyCertificates'];
  const report = (companyCertificates: Loaded): CompanyCertificatesReport => ({
    network: { extraCaCertsPath: file, companyCertificates },
  });

  it('passes only when that one file was added', () => {
    expect(
      companyCertificateFailure(report({ outcome: 'added', added: 1, path: file }), file)
    ).toBeNull();
  });

  it.each([
    ['nothing reported (the fused app did not load it)', null],
    ['the file could not be used', { outcome: 'unreadable', added: 0, path: file }],
    ['another file loaded', { outcome: 'added', added: 1, path: '/elsewhere.pem' }],
    [
      'the environment variable was ignored instead',
      { outcome: 'ignored-env', added: 0, path: null },
    ],
  ])('fails when %s', (_label, companyCertificates) => {
    expect(companyCertificateFailure(report(companyCertificates), file)).toContain(file);
  });
});
