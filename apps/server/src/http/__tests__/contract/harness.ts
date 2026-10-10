/**
 * The contract harness for the Express-to-Hono move (DOR-2793).
 *
 * A contract file states what the real server answers for one route group:
 * status, the headers that matter, and the body or its Zod schema. It talks to
 * the COMPOSED server, booted from `src/index.ts` exactly as the e2e legs boot
 * it, over a real port. So the same unchanged file passes before a group moves
 * (Express answers) and after (Hono answers), which is the proof a move PR
 * offers. A move PR may not edit its group's contract file (plan rule 2).
 *
 * Each case set should include the refusals as well as the answers: no
 * credential, a foreign `Host`, a wrong `Origin`, an empty body, malformed JSON
 * and an oversize body, wherever the group has them.
 *
 * @module http/__tests__/contract/harness
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const TSX = path.join(SERVER_DIR, 'node_modules/.bin/tsx');
const RECORD_MOUNT_PATHS = path.join(SERVER_DIR, 'src/http/route-census/record-mount-paths.ts');

/** How long a cold boot may take before the harness gives up. */
export const BOOT_TIMEOUT_MS = 180_000;

/** A running composed server. */
export interface ComposedServer {
  /** Where it listens, e.g. `http://127.0.0.1:53511`. */
  readonly baseUrl: string;
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
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(DORKOS_|DORK_HOME$|VITEST|NODE_ENV$|TEST$)/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    NODE_ENV: 'development',
    DORKOS_PORT: String(port),
    DORKOS_HOST: '127.0.0.1',
    DORK_HOME: dorkHome,
    DORKOS_BOUNDARY: REPO_ROOT,
    DORKOS_TEST_RUNTIME: 'true',
    DORKOS_RELAY_ENABLED: 'true',
    DORKOS_TASKS_ENABLED: 'true',
    DORKOS_A2A_ENABLED: 'true',
    DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
    ...extra,
  };
}

/** Poll `/api/health` until the server answers, or the child dies. */
async function waitUntilUp(
  baseUrl: string,
  child: ChildProcess,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The server exited (${child.exitCode}) before it answered:\n${output()}`);
    }
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The server did not answer /api/health in ${BOOT_TIMEOUT_MS} ms:\n${output()}`);
}

/**
 * Boot the composed server on a free port with a throwaway data directory.
 *
 * @param extra - More environment for the server, over the defaults.
 * @returns The running server.
 */
export async function bootComposedServer(
  extra: Record<string, string> = {}
): Promise<ComposedServer> {
  const port = await freePort();
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-contract-'));
  const child = spawn(TSX, ['--import', RECORD_MOUNT_PATHS, 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: serverEnv(port, dorkHome, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    await waitUntilUp(baseUrl, child, () => log);
  } catch (error) {
    await close();
    throw error;
  }
  return { baseUrl, close };
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
    /** Headers that must match; `null` means the header must be absent. */
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
    else if (want instanceof RegExp) expect(have, `header ${name}`).toMatch(want);
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

/**
 * A contract suite for one route group: boot the composed server once, then
 * run every case against it.
 *
 * @param group - The route group, as the plan names it.
 * @param cases - The cases.
 */
export function contractSuite(group: string, cases: readonly ContractCase[]): void {
  describe(`contract: ${group}`, () => {
    let server: ComposedServer | undefined;
    beforeAll(async () => {
      server = await bootComposedServer();
    }, BOOT_TIMEOUT_MS);
    afterAll(async () => {
      await server?.close();
    }, 30_000);

    it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
      await checkContractCase(server!.baseUrl, testCase);
    });
  });
}
