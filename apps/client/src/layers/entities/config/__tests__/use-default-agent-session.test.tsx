/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ServerConfig } from '@dorkos/shared/types';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

let mockConfig: Partial<ServerConfig> | undefined;
vi.mock('../model/use-config', () => ({
  useConfig: () => ({ data: mockConfig }),
}));

let mockAgentPaths: AgentPathEntry[];
const mockListMeshAgentPaths = vi.fn(() => Promise.resolve({ agents: mockAgentPaths }));
vi.mock('@/layers/shared/model', () => ({
  useTransport: () => ({ listMeshAgentPaths: mockListMeshAgentPaths }),
}));

import { resolveDefaultAgentDir, useDefaultAgentSession } from '../model/use-default-agent-session';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('resolveDefaultAgentDir', () => {
  it('falls back to DorkBot under ~/.dork/agents when config is absent', () => {
    expect(resolveDefaultAgentDir(undefined)).toBe('~/.dork/agents/dorkbot');
  });

  it('uses the configured default agent and directory', () => {
    const config = {
      agents: { defaultAgent: 'scout', defaultDirectory: '/custom/agents' },
    } as ServerConfig;
    expect(resolveDefaultAgentDir(config)).toBe('/custom/agents/scout');
  });
});

describe('useDefaultAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = { agents: { defaultAgent: 'dorkbot', defaultDirectory: '~/.dork/agents' } };
    mockAgentPaths = [];
  });

  it('prefers the agent REGISTERED absolute path (never the literal tilde) and navigates there', async () => {
    mockAgentPaths = [{ id: '1', name: 'dorkbot', projectPath: '/home/kai/.dork/agents/dorkbot' }];
    const { result } = renderHook(() => useDefaultAgentSession(), { wrapper });

    await waitFor(() =>
      expect(result.current.defaultAgentDir).toBe('/home/kai/.dork/agents/dorkbot')
    );
    expect(result.current.defaultAgentDir).not.toContain('~');

    result.current.startSession();
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/home/kai/.dork/agents/dorkbot' },
    });
  });

  it('matches the configured default agent name, not just DorkBot', async () => {
    mockConfig = { agents: { defaultAgent: 'scout', defaultDirectory: '/custom/agents' } };
    mockAgentPaths = [
      { id: '1', name: 'dorkbot', projectPath: '/home/kai/.dork/agents/dorkbot' },
      { id: '2', name: 'scout', projectPath: '/home/kai/projects/scout' },
    ];
    const { result } = renderHook(() => useDefaultAgentSession(), { wrapper });
    await waitFor(() => expect(result.current.defaultAgentDir).toBe('/home/kai/projects/scout'));
  });

  it('falls back to the config-composed dir when the agent is not yet registered', async () => {
    mockAgentPaths = [];
    const { result } = renderHook(() => useDefaultAgentSession(), { wrapper });
    // No registered match — the last-resort compose is used.
    await waitFor(() => expect(mockListMeshAgentPaths).toHaveBeenCalled());
    expect(result.current.defaultAgentDir).toBe('~/.dork/agents/dorkbot');
  });
});
