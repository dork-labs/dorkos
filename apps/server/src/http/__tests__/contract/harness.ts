/**
 * The contract harness for the Express-to-Hono move (DOR-2793).
 *
 * A contract file states what the real server answers for one route group:
 * status, the headers that matter, and the body or its Zod schema. It talks to
 * the COMPOSED server, a real process booted from `src/index.ts`, over a real
 * port. The run builds that entry once and each boot runs the build with plain
 * Node, which keeps every module's own location and packages
 * (`server-build.ts`); `DORKOS_CONTRACT_TSX=1`, or `vitest --watch`, boots
 * `tsx src/index.ts` instead, exactly as the e2e legs boot it, and
 * `tsx-parity.contract.test.ts` boots it that way once in every bundle run. So the same unchanged file passed before a group moved
 * (Express answered) and after (Hono answers), which is the proof each move PR
 * offered; a move PR could not edit its group's contract file (plan rule 2).
 * The contracts now pin the server's answers for whatever changes it next.
 *
 * Each case set should include the refusals as well as the answers: no
 * credential, a foreign `Host`, a wrong `Origin`, an empty body, malformed JSON
 * and an oversize body, wherever the group has them.
 *
 * @module http/__tests__/contract/harness
 */
import { PERSON_PROOF_HEADER, PERSON_SESSION_PATH } from '@dorkos/shared/person-session';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  BOOTED_MARKER_PREFIX,
  BUILD_MS_FILE,
  BUILT_ENTRIES,
  SERVER_DIR,
  TSX_ESCAPE_FLAG,
  buildContractServer,
  isAlive,
} from './server-build.js';

const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
// The CLI script run by this Node, not the `.bin` shim, so it spawns the same way everywhere.
const TSX_CLI = path.join(SERVER_DIR, 'node_modules/tsx/dist/cli.mjs');

/** How often a boot checks whether the server answers. */
const HEALTH_POLL_MS = 50;

/** How long a cold boot may take before the harness gives up. */
export const BOOT_TIMEOUT_MS = 180_000;

/**
 * The `beforeAll` budget for a boot: longer than {@link BOOT_TIMEOUT_MS}, so the
 * harness always gives up (and stops the child) before vitest abandons the
 * hook and leaves nobody to stop it.
 */
export const BOOT_HOOK_TIMEOUT_MS = BOOT_TIMEOUT_MS + 30_000;

