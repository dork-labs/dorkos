import { fixture, target } from './input-routes.fixture.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import type {
  PrivateBrowserSemanticDispatcher,
  OwnedSemanticReadAuthorization,
} from '@dorkos/browser/server-owner';
import { BrowserBindingSchema } from '@dorkos/shared/browser-schemas';
import {
  SemanticSnapshotV1Schema,
  SemanticActionV1Schema,
  SemanticReceiptV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';
import { BrowserSemanticReadHost } from '../semantic-read-host.js';
import { BrowserApiRefusal } from '../service.js';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { sessionGate } from '../../../core/auth/session-gate.js';
import { BrowserSemanticRoutes } from '../semantic-routes.js';
import { getAuth } from '../../../core/auth/index.js';

async function hostFixture() {
  const bank: {
    host?: BrowserSemanticReadHost;
    accepted?: Readonly<{ value: unknown }>;
    starting?: Promise<Awaited<ReturnType<typeof fixture>>>;
    closed: boolean;
    finishing?: Promise<void>;
  } = { closed: false };
  let release = () => {},
    settled = false;
  const finish = () =>
    (bank.finishing ??= Promise.resolve().then(async () => {
      bank.closed = true;
      let first: Readonly<{ value: unknown }> | undefined;
      try {
        release();
      } catch (value) {
        first = { value };
      }
      const results = await Promise.allSettled([
        ...(bank.starting ? [bank.starting] : []),
        Promise.resolve().then(() => bank.host?.close()),
      ]);
      for (const result of results)
        if (
          result.status === 'rejected' &&
          (!bank.accepted || !Object.is(result.reason, bank.accepted.value))
        )
          first ??= { value: result.reason };
      if (first) throw first.value;
    }));
  onTestFinished(finish);
  const starting = (bank.starting = fixture(undefined, finish));
  const f = await starting;
  if (bank.closed) throw new Error('SEMANTIC_FIXTURE_CLOSED');
  const host = new BrowserSemanticReadHost(f.identities, f.grants, () => true, f.controller);
  bank.host = host;
  const authorities: OwnedSemanticReadAuthorization[] = [];
  const read = vi.fn<PrivateBrowserSemanticDispatcher['read']>(async (binding, authority) => {
    authorities.push(authority);
    await authority.refresh();
    return SemanticSnapshotV1Schema.parse({
      version: 1,
      ...BrowserBindingSchema.parse(binding),
      treeId: 'semantic_tree_fixture_0001',
      treeRevision: 1,
      grantRevision: authority.grantRevision,
      semanticLeaseId: 'semantic_lease_fixture_001',
      capturedAt: new Date().toISOString(),
      expiresInMs: 2000,
      rootRefs: [],
      nodes: [],
      focusedRef: null,
      focusState: 'none',
      focusRevision: 0,
      completeness: 'complete',
    });
  });
  const resolve = vi.fn<PrivateBrowserSemanticDispatcher['resolve']>(
    async (_binding, _lease, _node, authority) => {
      await authority.refresh();
      return true;
    }
  );
  const action = vi.fn<PrivateBrowserSemanticDispatcher['action']>(async () => {
    throw new Error('UNUSED_SEMANTIC_ACTION');
  });
  const openStream = vi.fn<PrivateBrowserSemanticDispatcher['openStream']>(
    async (_binding, _lease, authority) => {
      await authority.refresh();
      return Object.freeze({
        eventStreamId: 'stream_original_fixture_001',
        next: async () => {
          await authority.refresh();
          return null;
        },
        close: async () => {},
      });
    }
  );
  host.registerDispatcher({ read, resolve, action, openStream });
  const grant = (permissions: Parameters<typeof f.grants.issue>[4]) => {
    const actor = f.ownerAuth.current();
    if (!actor) throw new Error('REAL_OWNER_MISSING');
    return f.grants.issue(
      f.ownerAuth.current,
      f.seat.binding,
      actor.owner,
      f.issueGrant(['browser.view']).attachment,
      permissions,
      new Date(Date.now() + 60000).toISOString()
    );
  };
  const request = (value: ReturnType<typeof grant>) => ({
    binding: f.seat.binding,
    grant: { grantId: value.grantId, revision: value.grantRevision },
  });
  return {
    f,
    host,
    read,
    resolve,
    action,
    openStream,
    grant,
    request,
    authorities,
    disposeParticipant: finish,
    accept: (value: unknown) => {
      bank.accepted = { value };
    },
    hold: () => {
      const held = new Promise<void>((done) => {
        release = done;
      });
      return {
        held,
        release: () => release(),
        settled: () => settled,
        observe: (original: Promise<unknown>) => {
          void original.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            }
          );
        },
      };
    },
  };
}
// Real BetterAuth, SQLite, original grant registry; only semantic native dispatcher is a named double.
it('requires browser.view rather than control and retains credential/revision-specific private keys', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    control = h.grant(['browser.control']);
  await expect(
    h.host.read(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      h.request(control),
      new AbortController().signal
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(h.read).not.toHaveBeenCalled();
  await h.host.read(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.request(view),
    new AbortController().signal
  );
  await h.host.read(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.request(view),
    new AbortController().signal
  );
  const other = h.grant(['browser.view']);
  await h.host.read(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.request(other),
    new AbortController().signal
  );
  expect(h.authorities[0]?.actorKey).toBe(h.authorities[1]?.actorKey);
  expect(h.authorities[0]?.grantKey).toBe(h.authorities[1]?.grantKey);
  expect(h.authorities[2]?.actorKey).toBe(h.authorities[0]?.actorKey);
  expect(h.authorities[2]?.grantKey).not.toBe(h.authorities[0]?.grantKey);
  expect(h.authorities[0]?.grantKey).not.toBe(view.grantId);
});
it('denies foreign actor and caller-supplied semantic authority without entering the original reader', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']);
  await expect(
    h.host.read(
      h.f.recipientRequest.req,
      h.f.recipientRequest.res,
      h.request(view),
      new AbortController().signal
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  await expect(
    h.host.read(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      { ...h.request(view), actorKey: 'caller_supplied_identity_01' },
      new AbortController().signal
    )
  ).rejects.toBeDefined();
  expect(h.read).not.toHaveBeenCalled();
});
it('close fences publication but joins the held original semantic read', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    hold = h.hold();
  const originalRead = h.read.getMockImplementation();
  if (!originalRead) throw new Error('ORIGINAL_READ_MISSING');
  h.read.mockImplementation(async (...args) => {
    await hold.held;
    return originalRead(...args);
  });
  const original = h.host.read(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.request(view),
    new AbortController().signal
  );
  void original.catch(() => undefined);
  await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  const closing = h.host.close();
  hold.observe(closing);
  await Promise.resolve();
  expect(hold.settled()).toBe(false);
  hold.release();
  await expect(original).rejects.toBeInstanceOf(BrowserApiRefusal);
  await closing;
});
it('preserves original server-store undefined before the native reader and through close', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    auth = getAuth();
  if (!auth) throw new Error('REAL_AUTH_MISSING');
  const originalSession = auth.api.getSession;
  const proxy = new Proxy(originalSession, {
    apply(target, receiver, args) {
      const original = Reflect.apply(target, receiver, args);
      return Promise.resolve(original).then(() => {
        throw undefined;
      });
    },
  });
  const spy = vi.spyOn(auth.api, 'getSession').mockImplementation(proxy);
  onTestFinished(() => spy.mockRestore());
  await expect(
    h.host.read(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      h.request(view),
      new AbortController().signal
    )
  ).rejects.toBeUndefined();
  expect(h.read).not.toHaveBeenCalled();
  h.accept(undefined);
  await expect(h.host.close()).rejects.toBeUndefined();
});
it('retains a producer-forged same-class refusal as an operational close failure', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    cause = new BrowserApiRefusal('unavailable');
  h.read.mockRejectedValueOnce(cause);
  await expect(
    h.host.read(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      h.request(view),
      new AbortController().signal
    )
  ).rejects.toBe(cause);
  h.accept(cause);
  await expect(h.host.close()).rejects.toBe(cause);
});

