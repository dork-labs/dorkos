/**
 * The image's promises to operators (specs/server-merge step 1, DOR-2875): how the container
 * starts and on which port, where each offline operator command lands in the build output, and
 * every `COMMUNITY_*` setting the server reads. All three are read from the real files, never a
 * hand list, and compared with `image.baseline.json`. A deliberate change updates the baseline in
 * the same PR and says so in the PR description:
 *
 *   pnpm --filter @dorkos/community census:update
 *
 * Settings only tests read (`COMMUNITY_TEST_DATABASE_URL` and the like) are left out because
 * only non-test source is scanned: `__tests__/` folders and `*.test.ts` files are skipped.
 * `COMMUNITY_TEST_RUNTIME` stays in: the server itself reads it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { decisionSettings } from '../../decisions/settings.js';
import { CENSUS_ENV } from './route-census.js';

const APP = new URL('../../../', import.meta.url);
const SRC = new URL('src/', APP);
const BASELINE = new URL('./image.baseline.json', import.meta.url);
const UPDATE = process.env.UPDATE_PROMISES === '1';

const NOTE =
  "The image's promises (DOR-2875), read from the Dockerfile, the build mapping and the source by image.test.ts. A deliberate change updates this file in the same PR and says so in the PR description: pnpm --filter @dorkos/community census:update";

/** What `image.baseline.json` holds. */
interface ImagePromises {
  /** The final stage's instructions an operator relies on, keyed by instruction. */
  runtime: Record<string, string[]>;
  /** The final stage's `ENV` defaults, one setting each. */
  env: Record<string, string>;
  /** What the build stage copies into the runtime image: the web page, the server, migrations. */
  copied: string[];
  /** Every offline command, by its path inside the image. */
  commands: string[];
  /** Every `COMMUNITY_*` setting the server reads. */
  settings: string[];
}

/** The instructions that decide how the image runs; `ENV` is read apart, one setting at a time. */
const RUNTIME_INSTRUCTIONS = ['WORKDIR', 'USER', 'EXPOSE', 'VOLUME', 'CMD'];

const DOCKERFILE = readFileSync(new URL('Dockerfile', APP), 'utf8');

/** The Dockerfile's stages, the final (runtime) one last. */
const STAGES = DOCKERFILE.split(/^FROM /mu);
const FINAL_STAGE = STAGES[STAGES.length - 1];

/** The final stage's runtime instructions, keyed by instruction, in file order. */
function runtimeInstructions(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const line of FINAL_STAGE.split('\n')) {
    const match = /^([A-Z]+)\s+(.+)$/u.exec(line.trim());
    if (match && RUNTIME_INSTRUCTIONS.includes(match[1]))
      (found[match[1]] ??= []).push(match[2].trim());
  }
  return found;
}

/** The final stage's `ENV` settings, each on its own. */
function runtimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [, pairs] of FINAL_STAGE.matchAll(/^ENV (.+)$/gmu))
    for (const pair of pairs.trim().split(/\s+/u)) {
      const [name, ...value] = pair.split('=');
      env[name] = value.join('=');
    }
  return env;
}

/** The sources the build stage's `RUN cp -R … /runtime/` puts into the runtime image. */
function copiedIntoRuntime(): string[] {
  const line = /^RUN cp -R (.+) \/runtime\/$/mu.exec(STAGES[STAGES.length - 2])?.[1];
  return line ? line.trim().split(/\s+/u).sort() : [];
}

/** Every non-test TypeScript file under `src/`, relative to it. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/u.test(name))
    .filter((name) => !/(^|\/)__tests__\//u.test(name) && !/\.test\.tsx?$/u.test(name))
    .sort();
}

/** The build mapping: `tsconfig.build.json` compiles `src/` into `dist-server/`. */
function buildMapping() {
  return JSON.parse(readFileSync(new URL('tsconfig.build.json', APP), 'utf8')) as {
    compilerOptions: { rootDir: string; outDir: string };
    include: string[];
    exclude: string[];
  };
}

/**
 * The source files the server build really compiles, relative to `src/`, as the compiler lists
 * them for `tsconfig.build.json`. A file it leaves out (an `exclude`, say) is no command in the
 * image, however the source looks.
 */