/** Children still running, stopped if this process exits without closing them. */
const running = new Set<ChildProcess>();
process.once('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

/** A running composed server. */
export interface ComposedServer {
  /** Where it listens, e.g. `http://127.0.0.1:53511`. */
  readonly baseUrl: string;
  /** Its throwaway data directory, for a test that checks what it wrote. */
  readonly dorkHome: string;
  /** The last of what the server printed, for a failure message. */
  log(): string;
  /** Stop it and delete its data directory. */
  close(): Promise<void>;
}

/** A free loopback port, released before the server takes it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * The child's environment: this process's, minus anything that would steer the
 * server (a developer's `DORKOS_PORT`, vitest's own variables), plus a throwaway
 * data directory and the flags the e2e test-mode leg sets.
 */
function serverEnv(
  port: number,
  dorkHome: string,
  version: string,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(DORKOS_|DORK_HOME$|VITEST|NODE_ENV$|NODE_OPTIONS$|TEST$|CLAUDE_CONFIG_DIR$)/.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return {
    ...env,
    NODE_ENV: 'development',
    // Names this boot, so the harness can tell its server from another
    // worker's that won a race for the same port. Still a `0.0.0` dev build.
    DORKOS_VERSION_OVERRIDE: version,
    DORKOS_PORT: String(port),
    DORKOS_HOST: '127.0.0.1',
    DORK_HOME: dorkHome,
    DORKOS_BOUNDARY: REPO_ROOT,
    DORKOS_TEST_RUNTIME: 'true',
    DORKOS_RELAY_ENABLED: 'true',
    DORKOS_TASKS_ENABLED: 'true',
    DORKOS_A2A_ENABLED: 'true',
    DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
    // No contract server reaches out: telemetry and install counts honour the
    // first switch, the npm update check the second (DOR-3226).
    DORKOS_TELEMETRY_DISABLED: '1',
    DORKOS_UPDATE_CHECK_DISABLED: '1',
    ...extra,
    // A test-mode boot must not discover the operator's real harness sign-ins.
    HOME: path.join(dorkHome, 'home'),
    CLAUDE_CONFIG_DIR: path.join(dorkHome, 'claude'),
  };
}

/** Poll `/api/health` until the server answers, or the child dies. */
async function waitUntilUp(
  baseUrl: string,
  version: string,
  child: ChildProcess,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The server exited (${child.exitCode}) before it answered:\n${output()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const { version: answered } = (await res.json()) as { version?: string };
        if (answered !== version) {
          throw new Error(`Another server answered on ${baseUrl} (version ${answered})`);
        }
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Another server')) throw error;
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`The server did not answer /api/health in ${BOOT_TIMEOUT_MS} ms:\n${output()}`);
}

/** This worker's built entries, once a boot has asked for them. */
let builtEntries: Promise<Map<string, string>> | undefined;

/** How long a worker waits for another worker's build before it gives up. */
const BUILD_WAIT_MS = 180_000;

/** This run's folder, from `global-setup.ts`. */
function runDir(): string {
  const dir = inject('contractServerBuildDir');
  if (!dir) throw new Error('No contract build folder: is global-setup.ts in vitest.config.ts?');
  return dir;
}

/**
 * This run's build of the composed server (`server-build.ts`), made by the
 * first worker to ask and read by the rest. The first to create the `lock`
 * folder writes its pid into it, builds into `out/` and then writes `ready`
 * (or `failed`, with the error); every other worker waits for one of the two,
 * and fails at once if the builder's process has gone without writing either.
 * (Vitest's default `forks` pool gives each worker its own pid.)
 */
function loadBuiltEntries(): Promise<Map<string, string>> {
  builtEntries ??= (async () => {
    const dir = runDir();
    const out = path.join(dir, 'out');
    const ready = path.join(dir, 'ready');
    const failed = path.join(dir, 'failed');
    const lock = path.join(dir, 'lock');
    const lockPid = path.join(lock, 'pid');
    let builder = true;
    try {
      await mkdir(lock);
    } catch {
      builder = false;
    }
    if (builder) {
      try {
        await writeFile(lockPid, String(process.pid));
        const started = Date.now();
        const built = await buildContractServer(out);
        await writeFile(path.join(dir, BUILD_MS_FILE), String(Date.now() - started));
        // Written whole, then renamed, so a waiting worker never reads half of it.
        await writeFile(`${ready}.tmp`, JSON.stringify([...built]));
        await rename(`${ready}.tmp`, ready);
        return built;
      } catch (error) {
        await writeFile(
          failed,
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        );
        throw error;
      }
    }
    const deadline = Date.now() + BUILD_WAIT_MS;
    while (Date.now() < deadline) {
      const done = await readFile(ready, 'utf8').catch(() => undefined);
      if (done) return new Map(JSON.parse(done) as [string, string][]);
      const error = await readFile(failed, 'utf8').catch(() => undefined);
      if (error !== undefined) throw new Error(`The contract server build failed:\n${error}`);
      // No pid yet means the builder has only just taken the lock. A builder
      // that finished and exited since `ready` was read above is not dead.
      const pid = Number(await readFile(lockPid, 'utf8').catch(() => ''));
      if (pid > 0 && !isAlive(pid) && !existsSync(ready)) {
        throw new Error(
          `The contract server build's worker (pid ${pid}) exited without finishing it ` +
            `or writing ${failed}; see that worker's error above.`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`The contract server build did not finish in ${BUILD_WAIT_MS} ms`);
  })();
  return builtEntries;
}

/**
 * The Node arguments that boot `entrypoint`. In a bundle-mode run
 * (`global-setup.ts`) a listed entry runs from its build, with source maps on
 * and the source entry in `argv[1]` as tsx leaves them, and a build that lacks
 * it throws rather than fall back to tsx. Anything else runs with tsx on the
 * source. Each boot marks its mode in the run folder for the run's mode line.
 *
 * @param entrypoint - `src/index.ts`, or an absolute path to a test bootstrap.
 * @param forceTsx - Boot with tsx whatever the run's mode (the parity boot).
 */
async function nodeArgs(entrypoint: string, forceTsx: boolean): Promise<string[]> {
  const source = path.resolve(SERVER_DIR, entrypoint);
  const bundled =
    !forceTsx &&
    inject('contractServerMode') === 'bundle' &&
    Object.values(BUILT_ENTRIES).includes(source);
  await writeFile(path.join(runDir(), BOOTED_MARKER_PREFIX + (bundled ? 'bundle' : 'tsx')), '');
  if (!bundled) return [TSX_CLI, entrypoint];
  const built = (await loadBuiltEntries()).get(source);
  if (!built) {
    throw new Error(
      `The contract server build has no ${source}; set ${TSX_ESCAPE_FLAG}=1 to boot with tsx.`
    );
  }
  const prelude = built.replace(/\.mjs$/, '.argv.mjs');
  return ['--enable-source-maps', '--import', pathToFileURL(prelude).href, built];
}

/** Options for {@link bootComposedServer}. */
export interface BootOptions {
  /** Boot with `tsx` even in a bundle-mode run: the parity check's real-ESM boot. */
  readonly tsx?: boolean;
}

/** How many ports a boot tries before it gives up. */
const BOOT_ATTEMPTS = 3;

/**
 * Boot the composed server on a free port with a throwaway data directory.
 *
 * {@link freePort} releases its port before the server takes it, so another
 * socket in this worker (an outgoing request's own port, say) can take it in
 * between. A boot that loses that race is tried again on a new port; any
 * other failure is thrown as it is.
 *
 * @param extra - More environment for the server, over the defaults.
 * @param entrypoint - A contract-specific test bootstrap, otherwise the real server entry.
 *   One listed in `server-build.ts` runs from this run's build; any other runs with tsx.
 * @param options - See {@link BootOptions}.
 * @returns The running server.
 */
export async function bootComposedServer(
  extra: Record<string, string> = {},
  entrypoint = 'src/index.ts',
  options: BootOptions = {}
): Promise<ComposedServer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bootOnce(extra, entrypoint, options.tsx ?? false);
    } catch (error) {
      const lostPort = error instanceof Error && /Port \d+ is already in use/.test(error.message);
      if (!lostPort || attempt >= BOOT_ATTEMPTS) throw error;
    }
  }
}

