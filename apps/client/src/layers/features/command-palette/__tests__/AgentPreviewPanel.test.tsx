/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { AgentPreviewPanel } from '../ui/AgentPreviewPanel';

// The panel animates its own width in; plain elements keep the assertions about
// what is drawn rather than when.
vi.mock('motion/react', () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      React.createElement('div', props, children),
  },
}));

vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({ sessionCount: 0, recentSessions: [], health: null }),
}));

const AGENT = {
  id: 'agent-1',
  name: 'api-bot',
  projectPath: '/home/kai/api',
  color: '#6366f1',
  icon: '🤖',
} as AgentPathEntry;

describe('AgentPreviewPanel', () => {
  afterEach(() => cleanup());

  it('draws the previewed agent as an agent, not a bare colour dot', () => {
    const { container } = render(<AgentPreviewPanel agent={AGENT} />);

    expect(screen.getByText('api-bot')).toBeTruthy();

    const disc = container.querySelector('[data-slot="agent-avatar"]');
    expect(disc).toBeTruthy();
    // Square, filled with the agent's own colour, and wearing the Bot mark —
    // the three things the hand-rolled `<span>` dot + emoji could not say.
    expect(disc?.className).toContain('rounded-lg');
    expect(disc?.className).not.toContain('rounded-full');
    expect(disc?.getAttribute('style')).toContain('#6366f1');
    expect(disc?.querySelector('[data-slot="identity-badge"]')).toBeTruthy();
  });

  it('heads the panel a step larger than the palette rows it previews', () => {
    const { container } = render(<AgentPreviewPanel agent={AGENT} />);

    // `sm` (28px), where `AgentOptionRow` and `SessionCommandItem` use `xs`
    // (20px): this line is the panel's heading, not another row in the list.
    expect(container.querySelector('[data-slot="agent-avatar"]')?.className).toContain('size-7');
  });
});
