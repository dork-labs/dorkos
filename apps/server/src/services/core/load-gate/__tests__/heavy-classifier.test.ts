/**
 * Which commands wait behind the load gate (DOR-4209). A table, so a change to
 * the built-in list reads as a changed row.
 */
import { describe, expect, it } from 'vitest';
import { parseShell } from '../../../runtimes/claude-code/shell-guard/shell-words.js';
import { classifyCommand, classifySegments } from '../heavy-classifier.js';

/** [command, the program it waits as, or null for light]. */
const BUILT_IN: readonly (readonly [string, string | null])[] = [
  // Type checks and test suites.
  ['tsc', 'tsc'],
  ['tsc -p apps/server', 'tsc'],
  ['./node_modules/.bin/tsc --noEmit', 'tsc'],
  ['tsc --version', null],
  ['vitest run', 'vitest'],
  ['vitest run apps/server/src/a.test.ts', null],
  ['vitest run a.test.ts b.test.ts', 'vitest'],
  ['vitest run apps/server', 'vitest'],
  ['vitest run session', 'vitest'],
  ['vitest run --project client', 'vitest'],
  ['vitest run --project client a.test.ts', null],
  ['vitest run apps/e2e/tests/chat.spec.ts', null],
  ['jest', 'jest'],
  ['jest src/one.test.ts', null],
  ['jest src', 'jest'],
  ['playwright test', 'playwright'],
  ['playwright test apps/e2e/tests/chat.spec.ts', 'playwright'],
  ['npx playwright test --project chromium', 'playwright'],
  ['pnpm exec playwright test', 'playwright'],
  ['playwright show-report', null],
  // Package managers, their flags and runners.
  ['pnpm install', 'pnpm'],
  ['npm ci', 'npm'],
  ['yarn', 'yarn'],
  ['yarn add left-pad', 'yarn'],
  ['bun install', 'bun'],
  ['pnpm build', 'pnpm'],
  ['pnpm verify', 'pnpm'],
  ['pnpm typecheck', 'pnpm'],
  ['pnpm lint', 'pnpm'],
  ['pnpm test:e2e', 'pnpm'],
  ['pnpm run build', 'pnpm'],
  ['npm run lint', 'npm'],
  // A package manager's `test` is the root script, which fans out through turbo.
  ['pnpm test', 'pnpm'],
  ['pnpm test -- --run', 'pnpm'],
  ['pnpm test -- apps/server/src/a.test.ts', 'pnpm'],
  ['pnpm test --filter @dorkos/server', 'pnpm'],
  ['npm test', 'npm'],
  ['yarn test src/a.test.ts', 'yarn'],
  // `bun test` is bun's own runner: one test file is a quick check.
  ['bun test', 'bun'],
  ['bun test src/a.test.ts', null],
  ['pnpm vitest run apps/server/src/a.test.ts', null],
  ['pnpm vitest run apps/server', 'vitest'],
  ['pnpm vitest run', 'vitest'],
  ['pnpm --filter @dorkos/server build', 'pnpm'],
  ['pnpm --filter=@dorkos/server typecheck', 'pnpm'],
  ['pnpm -C apps/site build', 'pnpm'],
  ['pnpm --dir apps/server exec vitest run a.test.ts b.test.ts', 'vitest'],
  ['pnpm --dir apps/server exec vitest run a.test.ts', null],
  ['pnpm exec tsc', 'tsc'],
  ['npx tsc --noEmit', 'tsc'],
  ['npx -p typescript tsc', 'tsc'],
  ['npm exec -- tsc', 'tsc'],
  ['pnpm dlx turbo run build', 'turbo'],
  ['corepack pnpm install', 'pnpm'],
  ['pnpm check:max-lines', null],
  ['pnpm --version', null],
  ['pnpm why zod', null],
  // Turbo, bundlers and frameworks.
  ['turbo run build', 'turbo'],
  ['turbo typecheck lint --filter=@dorkos/server', 'turbo'],
  ['turbo run @dorkos/server#test', 'turbo'],
  ['turbo prune @dorkos/server', null],
  ['vite build', 'vite'],
  ['vite', null],
  ['next build', 'next'],
  ['next dev', null],
  // Images.
  ['docker build -t made-up .', 'docker'],
  ['docker --context remote build .', 'docker'],
  ['docker buildx build --platform linux/amd64 .', 'docker'],
  ['docker compose build', 'docker'],
  ['docker compose -f made-up.yml up -d --build', 'docker'],
  ['docker compose up -d', null],
  ['docker-compose up --build', 'docker-compose'],
  ['docker ps', null],
  // Git runs hooks on these two.
  ['git commit -m "made-up message"', 'git'],
  ['git push origin made-up-branch', 'git'],
  ['git -C /made/up/repo push', 'git'],
  ['git -c core.hooksPath=/x commit', 'git'],
  ['git status', null],
  ['git log --oneline', null],
  // Others.
  ['cargo build --release', 'cargo'],
  ['cargo +nightly test', 'cargo'],
  ['cargo fmt', null],
  ['make', 'make'],
  ['make -j8 all', 'make'],
  ['make --help', null],
  // Light everyday commands.
  ['ls -la', null],
  ['cat package.json', null],
  ['echo "pnpm build"', null],
  ['node scripts/made-up.mjs', null],
  ['rg tsc apps', null],
  ['', null],
];

