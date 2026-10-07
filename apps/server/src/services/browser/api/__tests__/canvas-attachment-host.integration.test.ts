import { fixture } from './input-routes.fixture.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import { peekCanvasService } from '../../../canvas/index.js';
import { getRoomService } from '../../../rooms/index.js';
import { BrowserCanvasAttachmentHost } from '../canvas-attachment-host.js';
import { createBrowserCanvasScopeAdmission } from '../canvas-scope-admission.js';
import request from '@dorkos/test-utils/supertest';
import { BrowserCanvasAttachmentRoutes } from '../canvas-attachment-routes.js';
import { BrowserApiRefusal } from '../service.js';

async function canvasFixture() {
  const scopeCallbacks: { enter?: () => void } = {};
  const presentationCloseCallbacks: { entered?: () => void } = {};
  const bank: {
    starting?: Promise<Awaited<ReturnType<typeof fixture>>>;
    host?: BrowserCanvasAttachmentHost;
    closed: boolean;
    accepted?: Readonly<{ value: unknown }>;
    finishing?: Promise<void>;
  } = { closed: false };
  const originals: Promise<unknown>[] = [],
    releases: (() => void)[] = [],
    restores: (() => void)[] = [];
  const finish = () =>
    (bank.finishing ??= Promise.resolve().then(async () => {
      bank.closed = true;
      let first: Readonly<{ value: unknown }> | undefined;
      for (const release of releases) {
        try {
          release();
        } catch (value) {
          first ??= { value };
        }
      }
      // Cleanup begins independently; every late fixture/original still belongs to this bank.
      const closing = Promise.resolve().then(async () => {
        if (bank.starting) await bank.starting;
        if (bank.host) await bank.host.close();
      });
      for (const result of await Promise.allSettled([
        ...(bank.starting ? [bank.starting] : []),
        ...originals,
        closing,
      ]))
        if (
          result.status === 'rejected' &&
          (!bank.accepted || !Object.is(result.reason, bank.accepted.value))
        )
          first ??= { value: result.reason };
      for (const restore of restores) {
        try {
          restore();
        } catch (value) {
          first ??= { value };
        }
      }
      if (first) throw first.value;
    }));
  onTestFinished(finish);
  bank.starting = fixture(undefined, finish);
  const f = await bank.starting;
  if (bank.closed) throw new Error('CANVAS_FIXTURE_CLOSED');
  const canvas = peekCanvasService();
  if (!canvas) throw new Error('CANVAS_FIXTURE_MISSING');
  const scope = createBrowserCanvasScopeAdmission(f.canvasScope.db, f.canvasScope.authors);
  const issueObservations = { issued: 0, discarded: 0 };
  const originalPresentation = f.grants.presentationOwner.bind(f.grants);
  const observePresentation = vi
    .spyOn(f.grants, 'presentationOwner')
    .mockImplementation((...args) => {
      const original = originalPresentation(...args),
        issue = original.issue.bind(original),
        discard = original.discard.bind(original),
        close = original.close.bind(original);
      return Object.freeze({
        ...original,
        close: () => {
          const closing = close();
          // Observe after the genuine presentation lifetime has synchronously fenced grants.
          presentationCloseCallbacks.entered?.();
          return closing;
        },
        issue: (...values: Parameters<typeof issue>) => {
          issueObservations.issued++;
          return issue(...values);
        },
        discard: (...values: Parameters<typeof discard>) => {
          issueObservations.discarded++;
          return discard(...values);
        },
      });
    });
  restores.push(() => observePresentation.mockRestore());
  const host = (bank.host = new BrowserCanvasAttachmentHost(
    f.registry,
    f.grants,
    canvas,
    f.engine,
    (actor, target) => {
      scopeCallbacks.enter?.();
      return scope(actor, target);
    }
  ));
  const owner = (mark: (value: unknown) => void) =>
    f.identities.capture(f.ownerRequest.req, f.ownerRequest.res, undefined, mark);
  const recipient = (mark: (value: unknown) => void) =>
    f.identities.capture(f.recipientRequest.req, f.recipientRequest.res, undefined, mark);
  const target = { kind: 'room' as const, roomId: f.canvasScope.roomId };
  return {
    f,
    host,
    canvas,
    scope,
    owner,
    recipient,
    target,
    originals,
    releases,
    restores,
    issueObservations,
    disposeParticipant: finish,
    onPresentationClose: (callback: (() => void) | undefined) => {
      presentationCloseCallbacks.entered = callback;
    },
    onScope: (callback: (() => void) | undefined) => {
      scopeCallbacks.enter = callback;
    },
    accept: (value: unknown) => {
      bank.accepted = { value };
    },
    async present() {
      const document = await host.present(owner, f.seat.binding, target);
      expect(document.content.type).toBe('managed_browser');
      if (document.content.type !== 'managed_browser') throw new Error('WRONG_CANVAS_CONTENT');
      return { document, reference: document.content };
    },
  };
}

