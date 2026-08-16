/**
 * The join between a room's roster and the fleet's manifests.
 *
 * The claim under test is not "a map comes back" — it is that the key is the
 * `agentRef` a roster actually carries, and that an agent nobody could resolve
 * produces NO entry rather than a placeholder one.
 */
import { describe, it, expect } from 'vitest';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import type { AgentManifest, AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { hashToEmoji, hashToHslColor } from '@/layers/shared/lib';
import { agentFacesByRef, agentInfoByRef } from '../lib/agent-details';

/**
 * A registry entry as `GET /api/mesh/agents/paths` lists one.
 *
 * Its `id` defaults to something DIFFERENT from the manifest fixture's below,
 * on purpose: the two ids are separate spaces that usually agree, and a fixture
 * where they agreed would let the join read either one and stay green.
 */
function entry(projectPath: string, id = '01JREGISTRYULID'): AgentPathEntry {
  return { id, name: projectPath.split('/').pop()!, projectPath };
}

/** A manifest with only the fields this join reads. */
function manifest(runtime: string, model?: string, id = '01JMANIFESTULID'): AgentManifest {
  return { id, runtime, ...(model !== undefined && { model }) } as unknown as AgentManifest;
}

describe('agentInfoByRef', () => {
  it('keys an agent by the handle its roster entry carries', () => {
    const info = agentInfoByRef([entry('/w/bo')], { '/w/bo': manifest('claude-code', 'opus') });

    // The key a roster's `AuthorRef.agentRef` holds — derived from the path on
    // the server, derived again here, and the two must meet.
    expect(info.get(agentAuthorRef('/w/bo'))).toEqual({
      memberId: '01JREGISTRYULID',
      visual: { color: hashToHslColor('01JMANIFESTULID'), emoji: hashToEmoji('01JMANIFESTULID') },
      runtime: 'Claude Code',
      model: 'opus',
    });
  });

  it('names the runtime the way every other surface names it', () => {
    const info = agentInfoByRef([entry('/w/cx')], { '/w/cx': manifest('codex', 'gpt-5.3-codex') });

    expect(info.get(agentAuthorRef('/w/cx'))?.runtime).toBe('Codex');
  });

  it('shortens an OpenCode model to the half a reader reads', () => {
    const info = agentInfoByRef([entry('/w/oc')], {
      '/w/oc': manifest('opencode', 'ollama/qwen2.5-coder'),
    });

    expect(info.get(agentAuthorRef('/w/oc'))?.model).toBe('qwen2.5-coder');
  });

  it('leaves the model out entirely when the agent inherits its runtime default', () => {
    const info = agentInfoByRef([entry('/w/bo')], { '/w/bo': manifest('claude-code') });

    const resolved = info.get(agentAuthorRef('/w/bo'));
    expect(resolved).toEqual({
      memberId: '01JREGISTRYULID',
      visual: { color: hashToHslColor('01JMANIFESTULID'), emoji: hashToEmoji('01JMANIFESTULID') },
      runtime: 'Claude Code',
    });
    expect(resolved).not.toHaveProperty('model');
  });

  it('gives no entry at all for a path that resolved to no agent', () => {
    // The degradation that matters: a failed or empty resolve must leave the
    // map silent about that agent, so nothing downstream can draw a chip for a
    // fact nobody has.
    const info = agentInfoByRef([entry('/w/bo'), entry('/w/gone')], {
      '/w/bo': manifest('claude-code'),
      '/w/gone': null,
    });

    expect(info.has(agentAuthorRef('/w/gone'))).toBe(false);
    expect(info.size).toBe(1);
  });

  it('gives no entries when nothing resolved', () => {
    expect(agentInfoByRef([entry('/w/bo')], {}).size).toBe(0);
  });

  it('files an agent under the REGISTRY’s id, not the one inside its manifest', () => {
    // The two ids usually agree, which is exactly why this needs pinning: a
    // fixture where they matched let the join read the manifest and stay green,
    // and on a real machine 3 of 44 rows diverged. `GET /api/team` keys its
    // agent rows off the registry (`routes/team.ts` → `mesh.listWithHealth()`),
    // so the manifest's id opens a profile the roster does not hold — a click
    // that looks live and lands nowhere.
    const info = agentInfoByRef([entry('/w/bo', '01JREGISTRYWINS')], {
      '/w/bo': manifest('claude-code', 'opus', '01JSTALEONDISK'),
    });

    expect(info.get(agentAuthorRef('/w/bo'))?.memberId).toBe('01JREGISTRYWINS');
    expect(info.get(agentAuthorRef('/w/bo'))?.memberId).not.toBe('01JSTALEONDISK');
  });

  it('still draws the face off the MANIFEST when the two ids disagree', () => {
    // The other half of the same rule, and the reason `memberId` and `visual`
    // read from different sources rather than one being derived from the other:
    // the sidebar and the message gutter hash the manifest's id, so the face has
    // to keep doing that even where the routing id has moved on.
    const info = agentInfoByRef([entry('/w/bo', '01JREGISTRYWINS')], {
      '/w/bo': manifest('claude-code', 'opus', '01JSTALEONDISK'),
    });

    expect(info.get(agentAuthorRef('/w/bo'))?.visual).toEqual({
      color: hashToHslColor('01JSTALEONDISK'),
      emoji: hashToEmoji('01JSTALEONDISK'),
    });
  });
});

describe('the face the join resolves', () => {
  it('hashes an agent with no stored icon off its MANIFEST id, as the sidebar does', () => {
    // The whole reason a room's faces come through this join. Hashing anything
    // else — the author row the room actually holds, or the directory — lands
    // on a different emoji than the sidebar draws for the same agent, which is
    // the bug DOR-1002 closes. Pinned against `resolveAgentVisual`'s own
    // primitives rather than a literal emoji, so this asserts WHICH SEED is
    // hashed and stays true if the palette is ever retuned.
    const info = agentInfoByRef([entry('/w/bo')], { '/w/bo': manifest('claude-code', 'opus') });

    expect(info.get(agentAuthorRef('/w/bo'))?.visual).toEqual({
      color: hashToHslColor('01JMANIFESTULID'),
      emoji: hashToEmoji('01JMANIFESTULID'),
    });
    // Not the path, and not the author id — the two seeds that were available
    // and would both have been wrong.
    expect(info.get(agentAuthorRef('/w/bo'))?.visual.emoji).not.toBe(hashToEmoji('/w/bo'));
  });

  it('prefers the icon and colour an agent actually chose over the hash', () => {
    const chosen = {
      id: '01JMANIFESTULID',
      runtime: 'claude-code',
      icon: '🐙',
      color: '#7c3aed',
    } as unknown as AgentManifest;
    const info = agentInfoByRef([entry('/w/bo')], { '/w/bo': chosen });

    expect(info.get(agentAuthorRef('/w/bo'))?.visual).toEqual({ color: '#7c3aed', emoji: '🐙' });
  });

  it('projects to faces keyed the same way, and drops nothing else in', () => {
    const info = agentInfoByRef([entry('/w/bo'), entry('/w/gone')], {
      '/w/bo': manifest('claude-code', 'opus'),
      '/w/gone': null,
    });

    const faces = agentFacesByRef(info);

    expect([...faces.keys()]).toEqual([agentAuthorRef('/w/bo')]);
    expect(faces.get(agentAuthorRef('/w/bo'))).toEqual(info.get(agentAuthorRef('/w/bo'))?.visual);
    // A face is a face: an agent the fleet could not resolve has none, so
    // nothing downstream can be handed an override for it.
    expect(faces.has(agentAuthorRef('/w/gone'))).toBe(false);
  });
});
