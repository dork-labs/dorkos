import { expect, it, onTestFinished, vi } from 'vitest';
import { fixture } from './input-routes.fixture.js';
import { BrowserControllerInput } from '../controller-input.js';
import { BrowserCopySelectionRequestSchema } from '@dorkos/shared/browser-schemas';
import type { PrivateBrowserInputDispatcher } from '@dorkos/browser/server-owner';
import { parseBrowserId, parseTabId } from '@dorkos/browser';

function copyRequest(value: unknown) {
  const request = BrowserCopySelectionRequestSchema.parse(value);
  return {
    ...request,
    binding: {
      ...request.binding,
      browserId: parseBrowserId(request.binding.browserId),
      tabId: parseTabId(request.binding.tabId),
    },
  };
}

async function copyFixture() {
  const f = await fixture();
  const releases: Array<() => void> = [];
  const input = new BrowserControllerInput();
  let accepted: { value: unknown } | undefined;
  const copy = vi.fn<NonNullable<PrivateBrowserInputDispatcher['copySelection']>>(
    async (value, authority, signal) => {
      const request = copyRequest(value);
      signal.throwIfAborted();
      if (!authority.isCurrent() || !(await authority.refresh()))
        throw new Error('ORIGINAL_COPY_AUTH_REFUSED');
      return { ...request, outcome: 'selected', text: 'ordinary' };
    }
  );
  input.owner.registerDispatcher({
    input: async () => {
      throw new Error('NATIVE_INPUT_NOT_EXPECTED');
    },
    copySelection: copy,
  });
  input.bindHost(f.control);
  onTestFinished(async () => {
    for (const release of releases) release();
    try {
      await input.close();
    } catch (value) {
      if (!accepted || value !== accepted.value) throw value;
    }
  });
  const command = { requestId: 'copy_owner_request_000001', binding: f.seat.binding };
  const controllerId = f.seat.controllerId;
  if (!controllerId) throw new Error('ORIGINAL_CONTROLLER_REQUIRED');
  return {
    ...f,
    copy,
    input,
    command,
    controllerId,
    releases,
    accept: (value: unknown) => {
      accepted = { value };
    },
  };
}
// Real original BetterAuth/registry/controller/grant boundaries; selection producer is a named port double.
it('only HTTP owner capture exposes copy; runtime authorization capture remains input-only', async () => {
  const f = await copyFixture();
  const client = f.input.capture(f.ownerRequest.req, f.ownerRequest.res);
  expect(await client.copySelection(f.command, f.controllerId)).toMatchObject({
    outcome: 'selected',
    text: 'ordinary',
    binding: f.seat.binding,
  });
  expect(f.copy).toHaveBeenCalledTimes(1);
  const captured = f.control.capture(f.ownerRequest.req, f.ownerRequest.res);
  expect(f.input.captureAuthorization(captured.authorization.bind(captured))).not.toHaveProperty(
    'copySelection'
  );
});
it('refuses another signed-in user without original controller ownership before selection read', async () => {
  const f = await copyFixture();
  const client = f.input.capture(f.recipientRequest.req, f.recipientRequest.res);
  await expect(client.copySelection(f.command, f.controllerId)).rejects.toThrow();
  expect(f.copy).not.toHaveBeenCalled();
});
it.each([false, undefined])(
  'close joins entered original selection and retains falsy first: %s',
  async (cause) => {
    const f = await copyFixture();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    f.releases.push(release);
    f.copy.mockImplementation(async () => {
      entered();
      await held;
      throw cause;
    });
    const operation = f.input
      .capture(f.ownerRequest.req, f.ownerRequest.res)
      .copySelection(f.command, f.controllerId);
    void operation.catch(() => undefined);
    f.accept(cause);
    try {
      await ready;
      let returned = false;
      const close = f.input.close().then(() => {
        returned = true;
      });
      void close.catch(() => undefined);
      await Promise.resolve();
      expect(returned).toBe(false);
      release();
      await expect(operation).rejects.toBe(cause);
      await expect(close).rejects.toBe(cause);
      expect(f.copy).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.allSettled([operation, f.input.close()]);
    }
  }
);
it('auth refresh after held original read refuses retired original controller without text delivery', async () => {
  const f = await copyFixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.releases.push(release);
  f.copy.mockImplementation(async (value, authority) => {
    entered();
    await held;
    if (!(await authority.refresh()) || !authority.isCurrent())
      throw new Error('ORIGINAL_COPY_AUTH_REFUSED');
    return {
      ...copyRequest(value),
      outcome: 'selected',
      text: 'ordinary',
    };
  });
  const operation = f.input
    .capture(f.ownerRequest.req, f.ownerRequest.res)
    .copySelection(f.command, f.controllerId);
  void operation.catch((value) => f.accept(value));
  try {
    await ready;
    await f.identities.close();
    release();
    await expect(operation).rejects.toThrow();
  } finally {
    release();
    await Promise.allSettled([operation, f.input.close()]);
  }
});
