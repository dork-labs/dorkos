/**
 * The join between a room's roster and the fleet's manifests.
 *
 * The claim under test is not "a map comes back" — it is that the key is the
 * `agentRef` a roster actually carries, and that an agent nobody could resolve
 * produces NO entry rather than a placeholder one.
 */
import { describe, it, expect } from 'vitest';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { agentInfoByRef } from '../lib/agent-details';

/** A manifest with only the fields this join reads. */
function manifest(runtime: string, model?: string, id = '01JMANIFESTULID'): AgentManifest {
  return { id, runtime, ...(model !== undefined && { model }) } as unknown as AgentManifest;
}

describe('agentInfoByRef', () => {
  it('keys an agent by the handle its roster entry carries', () => {
    const info = agentInfoByRef(['/w/bo'], { '/w/bo': manifest('claude-code', 'opus') });

    // The key a roster's `AuthorRef.agentRef` holds — derived from the path on
    // the server, derived again here, and the two must meet.
    expect(info.get(agentAuthorRef('/w/bo'))).toEqual({
      manifestId: '01JMANIFESTULID',
      runtime: 'Claude Code',
      model: 'opus',
    });
  });

  it('names the runtime the way every other surface names it', () => {
    const info = agentInfoByRef(['/w/cx'], { '/w/cx': manifest('codex', 'gpt-5.3-codex') });

    expect(info.get(agentAuthorRef('/w/cx'))?.runtime).toBe('Codex');
  });

  it('shortens an OpenCode model to the half a reader reads', () => {
    const info = agentInfoByRef(['/w/oc'], {
      '/w/oc': manifest('opencode', 'ollama/qwen2.5-coder'),
    });

    expect(info.get(agentAuthorRef('/w/oc'))?.model).toBe('qwen2.5-coder');
  });

  it('leaves the model out entirely when the agent inherits its runtime default', () => {
    const info = agentInfoByRef(['/w/bo'], { '/w/bo': manifest('claude-code') });

    const entry = info.get(agentAuthorRef('/w/bo'));
    expect(entry).toEqual({ manifestId: '01JMANIFESTULID', runtime: 'Claude Code' });
    expect(entry).not.toHaveProperty('model');
  });

  it('gives no entry at all for a path that resolved to no agent', () => {
    // The degradation that matters: a failed or empty resolve must leave the
    // map silent about that agent, so nothing downstream can draw a chip for a
    // fact nobody has.
    const info = agentInfoByRef(['/w/bo', '/w/gone'], {
      '/w/bo': manifest('claude-code'),
      '/w/gone': null,
    });

    expect(info.has(agentAuthorRef('/w/gone'))).toBe(false);
    expect(info.size).toBe(1);
  });

  it('gives no entries when nothing resolved', () => {
    expect(agentInfoByRef(['/w/bo'], {}).size).toBe(0);
  });
});