it('records exact canonical metadata on the real room canvas without implicitly granting viewing', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  expect(x.canvas.get(shown.document.scope, shown.document.id)?.content).toEqual(shown.reference);
  expect(shown.reference.browserId).toBe(x.f.seat.binding.browserId);
  expect(x.host.ownsAttachment(shown.reference.attachmentId)).toBe(true);
  expect(x.host.ownsAttachment('unowned_reference_000001')).toBe(false);
  expect(shown.reference.browserGeneration).toBe(x.f.seat.binding.browserGeneration);
  expect(Object.keys(shown.reference).sort()).toEqual([
    'attachmentId',
    'browserGeneration',
    'browserId',
    'ownerAuthorId',
    'scope',
    'tabId',
    'type',
  ]);
  await expect(x.host.delivery(x.recipient, shown.reference.attachmentId)).rejects.toBeInstanceOf(
    BrowserApiRefusal
  );
  expect(x.host.faulted()).toBe(false);
  await expect(x.host.delivery(x.owner, shown.reference.attachmentId)).resolves.toEqual({
    owner: true,
    binding: x.f.seat.binding,
  });
});

it('requires explicit per-document recipient grants and refuses a grant from another presentation', async () => {
  const x = await canvasFixture(),
    first = await x.present();
  // Registry associations intentionally allow one active row per browser/room.
  // A second authorized room gives this document its own association and lifetime.
  const rooms = getRoomService();
  const room = rooms.createRoom(
    {
      kind: 'channel',
      title: 'Second presentation',
      members: [],
      agentPaths: [],
    },
    x.f.canvasScope.owner
  );
  rooms.addMember(room.id, x.f.canvasScope.owner, {
    authorId: x.f.canvasScope.recipient,
  });
  const second = await x.host.present(x.owner, x.f.seat.binding, {
    kind: 'room',
    roomId: room.id,
  });
  if (second.content.type !== 'managed_browser') throw new Error('WRONG_CANVAS_CONTENT');
  expect(second.content.attachmentId).not.toBe(first.reference.attachmentId);
  const grant = await x.host.share(
    x.owner,
    first.reference.attachmentId,
    x.f.canvasScope.recipient,
    ['browser.view'],
    new Date(Date.now() + 60000).toISOString()
  );
  const context = await x.host.delivery(x.recipient, first.reference.attachmentId);
  expect(context.grant).toEqual({
    grantId: grant.grantId,
    revision: grant.grantRevision,
  });
  await expect(
    x.host.delivery(x.recipient, second.content.attachmentId, context.grant)
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(x.host.faulted()).toBe(false);
});

it('removal fences grants synchronously and detaches metadata while leaving the original browser running', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  await x.host.share(
    x.owner,
    shown.reference.attachmentId,
    x.f.canvasScope.recipient,
    ['browser.view'],
    new Date(Date.now() + 60000).toISOString()
  );
  x.canvas.close(shown.document.scope, shown.document.id);
  await expect(x.host.delivery(x.recipient, shown.reference.attachmentId)).rejects.toBeInstanceOf(
    BrowserApiRefusal
  );
  await x.host.close();
  expect(
    x.f.engine.listTabs(x.f.seat.binding.browserId, x.f.seat.binding.browserGeneration)
  ).toContainEqual(x.f.seat.binding);
});

