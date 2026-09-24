/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginScreen } from '../ui/LoginScreen';

const signIn = vi.hoisted(() => ({
  run: vi.fn(),
  isPending: false,
  error: null as { message: string; status: number; code?: string } | null,
}));
vi.mock('../model/use-auth-session', () => ({ useSignIn: () => signIn }));

beforeEach(() => {
  signIn.run.mockReset();
  signIn.run.mockResolvedValue({ ok: true });
  signIn.isPending = false;
  signIn.error = null;
});
afterEach(cleanup);

describe('LoginScreen', () => {
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
