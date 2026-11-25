/** A claimed agent folder matches a registered one by real path, and only one. */
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registeredSpellingOf } from '../verify-chat-agent.js';

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'verify-chat-agent-')));
  await mkdir(join(root, 'home'));
  await mkdir(join(root, 'elsewhere'));
  await symlink(join(root, 'home'), join(root, 'home-alias'));
  await symlink(join(root, 'home'), join(root, 'second-alias'));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it('answers in the registry spelling, and refuses a real path two registrations share', () => {
  const home = join(root, 'home');
  const alias = join(root, 'home-alias');
  expect(registeredSpellingOf(alias, [home])).toBe(home);
  expect(registeredSpellingOf(home, [alias])).toBe(alias);
  expect(registeredSpellingOf(join(root, 'elsewhere'), [home])).toBeUndefined();
  expect(registeredSpellingOf(join(home, 'sub'), [home])).toBeUndefined();
  expect(registeredSpellingOf(home, undefined)).toBeUndefined();
  // Exact wins; otherwise an alias that could name either record names neither.
  expect(registeredSpellingOf(alias, [alias, join(root, 'second-alias')])).toBe(alias);
  expect(registeredSpellingOf(home, [alias, join(root, 'second-alias')])).toBeUndefined();
});
