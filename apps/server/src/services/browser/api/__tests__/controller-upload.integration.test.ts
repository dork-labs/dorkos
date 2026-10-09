import type { OwnedUploadLease, OwnedInputAuthorization } from '@dorkos/browser/server-owner';
import { fixture } from './input-routes.fixture.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserControllerUpload } from '../controller-upload.js';
import { BrowserUploadArtifacts } from '../files/upload-artifacts.js';
import { getAuth } from '../../../core/auth/index.js';

async function uploadFixture() {
  const originals: {
    upload?: BrowserControllerUpload;
    bank?: BrowserUploadArtifacts;
    home?: string;
    accepted?: Readonly<{ value: unknown }>;
  } = {};
  let closed = false;
  const acquiring = Promise.resolve().then(() => mkdtemp(join(tmpdir(), 'browser-upload-host-')));
  const setup = Promise.resolve().then(async () => {
    const rawHome = await acquiring;
    originals.home = rawHome;
    if (closed) throw new Error('UPLOAD_TEST_CLOSED');
    const home = await realpath(rawHome);
    if (closed) throw new Error('UPLOAD_TEST_CLOSED');
    const root = join(home, 'stage'),
      protectedRoot = join(home, 'profile');
    await Promise.all([mkdir(root, { mode: 0o700 }), mkdir(protectedRoot, { mode: 0o700 })]);
    if (closed) throw new Error('UPLOAD_TEST_CLOSED');
    return { root, protectedRoot };
  });
  onTestFinished(async () => {
    closed = true;
    await setup.catch(() => undefined);
    let failure: Readonly<{ value: unknown }> | undefined;
    try {
      await originals.upload?.close();
    } catch (value) {
      failure = { value };
    }
    try {
      await originals.bank?.close();
    } catch (value) {
      failure ??= { value };
    }
    if (failure) {
      if (!originals.accepted || failure.value !== originals.accepted.value) throw failure.value;
      return;
    }
    if (originals.home) await rm(originals.home, { recursive: true, force: false });
  });
  const { root, protectedRoot } = await setup;
  if (closed) throw new Error('UPLOAD_TEST_CLOSED');
  const f = await fixture();
  if (closed) throw new Error('UPLOAD_TEST_CLOSED');
  const bank = new BrowserUploadArtifacts(root, [protectedRoot]);
  originals.bank = bank;
  const upload = new BrowserControllerUpload(bank, f.identities, f.grants, () => true);
  originals.upload = upload;
  upload.bindHost(f.control);
  const dispatch = vi.fn(
    async (
      value: unknown,
      _authority: OwnedInputAuthorization,
      lease: OwnedUploadLease,
      signal?: AbortSignal
    ) => {
      const payload = await lease.consume(signal ?? new AbortController().signal);
      await lease.enter(async () => {
        expect((await readFile(payload.path)).toString()).toBe('upload content');
      });
      // Native upload dispatcher is a named test double; real original input here does not prove setFileInputFiles.
      const controllerId = f.seat.controllerId;
      if (!controllerId) throw new Error('REAL_CONTROLLER_MISSING');
      return f.input.capture(f.ownerRequest.req, f.ownerRequest.res).input(
        {
          kind: 'input',
          requestId: 'request_upload_host_fixture_01',
          binding: f.seat.binding,
          steps: [{ kind: 'mouseMove', x: 32, y: 36 }],
        },
        controllerId,
        undefined,
        signal
      );
    }
  );
  upload.owner.registerDispatcher({ upload: dispatch });
  const selfGrant = (permissions: Parameters<typeof f.grants.issue>[4]) => {
    const actor = f.ownerAuth.current();
    if (!actor) throw new Error('REAL_OWNER_MISSING');
    const attachment = f.issueGrant(['browser.view']).attachment;
    return f.grants.issue(
      f.ownerAuth.current,
      f.seat.binding,
      actor.owner,
      attachment,
      permissions,
      new Date(Date.now() + 60000).toISOString()
    );
  };
  const reference = (grant: ReturnType<typeof selfGrant>) => ({
    grantId: grant.grantId,
    revision: grant.grantRevision,
  });
  return {
    f,
    upload,
    bank,
    root,
    dispatch,
    selfGrant,
    reference,
    accept: (value: unknown) => {
      originals.accepted = { value };
    },
  };
}
// Genuine Auth/SQLite/grant/controller composition; only fixed native upload dispatcher is a test double.
it('requires independent explicit artifact and upload grants before the original private dispatch', async () => {
  const h = await uploadFixture(),
    artifact = h.selfGrant(['browser.artifact']);
  const staged = await h.upload.stage(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.f.seat.binding,
    h.reference(artifact),
    'file.txt',
    'text/plain',
    Buffer.from('upload content'),
    new AbortController().signal
  );
  const command = {
    kind: 'upload',
    requestId: 'request_upload_host_fixture_01',
    binding: h.f.seat.binding,
    artifactId: staged.artifactId,
    activation: { x: 32, y: 36 },
  };
  let reason: Readonly<{ value: unknown }> | undefined;
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  try {
    await h.upload.upload(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      command,
      controller,
      h.reference(artifact),
      h.reference(artifact)
    );
  } catch (value) {
    reason = { value };
  }
  expect(reason).toBeDefined();
  expect(h.dispatch).not.toHaveBeenCalled();
  h.accept(reason?.value);
  await expect(h.upload.close()).rejects.toBe(reason?.value);
});
it('delivers a once-owned file only with actual owner controller and both explicit grants', async () => {
  const h = await uploadFixture(),
    artifact = h.selfGrant(['browser.artifact']),
    upload = h.selfGrant(['browser.upload']);
  const staged = await h.upload.stage(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.f.seat.binding,
    h.reference(artifact),
    'file.txt',
    'text/plain',
    Buffer.from('upload content'),
    new AbortController().signal
  );
  const command = {
    kind: 'upload',
    requestId: 'request_upload_host_fixture_01',
    binding: h.f.seat.binding,
    artifactId: staged.artifactId,
    activation: { x: 32, y: 36 },
  };
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  const result = await h.upload.upload(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    command,
    controller,
    h.reference(artifact),
    h.reference(upload)
  );
  expect(result.outcome).toBe('completed');
  expect(h.dispatch).toHaveBeenCalledOnce();
});
it('does not lend another actual recipient grant artifact access to the owner', async () => {
  const h = await uploadFixture(),
    grant = h.f.issueGrant(['browser.artifact']);
  let reason: Readonly<{ value: unknown }> | undefined;
  try {
    await h.upload.stage(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      h.f.seat.binding,
      h.reference(grant),
      'file.txt',
      'text/plain',
      Buffer.from('upload content'),
      new AbortController().signal
    );
  } catch (value) {
    reason = { value };
  }
  expect(reason).toBeDefined();
  expect(h.dispatch).not.toHaveBeenCalled();
  h.accept(reason?.value);
  await expect(h.upload.close()).rejects.toBe(reason?.value);
});

