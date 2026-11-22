import { describe, expect, it } from 'vitest';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
  cardDecision,
  everyAgentDecision,
  type CardAccessLevel,
  type WhoCanUse,
} from '../lib/access-card-selection';
import { accessResult } from '../ui/access/access-result';
import { savedSummary } from '../ui/access/saved-summary';

// The spec's example is Apify, but Apify actions are paid by default, so no
// level would hold any. The fixture keeps the name on a free toolkit.
function candidate(id: string, classification: 'read' | 'write') {
  return {
    operationRevisionId: id,
    toolkit: 'notion',
    operationSlug: `notion.${id}`,
    toolkitVersion: '1',
    capabilityClassification: classification,
    retryPolicy: 'never' as const,
    inputSchema: {},
    supported: true,
  };
}

const NAMES = ['Marketing Lead', 'Scout', 'Pixel', 'Lens', 'Nova'];
const id = (name: string) => `agent-${name.toLowerCase().replace(' ', '-')}`;
const READ = { operationRevisionIds: ['read-v1'], level: 'read' as const };
const WRITE = { operationRevisionIds: ['read-v1', 'run-v1'], level: 'read-write' as const };

function preview({
  grants = {},
  sharedWithEvery = false,
}: {
  grants?: Record<string, typeof READ | typeof WRITE>;
  /** `true` shares Read with every agent; a grant shares that grant. */
  sharedWithEvery?: boolean | typeof READ | typeof WRITE;
} = {}): ConnectorReconciliationPreview {
  return {
    previewId: 'preview-1',
    connection: {
      connectionId: 'connection-1' as never,
      toolkit: 'notion',
      label: 'work',
      status: 'active',
      custody: 'external',
      reconciliationStatus: 'ready',
    },
    candidates: [candidate('read-v1', 'read'), candidate('run-v1', 'write')],
    agents: NAMES.map((name) => ({ agentId: id(name), displayName: name })),
    currentGrants: Object.entries(grants).map(([name, grant]) => ({
      agentId: id(name),
      ...grant,
    })),
    everyAgent: sharedWithEvery
      ? { available: true, ...(sharedWithEvery === true ? READ : sharedWithEvery) }
      : { available: true, operationRevisionIds: [] },
    catalogComplete: true,
    createdAt: '2026-11-21T00:00:00.000Z',
    expiresAt: '2099-11-21T01:00:00.000Z',
  };
}

/** What the page card would say for one choice, exactly as the card computes it. */
function lineFor(
  snapshot: ConnectorReconciliationPreview,
  {
    who,
    picked,
    level = 'read',
    levelTouched = false,
  }: {
    who: WhoCanUse;
    picked: string[];
    level?: CardAccessLevel | null;
    levelTouched?: boolean;
  }
) {
  const input = {
    serviceName: 'Apify',
    preview: snapshot,
    picked: new Set(picked.map(id)),
    level,
    who,
    decision: cardDecision(snapshot, {
      scope: who === 'every' ? [] : snapshot.agents.map((agent) => agent.agentId),
      picked: new Set(picked.map(id)),
      level,
      levelTouched,
    }),
    every: everyAgentDecision(snapshot, { who, level, levelTouched }),
  };
  return { result: accessResult(input), saved: savedSummary({ mode: 'page', ...input }) };
}

