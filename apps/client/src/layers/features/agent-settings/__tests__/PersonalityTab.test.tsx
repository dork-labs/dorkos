/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
// Mock useDebouncedInput before importing PersonalityTab (prevents Zustand app-store init)
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useDebouncedInput: (serverValue: string) => ({
      value: serverValue,
      onChange: vi.fn(),
      onBlur: vi.fn(),
    }),
  };
});

import { PersonalityTab } from '../ui/PersonalityTab';

// Mock child components to isolate PersonalityTab tests
vi.mock('@/layers/entities/agent', () => ({
  TraitSliders: ({ traits }: { traits: Record<string, number> }) => (
    <div data-testid="trait-sliders" data-traits={JSON.stringify(traits)} />
  ),
}));
vi.mock('../ui/ConventionFileEditor', () => ({
  ConventionFileEditor: ({ title }: { title: string }) => <div data-testid={`editor-${title}`} />,
}));
vi.mock('../ui/InjectionPreview', () => ({
  InjectionPreview: () => <div data-testid="injection-preview" />,
}));
vi.mock('@dorkos/shared/convention-files', () => ({
  SOUL_MAX_CHARS: 4000,
  NOPE_MAX_CHARS: 2000,
  extractCustomProse: vi.fn((content: string) => content),
  buildSoulContent: vi.fn((t: string, p: string) => `traits:${t}\n${p}`),
  TRAIT_SECTION_START: '<!-- TRAITS:START -->',
}));
vi.mock('@dorkos/shared/trait-renderer', () => ({
  renderTraits: vi.fn(() => 'rendered'),
  DEFAULT_TRAITS: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
  TRAIT_ORDER: ['tone', 'autonomy', 'caution', 'communication', 'creativity'],
  TRAIT_PREVIEWS: {
    tone: { 3: 'Balanced tone.' },
    autonomy: { 3: 'Balanced autonomy.' },
    caution: { 3: 'Balanced caution.' },
    communication: { 3: 'Balanced communication.' },
    creativity: { 3: 'Balanced creativity.' },
  },
}));
vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return {
    ...actual,
    playSliderTick: vi.fn(),
  };
});

const mockAgent = {
  id: 'test-id',
  name: 'test-agent',
  description: 'A test agent',
  capabilities: [],
  runtime: 'claude-code' as const,
  behavior: { responseMode: 'always' as const },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: new Date().toISOString(),
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
};

describe('PersonalityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders personality summary', () => {
    render(
      <PersonalityTab
        agent={mockAgent}
        soulContent="soul content"
        nopeContent="nope content"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByText(/Balanced tone\./)).toBeInTheDocument();
  });

  it('renders trait sliders, editors, and injection preview', () => {
    render(
      <PersonalityTab
        agent={mockAgent}
        soulContent="soul content"
        nopeContent="nope content"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByTestId('trait-sliders')).toBeInTheDocument();
    expect(screen.getByTestId('editor-Custom Instructions (SOUL.md)')).toBeInTheDocument();
    expect(screen.getByTestId('editor-Safety Boundaries (NOPE.md)')).toBeInTheDocument();
    expect(screen.getByTestId('injection-preview')).toBeInTheDocument();
  });

  it('renders dorkosKnowledge toggle', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    expect(
      screen.getByRole('switch', { name: 'Toggle DorkOS knowledge base injection' })
    ).toBeInTheDocument();
    expect(screen.getByText('DorkOS Knowledge Base')).toBeInTheDocument();
  });

  it('shows reset button only when traits differ from defaults', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    // All traits at default (3) — reset button should not appear
    expect(screen.queryByText('Reset to defaults')).not.toBeInTheDocument();
  });

  it('shows reset button when traits are non-default', () => {
    const agentWithTraits = {
      ...mockAgent,
      traits: { tone: 1, autonomy: 5, caution: 3, communication: 3, creativity: 3 },
    };
    render(
      <PersonalityTab
        agent={agentWithTraits}
        soulContent="soul"
        nopeContent="nope"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByText('Reset to defaults')).toBeInTheDocument();
  });

  it('renders response mode selector with current value', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    expect(screen.getByText('Response Mode')).toBeInTheDocument();
    expect(screen.getByText('Always respond')).toBeInTheDocument();
  });

  it('renders with null convention content without crashing', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent={null} nopeContent={null} onUpdate={vi.fn()} />
    );

    expect(screen.getByTestId('trait-sliders')).toBeInTheDocument();
    expect(screen.getByTestId('injection-preview')).toBeInTheDocument();
  });
});
