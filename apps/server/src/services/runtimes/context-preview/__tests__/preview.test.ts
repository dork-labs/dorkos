/**
 * The agent instructions views (spec `context-viewer` phase 3, QA rows):
 * the template, filled for an agent, equals that agent's preview, per
 * runtime; the agent-facing template has no values and no override counts;
 * and every block the real builders write is one the registry names.
 *
 * Against REAL files, as `prompt-content.test.ts` is: the property is about
 * what the builders read and write, which a mocked filesystem cannot show.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type {
  InstructionsPlace,
  InstructionsRuntime,
} from '@dorkos/shared/agent-instructions-schemas';
import { testHome } from '../../../core/agent-identity/__tests__/agent-home-fixture.js';

vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn(), getAll: vi.fn() },
}));
// A fully-featured server, so the agent's preview carries every gated
// paragraph the template shows.
vi.mock('../../../relay/relay-state.js', async (original) => ({
  ...(await original<object>()),
  isRelayEnabled: () => true,
}));
vi.mock('../../../tasks/task-state.js', async (original) => ({
  ...(await original<object>()),
  isTasksEnabled: () => true,
}));

import { configManager } from '../../../core/config-manager.js';
import { resetMemoryProvider } from '../../../memory/index.js';
import { buildInstructionsView, buildOwnNextTurnTemplate, type PreviewAgent } from '../preview.js';
import { LOCKED_BLOCK_IDS, SESSION_BLOCKS } from '../block-registry.js';
import { fillTemplate, variableValuesFor } from '../variables.js';

const RUNTIMES: InstructionsRuntime[] = ['claude-code', 'codex', 'opencode', 'doe'];
const PLACES: InstructionsPlace[] = ['direct', 'room', 'task'];

/** Every agent folder counts as registered with Mesh, so its chat is an agent's. */
const meshCore = { getByPath: () => ({ id: 'x' }) } as unknown as AgentRegistryPort;

let agentDir: string;

async function stageAgent(options: { nope?: boolean } = {}): Promise<PreviewAgent> {
  const dork = path.join(agentDir, '.dork');
  await mkdir(dork, { recursive: true });
  await writeFile(
    path.join(dork, 'agent.json'),
    JSON.stringify({
      id: '01JAGENT0000000000000000',
      name: 'harbor-scout',
      displayName: 'Harbor Scout',
      description: 'Watches the docks.',
      runtime: 'claude-code',
      capabilities: ['research', 'notes'],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'test',
      ...(options.nope === false ? { conventions: { nope: false } } : {}),
    }),
    'utf8'
  );
  await writeFile(path.join(dork, 'SOUL.md'), '## Identity\nI am Harbor Scout.\n', 'utf8');
  await writeFile(path.join(dork, 'NOPE.md'), '# Boundaries\n- Never sail at night\n', 'utf8');
  await writeFile(path.join(dork, 'MEMORY.md'), '## Notes\n- tide at six\n', 'utf8');
  await mkdir(path.join(dork, 'memory'), { recursive: true });
  await writeFile(
    path.join(dork, 'memory', 'tides.md'),
    '---\ndescription: Tide times\n---\nSix and eighteen.\n',
    'utf8'
  );
  return { id: '01JAGENT0000000000000000', home: testHome(agentDir), cwd: agentDir };
}

