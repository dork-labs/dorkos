/**
 * Contract for serving the app itself: the built client, its shell headers,
 * the missing-bundle trap and the deep-link fallback (`finalizeApp` in
 * `app.ts`). They move to Hono in DOR-2817; that PR must pass this file
 * unchanged.
 *
 * The server boots in production mode, the only mode that serves the client,
 * against a small stand-in build: a shell, one hashed bundle and an icon.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { contractSuite } from './harness.js';

const SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';
const BUNDLE = 'console.log("the app");';
const ICON = '<svg xmlns="http://www.w3.org/2000/svg"/>';

const dist = mkdtempSync(path.join(tmpdir(), 'dorkos-contract-dist-'));
mkdirSync(path.join(dist, 'assets'));
writeFileSync(path.join(dist, 'index.html'), SHELL);
writeFileSync(path.join(dist, 'assets', 'app-3f9a1c.js'), BUNDLE);
writeFileSync(path.join(dist, 'favicon.svg'), ICON);
writeFileSync(path.join(dist, '.hidden'), 'never served');
afterAll(() => rmSync(dist, { recursive: true, force: true }));

/** What every copy of the shell carries: never stored, and its page policy. */
const SHELL_HEADERS = {
  'content-type': /^text\/html\b/,
  'cache-control': 'no-store',
  'content-security-policy': /^default-src 'self'; .*frame-ancestors 'none'$/,
  'x-content-type-options': 'nosniff',
};

contractSuite(
  'the app',
  [
    {
      name: 'GET / serves the shell',
      path: '/',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'GET /index.html serves the shell with the same headers',
      path: '/index.html',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'a deep link serves the shell',
      path: '/session?session=abc',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'an extension page serves the shell',
      path: '/x/some-extension/settings',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'HEAD on a deep link answers like GET, with no body',
      method: 'HEAD',
      path: '/team',
      expect: { status: 200, headers: SHELL_HEADERS, body: '' },
    },
    {
      name: 'a hashed bundle is cached for a year',
      path: '/assets/app-3f9a1c.js',
      expect: {
        status: 200,
        headers: {
          'content-type': /^(text|application)\/javascript\b/,
          'cache-control': 'public, max-age=31536000, immutable',
          'content-security-policy': null,
        },
        body: BUNDLE,
      },
    },
    {
      name: 'a bundle carries validators for a conditional request',
      path: '/assets/app-3f9a1c.js',
      expect: {
        status: 200,
        headers: { etag: /^(W\/)?".+"$/, 'last-modified': / GMT$/, 'accept-ranges': 'bytes' },
      },
    },
    {
      name: 'a conditional request for a bundle the client holds is a 304',
      path: '/assets/app-3f9a1c.js',
      headers: { 'if-none-match': '*' },
      expect: { status: 304, body: '' },
    },
    {
      name: 'a range of a bundle is a 206',
      path: '/assets/app-3f9a1c.js',
      headers: { range: 'bytes=0-6' },
      expect: {
        status: 206,
        headers: { 'content-range': `bytes 0-6/${BUNDLE.length}` },
        body: BUNDLE.slice(0, 7),
      },
    },
    {
      name: 'a missing bundle is a plain 404, never the shell',
      path: '/assets/app-gone.js',
      expect: {
        status: 404,
        headers: { 'content-type': /^text\/plain\b/, 'cache-control': null },
        body: 'Not found: /assets/app-gone.js',
      },
    },
    {
      name: 'a missing bundle keeps its query in the 404',
      path: '/assets/app-gone.js?v=2',
      expect: { status: 404, body: 'Not found: /assets/app-gone.js?v=2' },
    },
    {
      name: 'the bundle folder itself is the bundle 404',
      path: '/assets/',
      expect: { status: 404, body: 'Not found: /assets/' },
    },
    {
      // Dotfiles are never served; the path is a deep link like any other.
      name: 'a dotfile in the build is never served',
      path: '/.hidden',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
    {
      name: 'a file at the root revalidates rather than caching',
      path: '/favicon.svg',
      expect: {
        status: 200,
        headers: { 'cache-control': 'public, max-age=0', 'content-security-policy': null },
        body: ICON,
      },
    },
    {
      name: 'a POST to a page is not the shell',
      method: 'POST',
      path: '/team',
      expect: { status: 404 },
    },
    {
      name: 'an unknown /api path is the API 404, never the shell',
      path: '/api/no-such-route',
      expect: { status: 404, body: { error: 'Not found', code: 'API_NOT_FOUND' } },
    },
    {
      name: 'a path that climbs out of the bundles is the bundle 404',
      path: '/assets/..%2f..%2findex.html',
      expect: { status: 404, body: 'Not found: /assets/..%2f..%2findex.html' },
    },
    {
      // The static handler refuses it and the deep-link fallback answers.
      name: 'a path that climbs out of the build gets the shell, never the file',
      path: '/..%2f..%2f..%2fetc%2fpasswd',
      expect: { status: 200, headers: SHELL_HEADERS, body: SHELL },
    },
  ],
  { env: { NODE_ENV: 'production', CLIENT_DIST_PATH: dist } }
);
