import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { _buildAgentBlock as buildAgentBlock } from '../context-builder.js';

// Mock the shared modules
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(),
}));
vi.mock('@dorkos/shared/convention-files', () => ({
  extractCustomProse: vi.fn(),
  buildSoulContent: vi.fn(),
  TRAIT_SECTION_START: '<!-- TRAITS:START -->',
}));
vi.mock('@dorkos/shared/convention-files-io', () => ({
  readConventionFile: vi.fn(),
}));
vi.mock('@dorkos/shared/trait-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/trait-renderer')>()),
  renderTraits: vi.fn(),
}));

import { readManifest } from '@dorkos/shared/manifest';
import { extractCustomProse, buildSoulContent } from '@dorkos/shared/convention-files';
import { readConventionFile } from '@dorkos/shared/convention-files-io';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';

/** Create a minimal valid AgentManifest for testing. */
function createTestManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'test-id',
    name: 'test-agent',
    description: 'A test agent',
    capabilities: [],
    runtime: 'claude-code',
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'test',
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    personaEnabled: true,
    enabledToolGroups: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildAgentBlock conventions', () => {
  it('returns empty string when no manifest exists', async () => {
    vi.mocked(readManifest).mockResolvedValue(null);
    const result = await buildAgentBlock('/test');
    expect(result).toBe('');
  });

  it('injects SOUL.md content as <agent_persona>', async () => {
    vi.mocked(readManifest).mockResolvedValue(createTestManifest());
    vi.mocked(readConventionFile).mockImplementation(async (_path, filename) => {
      if (filename === 'SOUL.md') return '## Identity\nI am test-agent.';
      return null;
    });

    const result = await buildAgentBlock('/test');
    expect(result).toContain('<agent_persona>');
    expect(result).toContain('## Identity');
  });

  it('injects NOPE.md content as <agent_safety_boundaries>', async () => {
    vi.mocked(readManifest).mockResolvedValue(createTestManifest());
    vi.mocked(readConventionFile).mockImplementation(async (_path, filename) => {
      if (filename === 'NOPE.md') return '# Safety Boundaries\n## Never Do\n- Never push to main';
      return null;
    });

    const result = await buildAgentBlock('/test');
    expect(result).toContain('<agent_safety_boundaries>');
    expect(result).toContain('Safety Boundaries');
  });

  it('respects conventions.soul: false', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({ conventions: { soul: false, nope: true } })
    );
    vi.mocked(readConventionFile).mockResolvedValue('some content');

    const result = await buildAgentBlock('/test');
    expect(result).not.toContain('<agent_persona>');
  });

  it('respects conventions.nope: false', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({ conventions: { soul: true, nope: false } })
    );
    vi.mocked(readConventionFile).mockResolvedValue('some content');

    const result = await buildAgentBlock('/test');
    expect(result).not.toContain('<agent_safety_boundaries>');
  });

  it('falls back to legacy persona when no SOUL.md exists', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({ persona: 'You are a legacy agent.', personaEnabled: true })
    );
    vi.mocked(readConventionFile).mockResolvedValue(null);

    const result = await buildAgentBlock('/test');
    expect(result).toContain('<agent_persona>');
    expect(result).toContain('You are a legacy agent.');
  });

  it('regenerates trait section when SOUL.md contains trait markers', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({
        traits: { ...DEFAULT_TRAITS, verbosity: 1, autonomy: 5 },
      })
    );
    vi.mocked(readConventionFile).mockImplementation(async (_path, filename) => {
      if (filename === 'SOUL.md')
        return '<!-- TRAITS:START -->\nold traits\n<!-- TRAITS:END -->\n\n## Identity';
      return null;
    });
    vi.mocked(extractCustomProse).mockReturnValue('## Identity');
    vi.mocked(renderTraits).mockReturnValue('rendered traits');
    vi.mocked(buildSoulContent).mockReturnValue('rebuilt soul content');

    const result = await buildAgentBlock('/test');
    expect(renderTraits).toHaveBeenCalledWith({
      verbosity: 1,
      autonomy: 5,
      chaos: 3,
      creativity: 3,
      humor: 3,
      spice: 3,
    });
    expect(buildSoulContent).toHaveBeenCalledWith('rendered traits', '## Identity');
    expect(result).toContain('rebuilt soul content');
  });

  it('includes both persona and safety boundaries when both files exist', async () => {
    vi.mocked(readManifest).mockResolvedValue(createTestManifest());
    vi.mocked(readConventionFile).mockImplementation(async (_path, filename) => {
      if (filename === 'SOUL.md') return '## Identity\nI am test-agent.';
      if (filename === 'NOPE.md') return '# Safety Boundaries\n- Never push to main';
      return null;
    });

    const result = await buildAgentBlock('/test');
    expect(result).toContain('<agent_identity>');
    expect(result).toContain('<agent_persona>');
    expect(result).toContain('<agent_safety_boundaries>');

    // Verify injection order: identity -> persona -> safety boundaries
    const identityIdx = result.indexOf('<agent_identity>');
    const personaIdx = result.indexOf('<agent_persona>');
    const safetyIdx = result.indexOf('<agent_safety_boundaries>');
    expect(identityIdx).toBeLessThan(personaIdx);
    expect(personaIdx).toBeLessThan(safetyIdx);
  });

  it('does not regenerate traits when SOUL.md has no trait markers', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({
        traits: { ...DEFAULT_TRAITS, verbosity: 1, autonomy: 5 },
      })
    );
    vi.mocked(readConventionFile).mockImplementation(async (_path, filename) => {
      if (filename === 'SOUL.md') return '## Identity\nI am a simple agent.';
      return null;
    });

    const result = await buildAgentBlock('/test');
    expect(renderTraits).not.toHaveBeenCalled();
    expect(result).toContain('I am a simple agent.');
  });

  it('does not inject persona when personaEnabled is false and no SOUL.md', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({ persona: 'You are a legacy agent.', personaEnabled: false })
    );
    vi.mocked(readConventionFile).mockResolvedValue(null);

    const result = await buildAgentBlock('/test');
    expect(result).not.toContain('<agent_persona>');
  });

  it('injects <dorkos_context> by default when conventions is undefined', async () => {
    vi.mocked(readManifest).mockResolvedValue(createTestManifest());
    vi.mocked(readConventionFile).mockResolvedValue(null);

    const result = await buildAgentBlock('/test');
    expect(result).toContain('<dorkos_context>');
    expect(result).toContain('DorkOS is the operating system');
    expect(result).toContain('</dorkos_context>');
  });

  it('injects <dorkos_context> when dorkosKnowledge is true', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({ conventions: { soul: true, nope: true, dorkosKnowledge: true } })
    );
    vi.mocked(readConventionFile).mockResolvedValue(null);

    const result = await buildAgentBlock('/test');
    expect(result).toContain('<dorkos_context>');
  });

  it('omits <dorkos_context> when dorkosKnowledge is false', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({ conventions: { soul: true, nope: true, dorkosKnowledge: false } })
    );
    vi.mocked(readConventionFile).mockResolvedValue(null);

    const result = await buildAgentBlock('/test');
    expect(result).not.toContain('<dorkos_context>');
  });

  it('injects <dorkos_context> when conventions exists but dorkosKnowledge is not set', async () => {
    vi.mocked(readManifest).mockResolvedValue(
      createTestManifest({ conventions: { soul: true, nope: true } })
    );
    vi.mocked(readConventionFile).mockResolvedValue(null);

    const result = await buildAgentBlock('/test');
    expect(result).toContain('<dorkos_context>');
  });

  it('<dorkos_context> contains subsystem and doc links', async () => {
    vi.mocked(readManifest).mockResolvedValue(createTestManifest());
    vi.mocked(readConventionFile).mockResolvedValue(null);

    const result = await buildAgentBlock('/test');
    expect(result).toContain('Console (chat)');
    expect(result).toContain('Tasks (scheduling)');
    expect(result).toContain('Relay (messaging)');
    expect(result).toContain('Mesh (discovery)');
    expect(result).toContain('https://dorkos.ai/llms.txt');
    expect(result).toContain('https://dorkos.ai/docs');
  });
});
