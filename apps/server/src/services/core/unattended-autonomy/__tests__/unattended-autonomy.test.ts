/**
 * What counts as "an agent is running without asking and nobody is watching".
 *
 * The collector is where the banner's whole definition lives, so this file is
 * the definition's specification: every arm of the liveness rule, both arms of
 * the posture rule, and the two ways a driver can name itself.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import {
  collectUnattendedAutonomy,
  type UnattendedBindingRow,
  type UnattendedTaskRow,
} from '../unattended-autonomy.js';

/** Claude Code's real prompting default — a stop that still asks. */
const ASK: PermissionModeDescriptor = {
  id: 'default',
  label: 'Default',
  description: 'Prompt on tool use.',
  stop: 'ask',
  asks: 'always',
  reach: 'edit',
  promise: 'Asks before it edits a file or runs a command.',
};

/** The middle stop — acts on its own, still stops for the risky things. */
const ACT: PermissionModeDescriptor = {
  id: 'acceptEdits',
  label: 'Accept edits',
  description: 'Auto-accept file edits.',
  stop: 'act',
  asks: 'when-risky',
  reach: 'edit',
  promise: 'Edits files on its own. Asks before it runs a command.',
};

/** The autonomy stop — the door the unattended pickers gate. */
const AUTONOMY: PermissionModeDescriptor = {
  id: 'bypassPermissions',
  label: 'Bypass permissions',
  description: 'Skip all tool approval prompts.',
  stop: 'autonomy',
  asks: 'never',
  reach: 'everything',
  promise: 'Runs everything without asking, including outside this project.',
};

/**
 * A mode filed at the MIDDLE stop that nevertheless never asks and reaches
 * everything — the shape `isBypassSemantics` exists for, and the one a
 * stop-only rule would miss.
 */
const SILENT_ACT: PermissionModeDescriptor = {
  id: 'workspace-write',
  label: 'Workspace write',
  description: 'Runs commands in the workspace.',
  stop: 'act',
  asks: 'never',
  reach: 'everything',
  promise: 'Runs edits and shell commands without asking.',
};

const MODES = [ASK, ACT, AUTONOMY, SILENT_ACT];

/** A live binding at the given mode, with everything else set to "reachable". */
function binding(over: Partial<UnattendedBindingRow> = {}): UnattendedBindingRow {
  return {
    id: 'b1',
    label: 'Deploys',
    adapterId: 'telegram-1',
    agentId: 'agent-a',
    enabled: true,
    canReceive: true,
    permissionMode: AUTONOMY.id,
    ...over,
  };
}

/** A live task at the given mode. */
function task(over: Partial<UnattendedTaskRow> = {}): UnattendedTaskRow {
  return {
    id: 't1',
    name: 'nightly-cleanup',
    displayName: 'Nightly cleanup',
    enabled: true,
    status: 'active',
    permissionMode: AUTONOMY.id,
    ...over,
  };
}

/**
 * Run the collector with the standard mode set, a naming adapter, and — unless
 * a test says otherwise — a running integration and a present agent.
 */
function collect(input: {
  bindings?: UnattendedBindingRow[];
  tasks?: UnattendedTaskRow[];
  modes?: PermissionModeDescriptor[];
  liveAdapters?: string[];
  liveAgents?: string[];
}) {
  return collectUnattendedAutonomy({
    bindings: input.bindings ?? [],
    tasks: input.tasks ?? [],
    modes: input.modes ?? MODES,
    adapterName: (id) => (id === 'telegram-1' ? 'Telegram' : id),
    adapterLive: (id) => (input.liveAdapters ?? ['telegram-1']).includes(id),
    agentLive: (id) => (input.liveAgents ?? ['agent-a']).includes(id),
  });
}

