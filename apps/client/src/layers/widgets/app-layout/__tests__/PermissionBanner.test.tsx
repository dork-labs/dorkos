// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionBanner } from '../ui/PermissionBanner';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/lib';

afterEach(() => {
  cleanup();
});

function createMockTransport(): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    getCommands: vi.fn(),
    health: vi.fn(),
    updateSession: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ path: '/test', entries: [], parent: null }),
    getDefaultCwd: vi.fn().mockResolvedValue({ path: '/test/cwd' }),
    listFiles: vi.fn().mockResolvedValue({ files: [], truncated: false, total: 0 }),
    getConfig: vi.fn().mockResolvedValue({ version: '1.0.0', port: 6942, uptime: 0, workingDirectory: '/test', nodeVersion: 'v20.0.0', claudeCliPath: null, tunnel: { enabled: false, connected: false, url: null, authEnabled: false, tokenConfigured: false } }),
    getGitStatus: vi.fn().mockResolvedValue({ error: 'not_git_repo' as const }),
  };
}

function createWrapper(sessionData?: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (sessionData) {
    queryClient.setQueryData(['session', sessionData.id], sessionData);
  }
  const transport = createMockTransport();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('PermissionBanner', () => {
  it('returns null when sessionId is null', () => {
    const { container } = render(
      <PermissionBanner sessionId={null} />,
      { wrapper: createWrapper() }
    );
    expect(container.textContent).toBe('');
  });

  it('returns null when session has no data yet', () => {
    const { container } = render(
      <PermissionBanner sessionId="s-unknown" />,
      { wrapper: createWrapper() }
    );
    expect(container.textContent).toBe('');
  });

  it('returns null for default permission mode', () => {
    const session = {
      id: 's1',
      permissionMode: 'default',
      title: 'Test',
      createdAt: '',
      updatedAt: '',
    };
    const { container } = render(
      <PermissionBanner sessionId="s1" />,
      { wrapper: createWrapper(session) }
    );
    expect(container.textContent).toBe('');
  });

  it('returns null even for bypassPermissions mode (banner hidden)', () => {
    const session = {
      id: 's2',
      permissionMode: 'bypassPermissions',
      title: 'Test',
      createdAt: '',
      updatedAt: '',
    };
    const { container } = render(
      <PermissionBanner sessionId="s2" />,
      { wrapper: createWrapper(session) }
    );
    expect(container.textContent).toBe('');
  });
});
