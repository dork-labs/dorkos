/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentHubContext } from '../model/agent-hub-context';

describe('useAgentHubContext', () => {
  it('throws when used outside AgentHubProvider', () => {
    expect(() => {
      renderHook(() => useAgentHubContext());
    }).toThrow('useAgentHubContext must be used within an AgentHubProvider');
  });
});
