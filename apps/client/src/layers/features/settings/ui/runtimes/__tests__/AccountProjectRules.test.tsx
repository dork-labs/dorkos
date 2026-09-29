/**
 * @vitest-environment jsdom
 *
 * Where each Claude account may work, as Settings → Runtimes shows and changes
 * it (spec `flow-multiproject` §8.5): the "Only for" line, the "Limit to
 * projects" dialog, and the "Project limits" list.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  LimitToProjectsDialog,
  OnlyForLine,
  ProjectLimitsList,
} from '../sections/AccountProjectRules';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  // Radix primitives call pointer-capture APIs jsdom lacks.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.setPointerCapture) proto.setPointerCapture = vi.fn();
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CLIENT_APP = { root: '/work/client-app', name: 'client-app' };
const CLIENT_API = { root: '/work/client-api', name: 'client-api' };

function renderWith(ui: React.ReactElement, overrides = {}) {
  const transport = createMockTransport({
    listProjects: vi.fn().mockResolvedValue(
      [CLIENT_APP, CLIENT_API].map((p) => ({
        ...p,
        originRepo: null,
        lastSeenAt: '2026-09-29T10:00:00.000Z',
      }))
    ),
    ...overrides,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
  return transport;
}

describe('OnlyForLine', () => {
  // Purpose: the row says which projects the account is kept to, names joined.
  it('names the projects, and says nothing for an account that may work anywhere', () => {
    const { rerender } = render(<OnlyForLine onlyProjects={[CLIENT_APP]} />);
    expect(screen.getByText('Only for client-app')).toBeInTheDocument();
    rerender(<OnlyForLine onlyProjects={[CLIENT_APP, CLIENT_API]} />);
    expect(screen.getByText('Only for client-app and client-api')).toBeInTheDocument();
    rerender(<OnlyForLine onlyProjects={[]} />);
    expect(screen.getByText('Not used in any project')).toBeInTheDocument();
    rerender(<OnlyForLine onlyProjects={null} />);
    expect(screen.queryByTestId('claude-account-only-for')).not.toBeInTheDocument();
  });
});

describe('LimitToProjectsDialog', () => {
  // Purpose: choosing projects writes the account's own rule with their roots.
  it('keeps the account to the ticked projects', async () => {
    const onOpenChange = vi.fn();
    const transport = renderWith(
      <LimitToProjectsDialog
        open
        onOpenChange={onOpenChange}
        accountId="work"
        accountName="Work"
        current={null}
      />
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Only these projects' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'client-app' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.setAccountOnlyProjects).toHaveBeenCalledWith('work', ['/work/client-app'])
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // Purpose: "Any project" clears the rule (null), for Main too.
  it('frees the account with "Any project"', async () => {
    const transport = renderWith(
      <LimitToProjectsDialog
        open
        onOpenChange={vi.fn()}
        accountId="default"
        accountName="Main"
        current={[CLIENT_APP]}
      />
    );
    expect(await screen.findByRole('checkbox', { name: 'client-app' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Any project' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.setAccountOnlyProjects).toHaveBeenCalledWith('default', null)
    );
  });

  // Purpose: "Only these projects" with nothing ticked is refused in plain
  // words before anything is sent.
  it('refuses "Only these projects" with none ticked', async () => {
    const transport = renderWith(
      <LimitToProjectsDialog
        open
        onOpenChange={vi.fn()}
        accountId="work"
        accountName="Work"
        current={null}
      />
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Only these projects' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Tick at least one project, or choose Any project.'
    );
    expect(transport.setAccountOnlyProjects).not.toHaveBeenCalled();
  });

  // Purpose: a project the rule names whose folder is gone stays ticked and is
  // sent back as it was, never dropped by a save.
  it('keeps a project whose folder is gone', async () => {
    const gone = { root: '/work/unplugged', name: 'unplugged' };
    const transport = renderWith(
      <LimitToProjectsDialog
        open
        onOpenChange={vi.fn()}
        accountId="work"
        accountName="Work"
        current={[gone]}
      />
    );
    expect(await screen.findByRole('checkbox', { name: 'unplugged' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.setAccountOnlyProjects).toHaveBeenCalledWith('work', ['/work/unplugged'])
    );
  });

  // Purpose: a refused write shows the server's own sentence and stays open.
  it('shows why a write was refused', async () => {
    const onOpenChange = vi.fn();
    renderWith(
      <LimitToProjectsDialog
        open
        onOpenChange={onOpenChange}
        accountId="work"
        accountName="Work"
        current={null}
      />,
      {
        setAccountOnlyProjects: vi
          .fn()
          .mockRejectedValue(new Error('Only a person can change where an account may be used.')),
      }
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a person can change where an account may be used.'
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('ProjectLimitsList', () => {
  // Purpose: a person can always see and undo a project's list from core.
  it('lists each project and its accounts, and Remove lets it use every account', async () => {
    const transport = renderWith(
      <ProjectLimitsList
        limits={[{ project: CLIENT_APP, allow: ['work', 'default'] }]}
        nameForId={(id) => (id === 'default' ? 'Main' : 'Work')}
      />
    );
    expect(screen.getByText('client-app')).toBeInTheDocument();
    expect(screen.getByText('Uses only Work and Main')).toBeInTheDocument();
    expect(screen.getByTestId('project-limits-note')).toHaveTextContent(
      'set by the Flow extension or a script'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Let client-app use every account' }));
    await waitFor(() =>
      expect(transport.setProjectAccounts).toHaveBeenCalledWith('/work/client-app', null)
    );
  });

  // Purpose: nothing is drawn when no project has a list.
  it('renders nothing without limits', () => {
    renderWith(<ProjectLimitsList limits={[]} nameForId={(id) => id} />);
    expect(screen.queryByTestId('project-limits')).not.toBeInTheDocument();
  });
});