it('joins exact unpublished-file discard after held final original server-store auth fails', async () => {
  const h = await uploadFixture(),
    artifact = h.selfGrant(['browser.artifact']);
  const auth = getAuth();
  if (!auth) throw new Error('REAL_AUTH_MISSING');
  const originalSession = auth.api.getSession;
  let entries = 0,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.f.releases.push(release);
  const delayed = new Proxy(originalSession, {
    apply(target, receiver, args) {
      const original = Reflect.apply(target, receiver, args);
      if (args[0]?.query?.disableCookieCache !== true) return original;
      entries++;
      if (entries !== 2) return original;
      return Promise.resolve(original).then(async () => {
        await held;
        throw undefined;
      });
    },
  });
  const observer = vi.spyOn(auth.api, 'getSession').mockImplementation(delayed);
  onTestFinished(() => observer.mockRestore());
  const original = h.upload.stage(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    h.f.seat.binding,
    h.reference(artifact),
    'file.txt',
    'text/plain',
    Buffer.from('upload content'),
    new AbortController().signal
  );
  void original.catch(() => undefined);
  await vi.waitFor(() => expect(entries).toBe(2));
  expect((await readdir(h.root)).length).toBe(1);
  release();
  await expect(original).rejects.toBeUndefined();
  expect(await readdir(h.root)).toEqual([]);
  expect(h.dispatch).not.toHaveBeenCalled();
  h.accept(undefined);
  await expect(h.upload.close()).rejects.toBeUndefined();
  await expect(h.bank.close()).resolves.toBeUndefined();
});

