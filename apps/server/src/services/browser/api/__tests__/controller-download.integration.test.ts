import type { OwnedDownloadSink, OwnedInputAuthorization } from '@dorkos/browser/server-owner';
import { fixture } from './input-routes.fixture.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserControllerDownload } from '../controller-download.js';
import { BrowserUploadArtifacts } from '../files/upload-artifacts.js';
import { BrowserApiRefusal } from '../service.js';
import { parseBrowserId, parseTabId } from '@dorkos/browser';
import { BrowserBindingSchema } from '@dorkos/shared/browser-schemas';
import type { OwnedBrowserGrants } from '../grants.js';

async function downloadFixture(beforeCapture?: (grants: OwnedBrowserGrants) => () => void) {
  const originals: {
    download?: BrowserControllerDownload;
    bank?: BrowserUploadArtifacts;
    home?: string;
    accepted?: Readonly<{ value: unknown }>;
    restore?: () => void;
  } = {};
  let closed = false;
  const acquiring = Promise.resolve().then(() => mkdtemp(join(tmpdir(), 'browser-download-host-')));
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
      await originals.download?.close();
    } catch (value) {
      failure = { value };
    }
    try {
      await originals.bank?.close();
    } catch (value) {
      failure ??= { value };
    }
    try {
      originals.restore?.();
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
  originals.restore = beforeCapture?.(f.grants);
  const download = new BrowserControllerDownload(bank, f.identities, f.grants, () => true);
  originals.download = download;
  download.bindHost(f.control);
  const dispatch = vi.fn(
    async (
      value: unknown,
      _authority: OwnedInputAuthorization,
      lease: OwnedDownloadSink,
      signal?: AbortSignal
    ) => {
      const originalSignal = signal ?? new AbortController().signal;
      const binding = BrowserBindingSchema.parse(f.seat.binding);
      await lease.authorize(
        {
          ...binding,
          browserId: parseBrowserId(binding.browserId),
          tabId: parseTabId(binding.tabId),
        },
        originalSignal
      );
      const artifact = await lease.stage(
        'native.txt',
        'text/plain',
        Buffer.from('native response'),
        originalSignal
      );
      // Response IO is a protocol double; the actual original auth/grants/controller remain real.
      const controllerId = f.seat.controllerId;
      if (!controllerId) throw new Error('REAL_CONTROLLER_MISSING');
      const input = await f.input.capture(f.ownerRequest.req, f.ownerRequest.res).input(
        {
          kind: 'input',
          requestId: 'request_download_fixture_0001',
          binding: f.seat.binding,
          steps: [{ kind: 'mouseMove', x: 32, y: 36 }],
        },
        controllerId,
        undefined,
        signal
      );
      return Object.freeze({ input, artifact });
    }
  );
  download.owner.registerDispatcher({ download: dispatch });
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
    download,
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
// Auth/SQLite/controller and actual filesystem are real; only native response transfer is doubled.
it('requires separate artifact access and existing download permission before any transfer', async () => {
  const h = await downloadFixture(),
    artifact = h.selfGrant(['browser.artifact']);
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  const command = {
    kind: 'download',
    requestId: 'request_download_fixture_0001',
    binding: h.f.seat.binding,
    activation: { x: 32, y: 36 },
  };
  const refused = await h.download
    .download(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      command,
      controller,
      h.reference(artifact),
      h.reference(artifact)
    )
    .then(
      () => {
        throw new Error('unexpected success');
      },
      (value) => ({ value })
    );
  expect(refused.value).toBeInstanceOf(BrowserApiRefusal);
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(await readdir(h.root)).toEqual([]);
  const download = h.selfGrant(['browser.download']);
  const result = await h.download.download(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    command,
    controller,
    h.reference(artifact),
    h.reference(download)
  );
  expect(result.input.outcome).toBe('completed');
  expect(h.dispatch).toHaveBeenCalledOnce();
  await expect(h.download.close()).resolves.toBeUndefined();
  expect(await readdir(h.root)).toEqual([]);
});
it('stages only original response bytes with both actual grants and current owner control', async () => {
  const h = await downloadFixture(),
    artifact = h.selfGrant(['browser.artifact']),
    download = h.selfGrant(['browser.download']);
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  const result = await h.download.download(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    {
      kind: 'download',
      requestId: 'request_download_fixture_0001',
      binding: h.f.seat.binding,
      activation: { x: 32, y: 36 },
    },
    controller,
    h.reference(artifact),
    h.reference(download)
  );
  expect(result.artifact.byteLength).toBe(15);
  const actor = h.f.ownerAuth.current();
  if (!actor) throw new Error('REAL_OWNER_MISSING');
  const lease = h.bank.claim(
    actor,
    BrowserBindingSchema.parse(h.f.seat.binding),
    result.artifact.artifactId,
    () => true
  );
  const payload = await lease.consume(new AbortController().signal);
  expect((await readFile(payload.path)).toString()).toBe('native response');
  await lease.close();
  expect(await readdir(h.root)).toEqual([]);
});
it('discards the exact unpublished staged response after genuine download grant revocation', async () => {
  const h = await downloadFixture(),
    artifact = h.selfGrant(['browser.artifact']),
    download = h.selfGrant(['browser.download']);
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  let release!: () => void, staged!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const observed = new Promise<void>((yes) => {
    staged = yes;
  });
  h.f.releases.push(release);
  const original = h.dispatch.getMockImplementation();
  if (!original) throw new Error('ORIGINAL_DISPATCH_MISSING');
  h.dispatch.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    staged();
    await held;
    return result;
  });
  const returning = h.download.download(
    h.f.ownerRequest.req,
    h.f.ownerRequest.res,
    {
      kind: 'download',
      requestId: 'request_download_fixture_0001',
      binding: h.f.seat.binding,
      activation: { x: 32, y: 36 },
    },
    controller,
    h.reference(artifact),
    h.reference(download)
  );
  void returning.catch(() => undefined);
  await observed;
  expect((await readdir(h.root)).length).toBe(1);
  h.f.grants.revoke(h.f.ownerAuth.current, download.grantId, download.grantRevision);
  release();
  const refused = await returning.then(
    () => {
      throw new Error('unexpected success');
    },
    (value) => ({ value })
  );
  h.accept(refused.value);
  expect(await readdir(h.root)).toEqual([]);
  await expect(h.download.close()).rejects.toBe(refused.value);
});