it('an explicit detach removes the real document but never stops its original browser', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  expect(x.host.ownsAttachment(shown.reference.attachmentId)).toBe(true);
  await x.host.detachPresentation(x.owner, shown.reference.attachmentId);
  expect(x.host.ownsAttachment(shown.reference.attachmentId)).toBe(false);
  expect(x.canvas.get(shown.document.scope, shown.document.id)).toBeNull();
  expect(
    x.f.engine.listTabs(x.f.seat.binding.browserId, x.f.seat.binding.browserGeneration)
  ).toHaveLength(1);
});

it('does not restore permission from replayed metadata after the private host closes', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  await x.host.close();
  expect(x.host.ownsAttachment(shown.reference.attachmentId)).toBe(false);
  const replay = new BrowserCanvasAttachmentHost(
    x.f.registry,
    x.f.grants,
    x.canvas,
    x.f.engine,
    x.scope
  );
  try {
    await expect(replay.delivery(x.owner, shown.reference.attachmentId)).rejects.toBeInstanceOf(
      BrowserApiRefusal
    );
  } finally {
    await replay.close();
  }
});

it('joins an entered original authentication before close and performs no late canvas publication', async () => {
  const x = await canvasFixture();
  const held: { release?: () => void } = {};
  const waiting = new Promise<void>((resolve) => {
    held.release = resolve;
  });
  const release = () => {
    const original = held.release;
    held.release = undefined;
    original?.();
  };
  x.releases.push(release);
  let entered = false;
  const original = x.host.present(
    (mark) => {
      const captured = x.owner(mark),
        refresh = captured.refresh.bind(captured);
      return {
        current: captured.current.bind(captured),
        refresh: async () => {
          entered = true;
          await waiting;
          return refresh();
        },
      };
    },
    x.f.seat.binding,
    x.target
  );
  void original.catch(() => {});
  x.originals.push(original);
  await vi.waitFor(() => expect(entered).toBe(true));
  let closed = false;
  const closing = x.host.close();
  void closing.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    }
  );
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await expect(original).rejects.toBeInstanceOf(BrowserApiRefusal);
  try {
    await original;
  } catch (value) {
    x.accept(value);
  }
  await expect(closing).resolves.toBeUndefined();
});

it('preserves an original authentication throw of undefined and fences subsequent acquisitions', async () => {
  const x = await canvasFixture(),
    next = vi.fn(x.owner);
  x.accept(undefined);
  await expect(
    x.host.present(
      () => {
        throw undefined;
      },
      x.f.seat.binding,
      x.target
    )
  ).rejects.toBeUndefined();
  let caught: unknown = Symbol('not thrown');
  try {
    x.host.present(next, x.f.seat.binding, x.target);
  } catch (value) {
    caught = value;
  }
  expect(caught).toBeUndefined();
  expect(next).not.toHaveBeenCalled();
  await expect(x.host.close()).rejects.toBeUndefined();
});

it.each([1, 2, 3])(
  'refuses publication when original actor read %s reenters presentation closure',
  async (closingRead) => {
    const x = await canvasFixture();
    const originalActor = await x.f.ownerAuth.refresh();
    const lifetime = x.f.grants.presentationOwner();
    const bank: { closing?: Promise<void> } = {};
    onTestFinished(async () => {
      bank.closing ??= lifetime.close();
      await bank.closing;
    });
    let reads = 0;
    const read = vi.fn(() => {
      if (++reads === closingRead) bank.closing = lifetime.close();
      return originalActor;
    });
    expect(() =>
      lifetime.issue(
        read,
        x.f.seat.binding,
        x.f.canvasScope.recipient,
        x.target,
        ['browser.view'],
        new Date(Date.now() + 60000).toISOString()
      )
    ).toThrow(BrowserApiRefusal);
    expect(read).toHaveBeenCalledTimes(closingRead);
    expect(lifetime.recipientView(x.f.canvasScope.recipient)).toBeUndefined();
    await expect(bank.closing).resolves.toBeUndefined();
  }
);

