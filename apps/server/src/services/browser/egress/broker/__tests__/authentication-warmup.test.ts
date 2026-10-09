import { request } from 'node:http';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createBrokerIssuer } from '../issuer.js';
import { createPreparedPrivateBroker } from '../broker.js';
import { createNodeBrokerTransport } from '../node/node-transport.js';
import { createOriginalAuthenticationWarmup } from '../authentication-warmup.js';
import { frameRequest, type RawRequest } from '../framing.js';
import { BROKER_LIMITS } from '../limits.js';
import { FakeSocket } from './fake-transport.js';

async function fixture() {
  let ready = false;
  const binding = Object.freeze({
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  });
  const receiver = Object.freeze({
    browserId: binding.browserId,
    browserGeneration: binding.browserGeneration,
    isAuthorityCurrent: () => ready,
  });
  const authority = () => ({
    binding,
    ownerExists: true as const,
    retainedRun: true as const,
    grantsCurrent: true as const,
    custodyKnown: true as const,
    runtimePolicyKnown: true as const,
    runtimeIdentity: 'runtime',
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: 1,
    monotonicNow: 0,
    utcNow: 1000,
    utcExpiresAt: 100000,
  });
  const issuer = createBrokerIssuer({
    now: () => 0,
    ports: {
      readCurrent: authority,
      readAuthority: async () => authority(),
      readInventory: () => ({
        revision: 1,
        publicAuthoritiesKnown: true,
        localCoverageComplete: true,
        validUntil: 10000,
        protectedEndpoints: [],
        declaredInstances: ['main'],
        coveredInstances: ['main'],
      }),
    },
  });
  const run = issuer.prepareRun(binding, {
    runtimeIdentity: 'runtime',
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: 1,
    receiver,
  });
  const native = createNodeBrokerTransport();
  const dial = vi.fn(async () => {
    throw new Error('FORBIDDEN_BOOTSTRAP_DIAL');
  });
  const resolver = vi.fn(async () => {
    throw new Error('FORBIDDEN_BOOTSTRAP_DNS');
  });
  const broker = createPreparedPrivateBroker({
    issuer,
    run,
    receiver,
    transport: { ...native, dial },
    policy: {
      revision: 1,
      adminAuthorities: [],
      hostInterfaces: ['127.0.0.1'],
      privateAdminEndpoints: [],
      resolver,
    },
  });
  onTestFinished(async () => {
    expect(await broker.close()).toBe(true);
  });
  const descriptor = await broker.start();
  ready = true;
  await broker.activate(receiver);
  const warmup = descriptor.authenticationWarmup;
  expect(warmup).toBeDefined();
  if (!warmup) throw new Error('ORIGINAL_WARMUP_NOT_ISSUED');
  const jobs: Promise<unknown>[] = [];
  const originals: ReturnType<typeof request>[] = [];
  onTestFinished(async () => {
    let first: Readonly<{ value: unknown }> | undefined;
    for (const original of originals) {
      try {
        original.destroy();
      } catch (value) {
        first ??= { value };
      }
    }
    await Promise.allSettled(jobs);
    if (first) throw first.value;
  });
  const send = (
    target = warmup.url,
    authenticated: boolean | string = false,
    method = 'GET',
    cookie?: string
  ) => {
    let resolve!: (value: {
        status: number;
        body: string;
        headers: Record<string, unknown>;
      }) => void,
      reject!: (value: unknown) => void;
    const returned = new Promise<{
      status: number;
      body: string;
      headers: Record<string, unknown>;
    }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void returned.catch(() => {});
    const outgoing = request(
      descriptor.server,
      {
        method,
        path: target,
        headers: {
          Host: new URL(warmup.url).host,
          ...(cookie === undefined ? {} : { Cookie: cookie }),
          ...(authenticated
            ? {
                'Proxy-Authorization':
                  typeof authenticated === 'string'
                    ? authenticated
                    : 'Basic ' + Buffer.from('dorkos:' + descriptor.credential).toString('base64'),
              }
            : {}),
        },
      },
      (incoming) => {
        jobs.push(new Promise<void>((yes) => incoming.once('close', yes)));
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 16384) {
            outgoing.destroy(new Error('ORIGINAL_RESPONSE_OVERFLOW'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once('error', reject);
        incoming.once('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: incoming.headers,
          })
        );
      }
    );
    originals.push(outgoing);
    const closed = new Promise<void>((yes) => outgoing.once('close', yes));
    outgoing.on('error', reject);
    jobs.push(returned, closed);
    outgoing.end();
    return returned.then(async (value) => {
      await closed;
      return value;
    });
  };
  return { broker, issuer, run, warmup, send, resolver, dial };
}

