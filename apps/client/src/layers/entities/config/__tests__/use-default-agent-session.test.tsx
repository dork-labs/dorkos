/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ServerConfig } from '@dorkos/shared/types';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

let mockConfig: Partial<ServerConfig> | undefined;
vi.mock('../model/use-config', () => ({
  useConfig: () => ({ data: mockConfig }),
}));

import { resolveDefaultAgentDir, useDefaultAgentSession } from '../model/use-default-agent-session';

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
  });

  it('navigates to /session with the default agent dir', () => {
    const { result } = renderHook(() => useDefaultAgentSession());
    result.current.startSession();
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '~/.dork/agents/dorkbot' },
    });
  });

  it('exposes the resolved default agent dir', () => {
    const { result } = renderHook(() => useDefaultAgentSession());
    expect(result.current.defaultAgentDir).toBe('~/.dork/agents/dorkbot');
  });
});
