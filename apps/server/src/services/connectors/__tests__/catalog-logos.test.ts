import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../lib/logger.js';
import { CatalogLogoService, MAX_LOGO_BYTES } from '../resources/catalog-logos.js';

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
  let logoUrlFor: ReturnType<typeof vi.fn<(serviceSlug: string) => Promise<string | undefined>>>;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

  function service() {
    return new CatalogLogoService({
      dorkHome,
      logoUrlFor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
  }

  const logosDir = () => path.join(dorkHome, 'cache', 'connectors', 'logos');

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(os.tmpdir(), 'dork-logos-'));
    now = 1_000;
    vi.mocked(logger.warn).mockClear();
    logoUrlFor = vi.fn((serviceSlug: string) =>
      Promise.resolve(serviceSlug === 'gmail' ? GMAIL : undefined)
    );
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
    expect(logoUrlFor).toHaveBeenCalledTimes(1);
  });

  it('never fetches for an app the list does not carry, and never for an unsafe id', async () => {
    const logos = service();

    await expect(logos.get('notion')).resolves.toBeUndefined();
    await expect(logos.get('../../etc/passwd')).resolves.toBeUndefined();
    await expect(logos.get('GMAIL')).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logoUrlFor).toHaveBeenCalledTimes(1);
    expect(logoUrlFor).toHaveBeenCalledWith('notion');
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
    logoUrlFor.mockResolvedValue('http://logos.composio.dev/api/gmail');

    await expect(service().get('gmail')).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