it('document replacement cannot keep an already issued viewer grant live', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  const grant = await x.host.share(
    x.owner,
    shown.reference.attachmentId,
    x.f.canvasScope.recipient,
    ['browser.view'],
    new Date(Date.now() + 60000).toISOString()
  );
  const original = await x.f.identities
    .capture(x.f.recipientRequest.req, x.f.recipientRequest.res)
    .refresh();
  x.canvas.update(shown.document.scope, x.f.canvasScope.owner, shown.document.id, {
    type: 'markdown',
    content: 'Replacement',
  });
  expect(() =>
    x.f.grants.admit(
      () => original,
      grant.grantId,
      grant.grantRevision,
      x.f.seat.binding,
      'browser.view'
    )
  ).toThrow(BrowserApiRefusal);
  expect(x.host.faulted()).toBe(false);
});

it('allows the genuine held input to complete while document retirement still awaits owner authentication', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  const grant = await x.host.share(
    x.owner,
    shown.reference.attachmentId,
    x.f.canvasScope.recipient,
    ['browser.view', 'browser.control'],
    new Date(Date.now() + 60000).toISOString()
  );
  const reference = { grantId: grant.grantId, revision: grant.grantRevision };
  const seat = await x.f.control
    .capture(x.f.recipientRequest.req, x.f.recipientRequest.res)
    .takeover(x.f.seat.binding, reference);
  let inputEntered!: () => void, releaseInput!: () => void;
  const started = new Promise<void>((resolve) => {
    inputEntered = resolve;
  });
  const inputHeld = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  x.releases.push(() => releaseInput());
  x.f.page.raw.mouse.move.mockImplementationOnce(async () => {
    inputEntered();
    await inputHeld;
  });
  const input = x.f.input
    .capture(x.f.recipientRequest.req, x.f.recipientRequest.res)
    .input({ ...x.f.command(), binding: seat.binding }, seat.controllerId!, reference);
  x.originals.push(input);
  void input.catch(() => {});
  await started;
  let authEntered!: () => void, releaseAuth!: () => void;
  const authenticated = new Promise<void>((resolve) => {
    authEntered = resolve;
  });
  const authHeld = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  x.releases.push(() => releaseAuth());
  // Preserve the actual captured admission and actor; hold only its genuine refresh return.
  const delayedOwner: Parameters<BrowserCanvasAttachmentHost['detachPresentation']>[0] = (mark) => {
    const original = x.owner(mark),
      refresh = original.refresh.bind(original);
    return Object.freeze({
      ...original,
      refresh: async () => {
        const actor = await refresh();
        authEntered();
        await authHeld;
        return actor;
      },
    });
  };
  let retirementEntries = 0;
  x.onPresentationClose(() => {
    retirementEntries++;
  });
  const closing = x.host.detachPresentation(delayedOwner, shown.reference.attachmentId);
  x.originals.push(closing);
  void closing.catch(() => {});
  await authenticated;
  expect(retirementEntries).toBe(0);
  releaseInput();
  expect((await input).outcome).toBe('completed');
  expect(retirementEntries).toBe(0);
  expect(x.canvas.get(shown.document.scope, shown.document.id)).not.toBeNull();
  releaseAuth();
  await closing;
  expect(retirementEntries).toBe(1);
  expect(x.canvas.get(shown.document.scope, shown.document.id)).toBeNull();
});

