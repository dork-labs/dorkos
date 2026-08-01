/**
 * @vitest-environment jsdom
 */
/**
 * The standing banner for autonomy nobody is watching: what it says, when it
 * says nothing, and where its two links go.
 *
 * The rule deciding WHICH drivers reach this component is the server's
 * (`services/core/unattended-autonomy/`). What is pinned here is the
 * half a person actually meets — that the banner names the things by name rather
 * than counting them, that it never appears over an empty list, and that each
 * link lands on the surface that can switch the thing off.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { UnattendedAutonomyDriver } from '@dorkos/shared/permission-semantics';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => ({}),
  useRouterState: () => '/',
}));

import { UnattendedAutonomyBanner } from '../ui/UnattendedAutonomyBanner';

// motion reads matchMedia (reduced-motion) which jsdom does not implement.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

const deploys: UnattendedAutonomyDriver = { kind: 'binding', id: 'b1', name: 'Deploys' };

const cleanup_task: UnattendedAutonomyDriver = {
  kind: 'task',
  id: 't1',
  name: 'Nightly cleanup',
};

describe('UnattendedAutonomyBanner', () => {
  it('renders nothing when nothing is running unattended', () => {
    const { container } = render(<UnattendedAutonomyBanner drivers={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names a single driver and what kind of thing it is', () => {
    render(<UnattendedAutonomyBanner drivers={[cleanup_task]} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'The Nightly cleanup task runs without asking.'
    );
  });

  it('names both drivers when two are running', () => {
    render(<UnattendedAutonomyBanner drivers={[deploys, cleanup_task]} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'The Deploys integration and the Nightly cleanup task run without asking.'
    );
  });

  it('names the first two and counts the rest', () => {
    render(
      <UnattendedAutonomyBanner
        drivers={[
          deploys,
          cleanup_task,
          { ...deploys, id: 'b2', name: 'Support' },
          { ...cleanup_task, id: 't2', name: 'Digest' },
        ]}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'The Deploys integration, the Nightly cleanup task and 2 more run without asking.'
    );
  });

  it('says why it matters — nobody is there to answer', () => {
    render(<UnattendedAutonomyBanner drivers={[cleanup_task]} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Nobody is watching, so nothing waits for your approval.'
    );
  });

  it('is amber, not red — a standing setting, not an incident', () => {
    render(<UnattendedAutonomyBanner drivers={[deploys]} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-variant', 'warning');
  });

  it('cannot be dismissed — the condition is standing, not an announcement', () => {
    render(<UnattendedAutonomyBanner drivers={[deploys]} />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it('offers only the surfaces it actually named', () => {
    render(<UnattendedAutonomyBanner drivers={[cleanup_task]} />);
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Integrations' })).not.toBeInTheDocument();
  });

  it('sends a person to the integrations dialog', async () => {
    render(<UnattendedAutonomyBanner drivers={[deploys]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Integrations' }));

    expect(navigate).toHaveBeenCalledTimes(1);
    const arg = navigate.mock.calls[0]![0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(arg.search({})).toEqual({ relay: 'open' });
  });

  it('sends a person to the tasks page', async () => {
    render(<UnattendedAutonomyBanner drivers={[cleanup_task]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    expect(navigate).toHaveBeenCalledWith({ to: '/tasks' });
  });
});