/**
 * One boot on one free port.
 *
 * @param extra - More environment for the server, over the defaults.
 */
async function bootOnce(
  extra: Record<string, string>,
  entrypoint: string,
  forceTsx: boolean
): Promise<ComposedServer> {
  const port = await freePort();
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-contract-'));
  await mkdir(path.join(dorkHome, 'home'));
  await mkdir(path.join(dorkHome, 'claude'));
  // The `r` keeps the tag alphanumeric: eight hex digits that happen to be all
  // numbers with a leading zero are not a valid semver prerelease, and the
  // config store refuses to start on that version.
  const version = `0.0.0-contract.r${randomUUID().slice(0, 8)}`;
  const child = spawn(process.execPath, await nodeArgs(entrypoint, forceTsx), {
    cwd: SERVER_DIR,
    env: serverEnv(port, dorkHome, version, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  let log = '';
  const keep = (chunk: Buffer): void => {
    log = (log + chunk.toString()).slice(-8_000);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);

  const baseUrl = `http://127.0.0.1:${port}`;
  const close = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    await rm(dorkHome, { recursive: true, force: true });
  };
  try {
    await waitUntilUp(baseUrl, version, child, () => log);
  } catch (error) {
    await close();
    throw error;
  }
  return { baseUrl, dorkHome, log: () => log, close };
}

/**
 * Stands for the server's own origin (`http://127.0.0.1:<port>`) in a case's
 * headers or expected headers, since the port is only known once it boots.
 */
export const SERVER_ORIGIN = '{{server-origin}}';

/** One request to the composed server, and what it must answer. */
export interface ContractCase {
  /** What the case shows, as the test title. */
  readonly name: string;
  /** Defaults to `GET`. */
  readonly method?: string;
  /** The path and query. */
  readonly path: string;
  /** Request headers. `host` is sent as given; {@link SERVER_ORIGIN} is filled in. */
  readonly headers?: Record<string, string>;
  /** A request body: a string is sent as it is, anything else as JSON. */
  readonly body?: unknown;
  /** The answer. */
  readonly expect: {
    /** The status. */
    readonly status: number;
    /**
     * Headers that must match; `null` means the header must be absent. A
     * pattern against a repeated header must match one of its values.
     */
    readonly headers?: Record<string, string | RegExp | null>;
    /** The body, compared as JSON when it parses, else as text. */
    readonly body?: unknown;
    /** A schema the JSON body must satisfy. */
    readonly schema?: ZodType;
  };
}

/** One raw answer. */
interface RawAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/**
 * Send one request with `node:http`, not `fetch`: `fetch` drops a `Host`
 * header it is handed, and the foreign-host refusal is a case every group has.
 */
function send(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, baseUrl), { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Send one case and check its answer.
 *
 * @param baseUrl - The composed server.
 * @param testCase - The case.
 */
export async function checkContractCase(baseUrl: string, testCase: ContractCase): Promise<void> {
  const fill = (value: string): string => value.replaceAll(SERVER_ORIGIN, baseUrl);
  const { method = 'GET', body } = testCase;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(testCase.headers ?? {})) {
    headers[name.toLowerCase()] = fill(value);
  }
  let payload: string | undefined;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') headers['content-type'] ??= 'application/json';
  }
  const res = await send(baseUrl, method, testCase.path, headers, payload);
  expect(
    res.status,
    `${method} ${testCase.path} answered ${res.status}: ${res.text.slice(0, 300)}`
  ).toBe(testCase.expect.status);
  for (const [name, want] of Object.entries(testCase.expect.headers ?? {})) {
    const raw = res.headers[name.toLowerCase()];
    const have = Array.isArray(raw) ? raw.join(', ') : (raw ?? null);
    if (want === null) expect(have, `header ${name}`).toBeNull();
    else if (want instanceof RegExp && Array.isArray(raw)) {
      // A repeated header (`Set-Cookie`): one of its values must match on its
      // own, so a pattern cannot borrow from the value beside it.
      expect(
        raw.some((value) => want.test(value)),
        `header ${name}: ${have}`
      ).toBe(true);
    } else if (want instanceof RegExp) expect(have, `header ${name}`).toMatch(want);
    else expect(have, `header ${name}`).toBe(fill(want));
  }
  let parsed: unknown = res.text;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    // Not JSON; compare as text.
  }
  if (testCase.expect.body !== undefined) expect(parsed).toEqual(testCase.expect.body);
  if (testCase.expect.schema) testCase.expect.schema.parse(parsed);
}

