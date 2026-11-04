import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'electron-vite';
import { build } from 'vite';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the production desktop renderer', () => {
  it('loads the same emitted assets at the root and at restored nested pages', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dorkos-renderer-urls-')));
    created.push(root);
    writeFileSync(
      path.join(root, 'index.html'),
      `<!doctype html>
      <link rel="icon" href="/favicon.png">
      <script type="module" src="/entry.js"></script>`
    );
    writeFileSync(path.join(root, 'entry.js'), `import './style.css'; console.log('loaded');`);
    writeFileSync(path.join(root, 'style.css'), 'body { color: red; }');
    mkdirSync(path.join(root, 'public'));
    writeFileSync(path.join(root, 'public/favicon.png'), 'fixture');

    // Use the shipping config AND electron-vite's production preset. Setting
    // renderer.base alone does not work: that preset overwrites it with './'.
    const resolved = await resolveConfig(
      { root: desktopRoot, configFile: path.join(desktopRoot, 'electron.vite.config.ts') },
      'build',
      'production'
    );
    expect(resolved.config?.renderer).toBeDefined();
    await build({
      ...resolved.config!.renderer,
      root,
      logLevel: 'silent',
      build: {
        outDir: path.join(root, 'dist'),
        rollupOptions: { input: path.join(root, 'index.html') },
      },
    });

    const html = readFileSync(path.join(root, 'dist/index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(urls.some((url) => url.endsWith('.js'))).toBe(true);
    expect(urls.some((url) => url.endsWith('.css'))).toBe(true);
    for (const page of ['/', '/x/mkt-site', '/x/mkt-site/', '/chat/restored-session']) {
      for (const url of urls) {
        const resolvedUrl = new URL(url, `http://localhost:4242${page}`);
        expect(resolvedUrl.pathname, `${page}: ${url}`).toBe(
          new URL(url, 'http://localhost:4242/').pathname
        );
        expect(() => readFileSync(path.join(root, 'dist', resolvedUrl.pathname))).not.toThrow();
      }
    }
  });
});