it('discards the actual staged cell before a fulfilled malformed original dispatcher result rejects', async () => {
  const h = await downloadFixture(),
    artifact = h.selfGrant(['browser.artifact']),
    download = h.selfGrant(['browser.download']);
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  const original = h.dispatch.getMockImplementation();
  if (!original) throw new Error('ORIGINAL_DISPATCH_MISSING');
  // A proxy models an original runtime receiver contradicting its declared fulfilled result; production types stay precise.
  h.dispatch.mockImplementationOnce(
    new Proxy(original, {
      apply: async (target, receiver, args) => {
        await Reflect.apply(target, receiver, args);
        return undefined;
      },
    })
  );
  const refused = await h.download
    .download(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      {
        kind: 'download',
        requestId: 'request_download_fixture_0001',
        binding: h.f.seat.binding,
        activation: { x: 32, y: 36 },
      },
      controller,
      h.reference(artifact),
      h.reference(download)
    )
    .then(
      () => {
        throw new Error('unexpected success');
      },
      (value) => ({ value })
    );
  h.accept(refused.value);
  expect(await readdir(h.root)).toEqual([]);
  await expect(h.download.close()).rejects.toBe(refused.value);
});

it.each(['stale', 'revoked'] as const)(
  'keeps genuine %s file-grant denial before dispatch nonsticky',
  async (kind) => {
    const h = await downloadFixture(),
      artifact = h.selfGrant(['browser.artifact']),
      download = h.selfGrant(['browser.download']);
    const controller = h.f.seat.controllerId;
    if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
    const binding =
      kind === 'stale'
        ? {
            ...h.f.seat.binding,
            epoch: h.f.seat.binding.epoch + 1,
            inputGeneration: h.f.seat.binding.inputGeneration + 1,
          }
        : h.f.seat.binding;
    if (kind === 'revoked')
      h.f.grants.revoke(h.f.ownerAuth.current, download.grantId, download.grantRevision);
    await expect(
      h.download.download(
        h.f.ownerRequest.req,
        h.f.ownerRequest.res,
        {
          kind: 'download',
          requestId: 'request_download_fixture_0001',
          binding,
          activation: { x: 32, y: 36 },
        },
        controller,
        h.reference(artifact),
        h.reference(download)
      )
    ).rejects.toBeInstanceOf(BrowserApiRefusal);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(await readdir(h.root)).toEqual([]);
    await expect(h.download.close()).resolves.toBeUndefined();
  }
);
it.each([undefined, new BrowserApiRefusal('inaccessible')])(
  'retains unmarked original pre-dispatch failure %s through close',
  async (reason) => {
    const h = await downloadFixture((grants) => {
        const observer = vi.spyOn(grants, 'admit').mockImplementation(() => {
          throw reason;
        });
        return () => observer.mockRestore();
      }),
      artifact = h.selfGrant(['browser.artifact']),
      download = h.selfGrant(['browser.download']);
    const controller = h.f.seat.controllerId;
    if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
    await expect(
      h.download.download(
        h.f.ownerRequest.req,
        h.f.ownerRequest.res,
        {
          kind: 'download',
          requestId: 'request_download_fixture_0001',
          binding: h.f.seat.binding,
          activation: { x: 32, y: 36 },
        },
        controller,
        h.reference(artifact),
        h.reference(download)
      )
    ).rejects.toBe(reason);
    h.accept(reason);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(await readdir(h.root)).toEqual([]);
    await expect(h.download.close()).rejects.toBe(reason);
  }
);
it('retains an original dispatcher undefined failure even before it stages any bytes', async () => {
  const h = await downloadFixture(),
    artifact = h.selfGrant(['browser.artifact']),
    download = h.selfGrant(['browser.download']);
  const controller = h.f.seat.controllerId;
  if (!controller) throw new Error('REAL_CONTROLLER_MISSING');
  h.dispatch.mockImplementationOnce(async () => {
    throw undefined;
  });
  await expect(
    h.download.download(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      {
        kind: 'download',
        requestId: 'request_download_fixture_0001',
        binding: h.f.seat.binding,
        activation: { x: 32, y: 36 },
      },
      controller,
      h.reference(artifact),
      h.reference(download)
    )
  ).rejects.toBeUndefined();
  h.accept(undefined);
  expect(h.dispatch).toHaveBeenCalledOnce();
  expect(await readdir(h.root)).toEqual([]);
  await expect(h.download.close()).rejects.toBeUndefined();
});