/** Options for {@link contractSuite}. */
export interface ContractSuiteOptions {
  /** More environment for the server, over the defaults. */
  readonly env?: Record<string, string>;
  /** Boot with tsx whatever the run's mode (see {@link BootOptions}). */
  readonly tsx?: boolean;
}

/**
 * A contract suite for one route group: boot the composed server once, then
 * run every case against it, in order. A case may rely on what an earlier
 * one did (an account created, an attempt counted); say so in its name.
 *
 * @param group - The route group, as the plan names it.
 * @param cases - The cases.
 * @param options - See {@link ContractSuiteOptions}.
 */
export function contractSuite(
  group: string,
  cases: readonly ContractCase[],
  options: ContractSuiteOptions = {}
): void {
  describe(`contract: ${group}`, () => {
    let server: ComposedServer | undefined;
    beforeAll(async () => {
      server = await bootComposedServer(options.env, undefined, { tsx: options.tsx });
    }, BOOT_HOOK_TIMEOUT_MS);
    afterAll(async () => {
      await server?.close();
    }, 30_000);

    it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
      await checkContractCase(server!.baseUrl, testCase);
    });
  });
}

/**
 * Sign the owner in at a name that is not this computer, as a browser there
 * would, and return the cookie header it set. A sign-in works only on the
 * route it was made on (DOR-2969), so a case about another device signs in
 * there rather than replaying the cookie this computer got. The proxy is
 * named as https, as a browser keeps a `Secure` cookie only over https.
 *
 * @param baseUrl - The composed server.
 * @param host - The name the request arrives at.
 * @param credentials - The owner's email and password.
 * @returns The `cookie` header, ready to spread into a case's headers.
 */
export async function signInAt(
  baseUrl: string,
  host: string,
  credentials: { email: string; password: string }
): Promise<{ cookie: string }> {
  const res = await send(
    baseUrl,
    'POST',
    '/api/auth/sign-in/email',
    {
      host,
      origin: `https://${host}`,
      'x-forwarded-proto': 'https',
      'content-type': 'application/json',
    },
    JSON.stringify(credentials)
  );
  if (res.status !== 200) {
    throw new Error(`sign-in at ${host} answered ${res.status}: ${res.text.slice(0, 300)}`);
  }
  const set = res.headers['set-cookie'] ?? [];
  return { cookie: set.map((value) => value.split(';')[0]!).join('; ') };
}

/**
 * The owner's one password step-up at this computer (DOR-3330): the headers
 * the app then sends with every change, its session cookie and the person
 * proof its page keeps.
 *
 * @param baseUrl - The composed server.
 * @param password - The owner's password.
 * @returns The `cookie` and person-proof headers, ready to spread into a request.
 */
export async function stepUpAt(baseUrl: string, password: string): Promise<Record<string, string>> {
  const res = await send(
    baseUrl,
    'POST',
    PERSON_SESSION_PATH,
    { origin: baseUrl, 'content-type': 'application/json' },
    JSON.stringify({ password })
  );
  if (res.status !== 200) {
    throw new Error(`the step-up answered ${res.status}: ${res.text.slice(0, 300)}`);
  }
  const set = res.headers['set-cookie'] ?? [];
  const { proof } = JSON.parse(res.text) as { proof: string };
  return {
    cookie: set.map((value) => value.split(';')[0]!).join('; '),
    [PERSON_PROOF_HEADER]: proof,
  };
}