it('actual proxy 407 then authenticated absolute GET returns one inert local response and exact terminal proof', async () => {
  const f = await fixture();
  expect((await f.send()).status).toBe(407);
  const original = await f.send(f.warmup.url, true);
  expect(original.status).toBe(200);
  expect(original.headers['cache-control']).toBe('no-store');
  expect(original.headers['set-cookie']).toBeUndefined();
  expect(original.headers['location']).toBeUndefined();
  expect(original.body).toContain('href="data:,"');
  expect(original.body).not.toContain('<script');
  await f.warmup.confirm();
  await expect(f.send(f.warmup.url, true)).rejects.toMatchObject({ code: 'ECONNRESET' });
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.dial).not.toHaveBeenCalled();
});

it.each(['direct', 'query', 'method'] as const)(
  'does not mint bootstrap proof from %s original HTTP request',
  async (kind) => {
    const f = await fixture();
    expect((await f.send()).status).toBe(407);
    const target =
      kind === 'direct'
        ? new URL(f.warmup.url).pathname
        : kind === 'query'
          ? f.warmup.url + '?foreign=1'
          : f.warmup.url;
    await expect(f.send(target, true, kind === 'method' ? 'POST' : 'GET')).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
    await expect(f.warmup.confirm()).rejects.toBeDefined();
    expect(f.resolver).not.toHaveBeenCalled();
    expect(f.dial).not.toHaveBeenCalled();
  }
);

it('revocation prevents authenticated bootstrap and cannot manufacture a terminal response receipt', async () => {
  const f = await fixture();
  expect((await f.send()).status).toBe(407);
  f.issuer.revoke(f.run);
  await expect(f.warmup.confirm()).rejects.toMatchObject({ code: 'CLOSED' });
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.dial).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  'retains original warm response failure %s after subsequent close',
  async (cause) => {
    const owner = createOriginalAuthenticationWarmup('http://127.0.0.1:4567', () => {});
    const raw: RawRequest = {
      method: 'GET',
      target: owner.capability.url,
      rawHeaders: ['Host', '127.0.0.1:4567'],
      head: new Uint8Array(),
    };
    const challenge = new FakeSocket();
    const issued = owner.challenge(raw, challenge);
    if (!issued) throw new Error('ORIGINAL_CHALLENGE_NOT_CAPTURED');
    issued.written();
    challenge.closed();
    const client = new FakeSocket();
    const framed = frameRequest(
      { ...raw, rawHeaders: [...raw.rawHeaders, 'Proxy-Authorization', 'Bearer original'] },
      BROKER_LIMITS
    );
    const original = owner.enter(raw, framed, client);
    if (!original) throw new Error('ORIGINAL_REQUEST_NOT_CAPTURED');
    try {
      await original.ready;
      original.fail(cause);
      owner.close();
      expect(await Promise.allSettled([owner.capability.confirm()])).toEqual([
        { status: 'rejected', reason: cause },
      ]);
    } finally {
      client.closed();
      owner.close();
      await Promise.allSettled([original.ready, original.closed]);
    }
  }
);

