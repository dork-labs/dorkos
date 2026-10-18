/**
 * The contract harness for the space server (specs/server-merge step 1, DOR-2875), in the
 * pattern of the Hono move's (DOR-2793). A contract file states, as a table of cases, what a real
 * server answers over HTTP for one group of routes: the status, the headers a caller relies on,
 * and the body or a Zod schema it satisfies. It pins what a caller depends on (status, content
 * type, required fields, error codes), never incidental bytes, so the same unchanged file must
 * pass before and after the server moves (step 2 on). A deliberate change updates the contract
 * file in the same PR and says so in the PR description.
 *
 * Cases run in order against one server per file, so a case may keep a value (a new id) for the
 * ones after it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

/** A value, or a function of the fixture that gives it once the server is up. */
type Late<F, T> = T | ((fixture: F) => T);

/** One request, and what the server must answer. */
export interface ContractCase<F> {
  /** What the case shows, as the test title. */
  readonly name: string;
  /** Defaults to `GET`. */
  readonly method?: string;
  /** The path and query. */
  readonly path: Late<F, string>;
  /** Request headers. */
  readonly headers?: Late<F, Record<string, string>>;
  /** A body: a string is sent as it is, anything else as JSON. */
  readonly body?: Late<F, unknown>;
  /** The answer. */
  readonly expect: {
    readonly status: number;
    /** Headers that must match; `null` means absent. */
    readonly headers?: Record<string, string | RegExp | null>;
    /** The exact JSON body. */
    readonly body?: unknown;
    /** Fields the JSON body must have, compared with `toMatchObject`. */
    readonly match?: unknown;
    /** A schema the JSON body must satisfy. */
    readonly schema?: ZodType;
    /** A pattern the text body must match. */
    readonly text?: RegExp;
  };
  /** Runs with the parsed JSON answer, to keep a value later cases need. */
  readonly keep?: (fixture: F, body: unknown) => void;
}

/** A running server and the fixture its cases read. */
export interface ContractServer<F> {
  readonly baseUrl: string;
  readonly fixture: F;
  close(): Promise<void>;
}

function late<F, T>(value: Late<F, T>, fixture: F): T {
  return typeof value === 'function' ? (value as (fixture: F) => T)(fixture) : value;
}

/**
 * Send one case and check its answer.
 *
 * @param server - The running server.
 * @param testCase - The case.
 */
async function checkContractCase<F>(
  server: ContractServer<F>,
  testCase: ContractCase<F>
): Promise<void> {
  const { fixture } = server;
  const method = testCase.method ?? 'GET';
  const path = late(testCase.path, fixture);
  const headers: Record<string, string> = { ...late(testCase.headers ?? {}, fixture) };
  const raw = testCase.body === undefined ? undefined : late(testCase.body, fixture);
  let body: string | undefined;
  if (raw !== undefined) {
    body = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (typeof raw !== 'string') headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const want = testCase.expect;
  // A live stream never ends; its status and headers are the contract.
  const streaming = res.headers.get('content-type')?.startsWith('text/event-stream') ?? false;
  const text = streaming ? (await res.body?.cancel(), '') : await res.text();
  expect(res.status, `${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`).toBe(
    want.status
  );
  for (const [name, value] of Object.entries(want.headers ?? {})) {
    const have = res.headers.get(name);
    if (value === null) expect(have, `header ${name}`).toBeNull();
    else if (value instanceof RegExp) expect(have ?? '', `header ${name}`).toMatch(value);
    else expect(have, `header ${name}`).toBe(value);
  }
  if (want.text) expect(text).toMatch(want.text);
  const needsJson =
    want.body !== undefined || want.match !== undefined || want.schema || testCase.keep;
  if (!needsJson) return;
  const json = JSON.parse(text) as unknown;
  if (want.body !== undefined) expect(json).toEqual(want.body);
  if (want.match !== undefined) expect(json).toMatchObject(want.match as object);
  if (want.schema) {
    const parsed = want.schema.safeParse(json);
    expect(parsed.success, `${method} ${path}: ${parsed.error?.message ?? ''}`).toBe(true);
  }
  testCase.keep?.(fixture, json);
}

/**
 * One `describe` for a group: start a server once, run every case against it in order, stop it.
 *
 * @param group - The route group, as the describe title.
 * @param start - Starts the server and builds the fixture.
 * @param cases - The cases, in the order they run.
 */
export function contractSuite<F>(
  group: string,
  start: () => Promise<ContractServer<F>>,
  cases: readonly ContractCase<F>[]
): void {
  describe(`contract: ${group}`, () => {
    let server: ContractServer<F> | undefined;
    beforeAll(async () => {
      server = await start();
    }, 120_000);
    afterAll(async () => {
      await server?.close();
    }, 60_000);
    for (const testCase of cases)
      it(testCase.name, async () => {
        if (!server) throw new Error('The server did not start');
        await checkContractCase(server, testCase);
      });
  });
}
