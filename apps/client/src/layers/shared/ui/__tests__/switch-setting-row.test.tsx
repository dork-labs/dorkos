/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { SwitchSettingRow } from '../setting-row';

afterEach(cleanup);

describe('SwitchSettingRow', () => {
  it('renders label and description', () => {
    render(
      <SwitchSettingRow
        label="My label"
        description="My description"
        checked={false}
        onCheckedChange={vi.fn()}
      />
    );
    expect(screen.getByText('My label')).toBeInTheDocument();
    expect(screen.getByText('My description')).toBeInTheDocument();
  });

  it('forwards checked state to the Switch', () => {
    render(
      <SwitchSettingRow
        label="Toggle"
        description="A toggle"
        checked={true}
        onCheckedChange={vi.fn()}
      />
    );
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onCheckedChange when toggled', async () => {
    const handler = vi.fn();
    render(
      <SwitchSettingRow
        label="Toggle"
        description="A toggle"
        checked={false}
        onCheckedChange={handler}
      />
    );
    await userEvent.click(screen.getByRole('switch'));
    expect(handler).toHaveBeenCalledWith(true);
  });

  it('uses label as default aria-label', () => {
    render(
      <SwitchSettingRow
        label="My label"
        description="My description"
        checked={false}
        onCheckedChange={vi.fn()}
      />
    );
    expect(screen.getByRole('switch', { name: 'My label' })).toBeInTheDocument();
  });

  it('honors custom ariaLabel override', () => {
    render(
      <SwitchSettingRow
        label="My label"
        description="My description"
        checked={false}
        onCheckedChange={vi.fn()}
        ariaLabel="Custom name"
      />
    );
    expect(screen.getByRole('switch', { name: 'Custom name' })).toBeInTheDocument();
  });

  it('forwards disabled state to the Switch', () => {
    render(
      <SwitchSettingRow
        label="Toggle"
        description="A toggle"
        checked={false}
        onCheckedChange={vi.fn()}
        disabled={true}
      />
    );
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
