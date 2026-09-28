/**
 * App logos for the Connections list, fetched by this server and kept on disk,
 * so the browser never loads a third-party URL (connection-app-details §2).
 *
 * The rules, each enforced here or at the one place that feeds this module:
 *
 * - **Only a URL the server's own app list recorded.** The route names a
 *   service id, never a URL. The URL comes from {@link CatalogLogoServiceOptions.logoUrlFor},
 *   a lookup in the server's kept app lists (it never lists a service), and a provider client only
 *   records a logo that is https and on that service's own logo host
 *   (`providers/app-presentation.ts`). An app the list does not carry has no
 *   logo to fetch.
 * - **https only, no redirects**, an image content type from a fixed list, at
 *   most {@link MAX_LOGO_BYTES}, within a deadline.
 * - **Kept at `<dorkHome>/cache/connectors/logos/`**, written through a temp
 *   file and a rename. Everything under `cache/` is safe to delete; a missing
 *   logo is fetched again on the next request.
 * - **A failure is remembered briefly**, so a broken logo is not fetched again
 *   on every page view.
 * - **A kept logo is fetched again after {@link LOGO_REFRESH_MS}**, in the
 *   background, so a brand's new logo arrives in time. The kept one is served
 *   meanwhile, and keeps being served whenever fetching the new one fails.
 *
 * @module services/connectors/resources/catalog-logos
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONNECTOR_LOGO_SERVICE_ID } from '@dorkos/shared/connector-resource-schemas';
import { logError, logger } from '../../../lib/logger.js';

/** The image types a logo may be, and the file suffix each is kept under. */
const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
} as const;

/** An image type a kept logo is served as. */
export type CatalogLogoContentType = keyof typeof EXTENSIONS;

const CONTENT_TYPE_BY_EXTENSION = new Map<string, CatalogLogoContentType>(
  (Object.entries(EXTENSIONS) as [CatalogLogoContentType, string][]).map(([type, ext]) => [
    ext,
    type,
  ])
);

/** The largest logo DorkOS keeps. Real Composio logos are a few KB. */
export const MAX_LOGO_BYTES = 256 * 1024;

/** How long one logo download may take. */
const FETCH_TIMEOUT_MS = 5_000;

/** How long a failed logo is left alone before it is tried again. */
const FAILURE_TTL_MS = 10 * 60_000;

/** At most this many failures are remembered; the oldest is forgotten first. */
const MAX_REMEMBERED_FAILURES = 2_000;

/** How old a kept logo gets before it is fetched again. */
export const LOGO_REFRESH_MS = 30 * 24 * 60 * 60_000;

/** Files are `logo-<id>.<ext>`; the prefix keeps ids like `con` off Windows' reserved names. */
const FILE_PREFIX = 'logo-';

/** One kept logo, ready to serve. */
export interface CatalogLogo {
  /** The image bytes as the service sent them. */
  readonly bytes: Buffer;
  /** The type the bytes are served as. */
  readonly contentType: CatalogLogoContentType;
}

/** Construction options for {@link CatalogLogoService}. */
export interface CatalogLogoServiceOptions {
  /** The resolved DorkOS data directory (`lib/dork-home.ts`). */
  readonly dorkHome: string;
  /**
   * The logo URL the server's kept app lists recorded for one app, or
   * `undefined` (`ConnectorRegistry.keptLogoUrl`). It only looks in kept
   * copies, so a logo miss never costs a catalog listing.
   */
  readonly logoUrlFor: (serviceSlug: string) => Promise<string | undefined>;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Fetches, keeps and serves app logos from `<dorkHome>/cache/connectors/logos/`. */
export class CatalogLogoService {
  private readonly dir: string;
  private readonly logoUrlFor: CatalogLogoServiceOptions['logoUrlFor'];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Service id to the suffix of its kept file, read from disk once. */
  private index: Promise<Map<string, string>> | undefined;
  /** Service id to when a failed fetch may be tried again. */
  private readonly failures = new Map<string, number>();
  /** Downloads in flight, so two requests for one logo fetch it once. */
  private readonly inFlight = new Map<string, Promise<CatalogLogo | undefined>>();

