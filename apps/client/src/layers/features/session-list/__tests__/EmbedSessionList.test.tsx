/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { Session } from '@dorkos/shared/types';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { EmbedSessionList } from '../ui/EmbedSessionList';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// The fleet bar is its own surface with its own tests, and it reads the whole
// session cache — out of scope for the roster's shape.
vi.mock('../ui/FleetContextBar', () => ({ FleetContextBar: () => null }));

function makeSession(id: string, title: string): Session {
  return {
    id,
    title,
    createdAt: '2026-02-07T10:00:00Z',
    updatedAt: '2026-02-07T14:00:00Z',
    permissionMode: 'default',
    runtime: 'claude-code',
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const transport = createMockTransport();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function renderList(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper });
}

const TWO_GROUPS = [
  { label: 'Today', sessions: [makeSession('s1', 'First')] },
  { label: 'Yesterday', sessions: [makeSession('s2', 'Second')] },
];

afterEach(cleanup);

describe('EmbedSessionList', () => {
  it('renders one row per session, across groups', () => {
    renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={TWO_GROUPS}
        onSessionClick={() => {}}
      />
    );

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-sidebar-row]')).toHaveLength(2);
  });

  it('names each group with the shared section header, as a heading', () => {
    renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={TWO_GROUPS}
        onSessionClick={() => {}}
      />
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Yesterday' })).toBeInTheDocument();
  });

  it('writes group names in sentence case, not the retired ALL-CAPS', () => {
    renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={TWO_GROUPS}
        onSessionClick={() => {}}
      />
    );

    const heading = screen.getByRole('heading', { level: 3, name: 'Today' });
    expect(heading.className).not.toMatch(/uppercase|tracking-wider/);
  });

  it('drops the header when one bucket named Today is the whole list', () => {
    renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={[{ label: 'Today', sessions: [makeSession('s1', 'Only')] }]}
        onSessionClick={() => {}}
      />
    );

    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument();
    expect(screen.getByText('Only')).toBeInTheDocument();
  });

  it('keeps a single bucket that is not Today labelled', () => {
    renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={[{ label: 'Yesterday', sessions: [makeSession('s1', 'Only')] }]}
        onSessionClick={() => {}}
      />
    );

    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeInTheDocument();
  });

  it('opens the session that was clicked', () => {
    const onSessionClick = vi.fn();
    renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={TWO_GROUPS}
        onSessionClick={onSessionClick}
      />
    );

    fireEvent.click(document.querySelectorAll('[data-sidebar-row]')[1]!);

    expect(onSessionClick).toHaveBeenCalledWith('s2');
  });

  it('marks the active session and only that one', () => {
    renderList(
      <EmbedSessionList
        activeSessionId="s2"
        groupedSessions={TWO_GROUPS}
        onSessionClick={() => {}}
      />
    );

    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Second');
  });

  it('says so, quietly, when there is nothing yet', () => {
    renderList(
      <EmbedSessionList activeSessionId={null} groupedSessions={[]} onSessionClick={() => {}} />
    );

    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    expect(document.querySelector('[data-sidebar-row]')).toBeNull();
  });

  it('reports a runtime that could not be listed', () => {
    renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={TWO_GROUPS}
        warnings={[{ runtime: 'codex', message: 'Codex is starting' }]}
        onSessionClick={() => {}}
      />
    );

    expect(screen.getByTestId('session-list-warnings')).toBeInTheDocument();
    expect(screen.getByTestId('session-list-warning-codex')).toBeInTheDocument();
  });

  it('holds one tab stop per group, not one per row', () => {
    renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={[
          {
            label: 'Today',
            sessions: [makeSession('s1', 'First'), makeSession('s2', 'Second')],
          },
        ]}
        onSessionClick={() => {}}
      />
    );

    // Roving focus stamps every focusable in the section `-1` except its one
    // stop. Two rows, two "⋮" triggers, one section header — one stop.
    const stops = Array.from(document.querySelectorAll<HTMLElement>('button')).filter(
      (b) => b.tabIndex !== -1
    );
    expect(stops).toHaveLength(1);
  });

  it('draws no hairline anywhere — separation is tint (R1)', () => {
    const { container } = renderList(
      <EmbedSessionList
        activeSessionId={null}
        groupedSessions={TWO_GROUPS}
        onSessionClick={() => {}}
      />
    );

    expect(container.querySelector('[class*="border-t"],[class*="border-b"]')).toBeNull();
  });
});