it('joins a healthy original controller reset before document closure completes', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  const grant = await x.host.share(
    x.owner,
    shown.reference.attachmentId,
    x.f.canvasScope.recipient,
    ['browser.view', 'browser.control'],
    new Date(Date.now() + 60000).toISOString()
  );
  const reference = { grantId: grant.grantId, revision: grant.grantRevision };
  const seat = await x.f.control
    .capture(x.f.recipientRequest.req, x.f.recipientRequest.res)
    .takeover(x.f.seat.binding, reference);
  const pressed = await x.f.input.capture(x.f.recipientRequest.req, x.f.recipientRequest.res).input(
    {
      ...x.f.command([{ kind: 'mouseDown', button: 'left' }]),
      binding: seat.binding,
    },
    seat.controllerId!,
    reference
  );
  expect(pressed.outcome).toBe('completed');
  const moved = await x.f.input
    .capture(x.f.recipientRequest.req, x.f.recipientRequest.res)
    .input({ ...x.f.command(), binding: seat.binding }, seat.controllerId!, reference);
  expect(moved.outcome).toBe('completed');
  expect(x.f.page.raw.mouse.move).toHaveBeenCalledOnce();
  let resetEntered!: () => void, releaseReset!: () => void;
  const resetStarted = new Promise<void>((resolve) => {
    resetEntered = resolve;
  });
  const resetHeld = new Promise<void>((resolve) => {
    releaseReset = resolve;
  });
  x.releases.push(() => releaseReset());
  x.f.page.session.send.mockImplementationOnce(async () => {
    resetEntered();
    await resetHeld;
  });
  let retired!: () => void;
  const retirementEntered = new Promise<void>((resolve) => {
    retired = resolve;
  });
  x.onPresentationClose(retired);
  const closing = x.host.detachPresentation(x.owner, shown.reference.attachmentId);
  x.originals.push(closing);
  let closed = false;
  void closing.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    }
  );
  await retirementEntered;
  expect(closed).toBe(false);
  await resetStarted;
  expect(closed).toBe(false);
  releaseReset();
  await closing;
  expect(x.f.page.raw.mouse.up).toHaveBeenCalledOnce();
  expect(x.canvas.get(shown.document.scope, shown.document.id)).toBeNull();
  expect(
    x.f.engine.listTabs(x.f.seat.binding.browserId, x.f.seat.binding.browserGeneration)
  ).toHaveLength(1);
});

it('refuses a held old-generation native ACK during document retirement without claiming healthy cleanup', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  const grant = await x.host.share(
    x.owner,
    shown.reference.attachmentId,
    x.f.canvasScope.recipient,
    ['browser.view', 'browser.control'],
    new Date(Date.now() + 60000).toISOString()
  );
  const reference = { grantId: grant.grantId, revision: grant.grantRevision };
  const seat = await x.f.control
    .capture(x.f.recipientRequest.req, x.f.recipientRequest.res)
    .takeover(x.f.seat.binding, reference);
  const pressed = await x.f.input.capture(x.f.recipientRequest.req, x.f.recipientRequest.res).input(
    {
      ...x.f.command([{ kind: 'mouseDown', button: 'left' }]),
      binding: seat.binding,
    },
    seat.controllerId!,
    reference
  );
  expect(pressed.outcome).toBe('completed');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held: { release?: () => void } = {};
  const waiting = new Promise<void>((resolve) => {
    held.release = resolve;
  });
  const release = () => {
    const original = held.release;
    held.release = undefined;
    original?.();
  };
  x.releases.push(release);
  x.f.page.raw.mouse.move.mockImplementationOnce(async () => {
    entered();
    await waiting;
  });
  const input = x.f.input
    .capture(x.f.recipientRequest.req, x.f.recipientRequest.res)
    .input({ ...x.f.command(), binding: seat.binding }, seat.controllerId!, reference);
  x.originals.push(input);
  void input.catch(() => {});
  await started;
  expect(x.f.page.raw.mouse.move).toHaveBeenCalledOnce();
  let retired!: () => void;
  const retirementEntered = new Promise<void>((resolve) => {
    retired = resolve;
  });
  x.onPresentationClose(retired);
  let resetEntered!: () => void;
  const originalResetStarted = new Promise<void>((resolve) => {
    resetEntered = resolve;
  });
  x.f.onOriginalReset(resetEntered);
  const closing = x.host.detachPresentation(x.owner, shown.reference.attachmentId);
  x.originals.push(closing);
  const originalFailure = closing.then(
    () => {
      throw new Error('EXPECTED_ORIGINAL_RESET_REFUSAL');
    },
    (value: unknown) => {
      // Accept only this exact body-owned rejection in the independent cleanup banks.
      x.accept(value);
      x.f.acceptFailure(value);
      return Object.freeze({ value });
    }
  );
  x.originals.push(originalFailure);
  void originalFailure.catch(() => {});
  let closed = false;
  void closing.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    }
  );
  await retirementEntered;
  expect(closed).toBe(false);
  // Cancellation settles the action, but the original native dispatch remains held.
  const result = await input;
  await originalResetStarted;
  expect(result.outcome).toBe('uncertain');
  expect(result.binding).toEqual(seat.binding);
  expect(x.f.engine.listTabs(seat.binding.browserId, seat.binding.browserGeneration)).toEqual([
    {
      ...seat.binding,
      epoch: seat.binding.epoch + 1,
      inputGeneration: seat.binding.inputGeneration + 1,
    },
  ]);
  expect(closed).toBe(false);
  release();
  const refused = await originalFailure;
  expect(refused.value).toBeInstanceOf(BrowserApiRefusal);
  expect(refused.value).toMatchObject({ reason: 'inaccessible' });
  await expect(closing).rejects.toBe(refused.value);
  expect(x.canvas.get(shown.document.scope, shown.document.id)).toBeNull();
  // The failed grant Seat is no longer an identity-reset candidate. Join the genuine
  // identity bank here; this does not qualify the already stopped native engine.
  await x.f.identities.close();
  x.f.expectRetiredControllerInputCleanup();
});

