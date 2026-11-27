import { describe, expect, it } from 'vitest';
import {
  AskAnswerSchema,
  AskOutcomeSchema,
  AskRequestSchema,
  StandingDecisionSchema,
  UNWIRED_COMPUTER_ASKS,
  createComputerAsksSlot,
  type AskAnswer,
  type AskRequest,
  type ComputerAsks,
  type StandingDecision,
} from '../computer-asks.js';

const DIGESTS = { hooks: 'h'.repeat(64), mcpJson: 'm'.repeat(64), manifest: 'f'.repeat(64) };
const HOOK = {
  projectPath: '/work/cedar',
  packageName: '@acme/lunar-hooks',
  hooks: [
    { event: 'PreToolUse', matcher: 'Bash', command: 'node "/plugins/lunar/hooks/guard.mjs"' },
    { event: 'Stop', command: 'sh run.sh' },
  ],
  scripts: [['hooks/guard.mjs', 'a'.repeat(64)] as const],
};

/** One of every ask the computer raises. */
const ASKS: Record<AskRequest['kind'], AskRequest> = {
  hook_projection: {
    kind: 'hook_projection',
    request: HOOK,
    notInstalledByDorkos: true,
    resumeOnly: false,
  },
  folder_allows: {
    kind: 'folder_allows',
    request: {
      agentId: '01AGENT',
      agentName: 'Marketing',
      home: '/homes/marketing',
      rules: ['Bash(ls:*)', 'Read'],
      previousRules: ['Bash(ls:*)'],
      dropped: 1,
    },
  },
  folder_config: {
    kind: 'folder_config',
    request: {
      agentId: '01AGENT',
      agentName: 'Marketing',
      home: '/homes/marketing',
      digests: DIGESTS,
      changed: ['hooks', 'manifest'],
      detail: 'Hooks:\n{}',
    },
  },
  repo_config: {
    kind: 'repo_config',
    request: {
      kind: 'hooks',
      digest: 'd'.repeat(64),
      names: ['.claude/hooks/guard.mjs'],
      detail: '--- a\n+++ b',
      cwd: '/work/cedar',
      agentName: 'Ops',
      trust: {
        commonDir: '/work/cedar/.git',
        baseline: { branch: 'origin/main', sha: 'c'.repeat(40) },
        reason: 'hooks-moved',
      },
    },
  },
};

/** One of every standing decision the computer reports. */
const DECISIONS: Record<StandingDecision['kind'], StandingDecision> = {
  folder_allows_approved: {
    kind: 'folder_allows_approved',
    agentId: '01AGENT',
    home: '/homes/marketing',
    rules: ['Bash(ls:*)'],
    reason: 'narrowing an approved agent folder allow list',
  },
  folder_config_approved: {
    kind: 'folder_config_approved',
    agentId: '01AGENT',
    home: '/homes/marketing',
    digests: DIGESTS,
    reason: 'pinned on first use',
  },
  folder_config_repinned: {
    kind: 'folder_config_repinned',
    agentId: '01AGENT',
    home: '/homes/marketing',
    part: 'manifest',
    before: 'f'.repeat(64),
    after: 'e'.repeat(64),
    reason: 'a person changed the agent',
  },
  folder_configs_pinned: { kind: 'folder_configs_pinned' },
  repo_config_approved: { kind: 'repo_config_approved', setting: 'local', digest: 'l'.repeat(64) },
  repo_baseline: {
    kind: 'repo_baseline',
    commonDir: '/work/cedar/.git',
    baseline: { branch: 'origin/main', sha: 'c'.repeat(40) },
  },
  repo_baselines_pinned: { kind: 'repo_baselines_pinned' },
  hook_files_pinned: { kind: 'hook_files_pinned', request: HOOK },
  workspace_hooks_approved: {
    kind: 'workspace_hooks_approved',
    entry: `/work/cedar@workspace-${'w'.repeat(64)}`,
  },
};

/** One answer per way an ask can end. */
const ANSWERS: AskAnswer[] = AskOutcomeSchema.options.map((outcome) => ({ outcome }));

describe('the asks port payloads (D11)', () => {
  it.each(Object.values(ASKS))('the $kind ask parses and survives JSON unchanged', (ask) => {
    expect(AskRequestSchema.parse(ask)).toStrictEqual(ask);
    expect(JSON.parse(JSON.stringify(ask))).toStrictEqual(ask);
  });

  it.each(Object.values(DECISIONS))(
    'the $kind decision parses and survives JSON unchanged',
    (decision) => {
      expect(StandingDecisionSchema.parse(decision)).toStrictEqual(decision);
      expect(JSON.parse(JSON.stringify(decision))).toStrictEqual(decision);
    }
  );

  it.each(ANSWERS)('the $outcome answer parses and survives JSON unchanged', (answer) => {
    expect(AskAnswerSchema.parse(answer)).toStrictEqual(answer);
    expect(JSON.parse(JSON.stringify(answer))).toStrictEqual(answer);
  });

  it('refuses a payload with a field the contract does not name', () => {
    expect(
      AskRequestSchema.safeParse({ ...ASKS.folder_allows, entry: 'precomputed' }).success
    ).toBe(false);
    expect(
      StandingDecisionSchema.safeParse({ ...DECISIONS.repo_baselines_pinned, sha: 'x' }).success
    ).toBe(false);
  });
});

describe('the port before a space side wires it', () => {
  it('answers every ask unwired, and nothing else allows anything', async () => {
    for (const ask of Object.values(ASKS)) {
      expect(await UNWIRED_COMPUTER_ASKS.raise(ask)).toEqual({ outcome: 'unwired' });
    }
    expect(UNWIRED_COMPUTER_ASKS.reaskedHooks()).toEqual([]);
    expect(UNWIRED_COMPUTER_ASKS.isReaskedHook(HOOK)).toBe(false);
    expect(() => UNWIRED_COMPUTER_ASKS.record(DECISIONS.repo_baselines_pinned)).not.toThrow();
  });

  it('a slot reads the unwired port until one is set, and again once cleared', () => {
    const slot = createComputerAsksSlot();
    expect(slot.get()).toBe(UNWIRED_COMPUTER_ASKS);
    expect(slot.wired()).toBe(false);
    const port: ComputerAsks = { ...UNWIRED_COMPUTER_ASKS };
    slot.set(port);
    expect(slot.get()).toBe(port);
    expect(slot.wired()).toBe(true);
    slot.set(undefined);
    expect(slot.get()).toBe(UNWIRED_COMPUTER_ASKS);
  });
});
