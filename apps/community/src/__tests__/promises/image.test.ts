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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
  /** Every offline command, by its path inside the image. */
  commands: string[];
  /** Every `COMMUNITY_*` setting the server reads. */
  settings: string[];
}

/** The instructions that decide how the image runs. */
const RUNTIME_INSTRUCTIONS = ['WORKDIR', 'USER', 'ENV', 'EXPOSE', 'VOLUME', 'CMD'];

/** The final stage's runtime instructions, keyed by instruction, in file order. */
function runtimeInstructions(dockerfile: string): Record<string, string[]> {
  const stages = dockerfile.split(/^FROM /mu);
  const final = stages[stages.length - 1];
  const found: Record<string, string[]> = {};
  for (const line of final.split('\n')) {
    const match = /^([A-Z]+)\s+(.+)$/u.exec(line.trim());
    if (match && RUNTIME_INSTRUCTIONS.includes(match[1]))
      (found[match[1]] ??= []).push(match[2].trim());
  }
  return found;
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

/** The image path a source file compiles to, or null when the build leaves it out. */
function imagePath(source: string): string | null {
  const { compilerOptions, exclude } = buildMapping();
  if (source.startsWith('browser/') && exclude.includes('src/browser/**')) return null;
  return `${compilerOptions.outDir}/${source.replace(/\.ts$/u, '.js')}`;
}

/** A file is a command when it runs its own entry point, as each offline command does. */
const RUNS_ITSELF =
  /process\.argv\[1\] && fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/u;

/** Every offline command in the image, read from which source files run themselves. */
function readCommands(): string[] {
  return sourceFiles()
    .filter((file) => RUNS_ITSELF.test(readFileSync(new URL(file, SRC), 'utf8')))
    .map((file) => imagePath(file))
    .filter((path): path is string => path !== null)
    .sort();
}

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
 * Every `COMMUNITY_*` setting the server reads: what `parseConfig` and `decisionSettings` read
 * from the environment they are handed (as `main.ts` hands them `process.env`), plus every direct
 * read in non-test source (`process.env.X`, `env.X`, and `process.env[NAME]` with `NAME` a string
 * constant in the same file), which is how the offline commands and the paid-checks flag read.
 */
function readSettings(): string[] {
  const read = new Set<string>();
  parseConfig(recordingEnv({ ...CENSUS_ENV }, read));
  decisionSettings(recordingEnv({}, read) as Record<string, string | undefined>, {
    paidArmed: false,
    fetch: () => Promise.reject(new Error('not called')),
  });
  for (const file of sourceFiles()) {
    const text = readFileSync(new URL(file, SRC), 'utf8');
    for (const [, name] of text.matchAll(/\b(?:process\.)?env\.(COMMUNITY_[A-Z0-9_]+)/gu))
      read.add(name);
    for (const [, constant] of text.matchAll(/process\.env\[([A-Z_]+)\]/gu)) {
      const value = new RegExp(String.raw`const ${constant} = '(COMMUNITY_[A-Z0-9_]+)'`, 'u').exec(
        text
      )?.[1];
      if (!value) throw new Error(`${file} reads process.env[${constant}], which is not a name`);
      read.add(value);
    }
  }
  return [...read].sort();
}

function readPromises(): ImagePromises {
  return {
    runtime: runtimeInstructions(readFileSync(new URL('Dockerfile', APP), 'utf8')),
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
    expect(actual.runtime.CMD).toEqual(['["node", "dist-server/main.js"]']);
    expect(actual.runtime.EXPOSE).toEqual(['6481']);
    expect(existsSync(new URL('main.ts', SRC))).toBe(true);
    // The server's own default port is the one the image exposes.
    expect(parseConfig(CENSUS_ENV).port).toBe(6481);
  });

  it('ships the server build where the start command looks for it', () => {
    // Purpose: fails if the build stops compiling src/ into dist-server/, or the image stops
    // copying it in, so `node dist-server/<command>.js` would find nothing.
    const mapping = buildMapping();
    expect(mapping.compilerOptions).toMatchObject({ rootDir: 'src', outDir: 'dist-server' });
    expect(mapping.include).toEqual(['src/**/*.ts']);
    const dockerfile = readFileSync(new URL('Dockerfile', APP), 'utf8');
    expect(dockerfile).toMatch(/^RUN cp -R .*apps\/community\/dist-server .*\/runtime\/$/mu);
    expect(dockerfile).toMatch(/^COPY --from=build \/runtime \/app$/mu);
  });

  it('keeps every offline operator command at its path', () => {
    // Purpose: fails if a command is removed, renamed, moved, or added without the baseline.
    expect(difference(actual.commands, baseline.commands)).toEqual({ added: [], removed: [] });
    for (const command of actual.commands) {
      const source = command.replace(/^dist-server\//u, '').replace(/\.js$/u, '.ts');
      expect(existsSync(new URL(source, SRC)), source).toBe(true);
    }
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
});
