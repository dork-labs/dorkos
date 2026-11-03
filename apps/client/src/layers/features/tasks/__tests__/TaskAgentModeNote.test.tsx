/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Task } from '@dorkos/shared/types';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '@/layers/shared/model';
import { TaskAgentModeNote } from '../ui/TaskAgentModeNote';

type AgentModeRecord = NonNullable<Task['agentModeRecord']>;

function renderNote(record: AgentModeRecord) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TransportProvider transport={createMockTransport()}>
        <TaskAgentModeNote record={record} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

const NOW = new Date().toISOString();

describe('TaskAgentModeNote (DOR-3703)', () => {
  afterEach(() => cleanup());

  it('names the agent that approved the task, and the mode before and after', () => {
    renderNote({
      kind: 'approved',
      agentPath: '/agents/lab-scout',
      agentName: 'Lab Scout',
      at: NOW,
      mode: 'dontAsk',
      previousMode: 'acceptEdits',
    });
    expect(screen.getByText(/Lab Scout approved it: Never ask, was Accept edits/)).toBeTruthy();
  });

  it('says an agent set the mode when it cannot be named, and leaves out an unchanged mode', () => {
    renderNote({
      kind: 'set_mode',
      agentPath: '/agents/x',
      agentName: null,
      at: NOW,
      mode: 'plan',
      previousMode: 'plan',
    });
    const text = screen.getByText(/An agent set Plan/).textContent ?? '';
    expect(text).not.toContain('was');
  });

  it('shows hidden characters in a name an agent chose', () => {
    renderNote({
      kind: 'approved',
      agentPath: '/agents/x',
      agentName: 'You‮',
      at: NOW,
      mode: 'dontAsk',
      previousMode: null,
    });
    const text = document.querySelector('[data-slot="task-agent-mode-note"]')?.textContent ?? '';
    expect(text).not.toContain('\u202e');
    expect(text).toContain('approved it');
  });

  it('names Bypass by its full label even before the runtime’s modes load', () => {
    renderNote({
      kind: 'set_mode',
      agentPath: '/agents/x',
      agentName: 'Lab Scout',
      at: NOW,
      mode: 'bypassPermissions',
      previousMode: 'acceptEdits',
    });
    const text = document.querySelector('[data-slot="task-agent-mode-note"]')?.textContent ?? '';
    expect(text).toContain('Lab Scout set Bypass permissions, was Accept edits');
    expect(text).not.toContain('Bypass all');
  });
});