it('retains a prior genuine marked grant refusal rethrown by a different original admission', async () => {
  const prior: { value?: Readonly<{ value: unknown }> } = {};
  let originalAdmit: OwnedBrowserGrants['admit'] | undefined;
  const h = await downloadFixture((grants) => {
    const admitted = grants.admit.bind(grants);
    originalAdmit = admitted;
    const observer = vi.spyOn(grants, 'admit').mockImplementation((...args) => {
      if (prior.value) throw prior.value.value;
      return admitted(...args);
    });
    return () => observer.mockRestore();
  });
  const artifact = h.selfGrant(['browser.artifact']),
    download = h.selfGrant(['browser.download']);
  const controller = h.f.seat.controllerId;
  if (!controller || !originalAdmit) throw new Error('REAL_CONTROLLER_OR_ADMISSION_MISSING');
  const stale = BrowserBindingSchema.parse({
    ...h.f.seat.binding,
    epoch: h.f.seat.binding.epoch + 1,
    inputGeneration: h.f.seat.binding.inputGeneration + 1,
  });
  try {
    originalAdmit(
      h.f.ownerAuth.current,
      artifact.grantId,
      artifact.grantRevision,
      stale,
      'browser.artifact'
    );
  } catch (value) {
    prior.value = { value };
  }
  if (!prior.value) throw new Error('GENUINE_PRIOR_DENIAL_MISSING');
  expect(prior.value.value).toBeInstanceOf(BrowserApiRefusal);
  await expect(
    h.download.download(
      h.f.ownerRequest.req,
      h.f.ownerRequest.res,
      {
        kind: 'download',
        requestId: 'request_download_fixture_0001',
        binding: h.f.seat.binding,
        activation: { x: 32, y: 36 },
      },
      controller,
      h.reference(artifact),
      h.reference(download)
    )
  ).rejects.toBe(prior.value.value);
  h.accept(prior.value.value);
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(await readdir(h.root)).toEqual([]);
  await expect(h.download.close()).rejects.toBe(prior.value.value);
});

it('uses the original private actor receiver for exact granted response staging', async () => {
  const h = await downloadFixture();
  const artifact = h.selfGrant(['browser.artifact']),
    permission = h.selfGrant(['browser.download']);
  const current = h.f.ownerAuth.current;
  const original = Object.freeze({
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
    onOriginalDenial: (_value: unknown) => {},
  });
  const id = h.f.seat.controllerId;
  if (!id) throw new Error('REAL_CONTROLLER_MISSING');
  const result = await h.download.downloadForActor(
    original,
    {
      kind: 'download',
      requestId: 'request_download_fixture_0001',
      binding: h.f.seat.binding,
      activation: { x: 32, y: 36 },
    },
    id,
    h.reference(artifact),
    h.reference(permission)
  );
  expect(result.input.outcome).toBe('completed');
  expect(result.artifact.byteLength).toBe(Buffer.byteLength('native response'));
  expect(h.dispatch).toHaveBeenCalledOnce();
});
it('does not forgive a same-class original actor current failure as a locally issued grant denial', async () => {
  const h = await downloadFixture();
  const artifact = h.selfGrant(['browser.artifact']),
    permission = h.selfGrant(['browser.download']);
  const unknown = new BrowserApiRefusal('inaccessible');
  const denied = vi.fn();
  const original = Object.freeze({
    refresh: h.f.ownerAuth.refresh.bind(h.f.ownerAuth),
    current: () => {
      throw unknown;
    },
    authorization: async () => {
      throw new Error('UNENTERED_CONTROLLER');
    },
    onOriginalDenial: denied,
  });
  const id = h.f.seat.controllerId;
  if (!id) throw new Error('REAL_CONTROLLER_MISSING');
  h.accept(unknown);
  await expect(
    h.download.downloadForActor(
      original,
      {
        kind: 'download',
        requestId: 'request_download_fixture_0001',
        binding: h.f.seat.binding,
        activation: { x: 32, y: 36 },
      },
      id,
      h.reference(artifact),
      h.reference(permission)
    )
  ).rejects.toBe(unknown);
  expect(denied).not.toHaveBeenCalled();
  expect(h.dispatch).not.toHaveBeenCalled();
  await expect(h.download.close()).rejects.toBe(unknown);
});
