/**
 * The packaged smoke's company-certificate rows (DOR-3053, DOR-3361): the seed
 * writes a real certificate and names it in the smoke home's `config.json`,
 * the check passes only when the running app reports that exact file and
 * count loaded, and a newly chosen file must read as pending until a restart.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  companyCertificateFailure,
  pendingCertificateFailure,
  seedCompanyCertificate,
  writeCertificateBundle,
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

describe('writeCertificateBundle', () => {
  it('writes as many certificates as asked, and no keys', () => {
    const pem = readFileSync(writeCertificateBundle(home, 'two.pem', 2), 'utf8');
    expect(pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
    expect(pem).not.toContain('PRIVATE KEY');
  });
});

describe('companyCertificateFailure with a count', () => {
  const file = '/tmp/home/company-ca-two.pem';
  const report = (added: number): CompanyCertificatesReport => ({
    network: {
      extraCaCertsPath: file,
      companyCertificates: { outcome: 'added', added, path: file },
    },
  });

  it('passes only at the expected count', () => {
    expect(companyCertificateFailure(report(2), file, 2)).toBeNull();
    expect(companyCertificateFailure(report(1), file, 2)).toContain('expected 2');
  });
});

describe('pendingCertificateFailure', () => {
  const before = { path: '/tmp/home/company-ca.pem', added: 1 };
  const chosen = '/tmp/home/company-ca-one.pem';
  const report = (
    saved: string | null,
    loaded: { added: number; path: string }
  ): CompanyCertificatesReport => ({
    network: { extraCaCertsPath: saved, companyCertificates: { outcome: 'added', ...loaded } },
  });

  it('passes when the setting names the new file and the old one is still loaded', () => {
    expect(pendingCertificateFailure(report(chosen, before), chosen, before)).toBeNull();
  });

  it.each([
    ['the choice was not saved', report(before.path, before)],
    ['the new file loaded without a restart', report(chosen, { added: 1, path: chosen })],
    ['the loaded count changed', report(chosen, { added: 2, path: before.path })],
  ])('fails when %s', (_label, payload) => {
    expect(pendingCertificateFailure(payload, chosen, before)).toContain(chosen);
  });
});
