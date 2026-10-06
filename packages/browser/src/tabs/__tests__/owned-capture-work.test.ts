import { expect, it, vi } from 'vitest';
import { parseBrowserCommand } from '../../contracts.js';
import {
  createOwnedCaptureIssuer,
  consumeOwnedCaptureWork,
  ownedCaptureWorkCurrent,
  authorizeOwnedCaptureWork,
  settleOwnedCaptureWork,
} from '../owned-capture-work.js';
const command = () => {
  const parsed = parseBrowserCommand({
    kind: 'capture',
    requestId: 'request_fixture_000000000001',
    binding: {
      browserId: 'browser_fixture_000000001',
      browserGeneration: 1,
      tabId: 'tab_fixture_00000000000001',
      navigationGeneration: 0,
      viewportVersion: 0,
      epoch: 0,
      inputGeneration: 0,
    },
  });
  if (parsed.kind !== 'capture') throw new Error('fixture');
  return parsed;
};
it('consumes an engine-issued capture work only once for exact command and original owner, then fences settlement', async () => {
  const issuer = createOwnedCaptureIssuer(),
    original = command(),
    owner = Object.freeze({});
  const authorization = { isCurrent: () => true, authorize: vi.fn(async () => 'allowed' as const) };
  const token = issuer.issue(original, authorization);
  try {
    expect(consumeOwnedCaptureWork({}, original, owner)).toBe(false);
    expect(
      consumeOwnedCaptureWork(
        token,
        { ...original, requestId: command().requestId, binding: { ...original.binding, epoch: 1 } },
        owner
      )
    ).toBe(false);
    expect(consumeOwnedCaptureWork(token, original, owner)).toBe(true);
    expect(consumeOwnedCaptureWork(token, original, Object.freeze({}))).toBe(false);
    expect(
      await authorizeOwnedCaptureWork(
        token,
        Object.freeze({}),
        original.binding,
        new AbortController().signal
      )
    ).toBe('refused');
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(
      await authorizeOwnedCaptureWork(token, owner, original.binding, new AbortController().signal)
    ).toBe('allowed');
    settleOwnedCaptureWork(token, owner);
    expect(ownedCaptureWorkCurrent(token, owner)).toBe(false);
    expect(consumeOwnedCaptureWork(token, original, owner)).toBe(false);
  } finally {
    issuer.invalidate(token);
  }
});
it('rechecks exact original permission after awaited authorization and refuses synchronous issuer invalidation', async () => {
  const issuer = createOwnedCaptureIssuer(),
    original = command(),
    owner = Object.freeze({});
  let current = true;
  const token = issuer.issue(original, {
    isCurrent: () => current,
    authorize: async () => {
      current = false;
      return 'allowed';
    },
  });
  try {
    expect(consumeOwnedCaptureWork(token, original, owner)).toBe(true);
    expect(
      await authorizeOwnedCaptureWork(token, owner, original.binding, new AbortController().signal)
    ).toBe('refused');
    current = true;
    issuer.invalidate(token);
    expect(ownedCaptureWorkCurrent(token, owner)).toBe(false);
  } finally {
    issuer.invalidate(token);
  }
});
it('keeps unrelated same-binding work separate and fences callback-triggered invalidation', async () => {
  const issuer = createOwnedCaptureIssuer(),
    original = command(),
    owner = Object.freeze({});
  let invalidate = () => {};
  const token = issuer.issue(original, {
    isCurrent: () => {
      invalidate();
      return true;
    },
    authorize: async () => 'allowed',
  });
  try {
    expect(consumeOwnedCaptureWork(token, original, owner)).toBe(true);
    invalidate = () => issuer.invalidate(token);
    expect(ownedCaptureWorkCurrent(token, owner)).toBe(false);
    expect(
      await authorizeOwnedCaptureWork(
        token,
        Object.freeze({}),
        original.binding,
        new AbortController().signal
      )
    ).toBe('refused');
  } finally {
    issuer.invalidate(token);
  }
});
