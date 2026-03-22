/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { InjectionPreview } from '../ui/InjectionPreview';

// Mock shared modules
vi.mock('@dorkos/shared/convention-files', () => ({
  buildSoulContent: vi.fn((traits: string, prose: string) => `TRAITS:${traits}\n${prose}`),
  extractCustomProse: vi.fn(() => '## Identity'),
  TRAIT_SECTION_START: '<!-- TRAITS:START -->',
}));
vi.mock('@dorkos/shared/trait-renderer', () => ({
  renderTraits: vi.fn(() => 'rendered-traits'),
  DEFAULT_TRAITS: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
}));

const defaultProps = {
  agentName: 'test-agent',
  agentId: 'test-id',
  agentDescription: 'A test agent',
  agentCapabilities: ['coding'],
  traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
  conventions: { soul: true, nope: true },
  soulContent: '<!-- TRAITS:START -->\ntraits\n<!-- TRAITS:END -->\n\n## Identity',
  nopeContent: '# Safety Boundaries',
};

describe('InjectionPreview', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders expand/collapse toggle', () => {
    const { container } = render(<InjectionPreview {...defaultProps} />);
    expect(within(container).getByText('Preview injected prompt')).toBeInTheDocument();
  });

  it('is collapsed by default', () => {
    const { container } = render(<InjectionPreview {...defaultProps} />);
    expect(within(container).queryByText(/agent_identity/)).not.toBeInTheDocument();
  });

  it('shows preview when expanded', () => {
    const { container } = render(<InjectionPreview {...defaultProps} />);

    fireEvent.click(within(container).getByText('Preview injected prompt'));
    expect(within(container).getByText(/agent_identity/)).toBeInTheDocument();
  });

  it('omits persona block when soul toggle is off', () => {
    const { container } = render(
      <InjectionPreview {...defaultProps} conventions={{ soul: false, nope: true }} />
    );

    fireEvent.click(within(container).getByText('Preview injected prompt'));
    expect(within(container).queryByText(/agent_persona/)).not.toBeInTheDocument();
  });

  it('omits safety block when nope toggle is off', () => {
    const { container } = render(
      <InjectionPreview {...defaultProps} conventions={{ soul: true, nope: false }} />
    );

    fireEvent.click(within(container).getByText('Preview injected prompt'));
    expect(within(container).queryByText(/agent_safety_boundaries/)).not.toBeInTheDocument();
  });

  it('has aria-expanded attribute', () => {
    const { container } = render(<InjectionPreview {...defaultProps} />);

    const button = within(container).getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows identity block with agent name and id when expanded', () => {
    const { container } = render(<InjectionPreview {...defaultProps} />);

    fireEvent.click(within(container).getByText('Preview injected prompt'));

    const code = container.querySelector('pre code');
    expect(code).toBeTruthy();
    const previewText = code!.textContent!;
    expect(previewText).toContain('Name: test-agent');
    expect(previewText).toContain('ID: test-id');
    expect(previewText).toContain('Description: A test agent');
    expect(previewText).toContain('Capabilities: coding');
  });

  it('shows safety boundaries block when nope is enabled and content present', () => {
    const { container } = render(<InjectionPreview {...defaultProps} />);

    fireEvent.click(within(container).getByText('Preview injected prompt'));

    const code = container.querySelector('pre code');
    expect(code!.textContent).toContain('<agent_safety_boundaries>');
    expect(code!.textContent).toContain('# Safety Boundaries');
  });

  it('omits safety block when nopeContent is empty even if nope toggle is on', () => {
    const { container } = render(<InjectionPreview {...defaultProps} nopeContent="" />);

    fireEvent.click(within(container).getByText('Preview injected prompt'));
    expect(within(container).queryByText(/agent_safety_boundaries/)).not.toBeInTheDocument();
  });

  it('collapses when toggle button clicked again', () => {
    const { container } = render(<InjectionPreview {...defaultProps} />);

    const button = within(container).getByRole('button');

    fireEvent.click(button);
    expect(within(container).getByText(/agent_identity/)).toBeInTheDocument();

    fireEvent.click(button);
    expect(within(container).queryByText(/agent_identity/)).not.toBeInTheDocument();
  });
});
