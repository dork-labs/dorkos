import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(ROOT, 'index.html'), 'utf-8');

/** The subset of the Web App Manifest shape this test cares about. */
interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface WebManifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: WebManifestIcon[];
}

describe('index.html PWA installability tags', () => {
  it('links the web app manifest', () => {
    expect(indexHtml).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/?>/);
  });

  it('links an apple-touch-icon', () => {
    expect(indexHtml).toMatch(
      /<link\s+rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"\s*\/?>/
    );
  });

  it('sets a theme-color meta for both light and dark', () => {
    expect(indexHtml).toMatch(
      /<meta\s+name="theme-color"\s+media="\(prefers-color-scheme:\s*light\)"\s+content="#[0-9a-f]{6}"\s*\/?>/i
    );
    expect(indexHtml).toMatch(
      /<meta\s+name="theme-color"\s+media="\(prefers-color-scheme:\s*dark\)"\s+content="#[0-9a-f]{6}"\s*\/?>/i
    );
  });
});

describe('manifest.webmanifest', () => {
  const manifest: WebManifest = JSON.parse(
    readFileSync(resolve(ROOT, 'public/manifest.webmanifest'), 'utf-8')
  );

  it('parses as valid JSON with a name and short_name', () => {
    expect(typeof manifest.name).toBe('string');
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(typeof manifest.short_name).toBe('string');
    expect(manifest.short_name.length).toBeGreaterThan(0);
  });

  it('sets start_url and standalone display', () => {
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('declares a theme_color and background_color', () => {
    // Deliberately dark, not light — the manifest spec has no media-query
    // escape hatch (unlike index.html's two theme-color metas above), so one
    // static value has to represent the app. Dark matches the control-panel
    // identity and is the boot script's own fallback when no theme is
    // stored; the tradeoff is a dark install splash for someone whose system
    // is set to light.
    expect(manifest.theme_color).toBe('#0a0a0a');
    expect(manifest.background_color).toBe('#0a0a0a');
  });

  it('declares at least a 192x192 and a 512x512 icon, and every icon file exists', () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    const sizes = manifest.icons.map((icon: WebManifestIcon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');

    // A `Set` built from `readdirSync` and a plain string comparison, not
    // `fs.existsSync` — macOS's default APFS/HFS+ volumes resolve paths
    // case-insensitively, so `existsSync` would pass even if the manifest's
    // `src` and the file on disk disagreed on case (fine here, broken on
    // Linux, where the CLI actually serves this).
    const publicFiles = new Set(readdirSync(resolve(ROOT, 'public')));
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const basename = icon.src.replace(/^\//, '');
      expect(publicFiles.has(basename)).toBe(true);
    }
  });

  it('includes a maskable icon', () => {
    const purposes = manifest.icons.map((icon: WebManifestIcon) => icon.purpose);
    expect(purposes).toContain('maskable');
  });
});