function builtSources(): Set<string> {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const listed = spawnSync(
    process.execPath,
    [tsc, '-p', 'tsconfig.build.json', '--listFilesOnly'],
    { cwd: fileURLToPath(APP), encoding: 'utf8' }
  );
  if (listed.status !== 0) throw new Error(`tsc --listFilesOnly failed: ${listed.stdout}`);
  const src = fileURLToPath(SRC);
  return new Set(
    listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((path) => path.startsWith(src) && !path.endsWith('.d.ts'))
      .map((path) => path.slice(src.length))
  );
}

/** A file is a command when it runs its own entry point, as each offline command does. */
const RUNS_ITSELF =
  /process\.argv\[1\] && fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/u;

const BUILT = builtSources();

/** Every offline command in the image: a built file that runs itself, at its compiled path. */
function readCommands(): string[] {
  const { outDir } = buildMapping().compilerOptions;
  return sourceFiles()
    .filter((file) => RUNS_ITSELF.test(readFileSync(new URL(file, SRC), 'utf8')))
    .filter((file) => BUILT.has(file))
    .map((file) => `${outDir}/${file.replace(/\.ts$/u, '.js')}`)
    .sort();
}

/**
 * `COMMUNITY_*` names in server source that are not settings, and why. Everything else named
 * `COMMUNITY_*` in non-test server source is a setting the server reads.
 */
const NOT_SETTINGS: Record<string, string> = {
  // Error codes a space answers with (the shared wire's codes), not settings.
  COMMUNITY_ARCHIVED: 'error code',
  COMMUNITY_DELETED: 'error code',
  COMMUNITY_DELETION_PENDING: 'error code',
  COMMUNITY_HELD: 'error code',
  COMMUNITY_MUTED: 'error code',
  COMMUNITY_RULES_NOT_ACCEPTED: 'error code',
  COMMUNITY_SELECTION_REQUIRED: 'error code',
  COMMUNITY_SLOW_MODE: 'error code',
  COMMUNITY_SUSPENDED: 'error code',
  COMMUNITY_TAKEN_DOWN: 'error code',
  COMMUNITY_UNAVAILABLE: 'error code',
  // Constants in code, fixed at build time.
  COMMUNITY_DELETION_OVERDUE_MS: 'constant (deletion-worker.ts)',
  COMMUNITY_EMAIL_LINK_PAGES: 'constant (shared wire)',
  COMMUNITY_IMPORT_MAX_PARTS: 'constant (shared wire)',
  COMMUNITY_MIGRATIONS: 'constant (migrate.ts)',
  COMMUNITY_MINIMUM_AGE_CEILING: 'constant (shared wire)',
  COMMUNITY_MINIMUM_AGE_FLOOR: 'constant (shared wire)',
  COMMUNITY_PASSWORD_MIN_LENGTH: 'constant (shared wire)',
  COMMUNITY_PATH_SHORT_NAMES: 'constant (shared wire)',
  COMMUNITY_SERVER_VERSION: 'constant (takedown evidence record)',
  COMMUNITY_SHORT_NAME_PATTERN: 'constant (shared wire)',
  COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE: 'constant: the value the setting must hold',
  // config.ts checks for a stray `COMMUNITY_EVIDENCE_*` setting by this prefix.
  COMMUNITY_EVIDENCE_: 'prefix, not a name',
};

/** Record every `COMMUNITY_*` name read from an environment object. */
function recordingEnv(values: Record<string, unknown>, read: Set<string>) {
  const note = (key: string | symbol) => {
    if (typeof key === 'string' && key.startsWith('COMMUNITY_')) read.add(key);
  };
  return new Proxy(values, {
    get(target, key) {
      note(key);
      return Reflect.get(target, key);
    },
    has(target, key) {
      note(key);
      return Reflect.has(target, key);
    },
  });
}

/**
 * What `parseConfig` and `decisionSettings` read from the environment they are handed (as
 * `main.ts` hands them `process.env`). A cross-check on the token scan: a name these build at
 * run time, rather than spell out, is still a setting.
 */
function readAtRunTime(): Set<string> {
  const read = new Set<string>();
  parseConfig(recordingEnv({ ...CENSUS_ENV }, read));
  decisionSettings(recordingEnv({}, read) as Record<string, string | undefined>, {
    paidArmed: false,
    fetch: () => Promise.reject(new Error('not called')),
  });
  return read;
}