it('confirmation stays pending until original warm response socket closes, despite a stop request', async () => {
  const owner = createOriginalAuthenticationWarmup('http://127.0.0.1:4567', () => {});
  const raw: RawRequest = {
    method: 'GET',
    target: owner.capability.url,
    rawHeaders: ['Host', '127.0.0.1:4567'],
    head: new Uint8Array(),
  };
  const challenge = new FakeSocket();
  const issued = owner.challenge(raw, challenge);
  if (!issued) throw new Error('ORIGINAL_CHALLENGE_NOT_CAPTURED');
  issued.written();
  challenge.closed();
  const client = new FakeSocket();
  client.closeHeld = true;
  const framed = frameRequest(
    { ...raw, rawHeaders: [...raw.rawHeaders, 'Proxy-Authorization', 'Bearer original'] },
    BROKER_LIMITS
  );
  const original = owner.enter(raw, framed, client);
  if (!original) throw new Error('ORIGINAL_REQUEST_NOT_CAPTURED');
  const result = owner.capability.confirm();
  let returned = false;
  void result.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    }
  );
  try {
    await original.ready;
    client.destroy();
    await Promise.resolve();
    expect(returned).toBe(false);
    client.closed();
    await original.closed;
    original.complete(true);
    await result;
  } finally {
    client.closed();
    owner.close();
    await Promise.allSettled([result, original.ready, original.closed]);
  }
});

it('authenticates a current preemptive Basic request without manufacturing a fresh challenge', async () => {
  const f = await fixture();
  expect((await f.send(f.warmup.url, true)).status).toBe(200);
  await f.warmup.confirm();
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.dial).not.toHaveBeenCalled();
});

it('wrong current credential and a foreign original run cannot use the private response scope', async () => {
  const f = await fixture(),
    foreign = await fixture();
  expect((await f.send()).status).toBe(407);
  await expect(
    f.send(f.warmup.url, 'Basic ' + Buffer.from('dorkos:' + 'X'.repeat(43)).toString('base64'))
  ).rejects.toMatchObject({ code: 'ECONNRESET' });
  await expect(f.send(foreign.warmup.url, true)).rejects.toMatchObject({ code: 'ECONNRESET' });
  await expect(f.warmup.confirm()).rejects.toBeDefined();
  expect((await foreign.send(foreign.warmup.url, true)).status).toBe(200);
  await foreign.warmup.confirm();
  for (const owner of [f, foreign]) {
    expect(owner.resolver).not.toHaveBeenCalled();
    expect(owner.dial).not.toHaveBeenCalled();
  }
});

it.each(['revoke', 'close'] as const)(
  'does not reuse completed response proof after original owner %s',
  async (kind) => {
    const f = await fixture();
    expect((await f.send(f.warmup.url, true)).status).toBe(200);
    await f.warmup.confirm();
    if (kind === 'revoke') f.issuer.revoke(f.run);
    else expect(await f.broker.close()).toBe(true);
    await expect(f.warmup.confirm()).rejects.toMatchObject({ code: 'CLOSED' });
  }
);

it.each([false, true])(
  'does not let a retained host cookie prevent private proxy authentication (preemptive=%s)',
  async (preemptive) => {
    const f = await fixture();
    const cookie = 'dork_fixture=fixture-alpha; dork_session=fixture-alpha';
    if (!preemptive) expect((await f.send(f.warmup.url, false, 'GET', cookie)).status).toBe(407);
    const result = await f.send(f.warmup.url, true, 'GET', cookie);
    expect(result.status).toBe(200);
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers.location).toBeUndefined();
    expect(result.body).not.toContain('fixture-alpha');
    expect(result.headers['cache-control']).toBe('no-store');
    await f.warmup.confirm();
    expect(f.resolver).not.toHaveBeenCalled();
    expect(f.dial).not.toHaveBeenCalled();
    await expect(f.send(f.warmup.url, true, 'GET', cookie)).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
  }
);
it('retained cookies do not substitute credentials or permit direct origin-form warmup', async () => {
  const f = await fixture();
  const cookie = 'dork_fixture=fixture-alpha';
  await expect(
    f.send(
      f.warmup.url,
      'Basic ' + Buffer.from('dorkos:' + 'X'.repeat(43)).toString('base64'),
      'GET',
      cookie
    )
  ).rejects.toMatchObject({ code: 'ECONNRESET' });
  await expect(f.send(new URL(f.warmup.url).pathname, true, 'GET', cookie)).rejects.toMatchObject({
    code: 'ECONNRESET',
  });
  await expect(f.warmup.confirm()).rejects.toBeDefined();
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.dial).not.toHaveBeenCalled();
});