async function canvasRoutesFixture() {
  const x = await canvasFixture();
  const bank: {
    routes?: BrowserCanvasAttachmentRoutes;
    accepted?: Readonly<{ value: unknown }>;
    fault?: () => void;
  } = {};
  onTestFinished(async () => {
    if (!bank.routes) return;
    try {
      await bank.routes.close();
    } catch (value) {
      if (!bank.accepted || !Object.is(value, bank.accepted.value)) throw value;
    }
  });
  x.f.canvasHttp.app.use('/api/private-browser-canvas', (req, _res, next) => {
    const original = bank.fault;
    bank.fault = undefined;
    if (original) Object.defineProperty(req, 'body', { get: original, configurable: true });
    next();
  });
  bank.routes = new BrowserCanvasAttachmentRoutes(x.host, x.f.identities, () => true);
  x.f.canvasHttp.app.use('/api/private-browser-canvas', bank.routes.router);
  const send = (
    kind: string,
    body: unknown,
    cookie = x.f.cookieOwner,
    origin: string | null = x.f.origin
  ) => {
    let original = request(x.f.canvasHttp.server)
      .post('/api/private-browser-canvas/canvas/' + kind)
      .set('Host', x.f.host)
      .set('Cookie', cookie);
    if (origin !== null) original = original.set('Origin', origin);
    return original.send(body as Parameters<typeof original.send>[0]);
  };
  return { ...x, bank, send };
}

