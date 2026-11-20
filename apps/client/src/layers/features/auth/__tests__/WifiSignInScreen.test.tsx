/**
 * @vitest-environment jsdom
 *
 * Signing a device in over Wi-Fi with a code from the computer DorkOS runs on
 * (DOR-4744): no password field, a match code to compare, then the one-time code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { getAuthRequired, setAuthRequired } from '@/layers/shared/lib';
import { WifiSignInScreen } from '../ui/WifiSignInScreen';

/** The server, at the network edge: each call answers in turn. */
const answers: { status: number; body: unknown }[] = [];
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
  const next = answers.shift() ?? { status: 500, body: {} };
  return new Response(JSON.stringify(next.body), { status: next.status });
});

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <WifiSignInScreen />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  answers.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  setAuthRequired(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WifiSignInScreen', () => {
  it('offers no password, only asking the computer for a code', () => {
    renderScreen();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask for a code' })).toBeInTheDocument();
  });

  it('shows the match code and device name, then signs in with the code', async () => {
    answers.push(
      {
        status: 200,
        body: { requestId: 'secret-id', matchCode: 'K7QX', deviceName: 'Safari on iPhone' },
      },
      { status: 200, body: { ok: true } }
    );
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a code' }));
    expect(await screen.findByLabelText('K 7 Q X')).toBeInTheDocument();
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Code from the computer'), {
      target: { value: 'abcd2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(getAuthRequired()).toBe(false));
    const finish = fetchMock.mock.calls[1]!;
    expect(finish[0]).toBe('/api/wifi-sign-in/finish');
    expect(JSON.parse(String(finish[1]!.body))).toEqual({
      requestId: 'secret-id',
      code: 'abcd2345',
    });
  });

  it('says so when the code does not work, and stays signed out', async () => {
    answers.push(
      { status: 200, body: { requestId: 'secret-id', matchCode: 'K7QX', deviceName: 'x' } },
      { status: 401, body: { error: 'no' } }
    );
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a code' }));
    fireEvent.change(await screen.findByLabelText('Code from the computer'), {
      target: { value: 'WRONG123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('That code didn’t work. Check it, or ask for a new one.')
    ).toBeInTheDocument();
    expect(getAuthRequired()).toBe(true);
  });
});
