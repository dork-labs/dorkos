import { readFileSync } from 'node:fs';
import tls from 'node:tls';

/**
 * Custom certificates for a company network, inside the desktop app (DOR-3361).
 *
 * Node reads the certificate bundle named by `NODE_EXTRA_CA_CERTS` at start-up,
 * which is how a network that inspects TLS traffic stays reachable. The
 * packaged app turns Electron's `NODE_OPTIONS` fuse off (DOR-3053), and that
 * fuse also stops Electron's Node from reading `NODE_EXTRA_CA_CERTS`. So the
 * app reads the file itself and adds its certificates to the default trust
 * store with `tls.setDefaultCACertificates`, which `fetch` and `https` both
 * use. The main process and the server's utility process each call this
 * first, before anything opens a connection.
 *
 * Outside Electron (the dev server under plain Node) Node already read the
 * file, so this does nothing. A file that can't be read, or holds no
 * certificate, is logged and skipped, as Node itself does: it never stops the
 * app from starting.
 *
 * Not covered: processes run as Node from the app binary (isolated extensions,
 * Playwright's browser download). They start without the variable's effect,
 * and an isolated extension can't read the file anyway.
 *
 * @module extra-ca-certs
 */

/** One PEM certificate, as a bundle file lists them. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** What happened to `NODE_EXTRA_CA_CERTS`. */
export type ExtraCaOutcome = 'not-set' | 'native' | 'added' | 'unreadable' | 'empty';

/** What {@link applyExtraCaCerts} reads. Defaults are the live process. */
export interface ExtraCaOptions {
  /** The environment to read `NODE_EXTRA_CA_CERTS` from. */
  env?: NodeJS.ProcessEnv;
  /** Whether this process runs on Electron, where the fuse applies. */
  electron?: boolean;
  /** Where a skipped file is reported. */
  warn?: (message: string) => void;
}

/**
 * Add the certificates `NODE_EXTRA_CA_CERTS` names to the default trust store.
 *
 * @param options - See {@link ExtraCaOptions}.
 * @returns What happened, and how many certificates were added.
 */
export function applyExtraCaCerts(options: ExtraCaOptions = {}): {
  outcome: ExtraCaOutcome;
  added: number;
} {
  // eslint-disable-next-line no-restricted-syntax -- the variable Node itself reads, before any env module loads
  const env = options.env ?? process.env;
  const electron = options.electron ?? Boolean(process.versions.electron);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const file = env.NODE_EXTRA_CA_CERTS;
  if (!file) return { outcome: 'not-set', added: 0 };
  if (!electron) return { outcome: 'native', added: 0 };
  let certificates: string[];
  try {
    certificates = readFileSync(file, 'utf8').match(PEM_CERTIFICATE) ?? [];
  } catch (err) {
    warn(`Ignoring extra certs from ${file}, load failed: ${(err as NodeJS.ErrnoException).code}`);
    return { outcome: 'unreadable', added: 0 };
  }
  if (certificates.length === 0) {
    warn(`Ignoring extra certs from ${file}: it holds no PEM certificate.`);
    return { outcome: 'empty', added: 0 };
  }
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...certificates]);
  } catch (err) {
    warn(`Ignoring extra certs from ${file}: ${(err as Error).message}`);
    return { outcome: 'unreadable', added: 0 };
  }
  return { outcome: 'added', added: certificates.length };
}