describe('accessResult — the line above Save (DOR-4899)', () => {
  it('Every agent → picked, one ticked: names who keeps it and that everyone else loses it', () => {
    const { result, saved } = lineFor(
      preview({ sharedWithEvery: true, grants: { 'Marketing Lead': READ } }),
      { who: 'picked', picked: ['Marketing Lead'] }
    );
    expect(result).toEqual({ line: 'Marketing Lead keeps Apify. Every other agent loses it.' });
    expect(saved).toBe(result?.line);
  });

  it('Every agent → picked, two ticked', () => {
    const { result } = lineFor(
      preview({ sharedWithEvery: true, grants: { 'Marketing Lead': READ } }),
      { who: 'picked', picked: ['Marketing Lead', 'Scout'] }
    );
    expect(result?.line).toBe('Marketing Lead and Scout keep Apify. Every other agent loses it.');
  });

  it('Every agent → picked, 4+ ticked: shortens the list and keeps every name for hover', () => {
    const { result } = lineFor(preview({ sharedWithEvery: true }), {
      who: 'picked',
      picked: ['Marketing Lead', 'Scout', 'Pixel', 'Lens'],
    });
    expect(result).toEqual({
      line: 'Marketing Lead, Scout and 2 more keep Apify. Every other agent loses it.',
      allNames: ['Marketing Lead', 'Scout', 'Pixel', 'Lens'],
    });
  });

  it('Every agent → picked, three ticked: names all three', () => {
    const { result } = lineFor(preview({ sharedWithEvery: true }), {
      who: 'picked',
      picked: ['Marketing Lead', 'Scout', 'Pixel'],
    });
    expect(result).toEqual({
      line: 'Marketing Lead, Scout and Pixel keep Apify. Every other agent loses it.',
    });
  });

  it('Every agent → picked, none ticked', () => {
    const { result, saved } = lineFor(preview({ sharedWithEvery: true }), {
      who: 'picked',
      picked: [],
    });
    expect(result?.line).toBe('No agent will be able to use Apify.');
    expect(saved).toBe('No agent will be able to use Apify.');
  });

  it('→ Every agent, Read', () => {
    const { result, saved } = lineFor(preview(), { who: 'every', picked: [] });
    expect(result?.line).toBe('Every agent can read Apify, including agents you add later.');
    expect(saved).toBe(result?.line);
  });

  it('→ Every agent, Read and write', () => {
    const { result } = lineFor(preview(), {
      who: 'every',
      picked: [],
      level: 'read-write',
      levelTouched: true,
    });
    expect(result?.line).toBe(
      'Every agent can read and change Apify, including agents you add later.'
    );
  });

  it('Picked only: gains first, then losses, then drops to Read', () => {
    const { result, saved } = lineFor(preview({ grants: { Pixel: READ, Lens: WRITE } }), {
      who: 'picked',
      picked: ['Scout', 'Lens'],
      level: 'read',
      levelTouched: true,
    });
    expect(result?.line).toBe('Scout gets Apify (Read). Pixel loses it. Lens drops to Read.');
    expect(saved).toBe(result?.line);
  });

  it('Picked only, a loss alone names the app', () => {
    const { result } = lineFor(preview({ grants: { Pixel: READ } }), {
      who: 'picked',
      picked: [],
    });
    expect(result?.line).toBe('Pixel loses Apify.');
  });

  it('Picked only, several gains and losses use the plural', () => {
    const { result } = lineFor(preview({ grants: { Pixel: READ, Lens: READ } }), {
      who: 'picked',
      picked: ['Scout', 'Nova'],
    });
    expect(result?.line).toBe('Scout and Nova get Apify (Read). Pixel and Lens lose it.');
  });

  it('Every agent → picked: a kept agent moved up to Read and write says so', () => {
    const { result, saved } = lineFor(
      preview({ sharedWithEvery: true, grants: { 'Marketing Lead': READ } }),
      {
        who: 'picked',
        picked: ['Marketing Lead', 'Scout'],
        level: 'read-write',
        levelTouched: true,
      }
    );
    // Two lines (designer, Nov 21), so neither runs past 15 words.
    expect(result).toEqual({
      line: 'Marketing Lead and Scout keep Apify. Every other agent loses it.',
      detail: 'Marketing Lead and Scout move up to Read and write.',
    });
    expect(saved).toBe(
      'Marketing Lead and Scout keep Apify. Every other agent loses it.\nMarketing Lead and Scout move up to Read and write.'
    );
  });

  it('Every agent → picked: an agent kept on its own Read loses the write every agent had', () => {
    const { result } = lineFor(
      preview({ sharedWithEvery: WRITE, grants: { 'Marketing Lead': READ } }),
      { who: 'picked', picked: ['Marketing Lead'], level: 'read-write' }
    );
    expect(result).toEqual({
      line: 'Marketing Lead keeps Apify. Every other agent loses it.',
      detail: 'Marketing Lead drops to Read.',
    });
  });

  it('Picked only: an agent that already reads moves up, rather than "gets" the app', () => {
    const { result } = lineFor(preview({ grants: { Lens: READ } }), {
      who: 'picked',
      picked: ['Lens', 'Scout'],
      level: 'read-write',
      levelTouched: true,
    });
    expect(result?.line).toBe(
      'Scout gets Apify (Read and write). Lens moves up to Read and write.'
    );
  });

  it('says nothing while Save still needs a level', () => {
    const { result } = lineFor(preview({ grants: { Pixel: READ, Lens: WRITE } }), {
      who: 'picked',
      picked: ['Pixel', 'Lens', 'Scout'],
      level: null,
    });
    expect(result).toBeNull();
  });

  it('says nothing when Save would change nothing', () => {
    expect(
      lineFor(preview({ grants: { Pixel: READ } }), { who: 'picked', picked: ['Pixel'] }).result
    ).toBeNull();
    expect(
      lineFor(preview({ sharedWithEvery: true }), { who: 'every', picked: [] }).result
    ).toBeNull();
  });
});
