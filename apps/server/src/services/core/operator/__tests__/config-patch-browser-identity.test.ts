import { it, expect, vi, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const fixture = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../config-manager.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config-manager.js')>();
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  fixture.dir = mkdtempSync(join(tmpdir(), 'dork-chrome-patch-'));
  writeFileSync(
    join(fixture.dir, 'config.json'),
    JSON.stringify({ version: 1, browser: { enabled: false, chromeUserAgent: true } })
  );
  return { ...original, configManager: new original.ConfigManager(fixture.dir) };
});
import { configManager } from '../../config-manager.js';
import { applyConfigPatch } from '../config-patch.js';
afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));
it('an unchanged true Chrome choice passes actual generic PATCH and persisted ConfigManager admission', () => {
  expect(configManager.get('browser').chromeUserAgent).toBe(true);
  expect(applyConfigPatch({ browser: { enabled: false, chromeUserAgent: true } }).ok).toBe(true);
  expect(JSON.parse(readFileSync(join(fixture.dir, 'config.json'), 'utf8')).browser).toEqual({
    enabled: false,
    chromeUserAgent: true,
  });
});
it('a changed Chrome choice is refused without an original config write', () => {
  const before = readFileSync(join(fixture.dir, 'config.json'), 'utf8');
  const result = applyConfigPatch({ browser: { enabled: false, chromeUserAgent: false } });
  expect(result.ok).toBe(false);
  expect(readFileSync(join(fixture.dir, 'config.json'), 'utf8')).toBe(before);
  expect(configManager.get('browser').chromeUserAgent).toBe(true);
});
it('generic PATCH still cannot enable Shared browser with an unchanged choice', () => {
  const before = readFileSync(join(fixture.dir, 'config.json'), 'utf8');
  expect(applyConfigPatch({ browser: { enabled: true, chromeUserAgent: true } }).ok).toBe(false);
  expect(readFileSync(join(fixture.dir, 'config.json'), 'utf8')).toBe(before);
});
