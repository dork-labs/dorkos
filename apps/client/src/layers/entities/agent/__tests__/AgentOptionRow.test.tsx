/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentOptionRow } from '../ui/AgentOptionRow';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

const AGENT: AgentPathEntry = {
  id: 'agent-1',
  name: 'code-reviewer',
  displayName: 'Code Reviewer',
  projectPath: '/home/user/projects/api',
};

describe('AgentOptionRow', () => {
  it('renders the agent display name by default', () => {
    render(<AgentOptionRow agent={AGENT} />);
    expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
  });

  it('renders an overridden name node instead of the plain display name', () => {
    render(<AgentOptionRow agent={AGENT} name={<mark>Code</mark>} />);
    expect(screen.queryByText('Code Reviewer')).not.toBeInTheDocument();
    const mark = screen.getByText('Code', { selector: 'mark' });
    expect(mark).toBeInTheDocument();
  });

  it('renders secondary text when provided', () => {
    const { container } = render(<AgentOptionRow agent={AGENT} secondary="~/projects/api" />);
    expect(container.querySelector('[data-slot="agent-option-row-secondary"]')).toHaveTextContent(
      '~/projects/api'
    );
  });

  it('renders no secondary element when omitted', () => {
    const { container } = render(<AgentOptionRow agent={AGENT} />);
    expect(
      container.querySelector('[data-slot="agent-option-row-secondary"]')
    ).not.toBeInTheDocument();
  });

  it('renders a default checkmark when selected and no trailing is given', () => {
    const { container } = render(<AgentOptionRow agent={AGENT} selected />);
    expect(container.querySelector('.lucide-check')).toBeInTheDocument();
  });

  it('renders no checkmark when not selected', () => {
    const { container } = render(<AgentOptionRow agent={AGENT} selected={false} />);
    expect(container.querySelector('.lucide-check')).not.toBeInTheDocument();
  });

  it('renders custom trailing content instead of the default checkmark, even when selected', () => {
    const { container } = render(
      <AgentOptionRow agent={AGENT} selected trailing={<span data-testid="custom-trailing" />} />
    );
    expect(screen.getByTestId('custom-trailing')).toBeInTheDocument();
    expect(container.querySelector('.lucide-check')).not.toBeInTheDocument();
  });

  it('renders the agent avatar', () => {
    const { container } = render(<AgentOptionRow agent={AGENT} />);
    expect(container.querySelector('[data-slot="agent-avatar"]')).toBeInTheDocument();
  });

  it('gives the name a floor the path beside it cannot push through', () => {
    // Both items shrink in proportion to their own length, so a short name
    // loses most of itself while a long path loses a slice and still reads —
    // "DorkBot" came out as "Dork…" beside fifty characters of path
    // (DOR-1747). The floor makes the path yield first.
    const { container } = render(
      <AgentOptionRow agent={AGENT} secondary="~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork" />
    );

    const name = screen.getByText('Code Reviewer');
    expect(name).toHaveClass('min-w-[8ch]');
    expect(name).not.toHaveClass('min-w-0');

    // The path may shrink to nothing, which is what keeps the row contained.
    const secondary = container.querySelector('[data-slot="agent-option-row-secondary"]');
    expect(secondary).toHaveClass('min-w-0');
    expect(secondary).toHaveClass('truncate');
  });
});
