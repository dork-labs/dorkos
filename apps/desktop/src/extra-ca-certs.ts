import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { configString, readUserConfig } from './main/user-config';

/**
 * Custom certificates for a company network, inside the desktop app (DOR-3361).
 *
 * A network that inspects TLS traffic stays reachable only if the app trusts
 * the company's own certificate authority. The packaged app turns Electron's
 * `NODE_OPTIONS` fuse off (DOR-3053), which also stops Electron's Node from
 * reading `NODE_EXTRA_CA_CERTS`, so the app adds the certificates itself with
 * `tls.setDefaultCACertificates`, which `fetch` and `https` both use. The main
 * process and the server's utility process each call this first, before
 * anything opens a connection.
 *
 * **Only a path a person set is trusted.** The bundle comes from the
 * `network.extraCaCertsPath` setting (Settings → Server → Network), never from
 * the environment. Reading `NODE_EXTRA_CA_CERTS` here would hand the whole
 * trust store to anything that runs as the user: one
 * `launchctl setenv NODE_EXTRA_CA_CERTS <its CA>` and the next launch trusts
 * that CA for every connection, with no notice. That is exactly the kind of
 * environment change the fuse exists to refuse. So in Electron an exported
 * variable is logged and ignored, and the setting is the only way in. The
 * setting itself is operator-only (`config-write-policy.ts`): an agent's
 * `config_patch` or `PATCH /api/config` naming it is refused.
 *
 * Outside Electron (the dev server under plain Node) Node already read the
 * variable natively at start-up, so it is left alone there. A file that can't
 * be read, or holds no certificate, is logged and skipped, as Node itself does:
 * it never stops the app from starting.
 *
 * Not covered: processes run as Node from the app binary (isolated extensions,
 * Playwright's browser download). They start without these certificates, and
 * an isolated extension can't read the file anyway.
 *
 * @module extra-ca-certs
 */

/** One PEM certificate, as a bundle file lists them. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Where the server picks up what the utility process loaded. A global rather
 * than an import because the server is a separate bundle (`@dorkos/server` is
 * shadowed in `server-entry.ts`); the same idiom as the desktop sign-in mint.
 * Mirrored by `COMPANY_CERTIFICATES_STATUS` in
 * `apps/server/src/services/core/company-certificates.ts`.
 */
export const COMPANY_CERTIFICATES_STATUS = Symbol.for('dorkos.desktop.companyCertificates');

/**
 * What happened to the company certificates.
 *
 * - `not-set` — no setting, no variable: nothing to do.
 * - `native` — plain Node, which read `NODE_EXTRA_CA_CERTS` by itself.
 * - `ignored-env` — Electron, the variable is exported but no person set the
 *   setting, so nothing was trusted.
 * - `added` — the file the setting names was loaded.
 * - `unreadable` / `empty` — that file could not be used and was skipped.
 */
export type ExtraCaOutcome =
  'not-set' | 'native' | 'ignored-env' | 'added' | 'unreadable' | 'empty';

/** What {@link applyExtraCaCerts} did. */
export interface ExtraCaResult {
  /** What happened; see {@link ExtraCaOutcome}. */
  outcome: ExtraCaOutcome;
  /** How many certificates were added to the trust store. */
  added: number;
  /** The file the setting named, or `null` when none was set. */
  path: string | null;
}

/** What {@link applyExtraCaCerts} reads. Defaults are the live process. */
export interface ExtraCaOptions {
  /**
   * The `network.extraCaCertsPath` a person set, read from `config.json` by the
   * caller (see {@link readCompanyCertificatesPath}). `null` when unset.
   */
  file?: string | null;
  /** The environment, only to notice an exported `NODE_EXTRA_CA_CERTS`. */
  env?: NodeJS.ProcessEnv;
  /** Whether this process runs on Electron, where the fuse applies. */
  electron?: boolean;
  /** Where a skipped file or an ignored variable is reported. */
  warn?: (message: string) => void;
}

/**
 * The `network.extraCaCertsPath` setting, read straight off `config.json`.
 *
 * Read from the file and not the environment on purpose (see the module doc).
 * A blank or non-string value counts as unset, and a relative one is ignored:
 * there is no working directory a person could have meant it against.
 *
 * @param dorkHome - The data directory holding `config.json`.
 * @returns The absolute path a person set, or `null`.
 */
export function readCompanyCertificatesPath(dorkHome: string): string | null {
  const value = configString(readUserConfig(dorkHome)?.network?.extraCaCertsPath);
  return value && path.isAbsolute(value) ? value : null;
}

/** A certificate bundle is kilobytes; anything past this is not one. */
const MAX_CERTIFICATE_FILE_BYTES = 1024 * 1024;

/**
 * Read the chosen file only if it is a regular file of sane size. This runs
 * before the single-instance lock, so a FIFO or a device must fail fast rather
 * than hang launch: the open never blocks, and fstat decides before any read.
 *
 * @param file - The absolute path a person set.
 * @returns The file's text.
 * @throws An error with `code` `ENOTREG` or `EFBIG`, or the open/read error.
 */
function readCertificateFile(file: string): string {
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });
    if (stat.size > MAX_CERTIFICATE_FILE_BYTES) {
      throw Object.assign(new Error('file too large'), { code: 'EFBIG' });
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Add the certificates in the file a person set to the default trust store.
 *
 * @param options - See {@link ExtraCaOptions}.
 * @returns What happened, how many certificates were added, and from where.
 */
export function applyExtraCaCerts(options: ExtraCaOptions = {}): ExtraCaResult {
  // eslint-disable-next-line no-restricted-syntax -- only to notice the variable Node itself reads, before any env module loads
  const env = options.env ?? process.env;
  const electron = options.electron ?? Boolean(process.versions.electron);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const file = options.file ?? null;
  if (!file) {
    if (!env.NODE_EXTRA_CA_CERTS) return { outcome: 'not-set', added: 0, path: null };
    if (!electron) return { outcome: 'native', added: 0, path: null };
    warn(
      'Ignoring NODE_EXTRA_CA_CERTS: set Company certificates in Settings → Server → Network to trust it.'
    );
    return { outcome: 'ignored-env', added: 0, path: null };
  }
  let certificates: string[];
  try {
    certificates = readCertificateFile(file).match(PEM_CERTIFICATE) ?? [];
  } catch (err) {
    warn(`Ignoring extra certs from ${file}, load failed: ${(err as NodeJS.ErrnoException).code}`);
    return { outcome: 'unreadable', added: 0, path: file };
  }
  if (certificates.length === 0) {
    warn(`Ignoring extra certs from ${file}: it holds no PEM certificate.`);
    return { outcome: 'empty', added: 0, path: file };
  }
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...certificates]);
  } catch (err) {
    warn(`Ignoring extra certs from ${file}: ${(err as Error).message}`);
    return { outcome: 'unreadable', added: 0, path: file };
  }
  return { outcome: 'added', added: certificates.length, path: file };
}