// Actor receiver is captured from this fixture's real authenticated owner. No request object enters the private host method.
it('stages and dispatches through the exact original actor receiver with independent grants', async () => {
  const h = await uploadFixture();
  const artifact = h.selfGrant(['browser.artifact']),
    permission = h.selfGrant(['browser.upload']);
  const refresh = h.f.ownerAuth.refresh.bind(h.f.ownerAuth),
    current = h.f.ownerAuth.current;
  const original = Object.freeze({
    refresh,
    current,
    authorization: async (
      binding: Parameters<typeof h.f.controller.authorization>[1],
      id: string
    ) =>
      h.f.controller.authorization(current, binding, id, undefined, {
        propagateFailures: true,
        onOriginalDenial: () => {},
      }),
    onOriginalDenial: (_value: unknown) => {},
  });
  const staged = await h.upload.stageForActor(
    original,
    h.f.seat.binding,
    h.reference(artifact),
    'file.txt',
    'text/plain',
    Buffer.from('upload content'),
    new AbortController().signal
  );
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  const result = await h.upload.uploadForActor(
    original,
    {
      kind: 'upload',
      requestId: 'request_upload_host_fixture_01',
      binding: h.f.seat.binding,
      artifactId: staged.artifactId,
      activation: { x: 32, y: 36 },
    },
    controller,
    h.reference(artifact),
    h.reference(permission)
  );
  expect(result.outcome).toBe('completed');
  expect(h.dispatch).toHaveBeenCalledOnce();
});
it('retains an original actor refresh undefined rather than interpreting it as denied permission', async () => {
  const h = await uploadFixture();
  const artifact = h.selfGrant(['browser.artifact']);
  const denied = vi.fn();
  const original = Object.freeze({
    refresh: async () => {
      throw undefined;
    },
    current: h.f.ownerAuth.current,
    authorization: async () => {
      throw new Error('UNENTERED_CONTROLLER');
    },
    onOriginalDenial: denied,
  });
  h.accept(undefined);
  await expect(
    h.upload.stageForActor(
      original,
      h.f.seat.binding,
      h.reference(artifact),
      'file.txt',
      'text/plain',
      Buffer.from('upload content'),
      new AbortController().signal
    )
  ).rejects.toBeUndefined();
  expect(denied).not.toHaveBeenCalled();
  expect(h.dispatch).not.toHaveBeenCalled();
  await expect(h.upload.close()).rejects.toBeUndefined();
});
it('preserves actual local grant refusal while retaining a separate original observer failure', async () => {
  const h = await uploadFixture();
  const foreign = h.f.issueGrant(['browser.artifact']);
  const observed: { reason?: unknown } = {};
  const original = Object.freeze({
    refresh: h.f.ownerAuth.refresh.bind(h.f.ownerAuth),
    current: h.f.ownerAuth.current,
    authorization: async () => {
      throw new Error('UNENTERED_CONTROLLER');
    },
    onOriginalDenial: (value: unknown) => {
      observed.reason = value;
      throw undefined;
    },
  });
  h.accept(undefined);
  const rejected = await h.upload
    .stageForActor(
      original,
      h.f.seat.binding,
      h.reference(foreign),
      'file.txt',
      'text/plain',
      Buffer.from('upload content'),
      new AbortController().signal
    )
    .then(
      () => ({ failed: false as const }),
      (reason: unknown) => ({ failed: true as const, reason })
    );
  expect(rejected.failed).toBe(true);
  if (!rejected.failed) throw new Error('EXPECTED_ORIGINAL_REFUSAL');
  expect(rejected.reason).toBe(observed.reason);
  expect(h.dispatch).not.toHaveBeenCalled();
  await expect(h.upload.close()).rejects.toBeUndefined();
});

