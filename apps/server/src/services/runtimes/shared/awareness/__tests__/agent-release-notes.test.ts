import { describe, expect, it } from 'vitest';
import { valid } from 'semver';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { MCP_TOOL_TIERS } from '../../../../core/mcp-tool-tiers.js';
import {
  AGENT_RELEASE_NOTES,
  notesSince,
  releaseNoteLine,
  type AgentReleaseNote,
} from '../agent-release-notes.js';

const note = (version: string): AgentReleaseNote => ({
  version,
  name: 'Memory',
  can: 'save a note.',
  covers: ['memory.write'],
  areas: [],
  gate: 'always on',
});

describe('release selection', () => {
  it('selects (seen, current], ignoring next, later releases and downgrades', () => {
    const notes = ['0.9.0', '0.10.0', '0.11.0', 'next'].map(note);
    expect(notesSince('0.9.0', '0.10.0', notes)).toEqual([notes[1]]);
    expect(notesSince('0.10.0', '0.10.0', notes)).toEqual([]);
    expect(notesSince('0.11.0', '0.10.0', notes)).toEqual([]);
    expect(notesSince('invalid', '0.10.0', notes)).toEqual([]);
  });

  it('formats permission names and static gates without claiming a live level', () => {
    expect(
      releaseNoteLine({ ...note('next'), areas: ['packages'], gate: 'adding always asks' })
    ).toBe('Memory: save a note. [Tools & packages; adding always asks]');
  });
});

describe('compiled release facts', () => {
  const ids = [
    ...composeCapabilityRegistryForDocs().capabilities.map((cap) => ({
      id: cap.id,
      area: cap.area,
    })),
    ...Object.entries(MCP_TOOL_TIERS).map(([id, tool]) => ({ id, area: tool.area })),
  ];

  it('keeps every fact short, single-line, stamped or explicitly unreleased, and gated', () => {
    for (const item of AGENT_RELEASE_NOTES) {
      expect(item.version === 'next' || !!valid(item.version)).toBe(true);
      expect(releaseNoteLine(item)).not.toMatch(/[<\r\n]/);
      expect(releaseNoteLine(item).length).toBeLessThan(160);
      expect(item.areas.length > 0 || !!item.gate).toBe(true);
    }
  });

  it('covers existing ids and states exactly their permission areas', () => {
    for (const item of AGENT_RELEASE_NOTES) {
      for (const prefix of item.covers) {
        expect(
          ids.some(({ id }) => id === prefix || id.startsWith(prefix)),
          prefix
        ).toBe(true);
      }
      const areas = new Set(
        ids
          .filter(({ id }) => item.covers.some((prefix) => id === prefix || id.startsWith(prefix)))
          .map(({ area }) => area)
      );
      expect(item.areas).toEqual(PERMISSION_AREA_IDS.filter((area) => areas.has(area)));
    }
  });
});
