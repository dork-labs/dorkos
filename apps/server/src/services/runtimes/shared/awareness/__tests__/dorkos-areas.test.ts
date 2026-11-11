/**
 * The area lines cover everything an agent can reach (DOR-3219).
 *
 * Read from both sources an agent's tools come from, the capability registry
 * and the direct MCP tools, the same two the permission-area census reads. A
 * new capability with no area line fails here, and so does a line whose stated
 * permission areas no longer match the ids it covers.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { MCP_TOOL_TIERS, type McpToolTier } from '../../../../core/mcp-tool-tiers.js';
import { DORKOS_AREAS, areaLineCovers, buildDorkosAreasBlock } from '../dorkos-areas.js';
import { estimateTokens } from '../../window/context-fit.js';

/** Every agent-reachable id, with the permission area it belongs to. */
function everyId(): { id: string; area: string | null }[] {
  const capabilities = composeCapabilityRegistryForDocs().capabilities.map((cap) => ({
    id: cap.id,
    area: cap.area,
  }));
  const tools = Object.entries(MCP_TOOL_TIERS as Record<string, McpToolTier>).map(([id, tool]) => ({
    id,
    area: tool.area,
  }));
  return [...capabilities, ...tools];
}

describe('DORKOS_AREAS', () => {
  const ids = everyId();

  it('has a line for every capability and tool an agent can reach', () => {
    const uncovered = ids
      .filter(({ id }) => !DORKOS_AREAS.some((line) => areaLineCovers(line, id)))
      .map(({ id }) => id);
    expect(uncovered).toEqual([]);
  });

  it('names exactly the permission areas of the ids each line covers', () => {
    for (const line of DORKOS_AREAS) {
      const areas = new Set(
        ids.filter(({ id }) => areaLineCovers(line, id)).flatMap(({ area }) => (area ? [area] : []))
      );
      const expected = PERMISSION_AREA_IDS.filter((id) => areas.has(id));
      expect({ line: line.name, areas: line.areas }).toEqual({ line: line.name, areas: expected });
    }
  });

  it('has no prefix that covers nothing', () => {
    for (const line of DORKOS_AREAS) {
      for (const prefix of line.covers) {
        const hits = ids.filter(({ id }) => id === prefix || id.startsWith(prefix));
        expect({ line: line.name, prefix, hits: hits.length > 0 }).toEqual({
          line: line.name,
          prefix,
          hits: true,
        });
      }
    }
  });
});

describe('buildDorkosAreasBlock', () => {
  const block = buildDorkosAreasBlock();

  it('lists every area, each with what governs it: a bracket, the gates line, or both', () => {
    for (const line of DORKOS_AREAS) expect(block).toContain(`- ${line.name}: `);
    const withArea = DORKOS_AREAS.filter((line) => line.areas.length > 0);
    expect(block.match(/\[[^\]]+\]$/gm)).toHaveLength(withArea.length);
    expect(block).toContain('[Tools & packages]');
    const gates = block.split('\n').find((text) => text.startsWith('Gates:')) ?? '';
    for (const line of DORKOS_AREAS.filter((candidate) => candidate.gate)) {
      expect({ line: line.name, gated: gates.includes(line.name) }).toEqual({
        line: line.name,
        gated: true,
      });
    }
    expect(gates).toContain('adding an MCP server asks (Tools)');
  });

  it('gives every line with no permission area the thing that gates it instead', () => {
    for (const line of DORKOS_AREAS) {
      if (line.areas.length === 0)
        expect({ line: line.name, gate: !!line.gate }).toEqual({ line: line.name, gate: true });
    }
  });

  it('says it describes what exists, not what is allowed, and where the levels are', () => {
    expect(block).toContain('What exists, not what you may do now');
    expect(block).toContain('ends in `list_my_permissions`');
  });

  it('sends an agent to the catalog before it says DorkOS cannot do something', () => {
    expect(block).toContain("Before you say DorkOS can't do something");
    expect(block).toContain('ends in `list_capabilities`');
  });

  it('tells an agent that MCP changes apply next turn, and that browsers are DorkOS', () => {
    expect(block).toContain('A change reaches you next turn, in this chat: no restart.');
    expect(block).toContain('never send them to a terminal');
  });

  it('stays small enough to ride in every session (DOR-3219 diet)', () => {
    // Design pass v1 row 14: at most 450 tokens, by the estimate the context
    // window fit uses, and no area line past about 25 words.
    expect(estimateTokens(block.length)).toBeLessThanOrEqual(450);
    for (const text of block.split('\n').filter((candidate) => candidate.startsWith('- '))) {
      const sentence = text.replace(/^- /, '').replace(/ \[[^\]]*\]$/, '');
      expect({ text, words: sentence.split(/\s+/).length <= 25 }).toEqual({ text, words: true });
    }
  });

  it('names no runtime prefix and no third-party engine', () => {
    expect(block).not.toMatch(/mcp__|Playwright/);
  });
});

/**
 * Area lines that carry no bracket and are not named on the Gates line: a line
 * an agent would read as ungoverned. Reads the rendered TEXT, so it holds
 * whatever the data model behind it becomes.
 */
function bareUngatedLines(block: string): string[] {
  const gates = block.split('\n').find((text) => text.startsWith('Gates:')) ?? '';
  return block
    .split('\n')
    .filter((text) => text.startsWith('- ') && !/\[[^\]]+\]$/.test(text))
    .map((text) => text.slice(2, text.indexOf(':')))
    .filter(
      (name) => !new RegExp(`[(,] ?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,)]`).test(gates)
    );
}

describe('no area line reads as ungoverned (Security, DOR-3219 diet)', () => {
  it('names every bracketless line on the Gates line', () => {
    expect(bareUngatedLines(buildDorkosAreasBlock())).toEqual([]);
  });

  it('catches a bracketless line the Gates line does not name', () => {
    // The guard on the guard: a planted line with neither must be reported.
    const planted = buildDorkosAreasBlock().replace(
      '\nGates:',
      '\n- Planted area: do something new.\nGates:'
    );
    expect(bareUngatedLines(planted)).toEqual(['Planted area']);
  });
});