/** Prefixes, chains and shells the shell guard's parser sees through. */
const WRAPPED: readonly (readonly [string, string | null])[] = [
  ['env FOO=1 tsc', 'tsc'],
  ['FOO=1 BAR=2 pnpm build', 'pnpm'],
  ['nice -n 10 pnpm build', 'pnpm'],
  ['timeout 600 pnpm verify', 'pnpm'],
  ['sudo docker build .', 'docker'],
  ['time pnpm typecheck', 'pnpm'],
  ['cd apps/server && pnpm build', 'pnpm'],
  ['ls; git push', 'git'],
  ['git status | head', null],
  ['(cd apps/site && next build)', 'next'],
  ['sh -c "pnpm install"', 'pnpm'],
  ["bash -lc 'tsc -p .'", 'tsc'],
  ['echo "$(tsc --noEmit)"', 'tsc'],
  ['sh -c "ls -la"', null],
];

describe('classifyCommand, built-in list', () => {
  it.each(BUILT_IN)('%s', (command, label) => {
    expect(classifyCommand(command)).toEqual(
      label === null ? { heavy: false } : { heavy: true, reason: label }
    );
  });
});

describe('classifyCommand, through prefixes and shells', () => {
  it.each(WRAPPED)('%s', (command, label) => {
    expect(classifyCommand(command)).toEqual(
      label === null ? { heavy: false } : { heavy: true, reason: label }
    );
  });
});

describe('a reason names the program only', () => {
  it('never carries an argument, a path or a message', () => {
    const { reason } = classifyCommand('git commit -m "fix the made-up secret thing" --author x');
    expect(reason).toBe('git');
    const fromPath = classifyCommand('/made/up/bin/tsc -p /made/up/project');
    expect(fromPath.reason).toBe('tsc');
  });
});

describe('a person’s overrides', () => {
  it('adds a pattern, matched through runners', () => {
    const overrides = { add: ['storybook build'], remove: [] };
    expect(classifyCommand('storybook build', { add: [], remove: [] })).toEqual({ heavy: false });
    expect(classifyCommand('storybook build', overrides)).toEqual({
      heavy: true,
      reason: 'storybook',
    });
    expect(classifyCommand('npx storybook build --quiet', overrides)).toEqual({
      heavy: true,
      reason: 'storybook',
    });
    expect(classifyCommand('pnpm exec storybook build', overrides)).toEqual({
      heavy: true,
      reason: 'storybook',
    });
    // Its leading words must all match.
    expect(classifyCommand('storybook dev', overrides)).toEqual({ heavy: false });
  });

  it('adds a script, matched with or without `run` and package-manager flags', () => {
    const overrides = { add: ['pnpm docs:export-api'], remove: [] };
    expect(classifyCommand('pnpm docs:export-api', overrides).heavy).toBe(true);
    expect(classifyCommand('pnpm run docs:export-api', overrides).heavy).toBe(true);
    expect(classifyCommand('pnpm -C apps/site docs:export-api', overrides).heavy).toBe(true);
    expect(classifyCommand('pnpm docs:export-api', { add: [], remove: [] }).heavy).toBe(false);
  });

  it('removes a built-in, including behind flags and runners', () => {
    const overrides = { add: [], remove: ['git push', 'tsc'] };
    expect(classifyCommand('git push', overrides)).toEqual({ heavy: false });
    expect(classifyCommand('git -C /made/up push', overrides)).toEqual({ heavy: false });
    expect(classifyCommand('pnpm exec tsc', overrides)).toEqual({ heavy: false });
    expect(classifyCommand('git commit', overrides)).toEqual({ heavy: true, reason: 'git' });
  });

  it('lets remove win over add for the same command', () => {
    const overrides = { add: ['pnpm docs:export-api'], remove: ['pnpm docs'] };
    expect(
      classifyCommand('pnpm docs:export-api', { ...overrides, remove: ['pnpm docs:export-api'] })
    ).toEqual({ heavy: false });
    // A pattern matches whole words, so `pnpm docs` is not `pnpm docs:export-api`.
    expect(classifyCommand('pnpm docs:export-api', overrides).heavy).toBe(true);
  });

  it('removes one command of a chain without hiding the others', () => {
    const overrides = { add: [], remove: ['pnpm build'] };
    expect(classifyCommand('pnpm build && git push', overrides)).toEqual({
      heavy: true,
      reason: 'git',
    });
  });

  it('ignores a blank pattern', () => {
    expect(classifyCommand('ls', { add: ['   '], remove: [] })).toEqual({ heavy: false });
    expect(classifyCommand('tsc', { add: [], remove: [''] })).toEqual({
      heavy: true,
      reason: 'tsc',
    });
  });
});

describe('classifySegments', () => {
  it('reads the parse a caller already did', () => {
    expect(classifySegments(parseShell('cd web && pnpm build'))).toEqual({
      heavy: true,
      reason: 'pnpm',
    });
    expect(classifySegments(parseShell('sh -c "tsc"'))).toEqual({ heavy: true, reason: 'tsc' });
    expect(classifySegments([])).toEqual({ heavy: false });
  });
});
