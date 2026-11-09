import { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { UseQueryResult } from '@tanstack/react-query';
import type { InstructionsView } from '@dorkos/shared/agent-instructions-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { InstructionsViewer, type InstructionsSelection } from '../ui/InstructionsViewer';
import { templateParts } from '../ui/TemplateText';

const VIEW: InstructionsView = {
  mode: 'template',
  runtime: 'codex',
  place: 'direct',
  level: 'act',
  agentId: null,
  runtimeNotes: ['Codex: sent once at start, then again only when it changes.'],
  levelNote: 'Levels change which actions ask first, not these words.',
  variables: [{ id: 'agent.name', label: 'The agent’s name', fillable: true }],
  tokens: 12,
  blocks: [
    {
      id: 'agent_identity',
      title: 'Who the agent is',
      layer: 'session',
      source: 'agent.json',
      condition: 'agent',
      conditionNote: 'When the chat belongs to an agent.',
      locked: true,
      editIn: null,
      delivery: 'once',
      text: '<agent_identity>\nName: {{agent.name}}\n</agent_identity>',
      variables: ['agent.name'],
      tokens: 12,
      overrideCount: 2,
    },
    {
      id: 'git_status',
      title: 'Git status',
      layer: 'turn',
      source: 'session/context-assembler.ts',
      condition: 'state',
      conditionNote: 'When the folder is a git repo.',
      locked: true,
      editIn: null,
      delivery: 'every-turn',
      text: null,
      variables: [],
      tokens: 0,
    },
  ],
  notIncluded: [],
};

function result(data: InstructionsView): UseQueryResult<InstructionsView> {
  return { data, isError: false, isFetching: false, refetch: async () => ({}) } as never;
}

function Harness() {
  const [selection, setSelection] = useState<InstructionsSelection>({
    place: 'direct',
    level: 'act',
  });
  return (
    <TooltipProvider>
      <InstructionsViewer
        selection={selection}
        onSelectionChange={setSelection}
        result={result(VIEW)}
        intro="What every agent is told."
      />
    </TooltipProvider>
  );
}

afterEach(cleanup);

describe('InstructionsViewer', () => {
  it('lists blocks in model order, with locks and Codex’s once-only note', () => {
    render(<Harness />);
    const rows = screen.getAllByRole('button', { name: /Who the agent is|Git status/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Who the agent is'),
      expect.stringContaining('Git status'),
    ]);
    expect(screen.getAllByLabelText('Locked')).toHaveLength(2);
    expect(screen.getByText(/Sent once at start/)).toBeInTheDocument();
  });

  it('draws variables as chips and says how many agents override a block', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /Who the agent is/ }));
    expect(screen.getByText('agent.name')).toHaveAttribute('title', 'The agent’s name');
    expect(screen.getByText('2 agents override this.')).toBeInTheDocument();
  });

  it('says a per-turn block is built live, with no text to show', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /Git status/ }));
    expect(screen.getByText('Built each turn from what is happening.')).toBeInTheDocument();
  });
});

describe('templateParts', () => {
  it('chips only documented variables', () => {
    const labels = new Map([['agent.name', 'Name']]);
    expect(templateParts('Hi {{agent.name}} {{other.thing}}', labels)).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'variable', id: 'agent.name' },
      { kind: 'text', value: ' {{other.thing}}' },
    ]);
  });
});
