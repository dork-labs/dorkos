// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PanelResourceVisible } from '@/layers/shared/model';
import { LocalBrowserContent } from '../ui/LocalBrowserContent';

const context = vi.hoisted(() => ({
  pathname: '/session',
  selectedCwd: '/unrelated-selected-agent',
  sessionId: 'last-chat' as string | null,
  routeSessionId: 'current-chat',
  rightPanelOpen: true,
  activeRightPanelTab: 'local-browser',
}));
const currentAgent = vi.hoisted(() => vi.fn(() => ({ data: { name: 'Kai' } })));
const currentSession = vi.hoisted(() =>
  vi.fn((id: string | null) => ({ data: id ? { cwd: '/owned-agent' } : undefined }))
);
vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => [context.routeSessionId, vi.fn()],
  useSessionRow: currentSession,
}));
vi.mock('@/layers/entities/agent', () => ({ useCurrentAgent: currentAgent }));
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => context.pathname }));
vi.mock('@/layers/shared/model', async () => ({
  PanelResourceVisible: (await import('react')).createContext(true),
  useAppStore: (select: (state: typeof context) => unknown) => select(context),
}));
vi.mock('../ui/LocalBrowserPanel', () => ({
  LocalBrowserPanel: ({
    sessionId,
    visible,
    agentName,
  }: {
    sessionId: string | null;
    visible: boolean;
    agentName?: string | null;
  }) => (
    <div
      data-testid="browser-scope"
      data-session={sessionId ?? 'human-only'}
      data-visible={visible}
      data-agent={agentName ?? 'none'}
    />
  ),
}));
beforeEach(() => {
  context.pathname = '/session';
  context.routeSessionId = 'current-chat';
  context.sessionId = 'last-chat';
  context.rightPanelOpen = true;
  context.activeRightPanelTab = 'local-browser';
});
describe('LocalBrowserContent', () => {
  it.each([null, 'last-chat'])('shares with the route when the legacy selection is %s', (id) => {
    context.sessionId = id;
    render(<LocalBrowserContent />);
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-session', 'current-chat');
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-agent', 'Kai');
    expect(currentSession).toHaveBeenLastCalledWith('current-chat', {
      enabled: true,
      nameOnly: true,
    });
    expect(currentAgent).toHaveBeenLastCalledWith('/owned-agent');
  });
  it('follows a route change while the legacy selection stays behind', () => {
    const view = render(<LocalBrowserContent />);
    context.routeSessionId = 'next-chat';
    view.rerender(<LocalBrowserContent />);
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-session', 'next-chat');
    expect(currentSession).toHaveBeenLastCalledWith('next-chat', {
      enabled: true,
      nameOnly: true,
    });
  });
  it('keeps room browsing human-only even with a remembered direct chat', () => {
    context.pathname = '/team';
    render(<LocalBrowserContent />);
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-session', 'human-only');
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-agent', 'none');
    expect(currentAgent).toHaveBeenLastCalledWith(null);
  });
  it('hides native presentation when its resource closes or its PiP host becomes inactive', () => {
    const view = render(
      <PanelResourceVisible value={false}>
        <LocalBrowserContent />
      </PanelResourceVisible>
    );
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-visible', 'false');
    view.rerender(
      <PanelResourceVisible value>
        <LocalBrowserContent />
      </PanelResourceVisible>
    );
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-visible', 'true');
    view.rerender(
      <PanelResourceVisible value={false}>
        <LocalBrowserContent />
      </PanelResourceVisible>
    );
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-visible', 'false');
  });
  it('hides native presentation when the panel closes or switches view', () => {
    const view = render(<LocalBrowserContent />);
    context.rightPanelOpen = false;
    view.rerender(<LocalBrowserContent />);
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-visible', 'false');
    context.rightPanelOpen = true;
    context.activeRightPanelTab = 'canvas';
    view.rerender(<LocalBrowserContent />);
    expect(screen.getByTestId('browser-scope')).toHaveAttribute('data-visible', 'false');
  });
});
