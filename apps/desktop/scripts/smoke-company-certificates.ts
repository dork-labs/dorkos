/**
 * Packaged-smoke rows for company certificates under the fuses (DOR-3053,
 * DOR-3361).
 *
 * The fuses switch off `NODE_OPTIONS`, which also stops Electron's Node from
 * reading `NODE_EXTRA_CA_CERTS`. The app instead loads the bundle a person
 * chose in Settings (`network.extraCaCertsPath`) itself, before the server
 * opens a connection (`src/extra-ca-certs.ts`). This proves that still works
 * in the fused, packaged app: a throwaway CA is set as the company certificate
 * before launch, and the running server must report it loaded.
 *
 * Throwaway only: the CA is made with `openssl` in the smoke's own home, its
 * key is never written, and nothing touches a keychain.
 *
 * @module scripts/smoke-company-certificates
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** What `GET /api/config` says about company certificates. */
export interface CompanyCertificatesReport {
  network?: {
    extraCaCertsPath?: string | null;
    companyCertificates?: { outcome: string; added: number; path: string | null } | null;
  };
}

/**
 * Make a throwaway CA and name it as the company certificate in the smoke
 * home's `config.json`, before the app launches.
 *
 * @param home - The throwaway home the app will run against.
 * @returns The certificate file's absolute path.
 */
export function seedCompanyCertificate(home: string): string {
  const certificate = path.join(home, 'company-ca.pem');
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
      '/CN=DorkOS smoke CA',
    ].concat(['-keyout', '/dev/null', '-out', certificate]),
    { stdio: 'ignore' }
  );
  const dorkHome = path.join(home, '.dork');
  mkdirSync(dorkHome, { recursive: true });
  writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({ network: { extraCaCertsPath: certificate } }, null, 2)
  );
  return certificate;
}

/**
 * Ask the running app what it loaded, and throw unless it is the chosen file.
 *
 * @param baseUrl - The server's origin, e.g. `http://127.0.0.1:4242`.
 * @param certificate - The file {@link seedCompanyCertificate} chose.
 * @returns The line the smoke prints when it held.
 * @throws When the app did not report that one certificate loaded.
 */
export async function assertCompanyCertificateLoaded(
  baseUrl: string,
  certificate: string
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${baseUrl}/api/config answered ${response.status}`);
  const failure = companyCertificateFailure(
    (await response.json()) as CompanyCertificatesReport,
    certificate
  );
  if (failure) throw new Error(failure);
  return 'the company certificate chosen in Settings loaded with the fuses on';
}

/**
 * Whether the running app loaded the chosen certificate: `null` when it did,
 * otherwise what it reported instead.
 *
 * @param report - The `GET /api/config` payload.
 * @param certificate - The file {@link seedCompanyCertificate} chose.
 */
export function companyCertificateFailure(
  report: CompanyCertificatesReport,
  certificate: string
): string | null {
  const loaded = report.network?.companyCertificates ?? null;
  if (loaded?.outcome === 'added' && loaded.added === 1 && loaded.path === certificate) return null;
  return (
    `GET /api/config reported ${JSON.stringify(report.network ?? null)}; expected the one ` +
    `certificate in ${certificate} added. With the fuses on, NODE_EXTRA_CA_CERTS is not read, ` +
    `so a company network's certificates load only through this setting.`
  );
}
