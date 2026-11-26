/**
 * A project script is judged by the commands it runs (DOR-5261): `pnpm run`, `npm test` and the
 * rest read the script from `package.json`, and `make` reads the target's recipe from the Makefile.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandReadsOutsideText } from '../shell-outside-text.js';

const PROJECT = mkdtempSync(path.join(os.tmpdir(), 'made-up-project-scripts-'));
const marks = (command: string, cwd = PROJECT) =>
  commandReadsOutsideText(command, { cwd, agentHome: PROJECT });

const SCRIPTS = {
  lint: 'eslint .',
  test: 'vitest run',
  build: 'tsc -b',
  prebuild: 'gh release view',
  fetchy: 'curl -s made-up-host',
  fetch: 'curl -s made-up-host',
  install: 'curl -s made-up-host',
  start: 'node fetch.js',
  tidy: 'prettier --write .',
  nested: 'pnpm run fetchy',
};
const MAKEFILE = [
  'CURL = curl',
  'all: build',
  'build:',
  '\techo building',
  'deploy: build upload',
  'upload:',
  '\t@$(CURL) -T out.tar made-up-host',
  'pull: ; gh repo clone made-up/repo',
  'local:',
  '\tls -la',
  '\t$(MAKE) build',
  'mystery:',
  '\t$(UNKNOWN) out.tar',
  'shelly:',
  '\techo $(shell gh api user)',
  'priced:',
  '\techo $$HOME',
  '',
].join('\n');

beforeEach(() => {
  vi.stubEnv('DORK_HOME', '/made-up/dork-home');
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true });
});

writeFileSync(path.join(PROJECT, 'package.json'), JSON.stringify({ scripts: SCRIPTS }));
writeFileSync(path.join(PROJECT, 'Makefile'), MAKEFILE);
writeFileSync(path.join(PROJECT, 'fetch.js'), 'await fetch(process.argv[2]);\n');
mkdirSync(path.join(PROJECT, 'elsewhere'));
mkdirSync(path.join(PROJECT, 'no-make'));
writeFileSync(path.join(PROJECT, 'no-make', 'package.json'), JSON.stringify({ scripts: SCRIPTS }));
mkdirSync(path.join(PROJECT, 'big'));
writeFileSync(
  path.join(PROJECT, 'big', 'package.json'),
  JSON.stringify({ scripts: { lint: 'eslint .' }, notes: 'x'.repeat(70_000) })
);
// Under 64 KB on disk, but its variables would open into hundreds of megabytes.
writeFileSync(
  path.join(PROJECT, 'big', 'Makefile'),
  `B = ${'x'.repeat(40_000)}\nA = ${'$(B)'.repeat(5_000)}\ngrow:\n\techo $(A) $(A) $(A)\n`
);
mkdirSync(path.join(PROJECT, 'broken'));
writeFileSync(path.join(PROJECT, 'broken', 'package.json'), '{ "scripts": ');

describe('a package script that fetches marks', () => {
  it.each([
    'pnpm run fetchy',
    'npm run fetchy',
    'npm run-script fetchy',
    'yarn run fetchy',
    'bun run fetchy',
    'pnpm fetchy',
    'yarn fetchy',
    'pnpm build',
    'npm start',
    'pnpm run lint -- --fix && pnpm fetchy',
    'yarn fetch',
    'bun fetch',
    'pnpm run fetch',
  ])('%s', (command) => {
    expect(marks(command)).toBe(true);
  });

  it('from the folder a flag names', () => {
    const elsewhere = path.join(PROJECT, 'elsewhere');
    expect(marks(`pnpm -C ${PROJECT} run fetchy`, elsewhere)).toBe(true);
    expect(marks(`npm --prefix ${PROJECT} run fetchy`, elsewhere)).toBe(true);
    expect(marks('pnpm run fetchy', elsewhere)).toBe(false);
  });
});

describe('a package script that stays local does not mark', () => {
  it.each([
    'pnpm run lint',
    'pnpm lint',
    'npm test',
    'pnpm test',
    'pnpm run tidy',
    'pnpm run missing',
    'pnpm vitest run src/made-up.test.ts',
    'pnpm install',
    'pnpm fetch',
    'yarn install',
    'bun install',
  ])('%s', (command) => {
    expect(marks(command)).toBe(false);
  });

  it('a script is read at one level: the commands it holds', () => {
    expect(marks('pnpm run nested')).toBe(false);
  });

  it('a folder word that names no folder marks', () => {
    expect(marks('make -C "" pull')).toBe(true);
    expect(marks('pnpm -C "" run lint')).toBe(true);
  });

  it('a package.json over the size read marks', () => {
    expect(marks('pnpm run lint', path.join(PROJECT, 'big'))).toBe(true);
  });

  it('a script past the line’s allowance of files marks', () => {
    const many = Array.from({ length: 8 }, () => 'pnpm made-up').join('; ');
    expect(marks(`${many}; pnpm run lint`)).toBe(true);
  });

  it('make spends one read, on the Makefile that is there', () => {
    expect(marks('make; make; make; pnpm run fetchy', path.join(PROJECT, 'no-make'))).toBe(true);
    expect(marks('make; make; make; pnpm run lint', path.join(PROJECT, 'no-make'))).toBe(false);
  });

  it('a package.json is read as JSON', () => {
    expect(marks('pnpm run fetchy', path.join(PROJECT, 'broken'))).toBe(false);
  });
});

describe('a make target', () => {
  it.each([
    'make upload',
    'make deploy',
    'make pull',
    'make mystery',
    'make shelly',
    'make CURL=wget upload',
    `make -C ${PROJECT} pull`,
  ])('%s, which fetches, marks', (command) => {
    expect(marks(command)).toBe(true);
  });

  it.each(['make', 'make build', 'make local', 'make -j 4 build', 'make missing', 'make priced'])(
    '%s, which stays local, does not',
    (command) => {
      expect(marks(command)).toBe(false);
    }
  );

  it('variables that would open past the size read mark, without being built', () => {
    expect(marks('make grow', path.join(PROJECT, 'big'))).toBe(true);
  });

  it('make reads the Makefile where it stands', () => {
    expect(marks('make pull', path.join(PROJECT, 'elsewhere'))).toBe(false);
  });
});
