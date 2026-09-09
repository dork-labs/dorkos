/**
 * Harness statuses to draw against — the shapes the components have to survive,
 * written once so a test and a Dev Playground showcase are looking at the same
 * tree.
 *
 * Modelled on the J-01 fixture and on this repository: three tools enabled, a
 * fourth found in the folder and not enabled, six skills, and one row for each
 * exception the chip vocabulary has a word for. Every string a component would
 * repeat verbatim is a plausible engine string rather than a placeholder, so a
 * showcase built from these looks like the real page rather than like lorem.
 *
 * @module entities/harness/__fixtures__/harness-status
 */
import type { HarnessRow, HarnessStatusResponse } from '@dorkos/shared/harness-schemas';

/** A row every enabled tool has and is current on — the collapsing case. */
const SHARED_ROW: HarnessRow = {
  artifact: 'skill',
  provenance: 'authored',
  name: 'release',
  source: '.agents/skills/release',
  adoptable: false,
  cells: {
    'claude-code': { state: 'native', target: '.claude/skills/release' },
    codex: { state: 'projected', target: '.codex/skills/release' },
    cursor: { state: 'projected', target: '.cursor/rules/release.mdc' },
  },
};

/** A row one tool cannot see at all, with the plan's own sentence about why. */
const DROPPED_ROW: HarnessRow = {
  artifact: 'skill',
  provenance: 'installed',
  name: 'browser-testing',
  source: '.agents/skills/browser-testing',
  adoptable: false,
  cells: {
    'claude-code': { state: 'native', target: '.claude/skills/browser-testing' },
    codex: {
      state: 'dropped',
      reason: 'Codex has no skills directory — its instructions file is the only place to put this',
    },
    cursor: { state: 'projected', target: '.cursor/rules/browser-testing.mdc' },
  },
};

/** A row a sync would rewrite. */
const DRIFTED_ROW: HarnessRow = {
  artifact: 'skill',
  provenance: 'authored',
  name: 'writing-changelogs',
  source: '.agents/skills/writing-changelogs',
  adoptable: false,
  cells: {
    'claude-code': { state: 'native', target: '.claude/skills/writing-changelogs' },
    codex: { state: 'drifted', reason: 'the projected copy is older than the file it came from' },
    cursor: { state: 'projected', target: '.cursor/rules/writing-changelogs.mdc' },
  },
};

/** A row a re-run will never fix, because something else owns the target. */
const CONFLICT_ROW: HarnessRow = {
  artifact: 'skill',
  provenance: 'authored',
  name: 'debugging-systematically',
  source: '.agents/skills/debugging-systematically',
  adoptable: false,
  cells: {
    'claude-code': { state: 'native', target: '.claude/skills/debugging-systematically' },
    codex: {
      state: 'conflict',
      reason: 'a file DorkOS did not write is already at .codex/skills/debugging-systematically',
    },
    cursor: { state: 'projected', target: '.cursor/rules/debugging-systematically.mdc' },
  },
};

/** A row that landed everywhere and still carries a warning on one tool. */
const WARNED_ROW: HarnessRow = {
  artifact: 'skill',
  provenance: 'installed',
  name: 'marketplace-dev',
  source: '.agents/skills/marketplace-dev',
  adoptable: false,
  cells: {
    'claude-code': { state: 'native', target: '.claude/skills/marketplace-dev' },
    codex: {
      state: 'projected',
      target: '.codex/skills/marketplace-dev',
      warnings: ['its frontmatter names a tool Codex does not have'],
    },
    cursor: { state: 'projected', target: '.cursor/rules/marketplace-dev.mdc' },
  },
};

/** A skill authored where only one tool looks — the adoptable case. */
const ADOPTABLE_ROW: HarnessRow = {
  artifact: 'skill',
  provenance: 'harness-native',
  name: 'chat-self-test',
  source: '.claude/skills/chat-self-test',
  adoptable: true,
  cells: {
    'claude-code': { state: 'native', target: '.claude/skills/chat-self-test' },
    codex: { state: 'dropped', reason: 'it lives in .claude/skills, which only Claude Code reads' },
    cursor: {
      state: 'dropped',
      reason: 'it lives in .claude/skills, which only Claude Code reads',
    },
  },
};

/** A row that is not a skill — the API is wider than the Skills page (D27). */
const HOOK_ROW: HarnessRow = {
  artifact: 'hook',
  provenance: 'installed',
  name: 'hooks',
  source: '.agents/hooks/settings.json',
  adoptable: false,
  cells: {
    'claude-code': { state: 'pending-approval', reason: 'acme-tools is waiting for your approval' },
    codex: { state: 'dropped', reason: 'Codex runs no hooks' },
    cursor: { state: 'dropped', reason: 'Cursor runs no hooks' },
  },
};

