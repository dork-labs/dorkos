/**
 * An offline DorkOS Cloud for the managed remote access tests (DOR-2086):
 * answers from the published `@dork-labs/cloud-api` fixtures, records every
 * call, and models the link so a test can unlink and relink between answers.
 */
import { createCloudApiClient, type FetchLike } from '@dork-labs/cloud-api/client';
import entitlementsFree from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-free.json' with { type: 'json' };
import signedIn from '@dork-labs/cloud-api/fixtures/v1/session/signed-in.json' with { type: 'json' };
import statusClosed from '@dork-labs/cloud-api/fixtures/v1/remote/status-closed.json' with { type: 'json' };

import type { CloudV1Context } from '../../cloud/v1-client.js';

/** One canned answer: a status and a JSON body, or a thrown network error. */
export type FakeAnswer = { status: number; body?: unknown } | { networkError: true };

/** One recorded request. */
export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string | undefined;
}

/** A problem envelope in the published shape. */
export function problem(status: number, code: string, title = 'Refused.'): FakeAnswer {
  return { status, body: { code, status, title } };
}

/** Entitlements whose remote capability is `remoteAccess`. */
export function entitlements(remoteAccess: 'byo' | 'on_demand' | 'always_available'): FakeAnswer {
  return {
    status: 200,
    body: { ...entitlementsFree, limits: { ...entitlementsFree.limits, remoteAccess } },
  };
}

/**
 * A fake Cloud and link.
 *
 * Answers are queued per `METHOD /path`; the last one repeats. Routes nobody
 * set answer `404` with a bare body, the way a service without the route does.
 */
export class FakeCloud {
  readonly calls: FakeCall[] = [];
  private readonly answers = new Map<string, FakeAnswer[]>();
  /** The current link generation; `null` when unlinked. */
  private generation: number | null = 1;
  private nextGeneration = 2;
  private token = 'instance-key-a';

  constructor() {
    this.on('GET', '/v1/session', { status: 200, body: signedIn });
    this.on('GET', '/v1/entitlements', entitlements('on_demand'));
    this.on('GET', '/v1/remote/status', { status: 200, body: statusClosed });
  }

  /**
   * Queue answers for one route.
   *
   * @param method - The HTTP method.
   * @param path - The path, without the query.
   * @param answers - Answered in order; the last repeats.
   */
  on(method: string, path: string, ...answers: FakeAnswer[]): this {
    this.answers.set(`${method} ${path}`, answers);
    return this;
  }

  /** The calls made to one route. */
  callsTo(method: string, path: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: headers.authorization,
    });
    const queue = this.answers.get(`${method} ${url.pathname}`);
    const answer = queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : { status: 404 };
    if ('networkError' in answer) throw new TypeError('fetch failed');
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  /** Capture the current link, the way `captureCloudV1Context` does. */
  readonly capture = (): CloudV1Context | null => {
    if (this.generation === null) return null;
    const generation = this.generation;
    return {
      client: createCloudApiClient({
        baseUrl: 'https://cloud.example.invalid',
        token: this.token,
        fetch: this.fetch,
      }),
      isCurrent: () => this.generation === generation,
    };
  };

  /** Unlink: every captured context goes stale. */
  unlink(): void {
    this.generation = null;
  }

  /** Link again, with the same key unless told otherwise. A new generation either way. */
  relink(token = this.token): void {
    this.token = token;
    this.generation = this.nextGeneration++;
  }
}
