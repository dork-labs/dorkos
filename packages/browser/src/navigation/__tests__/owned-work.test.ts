import { expect, it, vi } from 'vitest';
import { parseBrowserCommand } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import {
  createOwnedNavigationIssuer,
  consumeOwnedNavigationWork,
  ownedNavigationCurrent,
  authorizeOwnedNavigation,
} from '../owned-work.js';

const binding = Object.freeze({
  browserId: parseBrowserId('browser_subject_A_000000000000000'),
  browserGeneration: 0,
  tabId: parseTabId('canonical_tab_A_00000000000000000'),
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
});
function fixture() {
  const command = parseBrowserCommand({
    kind: 'navigate',
    requestId: 'request_subject_A_00000000000000',
    binding,
    url: 'http://127.0.0.1:4801/',
  });
  if (command.kind !== 'navigate') throw new Error('FIXTURE_COMMAND');
  let current = true;
  const authorize = vi.fn(async () => 'allowed' as const);
  const issuer = createOwnedNavigationIssuer();
  const token = issuer.issue(command, { isCurrent: () => current, authorize });
  const owner = Object.freeze({});
  return {
    command,
    authorize,
    issuer,
    token,
    owner,
    revoke: () => {
      current = false;
    },
  };
}
it('never lends URL authority to a forged, different-command, competing or replayed Work', async () => {
  const f = fixture();
  expect(consumeOwnedNavigationWork({}, f.command, f.owner)).toBe(false);
  expect(
    consumeOwnedNavigationWork(
      f.token,
      { ...f.command, url: 'http://127.0.0.1:4801/other' },
      f.owner
    )
  ).toBe(false);
  expect(consumeOwnedNavigationWork(f.token, f.command, f.owner)).toBe(true);
  expect(consumeOwnedNavigationWork(f.token, f.command, {})).toBe(false);
  expect(
    await authorizeOwnedNavigation(
      f.token,
      {},
      binding,
      f.command.url,
      new AbortController().signal
    )
  ).toBe('refused');
  expect(f.authorize).not.toHaveBeenCalled();
  expect(
    await authorizeOwnedNavigation(
      f.token,
      f.owner,
      binding,
      f.command.url,
      new AbortController().signal
    )
  ).toBe('allowed');
  f.issuer.invalidate(f.token);
  expect(ownedNavigationCurrent(f.token, f.owner)).toBe(false);
});
it('refuses revocation and issuer settlement during the original async URL permission callback', async () => {
  const f = fixture();
  consumeOwnedNavigationWork(f.token, f.command, f.owner);
  f.authorize.mockImplementation(async () => {
    f.revoke();
    return 'allowed';
  });
  expect(
    await authorizeOwnedNavigation(
      f.token,
      f.owner,
      binding,
      f.command.url,
      new AbortController().signal
    )
  ).toBe('refused');
  const other = fixture();
  consumeOwnedNavigationWork(other.token, other.command, other.owner);
  other.authorize.mockImplementation(async () => {
    other.issuer.invalidate(other.token);
    return 'allowed';
  });
  expect(
    await authorizeOwnedNavigation(
      other.token,
      other.owner,
      binding,
      other.command.url,
      new AbortController().signal
    )
  ).toBe('refused');
});
it('captures original authorization methods and refuses an already aborted original operation', async () => {
  const f = fixture();
  consumeOwnedNavigationWork(f.token, f.command, f.owner);
  const abort = new AbortController();
  abort.abort();
  expect(
    await authorizeOwnedNavigation(f.token, f.owner, binding, f.command.url, abort.signal)
  ).toBe('refused');
  expect(f.authorize).not.toHaveBeenCalled();
});
