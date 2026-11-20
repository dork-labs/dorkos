/** @vitest-environment node */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  dependencyResult,
  optionalPlatformOmission,
  preparationEnv,
  validatePluginLock,
} from './prepare-plugin-dependencies.js';

afterEach(() => vi.unstubAllEnvs());
const entry = {
  version: '1.19.3',
  resolved: 'https://registry.npmjs.org/@opencode-ai/plugin/-/plugin-1.19.3.tgz',
  integrity: 'sha512-fixture',
};
const lock = () => ({ packages: { '': {}, 'node_modules/@opencode-ai/plugin': { ...entry } } });

it('accepts the genuine-pin public identity shape without running npm or importing a package', () => {
  expect(() => validatePluginLock(lock())).not.toThrow();
});

it('rejects substituted pins, registry escapes, credentials and missing integrity', () => {
  for (const change of [
    { version: '1.19.4' },
    { resolved: 'https://example.com/a.tgz' },
    { resolved: 'https://user:password@registry.npmjs.org/a.tgz' },
    { integrity: '' },
  ]) {
    const value = lock();
    Object.assign(value.packages['node_modules/@opencode-ai/plugin'], change);
    expect(() => validatePluginLock(value)).toThrow();
  }
});

it('permits only optional packages explicitly excluded by the current platform', () => {
  expect(optionalPlatformOmission({ optional: true, os: [`!${process.platform}`] })).toBe(true);
  expect(
    optionalPlatformOmission({ optional: true, os: [process.platform], cpu: [process.arch] })
  ).toBe(false);
  expect(optionalPlatformOmission({ optional: true })).toBe(false);
  expect(optionalPlatformOmission({ os: [`!${process.platform}`] })).toBe(false);
});

it('preserves protected path values but strips ambient keys, profiles, proxies and bypass flags', () => {
  vi.stubEnv('CODEX_HOME', '/protected/codex');
  for (const key of [
    'OPENAI_API_KEY',
    'NPM_TOKEN',
    'HTTP_PROXY',
    'npm_config_registry',
    'CI',
    'DORKOS_HEAVY_SLOT_HELD',
  ])
    vi.stubEnv(key, 'must-not-inherit');
  const env = preparationEnv('/owned/cache', '/owned/user', '/owned/global');
  expect(env.HOME).toBe(process.env.HOME);
  expect(env.CODEX_HOME).toBe('/protected/codex');
  expect(env.npm_config_registry).toBe('https://registry.npmjs.org/');
  for (const key of ['OPENAI_API_KEY', 'NPM_TOKEN', 'HTTP_PROXY', 'CI', 'DORKOS_HEAVY_SLOT_HELD'])
    expect(env[key]).toBeUndefined();
  expect(env.npm_config_userconfig).toBe('/owned/user');
  expect(env.npm_config_globalconfig).toBe('/owned/global');
  expect(env.npm_config_fetch_retries).toBe('0');
});

// Synthetic files exercise the real returned consumer, not an installed-package claim.
async function syntheticTree() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-seal-unit-'));
  await fs.mkdir(path.join(dir, 'node_modules', 'synthetic'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'synthetic', 'index.js'), 'original');
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  return { dir, remove: () => fs.rm(dir, { recursive: true, force: true }) };
}

it('real verifyUnchanged accepts synthetic files, refuses content mutation and accepts exact restoration', async () => {
  const s = await syntheticTree();
  try {
    const result = await dependencyResult(s.dir, '{}', '{}');
    await expect(result.verifyUnchanged()).resolves.toBeUndefined();
    const file = path.join(s.dir, 'node_modules', 'synthetic', 'index.js');
    await fs.writeFile(file, 'changed');
    await expect(result.verifyUnchanged()).rejects.toThrow('changed');
    await fs.writeFile(file, 'original');
    await expect(result.verifyUnchanged()).resolves.toBeUndefined();
  } finally {
    await s.remove();
  }
});

it('the real seal consumer refuses an escaping symbolic link', async () => {
  const s = await syntheticTree();
  try {
    const result = await dependencyResult(s.dir, '{}', '{}');
    await fs.symlink(path.join(s.dir, 'package.json'), path.join(s.dir, 'node_modules', 'escape'));
    await expect(result.verifyUnchanged()).rejects.toThrow('escaped');
    await expect(dependencyResult(s.dir, '{}', '{}')).rejects.toThrow('escaped');
  } finally {
    await s.remove();
  }
});

it.each(['package.json', 'package-lock.json'])(
  'verifyUnchanged refuses synthetic root %s mutation',
  async (name) => {
    const s = await syntheticTree();
    try {
      const result = await dependencyResult(s.dir, '{}', '{}');
      await fs.writeFile(path.join(s.dir, name), '{"changed":true}');
      await expect(result.verifyUnchanged()).rejects.toThrow('changed');
    } finally {
      await s.remove();
    }
  }
);