describe('collectUnattendedAutonomy', () => {
  it('reports nothing when every driver still stops to ask', () => {
    const state = collect({
      bindings: [binding({ permissionMode: ASK.id })],
      tasks: [task({ permissionMode: ACT.id })],
    });
    expect(state.drivers).toEqual([]);
  });

  it('reports a live binding sitting at the autonomy stop', () => {
    const state = collect({ bindings: [binding()] });
    expect(state.drivers).toEqual([{ kind: 'binding', id: 'b1', name: 'Deploys' }]);
  });

  it('reports a live task sitting at the autonomy stop, by its display name', () => {
    const state = collect({ tasks: [task()] });
    expect(state.drivers).toEqual([{ kind: 'task', id: 't1', name: 'Nightly cleanup' }]);
  });

  it('falls back to the task’s own name when it has no display name', () => {
    const state = collect({ tasks: [task({ displayName: null })] });
    expect(state.drivers[0]?.name).toBe('nightly-cleanup');
  });

  it('names an unlabelled binding after its adapter', () => {
    const state = collect({ bindings: [binding({ label: '' })] });
    expect(state.drivers[0]?.name).toBe('Telegram');
  });

  it('reports a mode that never asks and reaches everything, wherever its runtime filed it', () => {
    // The Codex shape: `asks: 'never'` parked at the middle stop. A rule that
    // read only the dial position would call this attended and say nothing.
    const state = collect({ bindings: [binding({ permissionMode: SILENT_ACT.id })] });
    expect(state.drivers).toHaveLength(1);
    expect(state.drivers[0]?.id).toBe('b1');
  });

  it('ignores a paused binding — the router never delivers to it', () => {
    expect(collect({ bindings: [binding({ enabled: false })] }).drivers).toEqual([]);
  });

  it('ignores a binding that cannot receive — nothing inbound ever starts a turn', () => {
    expect(collect({ bindings: [binding({ canReceive: false })] }).drivers).toEqual([]);
  });

  it('ignores a binding whose integration is switched off', () => {
    // The case a binding row cannot show: every check the router makes runs
    // AFTER a message arrives through a registered adapter, and a disabled
    // integration means nothing arrives at all. Reported here until DOR-814's
    // review drove `POST /api/relay/adapters/:id/disable` in a browser and
    // found the banner still standing.
    expect(collect({ bindings: [binding()], liveAdapters: [] }).drivers).toEqual([]);
  });

  it('reports it again the moment the integration is switched back on', () => {
    // The other direction, because a gate that never re-opens is the same bug
    // wearing the opposite sign: a real bypass that stays hidden.
    expect(collect({ bindings: [binding()], liveAdapters: ['telegram-1'] }).drivers).toEqual([
      { kind: 'binding', id: 'b1', name: 'Deploys' },
    ]);
  });

  it('ignores a binding pointing at an agent the mesh does not have', () => {
    // `binding-router` refuses `agent_missing` right after the canReceive check.
    expect(collect({ bindings: [binding()], liveAgents: [] }).drivers).toEqual([]);
  });

  it('ignores a switched-off task', () => {
    expect(collect({ tasks: [task({ enabled: false })] }).drivers).toEqual([]);
  });

  it('ignores a task the scheduler would not register', () => {
    expect(collect({ tasks: [task({ status: 'paused' })] }).drivers).toEqual([]);
    expect(collect({ tasks: [task({ status: 'pending_approval' })] }).drivers).toEqual([]);
  });

  it('claims nothing about a mode the runtime does not declare', () => {
    // A stored mode with no descriptor is a fact nobody can read. Silence is the
    // only honest answer — the alternative is a banner asserting a posture from
    // a string it does not understand.
    const state = collect({ bindings: [binding({ permissionMode: 'invented-mode' })] });
    expect(state.drivers).toEqual([]);
  });

  it('claims nothing when no runtime profile is available at all', () => {
    // A test-mode boot, where claude-code is never registered.
    const state = collect({ bindings: [binding()], tasks: [task()], modes: [] });
    expect(state.drivers).toEqual([]);
  });

  it('reports every live driver, bindings before tasks', () => {
    const state = collect({
      bindings: [binding(), binding({ id: 'b2', label: 'Support', permissionMode: ASK.id })],
      tasks: [task(), task({ id: 't2', displayName: 'Digest', permissionMode: ACT.id })],
    });
    expect(state.drivers.map((d) => [d.kind, d.id])).toEqual([
      ['binding', 'b1'],
      ['task', 't1'],
    ]);
  });
});
