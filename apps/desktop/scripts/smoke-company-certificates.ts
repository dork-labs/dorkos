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
 * It then walks the Settings row's own flow: choose a file through the same
 * `PATCH /api/config` the row saves with, see the change reported as pending
 * while the old certificates stay loaded, restart, and see the new count. A
 * second file with a different count makes the reload visible. The restart is
 * a quit and relaunch against the same home: the Restart button's IPC
 * (`admin:restart-server`) only answers the app's own window, and the fuses
 * refuse the debugging switches a script would need to reach it. Both reload
 * the certificates the same way, in a fresh server process. The native file
 * dialog is not driven either; the path is set directly, as the row sets it.
 *
 * Throwaway only: the CAs are made with `openssl` in the smoke's own home,
 * their keys are never written, and nothing touches a keychain.
 *
 * @module scripts/smoke-company-certificates
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** What `GET /api/config` says about company certificates. */
export interface CompanyCertificatesReport {
  network?: {
    extraCaCertsPath?: string | null;
    companyCertificates?: { outcome: string; added: number; path: string | null } | null;
  };
}

/** Where the running server listens, as the packaged smoke found it. */
export interface ServerAddress {
  host: string;
  port: number;
}

/** A certificate file and how many certificates it holds. */
export interface LoadedCertificates {
  path: string;
  added: number;
}

/** Timeout for one config read or write against the running app. */
const CONFIG_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Write a bundle of `count` throwaway CA certificates, with no keys.
 *
 * @param home - The throwaway home the app runs against.
 * @param name - The bundle's file name inside `home`.
 * @param count - How many certificates it holds.
 * @returns The bundle's absolute path.
 */
export function writeCertificateBundle(home: string, name: string, count: number): string {
  const bundle = path.join(home, name);
  const scratch = path.join(home, `${name}.one`);
  writeFileSync(bundle, '');
  for (let i = 1; i <= count; i++) {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1'].concat([
        '-subj',
        `/CN=DorkOS smoke CA ${i}`,
        '-keyout',
        '/dev/null',
        '-out',
        scratch,
      ]),
      { stdio: 'ignore' }
    );
    appendFileSync(bundle, readFileSync(scratch));
  }
  rmSync(scratch, { force: true });
  return bundle;
}

/**
 * Make a throwaway CA and name it as the company certificate in the smoke
 * home's `config.json`, before the app launches.
 *
 * @param home - The throwaway home the app will run against.
 * @returns The certificate file's absolute path.
 */
export function seedCompanyCertificate(home: string): string {
  const certificate = writeCertificateBundle(home, 'company-ca.pem', 1);
  const dorkHome = path.join(home, '.dork');
  mkdirSync(dorkHome, { recursive: true });
  writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({ network: { extraCaCertsPath: certificate } }, null, 2)
  );
  return certificate;
}

/** Read `GET /api/config` from the running app. */
async function readCertificates(origin: string): Promise<CompanyCertificatesReport> {
  const response = await fetch(`${origin}/api/config`, {
    signal: AbortSignal.timeout(CONFIG_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${origin}/api/config answered ${response.status}`);
  return (await response.json()) as CompanyCertificatesReport;
}

/** Choose a file the way the Settings row saves it: `PATCH /api/config`. */
async function chooseCertificateFile(origin: string, file: string): Promise<void> {
  const response = await fetch(`${origin}/api/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: { extraCaCertsPath: file } }),
    signal: AbortSignal.timeout(CONFIG_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `PATCH ${origin}/api/config answered ${response.status}: ${await response.text()}`
    );
  }
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
  const failure = companyCertificateFailure(await readCertificates(baseUrl), certificate);
  if (failure) throw new Error(failure);
  return 'the company certificate chosen in Settings loaded with the fuses on';
}

/**
 * Whether the running app loaded the chosen certificates: `null` when it did,
 * otherwise what it reported instead.
 *
 * @param report - The `GET /api/config` payload.
 * @param certificate - The file that should have loaded.
 * @param added - How many certificates that file holds.
 */
export function companyCertificateFailure(
  report: CompanyCertificatesReport,
  certificate: string,
  added = 1
): string | null {
  const loaded = report.network?.companyCertificates ?? null;
  if (loaded?.outcome === 'added' && loaded.added === added && loaded.path === certificate) {
    return null;
  }
  return (
    `GET /api/config reported ${JSON.stringify(report.network ?? null)}; expected ${added} ` +
    `certificate(s) in ${certificate} added. With the fuses on, NODE_EXTRA_CA_CERTS is not ` +
    `read, so a company network's certificates load only through this setting.`
  );
}

/**
 * Whether a newly chosen file reads as pending: saved, but not loaded until a
 * restart, with what was loaded at start-up still reported. `null` when so.
 *
 * @param report - The `GET /api/config` payload after the choice.
 * @param chosen - The file just chosen.
 * @param before - What the running server loaded at start-up.
 */
export function pendingCertificateFailure(
  report: CompanyCertificatesReport,
  chosen: string,
  before: LoadedCertificates
): string | null {
  const network = report.network;
  const loaded = network?.companyCertificates ?? null;
  if (
    network?.extraCaCertsPath === chosen &&
    loaded?.outcome === 'added' &&
    loaded.added === before.added &&
    loaded.path === before.path
  ) {
    return null;
  }
  return (
    `GET /api/config reported ${JSON.stringify(network ?? null)} after choosing ${chosen}; ` +
    `expected the setting to name it while the server still reports ${before.added} ` +
    `certificate(s) from ${before.path} until a restart.`
  );
}

/** The files the restart flow chooses, in order, with their certificate counts. */
const RESTART_FLOW_FILES: ReadonlyArray<{ name: string; count: number }> = [
  { name: 'company-ca-one.pem', count: 1 },
  { name: 'company-ca-two.pem', count: 2 },
];

/**
 * Walk the Settings row's choose-then-restart flow against the running app.
 *
 * First require the seeded file loaded at launch. Then, for each file: choose
 * it, require the pending state while the old certificates stay loaded,
 * restart, and require the new file and count.
 *
 * @param server - Where the running server listens.
 * @param home - The throwaway home the app runs against.
 * @param seeded - The one-certificate file {@link seedCompanyCertificate} chose.
 * @param restart - Quits the app, relaunches it against `home`, and resolves
 *   to where the new server listens once it is healthy.
 * @throws When any step does not hold.
 */
export async function assertCertificatesReloadOnRestart(
  server: ServerAddress,
  home: string,
  seeded: string,
  restart: () => Promise<ServerAddress>
): Promise<void> {
  const log = (line: string): void => console.log(`      ✓ ${line}`);
  const originOf = ({ host, port }: ServerAddress): string => `http://${host}:${port}`;
  let serving = originOf(server);
  log(await assertCompanyCertificateLoaded(serving, seeded));
  let before: LoadedCertificates = { path: seeded, added: 1 };
  for (const { name, count } of RESTART_FLOW_FILES) {
    const file = writeCertificateBundle(home, name, count);
    await chooseCertificateFile(serving, file);
    const pending = pendingCertificateFailure(await readCertificates(serving), file, before);
    if (pending) throw new Error(pending);
    log(`chose ${file}: pending, still ${before.added} from ${before.path} until restart`);
    serving = originOf(await restart());
    const reloaded = companyCertificateFailure(await readCertificates(serving), file, count);
    if (reloaded) throw new Error(reloaded);
    log(`after restart: outcome added, ${count} certificate(s) from ${file}`);
    before = { path: file, added: count };
  }
}
