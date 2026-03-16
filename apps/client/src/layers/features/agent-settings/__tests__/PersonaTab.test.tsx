// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { PersonaTab } from '../ui/PersonaTab';

const baseAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A test agent',
  runtime: 'claude-code',
  capabilities: ['code-review', 'testing'],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  persona: 'You are a backend expert.',
} as AgentManifest;

describe('PersonaTab', () => {
  let onUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onUpdate = vi.fn();
  });

  it('renders the toggle and it controls persona enabled state', () => {
    const { container } = render(<PersonaTab agent={baseAgent} onUpdate={onUpdate} />);

    const toggle = within(container).getByRole('switch');
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Toggle off
    fireEvent.click(toggle);
    expect(onUpdate).toHaveBeenCalledWith({ personaEnabled: false });
  });

  it('textarea is disabled when toggle is off', () => {
    const agent = {
      ...baseAgent,
      personaEnabled: false,
    } as AgentManifest;

    const { container } = render(<PersonaTab agent={agent} onUpdate={onUpdate} />);

    const textarea = within(container).getByPlaceholderText(
      'You are backend-bot, an expert in REST API design...'
    );
    expect(textarea).toBeDisabled();
  });

  it('textarea is enabled when toggle is on', () => {
    const { container } = render(<PersonaTab agent={baseAgent} onUpdate={onUpdate} />);

    const textarea = within(container).getByPlaceholderText(
      'You are backend-bot, an expert in REST API design...'
    );
    expect(textarea).not.toBeDisabled();
  });

  it('shows correct character count', () => {
    const { container } = render(<PersonaTab agent={baseAgent} onUpdate={onUpdate} />);

    // "You are a backend expert." is 25 chars
    expect(within(container).getByText('25 / 4,000')).toBeInTheDocument();
  });

  it('shows character count of 0 when no persona', () => {
    const agent = { ...baseAgent, persona: undefined } as AgentManifest;
    const { container } = render(<PersonaTab agent={agent} onUpdate={onUpdate} />);

    expect(within(container).getByText('0 / 4,000')).toBeInTheDocument();
  });

  it('preview shows agent_identity block', () => {
    const { container } = render(<PersonaTab agent={baseAgent} onUpdate={onUpdate} />);

    const code = container.querySelector('pre code');
    expect(code).toBeTruthy();
    const previewText = code!.textContent!;

    expect(previewText).toContain('<agent_identity>');
    expect(previewText).toContain('Name: test-agent');
    expect(previewText).toContain('ID: 01HZ0000000000000000000001');
    expect(previewText).toContain('Description: A test agent');
    expect(previewText).toContain('Capabilities: code-review, testing');
    expect(previewText).toContain('</agent_identity>');
  });

  it('preview shows agent_persona when enabled and text non-empty', () => {
    const { container } = render(<PersonaTab agent={baseAgent} onUpdate={onUpdate} />);

    const code = container.querySelector('pre code');
    expect(code).toBeTruthy();
    const previewText = code!.textContent!;

    expect(previewText).toContain('<agent_persona>');
    expect(previewText).toContain('You are a backend expert.');
    expect(previewText).toContain('</agent_persona>');
  });

  it('preview hides agent_persona when toggle off', () => {
    const agent = {
      ...baseAgent,
      personaEnabled: false,
      persona: 'You are a backend expert.',
    } as AgentManifest;

    const { container } = render(<PersonaTab agent={agent} onUpdate={onUpdate} />);

    const code = container.querySelector('pre code');
    expect(code).toBeTruthy();
    const previewText = code!.textContent!;

    expect(previewText).toContain('<agent_identity>');
    expect(previewText).not.toContain('<agent_persona>');
  });

  it('preview hides agent_persona when persona text is empty', () => {
    const agent = {
      ...baseAgent,
      personaEnabled: true,
      persona: '',
    } as AgentManifest;

    const { container } = render(<PersonaTab agent={agent} onUpdate={onUpdate} />);

    const code = container.querySelector('pre code');
    expect(code).toBeTruthy();
    const previewText = code!.textContent!;

    expect(previewText).not.toContain('<agent_persona>');
  });

  it('treats personaEnabled as true when undefined (default behavior)', () => {
    const { personaEnabled: _, ...withoutEnabled } = baseAgent as Record<string, unknown>;
    const agent = {
      ...withoutEnabled,
      persona: 'Some persona',
    } as unknown as AgentManifest;

    const { container } = render(<PersonaTab agent={agent} onUpdate={onUpdate} />);

    const toggle = within(container).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    const textarea = within(container).getByPlaceholderText(
      'You are backend-bot, an expert in REST API design...'
    );
    expect(textarea).not.toBeDisabled();

    const code = container.querySelector('pre code');
    expect(code!.textContent).toContain('<agent_persona>');
  });

  it('shows guidance text', () => {
    const { container } = render(<PersonaTab agent={baseAgent} onUpdate={onUpdate} />);

    expect(
      within(container).getByText(/appended to Claude Code's system prompt/)
    ).toBeInTheDocument();
  });

  it('calls onUpdate on blur when persona text changed', () => {
    const { container } = render(<PersonaTab agent={baseAgent} onUpdate={onUpdate} />);

    const textarea = within(container).getByPlaceholderText(
      'You are backend-bot, an expert in REST API design...'
    );

    fireEvent.change(textarea, { target: { value: 'New persona text' } });
    fireEvent.blur(textarea);

    expect(onUpdate).toHaveBeenCalledWith({ persona: 'New persona text' });
  });
});
