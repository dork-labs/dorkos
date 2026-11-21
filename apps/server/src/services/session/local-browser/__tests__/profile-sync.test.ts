import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { disablePasswordSaving, plainChromiumArgs } from '../plain-chromium.js';

it('turns off Chrome sign-in per profile while preserving site data and other preferences', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'dorkos-profile-sync-'));
  try {
    await mkdir(path.join(folder, 'Default'));
    const file = path.join(folder, 'Default', 'Preferences');
    await writeFile(
      file,
      JSON.stringify({ signin: { allowed: true, other: 'keep' }, other: 'kept' })
    );
    await writeFile(path.join(folder, 'Default', 'Cookies'), 'example sign-in');
    await disablePasswordSaving(folder);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      signin: { allowed: false, other: 'keep' },
      other: 'kept',
    });
    expect(await readFile(path.join(folder, 'Default', 'Cookies'), 'utf8')).toBe('example sign-in');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it('disables sync in the plain sign-in window without machine policy', () => {
  expect(
    plainChromiumArgs('/example/profile', 'https://example.test', 'example.test', false)
  ).toContain('--disable-sync');
});
