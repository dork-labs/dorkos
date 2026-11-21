/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginScreen } from '../ui/LoginScreen';

const signIn = vi.hoisted(() => ({
  run: vi.fn(),
  isPending: false,
  error: null as { message: string; status: number; code?: string } | null,
}));
const passkeySignIn = vi.hoisted(() => ({
  run: vi.fn(),
  isPending: false,
  error: null as { message: string; status: number } | null,
}));
vi.mock('../model/use-auth-session', () => ({
  useSignIn: () => signIn,
  usePasskeySignIn: () => passkeySignIn,
}));

beforeEach(() => {
  signIn.run.mockReset();
  signIn.run.mockResolvedValue({ ok: true });
  signIn.isPending = false;
  signIn.error = null;
});
afterEach(cleanup);

describe('LoginScreen', () => {
  it('asks for an authenticator code as a second step from another device', async () => {
    signIn.error = { message: 'needs more', status: 401, code: 'SECOND_FACTOR_REQUIRED' };
    render(<LoginScreen />);
    expect(screen.getByText('One more step')).toBeInTheDocument();
    const code = screen.getByLabelText('Enter the code from your authenticator app.');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'kai@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(signIn.run).toHaveBeenCalledWith('kai@example.com', 'secret', '123456')
    );
  });

  /** Reach the second step with the server listing `methods`, on a browser with passkeys. */
  async function secondStepWith(methods: string[]) {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    Object.defineProperty(navigator, 'credentials', {
      value: { get: vi.fn() },
      configurable: true,
    });
    const required = {
      message: 'needs more',
      status: 401,
      code: 'SECOND_FACTOR_REQUIRED',
      methods,
    };
    signIn.run.mockResolvedValue({ ok: false, error: required });
    // The password first, as a person signs in; the server answers with the second step.
    const view = render(<LoginScreen />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'kai@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(signIn.run).toHaveBeenCalled());
    signIn.error = required;
    view.rerender(<LoginScreen />);
  }

  it('before the password step, says nothing about passkeys, whatever the owner has', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    Object.defineProperty(navigator, 'credentials', {
      value: { get: vi.fn() },
      configurable: true,
    });
    try {
      render(<LoginScreen />);
      expect(screen.queryByRole('button', { name: /passkey/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/passkey/i)).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers a passkey quietly beside the code only when the server says one works from here', async () => {
    try {
      await secondStepWith(['authenticator', 'passkey']);
      expect(screen.getByLabelText('Enter the code from your authenticator app.')).toBeVisible();
      expect(
        await screen.findByRole('button', { name: 'Use a passkey instead' })
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never offers a passkey the server does not list, such as one made only for this computer', async () => {
    try {
      await secondStepWith(['authenticator']);
      expect(screen.getByLabelText('Enter the code from your authenticator app.')).toBeVisible();
      expect(screen.queryByRole('button', { name: /passkey/i })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('with only a passkey that works from here, the passkey is the one main action', async () => {
    try {
      await secondStepWith(['passkey']);
      expect(await screen.findByRole('button', { name: 'Use a passkey' })).toBeInTheDocument();
      expect(
        screen.queryByLabelText('Enter the code from your authenticator app.')
      ).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A real form action must keep its explicit submit type and credential hints.
  it('submits credentials and keeps password manager hints', async () => {
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);
    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit');
    fireEvent.change(email, { target: { value: 'kai@example.com' } });
    fireEvent.change(password, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(signIn.run).toHaveBeenCalledWith('kai@example.com', 'secret'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  // Visibility is an in-form button action and must never submit credentials.
  it('toggles password visibility without submitting', () => {
    render(<LoginScreen />);
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    expect(signIn.run).not.toHaveBeenCalled();
  });

  // One failed request produces one alert with an ID referenced by the fields.
  it('announces one detailed error and connects it to mounted fields', () => {
    const view = render(<LoginScreen />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    signIn.error = { message: 'Invalid origin', status: 403, code: 'INVALID_ORIGIN' };
    view.rerender(<LoginScreen />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('Invalid origin');
    const id = alerts[0]?.id;
    expect(id).toBeTruthy();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-describedby', id);
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-describedby', id);
  });

  // Pending requests keep the form's existing disabled text and single action.
  it('shows the pending state on the submit button', () => {
    signIn.isPending = true;
    render(<LoginScreen />);
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
  });
});