  /** Bind the service to one install's data directory and its catalog. */
  constructor(options: CatalogLogoServiceOptions) {
    this.dir = path.join(options.dorkHome, 'cache', 'connectors', 'logos');
    this.logoUrlFor = options.logoUrlFor;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** The service ids whose logo is kept on disk right now. */
  async keptServiceIds(): Promise<ReadonlySet<string>> {
    return new Set((await this.loadIndex()).keys());
  }

  /**
   * The logo for one listed app: the kept copy, or a fresh download of the
   * URL the app list recorded for it. `undefined` when the app has none, the
   * download failed, or it failed recently.
   *
   * @param serviceSlug - The catalog's service id, as the route received it.
   */
  async get(serviceSlug: string): Promise<CatalogLogo | undefined> {
    if (!CONNECTOR_LOGO_SERVICE_ID.test(serviceSlug)) return undefined;
    const kept = await this.readKept(serviceSlug);
    if (kept) {
      // An old logo is served straight away; its refresh runs behind it.
      if (kept.stale) void this.fetchOnce(serviceSlug);
      return kept.logo;
    }
    return this.fetchOnce(serviceSlug);
  }

  /**
   * Download one logo unless it failed recently, sharing a download already in
   * flight so a burst of requests fetches it once.
   */
  private fetchOnce(serviceSlug: string): Promise<CatalogLogo | undefined> {
    const retryAt = this.failures.get(serviceSlug);
    if (retryAt !== undefined && retryAt > this.now()) return Promise.resolve(undefined);
    let pending = this.inFlight.get(serviceSlug);
    if (!pending) {
      pending = this.download(serviceSlug).finally(() => {
        this.inFlight.delete(serviceSlug);
      });
      this.inFlight.set(serviceSlug, pending);
    }
    return pending;
  }

  private loadIndex(): Promise<Map<string, string>> {
    this.index ??= readdir(this.dir).then(
      (names) => {
        const index = new Map<string, string>();
        for (const name of names) {
          const match = /^logo-([a-z0-9][a-z0-9_-]*)\.([a-z]+)$/.exec(name);
          if (match && CONTENT_TYPE_BY_EXTENSION.has(match[2]!)) index.set(match[1]!, match[2]!);
          // A `.tmp` file left by an interrupted write is never read; clear it.
          else if (name.endsWith('.tmp')) void rm(path.join(this.dir, name), { force: true });
        }
        return index;
      },
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('[CatalogLogoService] could not list kept logos', logError(error));
        }
        return new Map<string, string>();
      }
    );
    return this.index;
  }

  private async readKept(
    serviceSlug: string
  ): Promise<{ logo: CatalogLogo; stale: boolean } | undefined> {
    const index = await this.loadIndex();
    const extension = index.get(serviceSlug);
    if (!extension) return undefined;
    const file = this.fileFor(serviceSlug, extension);
    try {
      const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
      return {
        logo: { bytes, contentType: CONTENT_TYPE_BY_EXTENSION.get(extension)! },
        stale: this.now() - info.mtimeMs > LOGO_REFRESH_MS,
      };
    } catch {
      // Deleted from under us (the cache is safe to clear): fetch it again.
      index.delete(serviceSlug);
      return undefined;
    }
  }

  private async download(serviceSlug: string): Promise<CatalogLogo | undefined> {
    try {
      const url = await this.logoUrlFor(serviceSlug);
      if (!url) return this.fail(serviceSlug);
      const logo = await this.fetchLogo(url);
      if (!logo) return this.fail(serviceSlug);
      await this.keep(serviceSlug, logo);
      this.failures.delete(serviceSlug);
      return logo;
    } catch (error) {
      logger.warn(
        `[CatalogLogoService] could not fetch the logo for ${serviceSlug}`,
        logError(error)
      );
      return this.fail(serviceSlug);
    }
  }

  private async fetchLogo(url: string): Promise<CatalogLogo | undefined> {
    if (new URL(url).protocol !== 'https:') return undefined;
    const response = await this.fetchImpl(url, {
      // A redirect could leave the service's logo host, so none is followed.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: Object.keys(EXTENSIONS).join(', ') },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return undefined;
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!contentType || !Object.hasOwn(EXTENSIONS, contentType)) {
      await response.body.cancel();
      return undefined;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_LOGO_BYTES) {
      await response.body.cancel();
      return undefined;
    }
    const bytes = await readCapped(response.body, MAX_LOGO_BYTES);
    if (!bytes || bytes.length === 0) return undefined;
    return { bytes, contentType: contentType as CatalogLogoContentType };
  }

  private async keep(serviceSlug: string, logo: CatalogLogo): Promise<void> {
    const extension = EXTENSIONS[logo.contentType];
    const file = this.fileFor(serviceSlug, extension);
    const index = await this.loadIndex();
    await mkdir(this.dir, { recursive: true });
    const staged = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, logo.bytes);
      await rename(staged, file);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    const previous = index.get(serviceSlug);
    index.set(serviceSlug, extension);
    // A refreshed logo can change type: keep only the new file.
    if (previous && previous !== extension) {
      await rm(this.fileFor(serviceSlug, previous), { force: true });
    }
  }

  private fail(serviceSlug: string): undefined {
    this.failures.delete(serviceSlug);
    if (this.failures.size >= MAX_REMEMBERED_FAILURES) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    this.failures.set(serviceSlug, this.now() + FAILURE_TTL_MS);
    return undefined;
  }

  private fileFor(serviceSlug: string, extension: string): string {
    return path.join(this.dir, `${FILE_PREFIX}${serviceSlug}.${extension}`);
  }
}

/** The whole body, or `undefined` as soon as it passes `limit` bytes. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<Buffer | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