it('refuses actual grant revocation during held original authorization before claiming a file or dispatching', async () => {
  const h = await uploadFixture();
  const artifact = h.selfGrant(['browser.artifact']),
    permission = h.selfGrant(['browser.upload']);
  const current = h.f.ownerAuth.current;
  const original = {
    refresh: h.f.ownerAuth.refresh.bind(h.f.ownerAuth),
    current,
    authorization: async (
      binding: Parameters<typeof h.f.controller.authorization>[1],
      id: string
    ) =>
      h.f.controller.authorization(current, binding, id, undefined, {
        propagateFailures: true,
        onOriginalDenial: () => {},
      }),
    onOriginalDenial: vi.fn(),
  };
  const staged = await h.upload.stageForActor(
    original,
    h.f.seat.binding,
    h.reference(artifact),
    'file.txt',
    'text/plain',
    Buffer.from('upload content'),
    new AbortController().signal
  );
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  const gate = deferredVoid(),
    entered = deferredVoid();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      gate.resolve();
    }
  };
  h.f.releases.push(release); // Original fixture drains releases before any retained host/engine teardown.
  const authorize = original.authorization;
  const held = Object.freeze({
    ...original,
    authorization: async (...args: Parameters<typeof authorize>) => {
      const authority = await authorize(...args);
      entered.resolve();
      await gate.promise;
      return authority;
    },
  });
  const operation = h.upload.uploadForActor(
    held,
    {
      kind: 'upload',
      requestId: 'request_upload_host_fixture_01',
      binding: h.f.seat.binding,
      artifactId: staged.artifactId,
      activation: { x: 32, y: 36 },
    },
    controller,
    h.reference(artifact),
    h.reference(permission)
  );
  const settled = operation.then(
    () => ({ failed: false as const }),
    (reason: unknown) => ({ failed: true as const, reason })
  );
  onTestFinished(async () => {
    release();
    await settled;
  });
  try {
    await entered.promise;
    h.f.grants.revoke(current, permission.grantId, permission.grantRevision);
    release();
    const refused = await settled;
    expect(refused.failed).toBe(true);
    if (!refused.failed) throw new Error('EXPECTED_ORIGINAL_GRANT_REFUSAL');
    expect(original.onOriginalDenial).toHaveBeenCalledWith(refused.reason);
    expect(h.dispatch).not.toHaveBeenCalled();
    await expect(h.upload.close()).resolves.toBeUndefined();
  } finally {
    release();
    await settled;
  }
});

it('joins an exact host close during held original authorization without dispatch or sticky local shutdown denial', async () => {
  const h = await uploadFixture();
  const artifact = h.selfGrant(['browser.artifact']),
    permission = h.selfGrant(['browser.upload']);
  const current = h.f.ownerAuth.current;
  const original = {
    refresh: h.f.ownerAuth.refresh.bind(h.f.ownerAuth),
    current,
    authorization: async (
      binding: Parameters<typeof h.f.controller.authorization>[1],
      id: string
    ) =>
      h.f.controller.authorization(current, binding, id, undefined, {
        propagateFailures: true,
        onOriginalDenial: () => {},
      }),
    onOriginalDenial: vi.fn(),
  };
  const staged = await h.upload.stageForActor(
    original,
    h.f.seat.binding,
    h.reference(artifact),
    'file.txt',
    'text/plain',
    Buffer.from('upload content'),
    new AbortController().signal
  );
  const id = h.f.seat.controllerId;
  if (!id) throw new Error('REAL_CONTROLLER_MISSING');
  const gate = deferredVoid(),
    entered = deferredVoid();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      gate.resolve();
    }
  };
  h.f.releases.push(release);
  const authorize = original.authorization;
  const held = Object.freeze({
    ...original,
    authorization: async (...args: Parameters<typeof authorize>) => {
      const authority = await authorize(...args);
      entered.resolve();
      await gate.promise;
      return authority;
    },
  });
  const operation = h.upload.uploadForActor(
    held,
    {
      kind: 'upload',
      requestId: 'request_upload_host_fixture_01',
      binding: h.f.seat.binding,
      artifactId: staged.artifactId,
      activation: { x: 32, y: 36 },
    },
    id,
    h.reference(artifact),
    h.reference(permission)
  );
  const settled = operation.then(
    () => ({ failed: false as const }),
    (reason: unknown) => ({ failed: true as const, reason })
  );
  const originals: { closing?: Promise<void> } = {};
  onTestFinished(async () => {
    release();
    await settled;
    await originals.closing;
  });
  try {
    await entered.promise;
    originals.closing = h.upload.close();
    let returned = false;
    void originals.closing.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    release();
    const refused = await settled;
    expect(refused.failed).toBe(true);
    if (!refused.failed) throw new Error('EXPECTED_LOCAL_SHUTDOWN_DENIAL');
    expect(original.onOriginalDenial).toHaveBeenCalledWith(refused.reason);
    expect(h.dispatch).not.toHaveBeenCalled();
    await expect(originals.closing).resolves.toBeUndefined();
  } finally {
    release();
    await settled;
    await originals.closing;
  }
});

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
