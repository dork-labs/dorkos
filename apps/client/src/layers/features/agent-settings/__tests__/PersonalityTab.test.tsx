/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PersonalityTab } from '../ui/PersonalityTab';

// Mock child components to isolate PersonalityTab tests
vi.mock('../ui/PersonalitySliders', () => ({
  PersonalitySliders: () => <div data-testid="personality-sliders" />,
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
  extractCustomProse: vi.fn(() => ''),
  buildSoulContent: vi.fn((t: string, p: string) => `traits:${t}\n${p}`),
  TRAIT_SECTION_START: '<!-- TRAITS:START -->',
}));
vi.mock('@dorkos/shared/trait-renderer', () => ({
  renderTraits: vi.fn(() => 'rendered'),
  DEFAULT_TRAITS: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
}));

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

  it('renders all four sections in correct order', () => {
    render(
      <PersonalityTab
        agent={mockAgent}
        soulContent="soul content"
        nopeContent="nope content"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByTestId('personality-sliders')).toBeInTheDocument();
    expect(screen.getByTestId('editor-Custom Instructions (SOUL.md)')).toBeInTheDocument();
    expect(screen.getByTestId('editor-Safety Boundaries (NOPE.md)')).toBeInTheDocument();
    expect(screen.getByTestId('injection-preview')).toBeInTheDocument();
  });

  it('shows guidance text', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    expect(screen.getByText(/Configure your agent.*personality/)).toBeInTheDocument();
  });

  it('triggers migration for legacy agents (persona with no SOUL.md)', () => {
    const onMigrate = vi.fn();
    render(
      <PersonalityTab
        agent={
          { ...mockAgent, persona: 'legacy persona' } as typeof mockAgent & { persona: string }
        }
        soulContent={null}
        nopeContent={null}
        onUpdate={vi.fn()}
        onMigrate={onMigrate}
      />
    );

    expect(onMigrate).toHaveBeenCalled();
  });

  it('does not trigger migration when SOUL.md exists', () => {
    const onMigrate = vi.fn();
    render(
      <PersonalityTab
        agent={
          { ...mockAgent, persona: 'legacy persona' } as typeof mockAgent & { persona: string }
        }
        soulContent="existing soul content"
        nopeContent={null}
        onUpdate={vi.fn()}
        onMigrate={onMigrate}
      />
    );

    expect(onMigrate).not.toHaveBeenCalled();
  });

  it('does not trigger migration when no legacy persona', () => {
    const onMigrate = vi.fn();
    render(
      <PersonalityTab
        agent={mockAgent}
        soulContent={null}
        nopeContent={null}
        onUpdate={vi.fn()}
        onMigrate={onMigrate}
      />
    );

    expect(onMigrate).not.toHaveBeenCalled();
  });

  it('renders with null convention content without crashing', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent={null} nopeContent={null} onUpdate={vi.fn()} />
    );

    expect(screen.getByTestId('personality-sliders')).toBeInTheDocument();
    expect(screen.getByTestId('injection-preview')).toBeInTheDocument();
  });
});
