import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../lib/logger.js';
import { CatalogLogoService, LOGO_REFRESH_MS, MAX_LOGO_BYTES } from '../resources/catalog-logos.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn() },
  logError: (error: unknown) => ({ error: String(error) }),
}));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
const GMAIL = 'https://logos.composio.dev/api/gmail';

function svgResponse(body: BodyInit = SVG, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { 'content-type': 'image/svg+xml', ...headers } });
}

describe('CatalogLogoService', () => {
  let dorkHome: string;
  let now: number;
  let sources: ReturnType<typeof vi.fn<(signal: AbortSignal) => Promise<Map<string, string>>>>;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

  function service() {
    return new CatalogLogoService({
      dorkHome,
      sources,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
  }

  const logosDir = () => path.join(dorkHome, 'cache', 'connectors', 'logos');

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(os.tmpdir(), 'dork-logos-'));
    now = 1_000;
    vi.mocked(logger.warn).mockClear();
    sources = vi.fn(() => Promise.resolve(new Map([['gmail', GMAIL]])));
    fetchImpl = vi.fn(() => Promise.resolve(svgResponse()));
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('fetches only the URL the app list recorded, keeps it on disk, and serves the kept copy', async () => {
    const logos = service();

    const first = await logos.get('gmail');

    expect(first?.contentType).toBe('image/svg+xml');
    expect(first?.bytes.toString()).toBe(SVG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(GMAIL);
    expect(init?.redirect).toBe('error');
    expect(await readdir(logosDir())).toEqual(['logo-gmail.svg']);

    // A new server process reads the kept copy from disk without fetching.
    const restarted = service();
    await expect(restarted.get('gmail')).resolves.toMatchObject({ contentType: 'image/svg+xml' });
    await expect(restarted.keptServiceIds()).resolves.toEqual(new Set(['gmail']));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sources).toHaveBeenCalledTimes(1);
  });

  it('never fetches for an app the list does not carry, and never for an unsafe id', async () => {
    const logos = service();

    await expect(logos.get('notion')).resolves.toBeUndefined();
    await expect(logos.get('../../etc/passwd')).resolves.toBeUndefined();
    await expect(logos.get('GMAIL')).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sources).toHaveBeenCalledTimes(1);
  });

  it('fetches a logo once when many requests for it arrive together', async () => {
    const logos = service();

    const results = await Promise.all([logos.get('gmail'), logos.get('gmail'), logos.get('gmail')]);

    expect(results.every((logo) => logo?.contentType === 'image/svg+xml')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a non-image type',
      () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    ],
    ['no content type', () => new Response(SVG)],
    ['a type named like an object key', () => svgResponse(SVG, { 'content-type': 'constructor' })],
    [
      'an error status',
      () => new Response('nope', { status: 500, headers: { 'content-type': 'image/png' } }),
    ],
    [
      'a declared size over the cap',
      () => svgResponse(SVG, { 'content-length': String(MAX_LOGO_BYTES + 1) }),
    ],
    ['a body over the cap', () => svgResponse(new Uint8Array(MAX_LOGO_BYTES + 1))],
    ['an empty body', () => svgResponse('')],
  ])('refuses %s and keeps nothing', async (_label, respond) => {
    fetchImpl.mockImplementation(() => Promise.resolve(respond()));

    await expect(service().get('gmail')).resolves.toBeUndefined();

    await expect(readdir(logosDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a recorded URL that is not https', async () => {
    sources.mockResolvedValue(new Map([['gmail', 'http://logos.composio.dev/api/gmail']]));

    await expect(service().get('gmail')).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('remembers a failure for a while instead of refetching on every request', async () => {
    fetchImpl.mockRejectedValue(new TypeError('fetch failed'));
    const logos = service();

    await expect(logos.get('gmail')).resolves.toBeUndefined();
    await expect(logos.get('gmail')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    now += 10 * 60_000 + 1;
    fetchImpl.mockResolvedValue(svgResponse());
    await expect(logos.get('gmail')).resolves.toMatchObject({ contentType: 'image/svg+xml' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fetches a kept logo again once it is 30 days old, keeping the old one if that fails', async () => {
    const logos = service();
    await logos.get('gmail');
    const file = path.join(logosDir(), 'logo-gmail.svg');
    const old = new Date(Date.now() - LOGO_REFRESH_MS - 60_000);
    await utimes(file, old, old);
    now = Date.now();

    // The refresh fails: the old logo is still served, and not refetched per request.
    fetchImpl.mockRejectedValue(new TypeError('fetch failed'));
    await expect(logos.get('gmail')).resolves.toMatchObject({ contentType: 'image/svg+xml' });
    await expect(logos.get('gmail')).resolves.toMatchObject({ contentType: 'image/svg+xml' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Later it succeeds, as a new type: only the new file is kept.
    now += 10 * 60_000 + 1;
    fetchImpl.mockResolvedValue(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { 'content-type': 'image/png' },
      })
    );
    await expect(logos.get('gmail')).resolves.toMatchObject({ contentType: 'image/png' });
    expect(await readdir(logosDir())).toEqual(['logo-gmail.png']);
  });

  it('keeps a raster logo under its own type, ignoring content-type parameters', async () => {
    const logos = service();
    fetchImpl.mockResolvedValue(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { 'content-type': 'image/png; charset=binary' },
      })
    );

    await expect(logos.get('gmail')).resolves.toMatchObject({ contentType: 'image/png' });

    expect(await readdir(logosDir())).toEqual(['logo-gmail.png']);
  });

  it('refetches a kept logo someone deleted, and clears staging files an interrupted write left', async () => {
    await mkdir(logosDir(), { recursive: true });
    await writeFile(path.join(logosDir(), 'logo-gmail.svg.1234.tmp'), 'partial');
    await writeFile(path.join(logosDir(), 'logo-gmail.svg'), SVG);
    const logos = service();

    await expect(logos.keptServiceIds()).resolves.toEqual(new Set(['gmail']));
    await rm(path.join(logosDir(), 'logo-gmail.svg'));
    await expect(logos.get('gmail')).resolves.toMatchObject({ contentType: 'image/svg+xml' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      expect(await readdir(logosDir())).toEqual(['logo-gmail.svg']);
    });
    expect(await readFile(path.join(logosDir(), 'logo-gmail.svg'), 'utf8')).toBe(SVG);
  });
});
