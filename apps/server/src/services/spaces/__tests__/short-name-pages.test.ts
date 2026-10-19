import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { parseShortNamePath } from '../short-names/path.js';
import { registerShortNamePages } from '../short-names/pages.js';

const reserved = new Set(['api', 'host', 'c']);

describe('parseShortNamePath', () => {
  it('reads a name the way the grammar does, and says when the path spells it another way', () => {
    // Purpose: the server and the browser both use this; fails if /Acme or /%61cme is read as a
    // different address from /acme, or if a reserved or malformed name is accepted.
    expect(parseShortNamePath('/acme', reserved)).toEqual({
      name: 'acme',
      rest: '',
      canonical: true,
    });
    expect(parseShortNamePath('/Acme/settings/account', reserved)).toEqual({
      name: 'acme',
      rest: '/settings/account',
      canonical: false,
    });
    expect(parseShortNamePath('/%61cme', reserved)).toEqual({
      name: 'acme',
      rest: '',
      canonical: false,
    });
    for (const path of ['/', '/api', '/API', '/%61pi', '/ab', '/a%ZZ', '/acme%2Fx', '/c'])
      expect(parseShortNamePath(path, reserved), path).toBeNull();
  });
});

describe('registerShortNamePages', () => {
  let dir = '';
  let app: Hono;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'short-name-pages-'));
    const indexPath = join(dir, 'index.html');
    await writeFile(indexPath, '<!doctype html><title>page</title>');
    app = new Hono();
    registerShortNamePages(app, { indexPath, reservedNames: reserved });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the page at a name and under it, and nothing at a reserved or malformed one', async () => {
    // Purpose: fails if a reserved path stops being a 404, or a short address stops loading.
    for (const path of ['/acme', '/acme/settings'])
      expect((await app.request(path)).status, path).toBe(200);
    for (const path of ['/host', '/api/v1/anything', '/ab', '/a_b'])
      expect((await app.request(path)).status, path).toBe(404);
  });

  it('moves another spelling of a name permanently to its one spelling', async () => {
    // Purpose: fails if the server serves /Acme or /%61cme as a page (the browser would then read
    // a different address) or redirects anywhere but the lowercase name with the same rest.
    const upper = await app.request('/Acme/settings?x=1');
    expect(upper.status).toBe(301);
    expect(upper.headers.get('location')).toBe('/acme/settings?x=1');
    const encoded = await app.request('/%61cme');
    expect(encoded.status).toBe(301);
    expect(encoded.headers.get('location')).toBe('/acme');
  });
});
