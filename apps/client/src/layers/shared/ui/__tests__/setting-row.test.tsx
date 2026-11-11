/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingRow } from '../setting-row';
import { Switch } from '../switch';

afterEach(cleanup);

describe('SettingRow', () => {
  it('renders label and description text', () => {
    render(
      <SettingRow label="Theme" description="Choose light or dark mode">
        <Switch />
      </SettingRow>
    );
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Choose light or dark mode')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('renders description inside a field-description slot element', () => {
    render(
      <SettingRow label="Notifications" description="Enable push alerts">
        <Switch />
      </SettingRow>
    );
    const description = screen.getByText('Enable push alerts');
    expect(description).toHaveAttribute('data-slot', 'field-description');
  });

  it('renders compound children (badge + switch)', () => {
    render(
      <SettingRow label="Feature" description="A feature toggle">
        <div className="flex items-center gap-2">
          <span>Badge</span>
          <Switch />
        </div>
      </SettingRow>
    );
    expect(screen.getByText('Badge')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });
});
