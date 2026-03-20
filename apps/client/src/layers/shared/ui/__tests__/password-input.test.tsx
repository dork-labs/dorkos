/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PasswordInput } from '../password-input';

afterEach(cleanup);

describe('PasswordInput', () => {
  it('renders as password type by default', () => {
    render(<PasswordInput placeholder="Enter password" />);
    expect(screen.getByPlaceholderText('Enter password')).toHaveAttribute('type', 'password');
  });

  it('toggles visibility on button click', () => {
    render(<PasswordInput placeholder="Secret" />);
    const input = screen.getByPlaceholderText('Secret');
    const toggle = screen.getByRole('button', { name: 'Show password' });

    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
  });

  it('respects controlled showPassword prop', () => {
    const onChange = vi.fn();
    render(
      <PasswordInput showPassword={true} onShowPasswordChange={onChange} placeholder="controlled" />
    );
    const input = screen.getByPlaceholderText('controlled');
    expect(input).toHaveAttribute('type', 'text');
  });

  it('calls onShowPasswordChange in controlled mode', () => {
    const onChange = vi.fn();
    render(<PasswordInput showPassword={false} onShowPasswordChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('starts visible when visibleByDefault is true', () => {
    render(<PasswordInput visibleByDefault placeholder="Token" />);
    expect(screen.getByPlaceholderText('Token')).toHaveAttribute('type', 'text');
  });

  it('forwards standard input props', () => {
    render(<PasswordInput placeholder="my-secret" id="my-pw" disabled />);
    const input = screen.getByPlaceholderText('my-secret');
    expect(input).toHaveAttribute('id', 'my-pw');
    expect(input).toBeDisabled();
  });
});