beforeEach(async () => {
  resetMemoryProvider();
  agentDir = await mkdtemp(path.join(os.tmpdir(), 'dorkos-context-preview-'));
  vi.mocked(configManager.getAll).mockReturnValue({
    profile: { roles: ['ops'], tools: ['Linear'], displayName: 'Sam', rolePromptDismissedAt: null },
  } as unknown as ReturnType<typeof configManager.getAll>);
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

describe('the template', () => {
  it.each(RUNTIMES)('names every block the %s builders write', async (runtime) => {
    for (const place of PLACES) {
      const view = await buildInstructionsView({
        runtime,
        place,
        level: 'act',
        audience: 'person',
      });
      expect(view.blocks.map((block) => block.title)).not.toContain('Unnamed block');
    }
  });

  it('is written by the builders for every registry entry that has a template', async () => {
    const written = new Set<string>();
    for (const runtime of RUNTIMES) {
      for (const place of PLACES) {
        const view = await buildInstructionsView({
          runtime,
          place,
          level: 'act',
          audience: 'person',
        });
        for (const block of view.blocks) if (block.text) written.add(block.id);
      }
    }
    // Only ever written from live state, so the template cannot show them.
    const stateOnly = ['agent_browser', 'folder_instructions', 'blocked_areas'];
    const missing = SESSION_BLOCKS.map((spec) => spec.id).filter(
      (id) => !written.has(id) && !stateOnly.includes(id)
    );
    expect(missing).toEqual([]);
  });

  it('carries variables, never an agent’s or this computer’s values', async () => {
    const view = await buildInstructionsView({
      runtime: 'claude-code',
      place: 'direct',
      level: 'act',
      audience: 'agent',
    });
    const text = view.blocks.map((block) => block.text ?? '').join('\n');
    expect(text).toContain('Name: {{agent.name}}');
    expect(text).toContain('Hostname: {{env.hostname}}');
    expect(text).not.toContain(os.hostname());
    expect(text).not.toContain('Sam');
    for (const block of [...view.blocks, ...view.notIncluded]) {
      expect(block).not.toHaveProperty('overrideCount');
    }
  });

  it('keeps override counts in the person’s view', async () => {
    const view = await buildInstructionsView({
      runtime: 'codex',
      place: 'direct',
      level: 'act',
      audience: 'person',
    });
    expect(view.blocks.every((block) => block.overrideCount === 0)).toBe(true);
  });

  it('marks what Codex sends once', async () => {
    const view = await buildInstructionsView({
      runtime: 'codex',
      place: 'direct',
      level: 'act',
      audience: 'person',
    });
    const delivery = Object.fromEntries(view.blocks.map((block) => [block.id, block.delivery]));
    expect(delivery.working_rules).toBe('once');
    expect(delivery.agent_memory).toBe('every-turn');
    expect(delivery.room_tools).toBe('every-turn');
  });
});

describe('a preview', () => {
  it.each(RUNTIMES)('equals the template filled for the agent, on %s', async (runtime) => {
    const agent = await stageAgent();
    const values = await variableValuesFor(agent.home, agent.cwd);
    for (const place of PLACES) {
      const template = await buildInstructionsView({
        runtime,
        place,
        level: 'act',
        audience: 'person',
      });
      const preview = await buildInstructionsView({
        runtime,
        place,
        level: 'act',
        audience: 'person',
        agent,
        meshCore,
      });
      const filled = new Map(
        template.blocks.map((block) => [
          `${block.layer}:${block.id}`,
          block.text === null ? null : fillTemplate(block.text, values),
        ])
      );
      expect(preview.blocks.length).toBeGreaterThan(5);
      for (const block of preview.blocks) {
        expect(filled.has(`${block.layer}:${block.id}`)).toBe(true);
        expect(block.text).toBe(filled.get(`${block.layer}:${block.id}`));
      }
      expect(preview.blocks.map((b) => b.text ?? '').join('\n')).toContain('Name: harbor-scout');
    }
  });

  it('leaves out a block the agent switched off, and nothing else changes', async () => {
    const agent = await stageAgent({ nope: false });
    const preview = await buildInstructionsView({
      runtime: 'opencode',
      place: 'direct',
      level: 'act',
      audience: 'person',
      agent,
      meshCore,
    });
    expect(preview.blocks.map((b) => b.id)).not.toContain('agent_safety_boundaries');
    expect(preview.notIncluded.map((b) => b.id)).toContain('agent_safety_boundaries');
  });

  it('keeps the memory and the fence code as chips', async () => {
    const agent = await stageAgent();
    const preview = await buildInstructionsView({
      runtime: 'claude-code',
      place: 'direct',
      level: 'act',
      audience: 'person',
      agent,
      meshCore,
    });
    const memory = preview.blocks.find((block) => block.id === 'agent_memory');
    expect(memory?.text).toContain('{{agent.memory}}');
    expect(memory?.text).toContain('{{turn.nonce}}');
    expect(memory?.text).not.toContain('tide at six');
  });
});

describe('an agent’s own next turn', () => {
  it('is the template narrowed to its own blocks, with no values', async () => {
    const agent = await stageAgent({ nope: false });
    const view = await buildOwnNextTurnTemplate({
      runtime: 'claude-code',
      place: 'direct',
      level: 'act',
      audience: 'agent',
      agent,
      meshCore,
    });
    const text = view.blocks.map((block) => block.text ?? '').join('\n');
    expect(view.agentId).toBeNull();
    expect(text).not.toContain('harbor-scout');
    expect(text).not.toContain('Harbor Scout');
    expect(text).toContain('{{agent.name}}');
    expect(view.blocks.map((b) => b.id)).not.toContain('agent_safety_boundaries');
    for (const block of view.notIncluded) expect(block.text).toBeNull();
    for (const block of view.blocks) expect(block).not.toHaveProperty('overrideCount');
  });
});

describe('locked blocks', () => {
  it('lock what tells the model what to trust or may do, and nothing a person edits', () => {
    for (const id of [
      'working_rules',
      'session_model',
      'agent_memory',
      'dorkos_tools',
      'dorkos_context',
      'room_context',
      'relay_context',
      'doc_events',
      'accounts_access',
      'task_scheduler',
      'blocked_areas',
    ]) {
      expect(LOCKED_BLOCK_IDS.has(id)).toBe(true);
    }
    for (const id of ['agent_persona', 'agent_safety_boundaries', 'user_profile']) {
      expect(LOCKED_BLOCK_IDS.has(id)).toBe(false);
    }
  });
});

describe('fillTemplate', () => {
  it('fills once and never re-expands a value', () => {
    expect(fillTemplate('{{agent.name}} {{agent.id}}', { 'agent.name': '{{agent.id}}' })).toBe(
      '{{agent.id}} {{agent.id}}'
    );
  });

  it('leaves unknown and unfilled tokens as written', () => {
    expect(fillTemplate('{{room.secret}} {{agent.name}}', {})).toBe(
      '{{room.secret}} {{agent.name}}'
    );
  });
});