it('consumes real authenticated HTTP and room authority before returning a canvas reference', async () => {
  const x = await canvasRoutesFixture();
  const presented = await x.send('present', {
    binding: x.f.seat.binding,
    target: x.target,
  });
  expect(presented.status).toBe(200);
  const attachmentId = presented.body.content.attachmentId as string;
  const denied = await x.send('delivery', { attachmentId }, x.f.cookieViewer);
  expect(denied.status).toBe(403);
  const shared = await x.send('share', {
    attachmentId,
    recipient: x.f.canvasScope.recipient,
    permissions: ['browser.view'],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  expect(shared.status).toBe(200);
  const delivered = await x.send('delivery', { attachmentId }, x.f.cookieViewer);
  expect(delivered.status).toBe(200);
  expect(delivered.body.owner).toBe(false);
  expect(delivered.body.grant.grantId).toBe(shared.body.grantId);
  expect((await x.send('detach', { attachmentId })).status).toBe(200);
  expect((await x.send('delivery', { attachmentId }, x.f.cookieViewer)).status).toBe(403);
  expect(
    x.f.engine.listTabs(x.f.seat.binding.browserId, x.f.seat.binding.browserGeneration)
  ).toHaveLength(1);
});

it('missing or foreign original HTTP origin cannot create a canvas association', async () => {
  const x = await canvasRoutesFixture();
  const body = { binding: x.f.seat.binding, target: x.target };
  expect((await x.send('present', body, x.f.cookieOwner, null)).status).toBe(403);
  expect((await x.send('present', body, x.f.cookieOwner, 'https://foreign.invalid')).status).toBe(
    403
  );
  expect((await x.send('present', body)).status).toBe(200);
  await expect(x.bank.routes!.close()).resolves.toBeUndefined();
});

it('owns original HTTP body undefined before delegation and fences the next producer', async () => {
  const x = await canvasRoutesFixture();
  x.bank.accepted = { value: undefined };
  x.bank.fault = () => {
    throw undefined;
  };
  const scope = 'room:' + x.f.canvasScope.roomId;
  const before = x.canvas.list(scope).map((document) => document.id);
  const body = { binding: x.f.seat.binding, target: x.target };
  expect((await x.send('present', body)).status).toBe(503);
  expect((await x.send('present', body)).status).toBe(503);
  expect(x.canvas.list(scope).map((document) => document.id)).toEqual(before);
  await expect(x.bank.routes!.close()).rejects.toBeUndefined();
  expect(x.host.faulted()).toBe(false);
});

it('rechecks the original credential after an original scope callback before issuing a grant', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  const state = { current: true };
  const acquire = (mark: (value: unknown) => void) => {
    const original = x.owner(mark),
      refresh = original.refresh.bind(original),
      current = original.current.bind(original);
    return { refresh, current: () => (state.current ? current() : undefined) };
  };
  x.onScope(() => {
    state.current = false;
  });
  await expect(
    x.host.share(
      acquire,
      shown.reference.attachmentId,
      x.f.canvasScope.recipient,
      ['browser.view'],
      new Date(Date.now() + 60000).toISOString()
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(x.issueObservations.issued).toBe(0);
  x.onScope(undefined);
  await expect(x.host.delivery(x.recipient, shown.reference.attachmentId)).rejects.toBeInstanceOf(
    BrowserApiRefusal
  );
  expect(x.host.faulted()).toBe(false);
});

it('runs the pre-disposal participant release and original held work before inner DB disposal', async () => {
  const x = await canvasFixture();
  const hold: { release?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    hold.release = resolve;
  });
  x.releases.push(() => {
    const original = hold.release;
    hold.release = undefined;
    original?.();
  });
  let joined = false;
  x.originals.push(
    held.then(() => {
      joined = true;
    })
  );
  await x.disposeParticipant();
  expect(joined).toBe(true);
  // The inner fixture consumes this same idempotent participant before closing SQLite.
  expect(x.f.canvasScope.db.$client.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
});

it('independently discards the exact new grant when final original scope observation revokes credentials', async () => {
  const x = await canvasFixture(),
    shown = await x.present();
  const state = { current: true, observations: 0 };
  const acquire = (mark: (value: unknown) => void) => {
    const original = x.owner(mark),
      refresh = original.refresh.bind(original),
      current = original.current.bind(original);
    return { refresh, current: () => (state.current ? current() : undefined) };
  };
  x.onScope(() => {
    if (++state.observations === 2) state.current = false;
  });
  await expect(
    x.host.share(
      acquire,
      shown.reference.attachmentId,
      x.f.canvasScope.recipient,
      ['browser.view'],
      new Date(Date.now() + 60000).toISOString()
    )
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(state.observations).toBe(2);
  expect(x.issueObservations.issued).toBe(1);
  expect(x.issueObservations.discarded).toBe(1);
  x.onScope(undefined);
  await expect(x.host.delivery(x.recipient, shown.reference.attachmentId)).rejects.toBeInstanceOf(
    BrowserApiRefusal
  );
  expect(x.host.faulted()).toBe(false);
});
