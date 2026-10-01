// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeepOwnership } from '../KeepOwnership.js';
import { captureFragment, mockFetch, refusal, spyConsole, type Call } from './harness.js';

// The page the owner's emailed link opens (specs/community-owner-replacement, "The object-only
// link page"). The token must never leave page memory except in the two POST bodies, and
// opening the page must never keep ownership on its own.
const TOKEN = 'object-token-9f8e7d6c5b4a';
const PREFLIGHT = 'POST /api/v1/owner-replacements/object-preflight';
const OBJECT = 'POST /api/v1/owner-replacements/object';
const live = {
  status: 200,
  body: { communityName: 'Acme Ops', claimableAfter: null, objectionCooldownDays: 60 },
};

let consoleText: () => string;
beforeEach(() => {
  window.history.replaceState(null, '', '/keep-ownership');
  consoleText = spyConsole();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.__clearDorkosOwnerReplacementFragment?.();
});

/** The requests about the link, leaving out the host's policy links every page reads. */
function linkCalls(calls: Call[]) {
  return calls
    .filter((call) => call.url.includes('/owner-replacements/'))
    .map((call) => ({ route: `${call.method} ${call.url}`, body: call.body }));
}

/** The token stayed out of every address, every request URL, and the console. */
function expectTokenContained(calls: { url: string }[]) {
  expect(window.location.search).not.toContain(TOKEN);
  expect(window.location.href).not.toContain(TOKEN);
  expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
  expect(consoleText()).not.toContain(TOKEN);
}

describe('KeepOwnership', () => {
  it('only checks the link on load, then keeps ownership when the owner presses the button', async () => {
    // Purpose: fails if loading the page objects by itself (a mail scanner would end the
    // request), if the fragment copy outlives the preflight, or if the token leaks.
    captureFragment(TOKEN);
    const calls = mockFetch({
      [PREFLIGHT]: live,
      [OBJECT]: { status: 200, body: { outcome: 'kept' } },
    });
    render(<KeepOwnership />);
    expect(
      await screen.findByRole('heading', { name: 'Keep ownership of Acme Ops?' })
    ).toBeTruthy();
    expect(
      screen.getByText(
        'The host’s request will end. The host can ask again after 60 days, and you’ll be told again.'
      )
    ).toBeTruthy();
    expect(linkCalls(calls)).toEqual([{ route: PREFLIGHT, body: { token: TOKEN } }]);
    // The page-memory copy the bootstrap made is gone once the server has seen the token.
    expect(window.__readDorkosOwnerReplacementFragment).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Keep ownership' }));
    expect(
      await screen.findByRole('heading', { name: 'You kept ownership. The host has been told.' })
    ).toBeTruthy();
    expect(linkCalls(calls)).toEqual([
      { route: PREFLIGHT, body: { token: TOKEN } },
      { route: OBJECT, body: { token: TOKEN } },
    ]);
    expect(screen.queryByRole('button', { name: 'Keep ownership' })).toBeNull();
    expectTokenContained(calls);
  });

  it('says the request already ended when it closed another way', async () => {
    // Purpose: fails if an `ended` outcome is reported as the owner keeping ownership.
    captureFragment(TOKEN);
    mockFetch({ [PREFLIGHT]: live, [OBJECT]: { status: 200, body: { outcome: 'ended' } } });
    render(<KeepOwnership />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep ownership' }));
    expect(
      await screen.findByRole('heading', { name: 'This request has already ended.' })
    ).toBeTruthy();
  });

  it('says a dead link no longer works, and offers nothing to press', async () => {
    // Purpose: fails if a refused link shows the button or any other detail.
    captureFragment(TOKEN);
    const calls = mockFetch({
      [PREFLIGHT]: refusal(403, 'FORBIDDEN', 'This link no longer works.'),
    });
    render(<KeepOwnership />);
    expect(await screen.findByRole('heading', { name: 'This link no longer works.' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep ownership' })).toBeNull();
    expect(window.__readDorkosOwnerReplacementFragment).toBeUndefined();
    expect(linkCalls(calls)).toEqual([{ route: PREFLIGHT, body: { token: TOKEN } }]);
    expectTokenContained(calls);
  });

  it('turns a link that died after the check into the dead-link page', async () => {
    // Purpose: fails if a refusal of the objection itself is shown as a retryable error.
    captureFragment(TOKEN);
    mockFetch({
      [PREFLIGHT]: live,
      [OBJECT]: refusal(403, 'FORBIDDEN', 'This link no longer works.'),
    });
    render(<KeepOwnership />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep ownership' }));
    expect(await screen.findByRole('heading', { name: 'This link no longer works.' })).toBeTruthy();
  });

  it('asks nothing of the server without a token', async () => {
    // Purpose: fails if the page sends an empty or guessed token.
    const calls = mockFetch({});
    render(<KeepOwnership />);
    expect(await screen.findByRole('heading', { name: 'This link no longer works.' })).toBeTruthy();
    expect(linkCalls(calls)).toEqual([]);
  });

  it('keeps the token for a retry when the check could not reach the server', async () => {
    // Purpose: fails if a network failure throws the token away, so the owner cannot retry.
    captureFragment(TOKEN);
    let attempts = 0;
    const calls = mockFetch({
      [PREFLIGHT]: () => (++attempts === 1 ? { status: 503 } : live),
    });
    render(<KeepOwnership />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Keep ownership of Acme Ops?' })
    ).toBeTruthy();
    expect(linkCalls(calls)).toEqual([
      { route: PREFLIGHT, body: { token: TOKEN } },
      { route: PREFLIGHT, body: { token: TOKEN } },
    ]);
  });
});