/**
 * Every `COMMUNITY_*` setting the server reads: every `COMMUNITY_*` name spelled in non-test
 * server source (the browser page reads no settings), however it is read, minus
 * {@link NOT_SETTINGS}, plus anything read at run time.
 */
function readSettings(): string[] {
  const names = new Set<string>(readAtRunTime());
  for (const file of sourceFiles().filter((name) => !name.startsWith('browser/')))
    for (const [name] of readFileSync(new URL(file, SRC), 'utf8').matchAll(
      /\bCOMMUNITY_[A-Z0-9_]+/gu
    ))
      if (!(name in NOT_SETTINGS)) names.add(name);
  return [...names].sort();
}

function readPromises(): ImagePromises {
  return {
    runtime: runtimeInstructions(),
    env: runtimeEnv(),
    copied: copiedIntoRuntime(),
    commands: readCommands(),
    settings: readSettings(),
  };
}

const actual = readPromises();
if (UPDATE) await writeFile(BASELINE, `${JSON.stringify({ '//': NOTE, ...actual }, null, 2)}\n`);
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as ImagePromises;

/** The names in one list and not the other, so a failure says what changed. */
function difference(have: string[], want: string[]) {
  return {
    added: have.filter((name) => !want.includes(name)),
    removed: want.filter((name) => !have.includes(name)),
  };
}

describe('the image', () => {
  it('starts the server the same way, on the same port', () => {
    // Purpose: fails if the start command, port, data volume, user or default settings change.
    expect(actual.runtime).toEqual(baseline.runtime);
    expect(actual.env).toEqual(baseline.env);
    expect(actual.runtime.CMD).toEqual(['["node", "dist-server/main.js"]']);
    expect(actual.runtime.EXPOSE).toEqual(['6481']);
    expect(actual.env).toMatchObject({
      COMMUNITY_PORT: '6481',
      COMMUNITY_STORAGE_PATH: '/data/blobs',
      NODE_ENV: 'production',
    });
    expect(BUILT.has('main.ts')).toBe(true);
    // The server's own default port is the one the image exposes.
    expect(parseConfig(CENSUS_ENV).port).toBe(6481);
  });

  it('ships the server build, the web page and the migrations where they are read from', () => {
    // Purpose: fails if the build stops compiling src/ into dist-server/, or the image stops
    // copying in the server, the page `main.ts` serves (../dist) or the migrations
    // `migrate.ts` runs (../migrations).
    expect(buildMapping().compilerOptions).toMatchObject({ rootDir: 'src', outDir: 'dist-server' });
    expect(actual.copied).toEqual(baseline.copied);
    expect(actual.copied).toEqual(
      expect.arrayContaining([
        'apps/community/dist',
        'apps/community/dist-server',
        'apps/community/migrations',
      ])
    );
    expect(DOCKERFILE).toMatch(/^COPY --from=build \/runtime \/app$/mu);
  });

  it('keeps every offline operator command at its path, in the build', () => {
    // Purpose: fails if a command is removed, renamed, moved, left out of the build, or added
    // without the baseline.
    expect(difference(actual.commands, baseline.commands)).toEqual({ added: [], removed: [] });
  });

  it('documents only commands the image has', () => {
    // Purpose: fails if an operator guide names a `dist-server/` path the image does not ship.
    const guides = readdirSync(APP).filter((name) => name.endsWith('.md'));
    const named = new Set<string>();
    for (const guide of guides)
      for (const [path] of readFileSync(new URL(guide, APP), 'utf8').matchAll(
        /dist-server\/[A-Za-z0-9_/.-]+\.js/gu
      ))
        named.add(path);
    expect(named.size).toBeGreaterThan(0);
    for (const path of named)
      expect([...actual.commands, 'dist-server/main.js'], path).toContain(path);
  });

  it('reads every COMMUNITY_* setting it reads today', () => {
    // Purpose: fails if the server stops reading a setting an operator may have set, or reads a
    // new one without the baseline saying so.
    expect(actual.settings.length).toBeGreaterThan(80);
    expect(difference(actual.settings, baseline.settings)).toEqual({ added: [], removed: [] });
  });

  it('lists as not a setting only names nothing reads as one', () => {
    // Purpose: fails if an exception above hides a setting the server does read.
    const read = readAtRunTime();
    for (const name of Object.keys(NOT_SETTINGS)) expect(read.has(name), name).toBe(false);
  });
});
