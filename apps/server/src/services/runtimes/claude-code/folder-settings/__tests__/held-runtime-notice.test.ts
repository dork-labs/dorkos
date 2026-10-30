/**
 * A Claude Code turn for an agent set to another runtime says why, never a
 * silent switch (DOR-3459).
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ held: false, registered: new Set(['claude-code', 'codex']) }));

vi.mock('../folder-config-consent.js', () => ({
  runtimeUnlessHeld: (manifest: { runtime?: string } | null) =>
    state.held ? undefined : manifest?.runtime,
}));
vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: { has: (type: string) => state.registered.has(type) },
}));

import { heldRuntimeNotice } from '../held-runtime-notice.js';

const HOME = '/agents/coder';
const message = (event: ReturnType<typeof heldRuntimeNotice>) =>
  (event as { data: { message: string } } | undefined)?.data.message;

beforeEach(() => {
  state.held = false;
  state.registered = new Set(['claude-code', 'codex']);
});

describe('heldRuntimeNotice', () => {
  it('says nothing for an agent on Claude Code, or with no runtime named', () => {
    state.held = true;
    expect(heldRuntimeNotice({ id: 'a', runtime: 'claude-code' }, HOME)).toBeUndefined();
    expect(heldRuntimeNotice({ id: 'a' }, HOME)).toBeUndefined();
    expect(heldRuntimeNotice(null, HOME)).toBeUndefined();
  });

  it('says the runtime waits for an OK when the agent file is held', () => {
    state.held = true;
    expect(message(heldRuntimeNotice({ id: 'a', runtime: 'codex' }, HOME))).toBe(
      "Codex waits for your OK on this agent's file. This chat runs on Claude Code."
    );
  });

  it('says the runtime is not set up when this computer lacks it', () => {
    expect(message(heldRuntimeNotice({ id: 'a', runtime: 'opencode' }, HOME))).toBe(
      "OpenCode isn't set up on this computer, so this chat runs on Claude Code."
    );
  });

  it('says nothing when the runtime was free to run and is set up', () => {
    expect(heldRuntimeNotice({ id: 'a', runtime: 'codex' }, HOME)).toBeUndefined();
  });
});
