/**
 * @vitest-environment jsdom
 *
 * Creating the owner from another device asks for the setup code the computer
 * printed (DOR-2968): the field appears when the server asks, and the next
 * attempt carries what the person typed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OwnerSetupScreen } from '../ui/OwnerSetupScreen';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';
import type { AuthClient } from '../model/auth-client';

const NEEDS_CODE = {
  data: null,
  error: { message: 'raw', status: 403, code: 'SETUP_CODE_REQUIRED' },
};

function setup(signUpEmail: AuthClient['signUp']['email'], onCreated = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthClientProvider client={createFakeAuthClient({ signUpEmail })}>
        <OwnerSetupScreen onCreated={onCreated} />
      </AuthClientProvider>
    </QueryClientProvider>
  );
  return { onCreated };
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'owner@example.com');
  await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
  await user.type(screen.getByLabelText('Confirm password'), 'sup3rsecret');
  await user.click(screen.getByRole('button', { name: /create account/i }));
}

describe('OwnerSetupScreen — the setup code', () => {
  afterEach(cleanup);

  it('shows no setup code field until the server asks for one', () => {
    setup(vi.fn());
    expect(screen.queryByLabelText('Setup code')).not.toBeInTheDocument();
  });

  it('asks for the code, then sends what the person typed', async () => {
    const user = userEvent.setup();
    const signUpEmail = vi
      .fn()
      .mockResolvedValueOnce(NEEDS_CODE)
      .mockResolvedValueOnce({ data: { user: { id: 'u1' } }, error: null });
    const { onCreated } = setup(signUpEmail);

    await fillAndSubmit(user);

    expect(await screen.findByLabelText('Setup code')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter the setup code from the computer DorkOS runs on.'
    );
    expect(signUpEmail).toHaveBeenLastCalledWith(
      { email: 'owner@example.com', password: 'sup3rsecret', name: '' },
      undefined
    );

    await user.type(screen.getByLabelText('Setup code'), 'ABCDE-12345');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUpEmail).toHaveBeenLastCalledWith(
      { email: 'owner@example.com', password: 'sup3rsecret', name: '' },
      { setupCode: 'ABCDE-12345' }
    );
    expect(onCreated).toHaveBeenCalled();
  });

  it('keeps the field after a wrong code, and says so', async () => {
    const user = userEvent.setup();
    const signUpEmail = vi
      .fn()
      .mockResolvedValueOnce(NEEDS_CODE)
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'raw', status: 403, code: 'SETUP_CODE_INVALID' },
      });
    setup(signUpEmail);

    await fillAndSubmit(user);
    await user.type(await screen.findByLabelText('Setup code'), 'WRONG-CODE0');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/wrong or expired/)).toBeInTheDocument();
    expect(screen.getByLabelText('Setup code')).toBeInTheDocument();
  });
});