/**
 * The full, interesting status: six skills across three tools, with one row per
 * exception and a seventh row that is not a skill.
 */
export const HARNESS_STATUS_READY: HarnessStatusResponse = {
  projectPath: '/Users/kai/code/dorkos',
  state: 'ready',
  computedAt: '2026-09-08T09:00:00.000Z',
  enabled: ['claude-code', 'codex', 'cursor'],
  notEnabled: [{ harness: 'gemini', signal: '.gemini/ exists in this folder' }],
  clean: false,
  counts: {
    skills: 6,
    drifted: 1,
    conflicts: 1,
    orphans: 2,
    adoptable: 1,
    pendingApproval: 1,
  },
  sweepPreview: ['.claude/skills/beta', '.claude/skills/gamma'],
  removals: [
    { path: '.claude/skills/beta', reason: 'The skill this link pointed to is gone.' },
    { path: '.claude/skills/gamma', reason: 'The skill this link pointed to is gone.' },
  ],
  rows: [SHARED_ROW, DROPPED_ROW, DRIFTED_ROW, CONFLICT_ROW, WARNED_ROW, ADOPTABLE_ROW, HOOK_ROW],
  projectLevel: [
    {
      kind: 'drop',
      artifact: 'plugin',
      name: '@dork-labs/relay-kit',
      source: '.agents/plugins/relay-kit',
      reason:
        'plugin layer "adapters" is not a portable harness asset — Messaging runs inside DorkOS, not in a harness',
    },
    {
      kind: 'warning',
      artifact: 'mcp',
      name: '.mcp.json',
      source: '.mcp.json',
      reason: 'the file could not be parsed, so no MCP server in it was projected anywhere',
    },
    {
      kind: 'write',
      artifact: 'skill',
      name: '.agents/skills',
      target: '.agents/skills',
      reason: 'the canonical link a sync creates for the directory rather than for one tool',
    },
    {
      kind: 'notice',
      artifact: 'manifest',
      name: 'hookPolicy.gemini',
      reason: 'a hook policy names gemini, which this manifest does not enable',
    },
  ],
  pendingApproval: [
    {
      packageName: 'acme-tools',
      events: ['PreToolUse'],
      commandCount: 2,
      reason: 'unasked',
    },
  ],
};

/** A tree where everything is shared and current — every row collapses. */
export const HARNESS_STATUS_ALL_SHARED: HarnessStatusResponse = {
  ...HARNESS_STATUS_READY,
  clean: true,
  counts: { skills: 1, drifted: 0, conflicts: 0, orphans: 0, adoptable: 0, pendingApproval: 0 },
  sweepPreview: [],
  removals: [],
  rows: [SHARED_ROW],
  projectLevel: [],
  pendingApproval: [],
};

/** Set up, and nothing in it. */
export const HARNESS_STATUS_NO_SKILLS: HarnessStatusResponse = {
  ...HARNESS_STATUS_READY,
  clean: true,
  counts: { skills: 0, drifted: 0, conflicts: 0, orphans: 0, adoptable: 0, pendingApproval: 0 },
  sweepPreview: [],
  removals: [],
  rows: [],
  notEnabled: [],
  projectLevel: [],
  pendingApproval: [],
};

/** The envelope every state but `ready` answers with. */
function emptyStatus(
  state: HarnessStatusResponse['state'],
  detail?: string
): HarnessStatusResponse {
  return {
    projectPath: '/Users/kai/code/dorkos',
    state,
    ...(detail === undefined ? {} : { detail }),
    computedAt: '2026-09-08T09:00:00.000Z',
    enabled: [],
    notEnabled: [],
    clean: true,
    counts: { skills: 0, drifted: 0, conflicts: 0, orphans: 0, adoptable: 0, pendingApproval: 0 },
    sweepPreview: [],
    removals: [],
    rows: [],
    projectLevel: [],
    pendingApproval: [],
  };
}

/** No manifest in this folder yet. */
export const HARNESS_STATUS_NOT_SET_UP: HarnessStatusResponse = emptyStatus('not-set-up');

/** A manifest that is there and cannot be used. */
export const HARNESS_STATUS_UNREADABLE: HarnessStatusResponse = emptyStatus(
  'unreadable',
  '.agents/harness.manifest.json is not valid JSON.'
);

/** What an Obsidian vault is told. */
export const HARNESS_STATUS_UNAVAILABLE: HarnessStatusResponse = emptyStatus(
  'unavailable',
  'Agent file sharing runs in the DorkOS app.'
);