it('revocation while an original read is held refuses disclosure after natural settlement', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    hold = h.hold();
  const originalRead = h.read.getMockImplementation();
  if (!originalRead) throw new Error('ORIGINAL_READ_MISSING');
  h.read.mockImplementation(async (...args) => {
    await hold.held;
    return originalRead(...args);
  });
  const original = h.host.read(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.request(view),
    new AbortController().signal
  );
  void original.catch(() => undefined);
  await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  h.f.grants.revoke(h.f.ownerAuth.current, view.grantId, view.grantRevision);
  hold.release();
  await expect(original).rejects.toBeInstanceOf(BrowserApiRefusal);
  await h.host.close();
});

it('bounds whole delivery but joins the exact native read after the request deadline', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    hold = h.hold();
  const originalRead = h.read.getMockImplementation();
  if (!originalRead) throw new Error('ORIGINAL_READ_MISSING');
  h.read.mockImplementation(async (...args) => {
    await hold.held;
    return originalRead(...args);
  });
  const caller = h.host.read(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.request(view),
    new AbortController().signal
  );
  void caller.catch(() => undefined);
  await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  await expect(caller).rejects.toBeInstanceOf(BrowserApiRefusal);
  const closing = h.host.close();
  hold.observe(closing);
  await Promise.resolve();
  expect(hold.settled()).toBe(false);
  hold.release();
  await closing;
});

