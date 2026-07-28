import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { _buildAgentBlock as buildAgentBlock } from '../agent-context.js';

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
    personaEnabled: true,
    enabledToolGroups: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Re-import `buildAgentBlock` with `DORKOS_DOCS_BASE_URL` explicitly unset, and
 * re-arm the two convention-file mocks on the reset module registry.
 *
 * The `<dorkos_context>` doc pointers are environment-derived now, and this
 * suite can inherit a real override rather than a clean environment: `.env`
 * carries it, root `package.json` runs tests as `dotenv -- turbo test`, and
 * `turbo.json`'s `globalPassThroughEnv` forwards it into the test task. A
 * developer running a local docs site is precisely who that variable is for, so
 * a test asserting the PRODUCTION URLs has to pin the environment instead of
 * reading it. Same treatment as `composeWithDocsBase(undefined)` in
 * `services/core/__tests__/context-builder.test.ts`.
 */
async function buildAgentBlockWithoutDocsOverride(): Promise<string> {
  vi.stubEnv('DORKOS_DOCS_BASE_URL', undefined as unknown as string);
  vi.resetModules();
  const { readManifest: freshReadManifest } = await import('@dorkos/shared/manifest');
  vi.mocked(freshReadManifest).mockResolvedValue(createTestManifest());
  const { readConventionFile: freshReadConventionFile } =
    await import('@dorkos/shared/convention-files-io');
  vi.mocked(freshReadConventionFile).mockResolvedValue(null);
  const { _buildAgentBlock: freshBuildAgentBlock } = await import('../agent-context.js');
  return freshBuildAgentBlock('/test');
}

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
    const result = await buildAgentBlockWithoutDocsOverride();
    expect(result).toContain('Console (chat)');
    expect(result).toContain('Tasks (scheduling)');
    expect(result).toContain('Relay (messaging)');
    expect(result).toContain('Mesh (discovery)');
    expect(result).toContain('https://dorkos.ai/llms.txt');
    expect(result).toContain('https://dorkos.ai/docs');
  });
});

/**
 * The two doc pointers are the only environment-derived part of
 * `<dorkos_context>`, and `env.ts` snapshots `process.env` once at module load,
 * so these assertions have to re-import the builder under a stubbed
 * environment. That is why they sit in their own describe rather than joining
 * the block above: the tests up there hold references to statically imported
 * mocks, and `vi.resetModules()` would hand a re-imported module a different
 * set of them.
 */
describe('buildDorkosContextBlock documentation links', () => {
  /** Re-import the builder so it reads the environment stubbed by this test. */
  async function freshBlock(): Promise<string> {
    vi.resetModules();
    const { _buildDorkosContextBlock } = await import('../agent-context.js');
    return _buildDorkosContextBlock();
  }

  it('points at production docs when DORKOS_DOCS_BASE_URL is unset', async () => {
    // Explicitly unset: a normal install has no override and must be untouched.
    vi.stubEnv('DORKOS_DOCS_BASE_URL', undefined as unknown as string);
    const block = await freshBlock();
    expect(block).toContain('Documentation: https://dorkos.ai/llms.txt');
    expect(block).toContain('Full docs: https://dorkos.ai/docs');
  });

  it('points at the override when DORKOS_DOCS_BASE_URL is set', async () => {
    vi.stubEnv('DORKOS_DOCS_BASE_URL', 'http://localhost:6244');
    const block = await freshBlock();
    expect(block).toContain('Documentation: http://localhost:6244/llms.txt');
    expect(block).toContain('Full docs: http://localhost:6244/docs');
    expect(block).not.toContain('dorkos.ai');
  });

  it('strips a trailing slash so the override cannot produce //llms.txt', async () => {
    vi.stubEnv('DORKOS_DOCS_BASE_URL', 'http://localhost:6244/');
    const block = await freshBlock();
    expect(block).toContain('Documentation: http://localhost:6244/llms.txt');
    expect(block).toContain('Full docs: http://localhost:6244/docs');
    expect(block).not.toContain('//llms.txt');
  });

  it('a trailing newline cannot split the pointer across two lines', async () => {
    // Asserted on the emitted BLOCK, not just the parsed env value, because
    // that is where the damage is legible: validating the parsed URL while
    // emitting the caller's raw string lets `"…\n"` through and renders
    // "Documentation: https://x.dev" and "/llms.txt" as two separate lines, in
    // a block that ships on every turn of every runtime.
    vi.stubEnv('DORKOS_DOCS_BASE_URL', 'https://x.dev\n');
    const block = await freshBlock();
    expect(block).toContain('Documentation: https://x.dev/llms.txt');
    expect(block).toContain('Full docs: https://x.dev/docs');
    expect(block.split('\n')).not.toContain('/llms.txt');
  });

  it('changes the origin and nothing else: same two lines, same order, index not corpus', async () => {
    vi.stubEnv('DORKOS_DOCS_BASE_URL', 'https://docs.example.test');
    const block = await freshBlock();
    const docLines = block.split('\n').filter((line) => line.includes('docs.example.test'));
    expect(docLines).toEqual([
      'Documentation: https://docs.example.test/llms.txt',
      'Full docs: https://docs.example.test/docs',
    ]);
    // `llms.txt` is the ~29 KB index. `llms-full.txt` is the ~875 KB corpus and
    // would swallow the context window of every turn on every runtime.
    expect(block).not.toContain('llms-full.txt');
  });
});
