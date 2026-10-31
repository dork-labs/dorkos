/**
 * Synthetic packages too large for one approval card's `detail` (DOR-3070).
 * Every name, command and host here is made up; none is read from a real
 * package.
 *
 * @module services/marketplace-mcp/__tests__/fixtures/large-packages
 */
import type { DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import type { PermissionPreview } from '../../../marketplace/types.js';

/** A disclosure that runs nothing. */
export const NOTHING: DisclosedEffects = {
  hooks: [],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
  skillCommands: [],
};

/** An empty install preview. */
export function emptyPreview(): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: [],
    skillTools: [],
    skillCommands: [],
    skippedLinks: [],
    unreadableDeclarations: [],
    npmDependencies: [],
    schedules: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
  };
}

/** A long, made-up tool list, so a few skills are enough to pass the card's bound. */
const TOOLS = Array.from({ length: 12 }, (_, i) => `Bash(sample-tool-${i} --flag:*)`);

/** `count` skills or commands that each may use {@link TOOLS} without asking. */
export function skillTools(count: number, kind: 'skills' | 'commands') {
  return Array.from({ length: count }, (_, i) => ({
    source: kind === 'skills' ? `skills/sample-skill-${i}/SKILL.md` : `commands/sample-${i}.md`,
    skill: kind === 'skills' ? `sample-skill-${i}` : `sample-${i}`,
    tools: TOOLS,
  }));
}

/**
 * `count` hooks, each a distinct command, so every one is a code-running row.
 * Long enough that the full list passes the card's bound on its own.
 */
export function hooks(count: number, prefix = 'sample-hook') {
  return Array.from({ length: count }, (_, i) => ({
    event: 'PostToolUse',
    matcher: `Tool${i}`,
    command: `node ./scripts/${prefix}-${i}.mjs --mode check --report ./out/${prefix}-${i}.json`,
    source: null,
  }));
}

/**
 * A package shaped like a large workflow plugin: 21 skills and 15 commands
 * with long tool lists, 2 hooks, 5 schedules, and an extension that runs
 * server code inside DorkOS. Its full list is well past 4,000 characters.
 */
export function flowSizedPreview(): PermissionPreview {
  return {
    ...emptyPreview(),
    extensions: [
      {
        id: 'sample-flow-panel',
        slots: ['right-panel'],
        hasServer: true,
        isolation: { runtime: 'in-process', net: [], run: [], agents: false },
      },
    ],
    hooks: [
      { event: 'Stop', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/sample-loop.mjs"' },
      {
        event: 'PostToolUse',
        command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/sample.ts" limit-check --hook',
      },
    ],
    schedules: Array.from({ length: 5 }, (_, i) => ({
      name: `sample-job-${i}`,
      cron: '0 * * * *',
      permissionMode: 'acceptEdits',
      startsEnabled: false,
    })) as PermissionPreview['schedules'],
    skillTools: [...skillTools(21, 'skills'), ...skillTools(15, 'commands')],
    externalHosts: ['api.sample.invalid'],
    secrets: [{ key: 'SAMPLE_TOKEN', required: false }],
  };
}

/** An install preview with 60 hooks: past the in-chat cap. */
export function sixtyRowPreview(): PermissionPreview {
  return { ...emptyPreview(), hooks: hooks(60).map(({ source: _source, ...hook }) => hook) };
}

/** A disclosure with 41 hooks: one past the in-chat cap. */
export function fortyOneNewRows(): DisclosedEffects {
  return { ...NOTHING, hooks: hooks(41) };
}

/** Enough unchanged skills that an update's full list passes the card's bound. */
export function bulkyUnchanged(): DisclosedEffects {
  return { ...NOTHING, skillTools: skillTools(30, 'skills') };
}
