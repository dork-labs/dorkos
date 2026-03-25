/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AdapterCardError } from '../AdapterCardError';
import type { CatalogInstance } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInstance(overrides: Partial<CatalogInstance['status']> = {}): CatalogInstance {
  return {
    id: 'tg-test',
    enabled: true,
    status: {
      id: 'tg-test',
      type: 'telegram',
      displayName: 'Test Telegram',
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterCardError', () => {
  afterEach(() => {
    cleanup();
  });

  it('returns null when errorCount is 0 and lastError is undefined', () => {
    const { container } = render(<AdapterCardError instance={makeInstance()} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows error count text when errorCount > 0 and no lastError', () => {
    render(<AdapterCardError instance={makeInstance({ errorCount: 3 })} />);
    expect(screen.getByText(/3 errors/)).toBeInTheDocument();
  });

  it('shows singular "error" for errorCount === 1 without lastError', () => {
    render(<AdapterCardError instance={makeInstance({ errorCount: 1 })} />);
    expect(screen.getByText(/1 error/)).toBeInTheDocument();
    expect(screen.queryByText(/1 errors/)).not.toBeInTheDocument();
  });

  it('renders collapsible trigger when lastError is set', () => {
    render(
      <AdapterCardError
        instance={makeInstance({ errorCount: 2, lastError: 'Connection timed out' })}
      />
    );
    const trigger = screen.getByRole('button', { name: 'Toggle full error message' });
    expect(trigger).toBeInTheDocument();
  });

  it('shows full error text when collapsible is expanded', async () => {
    render(
      <AdapterCardError
        instance={makeInstance({ errorCount: 1, lastError: 'Connection timed out' })}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Toggle full error message' });
    await act(async () => {
      fireEvent.click(trigger);
    });

    await waitFor(() => {
      expect(screen.getByText('Connection timed out')).toBeInTheDocument();
    });
  });

  it('shows error count in collapsible trigger when errorCount > 0', () => {
    render(
      <AdapterCardError instance={makeInstance({ errorCount: 5, lastError: 'Auth failed' })} />
    );
    expect(screen.getByText(/5 errors/)).toBeInTheDocument();
  });

  it('shows lastError as trigger text when errorCount is 0 but lastError exists', () => {
    render(
      <AdapterCardError instance={makeInstance({ errorCount: 0, lastError: 'Stale error' })} />
    );
    // Should show the lastError text in the trigger since errorCount is 0
    expect(screen.getByRole('button', { name: 'Toggle full error message' })).toBeInTheDocument();
  });

  it('does not render collapsible when lastError is undefined', () => {
    render(<AdapterCardError instance={makeInstance({ errorCount: 3 })} />);
    expect(
      screen.queryByRole('button', { name: 'Toggle full error message' })
    ).not.toBeInTheDocument();
  });
});