it('private actor read uses the retained real credential and explicit view grant without HTTP objects', async () => {
  const h = await hostFixture();
  const view = h.grant(['browser.view']);
  const original = h.f.ownerAuth;
  const result = await h.host.readForActor(original, h.request(view), new AbortController().signal);
  expect(result.grantRevision).toBe(view.grantRevision);
  expect(h.read).toHaveBeenCalledTimes(1);
  await expect(
    h.host.readForActor(
      original,
      h.request(h.grant(['browser.control'])),
      new AbortController().signal
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(h.read).toHaveBeenCalledTimes(1);
});

it('private actor acquisition preserves an original undefined refresh failure without entering native read', async () => {
  const h = await hostFixture();
  const original = {
    current: h.f.ownerAuth.current,
    refresh: async () => {
      throw undefined;
    },
  };
  h.accept(undefined);
  await expect(
    h.host.readForActor(
      original,
      h.request(h.grant(['browser.view'])),
      new AbortController().signal
    )
  ).rejects.toBeUndefined();
  expect(h.read).not.toHaveBeenCalled();
  await expect(h.host.close()).rejects.toBeUndefined();
});

// These controls use the real retained SQLite identity and grants; the native stream is explicitly a port double.
it('retains exact view-grant scope for stream birth and denies a control-only grant before native entry', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    control = h.grant(['browser.control']);
  const source = h.f.ownerAuth;
  const stream = await h.host.streamForActor(
    source,
    { ...h.request(view), leaseId: 'semantic_lease_fixture_001' },
    new AbortController().signal
  );
  expect(h.openStream).toHaveBeenCalledTimes(1);
  expect(await stream.next()).toBeNull();
  await expect(
    h.host.streamForActor(
      source,
      { ...h.request(control), leaseId: 'semantic_lease_fixture_001' },
      new AbortController().signal
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(h.openStream).toHaveBeenCalledTimes(1);
});

it('does not reclassify a prior genuine admission refusal thrown by a later original principal producer', async () => {
  const h = await hostFixture(),
    control = h.grant(['browser.control']),
    view = h.grant(['browser.view']);
  let captured: { value: unknown } | undefined;
  try {
    await h.host.readForActor(h.f.ownerAuth, h.request(control), new AbortController().signal);
  } catch (value) {
    captured = { value };
  }
  expect(captured?.value).toBeInstanceOf(BrowserApiRefusal);
  if (!captured) throw new Error('EXPECTED_LOCAL_REFUSAL_MISSING');
  const exact = captured.value;
  h.accept(exact);
  await expect(
    h.host.readForActor(
      {
        current: h.f.ownerAuth.current,
        refresh: async () => {
          throw exact;
        },
      },
      h.request(view),
      new AbortController().signal
    )
  ).rejects.toBe(exact);
  expect(h.read).not.toHaveBeenCalled();
  await expect(h.host.close()).rejects.toBe(exact);
});

it('strict semantic controller admission preserves an original actor callback throwing undefined', async () => {
  const h = await hostFixture(),
    actor = h.f.ownerAuth.current();
  if (!actor) throw new Error('REAL_OWNER_MISSING');
  const observed: unknown[] = [];
  let calls = 0,
    rejected: { value: unknown } | undefined;
  try {
    h.f.controller.authorization(
      () => {
        if (++calls === 1) return actor;
        throw undefined;
      },
      h.f.seat.binding,
      h.f.seat.controllerId!,
      undefined,
      {
        propagateFailures: true,
        onOriginalDenial: (value) => {
          observed.push(value);
        },
      }
    );
  } catch (value) {
    rejected = { value };
  }
  expect(rejected).toEqual({ value: undefined });
  expect(calls).toBe(2);
  expect(observed).toEqual([]);
});
it('a fresh same-class producer exception cannot imitate a locally issued strict controller refusal', async () => {
  const h = await hostFixture(),
    actor = h.f.ownerAuth.current();
  if (!actor) throw new Error('REAL_OWNER_MISSING');
  const forged = new BrowserApiRefusal('inaccessible'),
    observed: unknown[] = [];
  let calls = 0,
    rejected: { value: unknown } | undefined;
  try {
    h.f.controller.authorization(
      () => {
        if (++calls === 1) return actor;
        throw forged;
      },
      h.f.seat.binding,
      h.f.seat.controllerId!,
      undefined,
      {
        propagateFailures: true,
        onOriginalDenial: (value) => {
          observed.push(value);
        },
      }
    );
  } catch (value) {
    rejected = { value };
  }
  expect(rejected?.value).toBe(forged);
  expect(calls).toBe(2);
  expect(observed).toEqual([]);
});

it('requires the exact genuinely acquired controller and current view/control grant before semantic action entry', async () => {
  const h = await hostFixture(),
    grant = h.grant(['browser.view', 'browser.control']);
  const controlGrant = h.f.grants.controllerGrant(
    h.f.ownerAuth.current,
    grant.grantId,
    grant.grantRevision,
    h.f.seat.binding
  );
  const bank: { takeover?: ReturnType<typeof h.f.controller.takeover> } = {};
  onTestFinished(async () => {
    if (bank.takeover) await bank.takeover;
  });
  const seat = await (bank.takeover = h.f.controller.takeover(
    h.f.ownerAuth.current,
    h.f.seat.binding,
    controlGrant
  ));
  const value = {
    binding: seat.binding,
    grant: { grantId: grant.grantId, revision: grant.grantRevision },
    controllerId: seat.controllerId,
    request: {
      requestId: 'semantic_action_fixture_001',
      identity: {
        version: 1,
        ...seat.binding,
        treeId: 'semantic_tree_fixture_0001',
        treeRevision: 1,
        grantRevision: grant.grantRevision,
        semanticLeaseId: 'semantic_lease_fixture_001',
      },
      frameId: 'semantic_frame_fixture_001',
      frameNavigationGeneration: 0,
      nodeRef: 'semantic_node_fixture_0001',
      focusRevision: 1,
      action: { kind: 'focus' },
    },
  };
  h.action.mockImplementation(async (requestValue, authority) => {
    const request = SemanticActionV1Schema.parse(requestValue);
    await authority.refresh();
    expect(authority.input.isCurrent()).toBe(true);
    const { semanticLeaseId: _lease, ...identity } = request.identity;
    return SemanticReceiptV1Schema.parse({
      version: 1,
      requestId: request.requestId,
      identity,
      outcome: 'completed',
    });
  });
  expect(
    await h.host.actionForActor(h.f.ownerAuth, value, new AbortController().signal)
  ).toMatchObject({ outcome: 'completed' });
  expect(h.action).toHaveBeenCalledTimes(1);
  h.f.grants.revoke(h.f.ownerAuth.current, grant.grantId, grant.grantRevision);
  await expect(
    h.host.actionForActor(h.f.ownerAuth, value, new AbortController().signal)
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(h.action).toHaveBeenCalledTimes(1);
});

it('recognizes an engine denial only in its issuing operation, not a later producer replay', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    denied = new Error('SEMANTIC_LEASE_REFUSED');
  h.read.mockImplementationOnce(async (_binding, authority) => {
    authority.onOriginalDenial(denied);
    throw denied;
  });
  await expect(
    h.host.readForActor(h.f.ownerAuth, h.request(view), new AbortController().signal)
  ).rejects.toBe(denied);
  h.read.mockImplementationOnce(async () => {
    throw denied;
  });
  h.accept(denied);
  await expect(
    h.host.readForActor(h.f.ownerAuth, h.request(view), new AbortController().signal)
  ).rejects.toBe(denied);
  expect(h.read).toHaveBeenCalledTimes(2);
  await expect(h.host.close()).rejects.toBe(denied);
});

it('private actor reports only this call original grant refusal and keeps an earlier refusal replay sticky', async () => {
  const h = await hostFixture();
  const denied = h.grant(['browser.control']);
  const reports: unknown[] = [];
  const actor = {
    ...h.f.ownerAuth,
    onOriginalDenial: (value: unknown) => {
      reports.push(value);
    },
  };
  const first = await h.host
    .readForActor(actor, h.request(denied), new AbortController().signal)
    .then(
      () => {
        throw new Error('Expected exact grant refusal');
      },
      (value) => value
    );
  expect(reports).toEqual([first]);
  expect(h.read).not.toHaveBeenCalled();
  reports.length = 0;
  const replay = {
    ...actor,
    refresh: async () => {
      throw first;
    },
  };
  h.accept(first);
  await expect(
    h.host.readForActor(replay, h.request(h.grant(['browser.view'])), new AbortController().signal)
  ).rejects.toBe(first);
  expect(reports).toEqual([]);
  await expect(h.host.close()).rejects.toBe(first);
});

it('a private denial observer undefined failure is retained independently without replacing its actual refusal', async () => {
  const h = await hostFixture();
  h.accept(undefined);
  const reports: unknown[] = [];
  const actor = {
    ...h.f.ownerAuth,
    onOriginalDenial: (value: unknown) => {
      reports.push(value);
      throw undefined;
    },
  };
  const refusal = await h.host
    .readForActor(actor, h.request(h.grant(['browser.control'])), new AbortController().signal)
    .then(
      () => {
        throw new Error('Expected exact grant refusal');
      },
      (value) => value
    );
  expect(refusal).toBeInstanceOf(BrowserApiRefusal);
  expect(reports).toEqual([refusal]);
  expect(h.read).not.toHaveBeenCalled();
  await expect(h.host.close()).rejects.toBeUndefined();
});

// Genuine owner admission uses the real account/AuthorRegistry tuple, never a fabricated recipient grant.
it('owner HTTP read needs no recipient grant while recipient HTTP read still refuses missing grants', async () => {
  const h = await hostFixture();
  const value = { binding: h.f.seat.binding };
  const delivered = await h.host.wire(
    'read',
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    value,
    new AbortController().signal,
    true
  );
  let body: string | undefined;
  delivered.publish((wire, check) => {
    check();
    body = wire;
  });
  expect(SemanticSnapshotV1Schema.parse(JSON.parse(body!)).browserId).toBe(value.binding.browserId);
  expect(h.read).toHaveBeenCalledTimes(1);
  await expect(
    h.host.wire(
      'read',
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      value,
      new AbortController().signal
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  await expect(
    h.host.wire(
      'read',
      h.f.recipientRequest.req,
      h.f.recipientRequest.res,
      value,
      new AbortController().signal,
      true
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(h.read).toHaveBeenCalledTimes(1);
});

it('a published owner stream retains its own lifetime after the original HTTP response ends', async () => {
  const h = await hostFixture();
  const request = new AbortController();
  const delivered = await h.host.wire(
    'stream',
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    { binding: h.f.seat.binding, leaseId: 'semantic_lease_fixture_001' },
    request.signal,
    true
  );
  let streamId: string | undefined;
  delivered.publish((body, check) => {
    check();
    streamId = JSON.parse(body).eventStreamId;
  });
  request.abort();
  const next = await h.host.wire(
    'next',
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    {
      binding: h.f.seat.binding,
      streamId,
      leaseId: 'semantic_lease_fixture_001',
    },
    new AbortController().signal,
    true
  );
  let result: string | undefined;
  next.publish((body, check) => {
    check();
    result = body;
  });
  expect(result).toBe('null');
  expect(h.openStream).toHaveBeenCalledTimes(1);
});

it('a stream born after request cancellation independently joins its original close', async () => {
  const h = await hostFixture(),
    hold = h.hold();
  const closed = vi.fn(async () => {});
  h.openStream.mockImplementationOnce(async () => {
    await hold.held;
    return {
      eventStreamId: 'stream_late_fixture_001',
      next: async () => null,
      close: closed,
    };
  });
  const request = new AbortController();
  const bank: { original?: Promise<unknown> } = {};
  onTestFinished(async () => {
    hold.release();
    if (bank.original) await Promise.allSettled([bank.original]);
  });
  bank.original = h.host.wire(
    'stream',
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    { binding: h.f.seat.binding, leaseId: 'semantic_lease_fixture_001' },
    request.signal,
    true
  );
  void bank.original.catch(() => {});
  await vi.waitFor(() => expect(h.openStream).toHaveBeenCalledTimes(1));
  request.abort();
  hold.release();
  const reason = await bank.original.then(
    () => {
      throw new Error('Expected cancelled original stream birth');
    },
    (value) => value
  );
  h.accept(reason);
  expect(closed).toHaveBeenCalledTimes(1);
});

it('owner secret permission is separately issued from explicit intent and the fresh original controller authority', async () => {
  const h = await hostFixture();
  const input = h.f.controller.authorization(
    h.f.ownerAuth.current,
    h.f.seat.binding,
    h.f.seat.controllerId!,
    undefined,
    { propagateFailures: true, onOriginalDenial: () => {} }
  );
  const viewOnly = h.f.grants.ownerSemantic(
    h.f.ownerAuth.current,
    h.f.seat.binding,
    undefined,
    false
  );
  expect(viewOnly.current()).toBe(true);
  expect(() => viewOnly.secretCurrent()).toThrow(BrowserApiRefusal);
  const noIntent = h.f.grants.ownerSemantic(h.f.ownerAuth.current, h.f.seat.binding, input, false);
  expect(() => noIntent.secretCurrent()).toThrow(BrowserApiRefusal);
  const permitted = h.f.grants.ownerSemantic(h.f.ownerAuth.current, h.f.seat.binding, input, true);
  expect(permitted.secretCurrent()).toBe(true);
  expect(() =>
    h.f.grants.ownerSemantic(
      h.f.ownerAuth.current,
      { ...h.f.seat.binding, epoch: h.f.seat.binding.epoch + 1 },
      input,
      true
    )
  ).toThrow(BrowserApiRefusal);
});

it('wire publication classifies only its own final grant refusal, not a fresh typed producer lookalike', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']);
  const delivery = await h.host.wire(
    'read',
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.request(view),
    new AbortController().signal
  );
  h.f.grants.revoke(h.f.ownerAuth.current, view.grantId, view.grantRevision);
  const bank: { refusal?: Readonly<{ value: unknown }> } = {};
  try {
    delivery.publish((_body, check) => {
      check();
    });
  } catch (value) {
    bank.refusal = { value };
  }
  expect(bank.refusal).toBeDefined();
  expect(delivery.isOriginalRefusal(bank.refusal!.value)).toBe(true);
  expect(delivery.isOriginalRefusal(new BrowserApiRefusal('inaccessible'))).toBe(false);
  expect(delivery.isOriginalRefusal(undefined)).toBe(false);
});

it('publishes owner semantic snapshots over actual Express/Node responses with original cookie auth', async () => {
  const bank: { routes?: BrowserSemanticRoutes; request?: Promise<unknown> } = {};
  onTestFinished(async () => {
    if (bank.request) await Promise.allSettled([bank.request]);
    if (bank.routes) await bank.routes.close();
  });
  const h = await hostFixture();
  const routes = (bank.routes = new BrowserSemanticRoutes(h.host));
  const app = express();
  app.use(express.json());
  app.use(sessionGate);
  app.use('/api/browser', routes.router);
  target.mount(app);
  const original = request(target.server)
    .post('/api/browser/semantic/owner/read')
    .set('Cookie', h.f.cookieOwner)
    .set('Origin', h.f.origin)
    .set('Host', h.f.host)
    .send({ binding: h.f.seat.binding });
  const entered = original.then((value) => value);
  bank.request = entered;
  const response = await entered;
  // The original Node response descriptor fence is exercised, not a hand-built Response double.
  expect(response.status).toBe(200);
  expect(SemanticSnapshotV1Schema.parse(response.body).browserId).toBe(h.f.seat.binding.browserId);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(h.read).toHaveBeenCalledOnce();
});

it('an original denial-observer undefined fault fences a subsequent valid actor read before its native producer', async () => {
  const h = await hostFixture();
  h.accept(undefined);
  const actor = {
    ...h.f.ownerAuth,
    onOriginalDenial: () => {
      throw undefined;
    },
  };
  await expect(
    h.host.readForActor(
      actor,
      h.request(h.grant(['browser.control'])),
      new AbortController().signal
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  const refresh = vi.fn(h.f.ownerAuth.refresh.bind(h.f.ownerAuth));
  await expect(
    h.host.readForActor(
      { ...h.f.ownerAuth, refresh },
      h.request(h.grant(['browser.view'])),
      new AbortController().signal
    )
  ).rejects.toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
  expect(h.read).not.toHaveBeenCalled();
  await expect(h.host.close()).rejects.toBeUndefined();
});

it('an actual Node response publication undefined fault fences later authenticated HTTP native reads', async () => {
  const bank: {
    routes?: BrowserSemanticRoutes;
    original?: Promise<unknown>;
    accepted: boolean;
  } = {
    accepted: false,
  };
  onTestFinished(async () => {
    if (bank.original) await Promise.allSettled([bank.original]);
    if (bank.routes) {
      try {
        await bank.routes.close();
      } catch (value) {
        if (!bank.accepted || value !== undefined) throw value;
      }
    }
  });
  const h = await hostFixture();
  const routes = (bank.routes = new BrowserSemanticRoutes(h.host));
  const app = express();
  app.use(express.json());
  app.use(sessionGate);
  let entries = 0;
  app.use((_req, res, next) => {
    const original = res.end.bind(res);
    res.end = new Proxy(original, {
      apply(receiver, owner, args) {
        entries++;
        if (entries === 1) throw undefined;
        return Reflect.apply(receiver, owner, args);
      },
    });
    next();
  });
  app.use('/api/browser', routes.router);
  target.mount(app);
  const post = () =>
    request(target.server)
      .post('/api/browser/semantic/owner/read')
      .set('Cookie', h.f.cookieOwner)
      .set('Origin', h.f.origin)
      .set('Host', h.f.host)
      .send({ binding: h.f.seat.binding });
  const first = post().then((value) => value);
  bank.original = first;
  await Promise.allSettled([first]);
  expect(entries).toBeGreaterThan(0);
  expect(h.read).toHaveBeenCalledTimes(1);
  bank.accepted = true;
  const next = post().then((value) => value);
  bank.original = next;
  const refused = await next;
  expect(refused.status).toBe(503);
  expect(h.read).toHaveBeenCalledTimes(1);
  await expect(routes.close()).rejects.toBeUndefined();
});

it('reentrant original abort-listener registration joins host close and removes its exact listener before refusing birth', async () => {
  const h = await hostFixture(),
    source = new AbortController();
  const originals: { closing?: Promise<void>; wire?: Promise<unknown> } = {};
  const add = source.signal.addEventListener,
    remove = source.signal.removeEventListener;
  let added = 0,
    removed = 0;
  const restoreAdd = vi.spyOn(source.signal, 'addEventListener').mockImplementation(function (
    this: AbortSignal,
    ...args
  ) {
    added++;
    Reflect.apply(add, this, args);
    originals.closing = h.host.close();
    void originals.closing.catch(() => {});
  });
  const restoreRemove = vi.spyOn(source.signal, 'removeEventListener').mockImplementation(function (
    this: AbortSignal,
    ...args
  ) {
    removed++;
    Reflect.apply(remove, this, args);
  });
  onTestFinished(async () => {
    if (originals.wire) await Promise.allSettled([originals.wire]);
    if (originals.closing) await originals.closing;
    restoreAdd.mockRestore();
    restoreRemove.mockRestore();
  });
  originals.wire = h.host.wire(
    'stream',
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    { binding: h.f.seat.binding, leaseId: 'semantic_lease_fixture_001' },
    source.signal,
    true
  );
  await expect(originals.wire).rejects.toBeInstanceOf(BrowserApiRefusal);
  await originals.closing;
  expect(added).toBe(1);
  expect(removed).toBe(1);
  expect(h.openStream).not.toHaveBeenCalled();
});

it('repeated successful original stream closes prune the retained bank without duplicate cleanup', async () => {
  const h = await hostFixture();
  let births = 0,
    closed = 0;
  h.openStream.mockImplementation(async (_binding, _lease, authority) => {
    await authority.refresh();
    births++;
    return {
      eventStreamId: `stream_fixture_${String(births).padStart(8, '0')}`,
      next: async () => null,
      close: async () => {
        closed++;
      },
    };
  });
  for (let index = 0; index < 20; index++) {
    const delivery = await h.host.wire(
      'stream',
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      { binding: h.f.seat.binding, leaseId: 'semantic_lease_fixture_001' },
      new AbortController().signal,
      true
    );
    let streamId: string | undefined;
    delivery.publish((body, check) => {
      check();
      streamId = JSON.parse(body).eventStreamId;
    });
    const close = await h.host.wire(
      'close',
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      {
        binding: h.f.seat.binding,
        streamId,
        leaseId: 'semantic_lease_fixture_001',
      },
      new AbortController().signal,
      true
    );
    close.publish((_body, check) => {
      check();
    });
  }
  expect(births).toBe(20);
  expect(closed).toBe(20);
  await h.host.close();
  expect(closed).toBe(20);
});

it('a queued original actor-acquisition fault fences the next queued call before its original receiver getter', async () => {
  const h = await hostFixture();
  h.accept(undefined);
  const value = h.request(h.grant(['browser.view']));
  let acquired = 0;
  const first = h.host.readForActor(
    {
      ...h.f.ownerAuth,
      get refresh(): () => Promise<import('../controller.js').BrowserControllerActor> {
        throw undefined;
      },
    },
    value,
    new AbortController().signal
  );
  const second = h.host.readForActor(
    {
      ...h.f.ownerAuth,
      get refresh() {
        acquired++;
        return h.f.ownerAuth.refresh.bind(h.f.ownerAuth);
      },
    },
    value,
    new AbortController().signal
  );
  const returned = await Promise.allSettled([first, second]);
  expect(returned).toEqual([
    { status: 'rejected', reason: undefined },
    { status: 'rejected', reason: undefined },
  ]);
  expect(acquired).toBe(0);
  expect(h.read).not.toHaveBeenCalled();
  await expect(h.host.close()).rejects.toBeUndefined();
});

it.each(['listener', 'body'] as const)(
  'an original pre-host %s undefined fault stays owned and fences subsequent HTTP native admission',
  async (producer) => {
    const bank: {
      routes?: BrowserSemanticRoutes;
      original?: Promise<unknown>;
      accepted: boolean;
    } = { accepted: false };
    onTestFinished(async () => {
      if (bank.original) await Promise.allSettled([bank.original]);
      if (bank.routes)
        try {
          await bank.routes.close();
        } catch (value) {
          if (!bank.accepted || value !== undefined) throw value;
        }
    });
    const h = await hostFixture();
    const routes = (bank.routes = new BrowserSemanticRoutes(h.host));
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    let entered = 0;
    app.use((req, _res, next) => {
      if (producer === 'listener') {
        const original = req.on;
        req.on = new Proxy(original, {
          apply(receiver, owner, args) {
            if (args[0] === 'aborted' && entered++ === 0) throw undefined;
            return Reflect.apply(receiver, owner, args);
          },
        });
      } else {
        const body = req.body;
        Object.defineProperty(req, 'body', {
          configurable: true,
          get() {
            if (entered++ === 0) throw undefined;
            return body;
          },
        });
      }
      next();
    });
    app.use('/api/browser', routes.router);
    target.mount(app);
    const post = () =>
      request(target.server)
        .post('/api/browser/semantic/owner/read')
        .set('Cookie', h.f.cookieOwner)
        .set('Origin', h.f.origin)
        .set('Host', h.f.host)
        .send({ binding: h.f.seat.binding });
    bank.original = post().then((value) => value);
    const first = await bank.original;
    expect(first).toMatchObject({ status: 503 });
    bank.accepted = true;
    bank.original = post().then((value) => value);
    const subsequent = await bank.original;
    expect(subsequent).toMatchObject({ status: 503 });
    expect(h.read).not.toHaveBeenCalled();
    await expect(routes.close()).rejects.toBeUndefined();
  }
);

it('releases and joins the original held read in the inner pre-disposal participant before SQL teardown', async () => {
  const h = await hostFixture(),
    view = h.grant(['browser.view']),
    hold = h.hold();
  const originalRead = h.read.getMockImplementation();
  if (!originalRead) throw new Error('ORIGINAL_READ_MISSING');
  h.read.mockImplementation(async (...args) => {
    await hold.held;
    return originalRead(...args);
  });
  const original = h.host.read(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.request(view),
    new AbortController().signal
  );
  void original.catch(() => {});
  await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce());
  await h.disposeParticipant();
  await expect(original).rejects.toBeInstanceOf(BrowserApiRefusal);
  // Original identity SQL remains alive until the inner fixture completes this participant.
  expect((await h.f.ownerAuth.refresh()).owner).toBeTruthy();
});
